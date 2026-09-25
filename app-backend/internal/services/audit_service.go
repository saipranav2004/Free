// pam/internal/services/audit_service.go
//
// AuditService is the single entry point for writing audit records — for
// every branch. Two independent implementations existed before the merge
// (see internal/models/audit_log.go's doc comment for why they were
// unified). This version keeps THREE call shapes so that neither branch's
// call sites needed to change:
//
//   - Append(ctx, e)      — compliance branch: opens its own transaction.
//     Used by middleware/audit.go (HTTP auto-logging) and
//     audit_report_service.go ("report generated" entries).
//   - WriteTx(tx, e) error — JIT branch: participates in the CALLER's
//     transaction, so a JIT state change (approve/deny/revoke/expire) and
//     its audit row commit or roll back together. Used throughout
//     jit_service.go.
//   - Write(e)            — JIT branch: fire-and-forget, own transaction,
//     swallows its own error (logs it). Used for post-commit side effects
//     (IAM sync, break-glass report generation) and for the two
//     handler-layer session/admin audit writes where the state change
//     already committed separately.
//
// All three share one core (appendCore) so there is exactly one hash-chain
// implementation and one advisory-lock/sequence-allocation path.
package services

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/pkg/auditchain"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

// AuditService is the single entry point for writing audit records.
//
// Concurrency model:
//   - We take a Postgres advisory lock keyed on OrgID so concurrent writers
//     in the same tenant append strictly serially. Different tenants do not
//     block each other.
//   - We do NOT take a row lock (FOR UPDATE) on the last row; inserting a new
//     row would not block another inserter on that lock. The advisory lock
//     is the correct primitive for chain serialization.
//
// On failure:
//   - Append/WriteTx return the error — the caller decides whether to retry
//     or roll back. We do NOT silently drop those audit events.
//   - Write (fire-and-forget) logs and swallows its error, by design — it is
//     used only for post-commit side effects where the primary state change
//     has already succeeded and must not be undone by an audit hiccup.
type AuditService struct {
	db         *gorm.DB
	hmacSecret []byte
	defaultOrg string
	logger     *zap.Logger
}

// NewAuditService wires the service. hmacSecret must be >= 32 bytes in
// production and must come from config (env var, not source code).
func NewAuditService(db *gorm.DB, hmacSecret []byte, defaultOrg string, logger *zap.Logger) *AuditService {
	if defaultOrg == "" {
		defaultOrg = "default"
	}
	return &AuditService{
		db:         db,
		hmacSecret: hmacSecret,
		defaultOrg: defaultOrg,
		logger:     logger,
	}
}

// AuditEntry is the public input to Append/WriteTx/Write. Optional fields
// stay at their zero value. Details accepts either a pre-formatted string
// (compliance branch call sites) or a map/struct that will be JSON-encoded
// (JIT branch call sites) — see detailsToString.
type AuditEntry struct {
	OrgID       string
	UserID      string
	Username    string
	Email       string
	ServiceName string

	// ActorUserID/ActorUsername are the JIT branch's own naming for the same
	// two fields as UserID/Username (jit_service.go, session_handler.go, and
	// admin_handler.go all construct AuditEntry this way, since that is what
	// team-jit's own now-discarded audit_service.go called them). Rather than
	// rewrite those call sites, appendCore treats these as an alias: if set,
	// they take precedence over UserID/Username for the same entry. Exactly
	// one of the two naming schemes should be set per call site in practice.
	ActorUserID   string
	ActorUsername string

	// ActorType: USER | SYSTEM | IAM. Defaults to "USER" when empty.
	ActorType string

	Category models.AuditCategory // optional; derived from Action when empty
	Action   string
	Outcome  models.AuditOutcome
	// Severity: INFO | WARN | CRITICAL. Defaults to "INFO" when empty.
	Severity string

	// Resource is the compliance branch's generic path/ARN form.
	Resource string
	// ResourceType/ResourceID/ResourceName are the JIT branch's structured form.
	ResourceType string
	ResourceID   string
	ResourceName string

	// Details may be a string (used as-is) or any other value (JSON-encoded).
	Details       interface{}
	Justification string

	SourceIP        string
	UserAgent       string
	RequestID       string
	SessionID       string
	GrantID         string
	AuthzDecisionID string

	OccurredAt time.Time // optional override; if zero, service uses time.Now().UTC()
}

// Append writes a single audit record in its own transaction and returns the
// persisted row. The hash chain is extended atomically with the insert.
func (s *AuditService) Append(ctx context.Context, e AuditEntry) (*models.AuditLog, error) {
	var out *models.AuditLog
	err := s.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		row, err := s.appendCore(tx, e)
		out = row
		return err
	})
	if err != nil {
		s.logger.Error("audit.append.fail",
			zap.String("action", e.Action),
			zap.String("user_id", e.resolvedUserID()),
			zap.Error(err),
		)
		return nil, err
	}
	return out, nil
}

// resolvedUserID returns ActorUserID if set, else UserID — used where we
// only need the actor for logging, not the full appendCore reconciliation.
func (e AuditEntry) resolvedUserID() string {
	if e.ActorUserID != "" {
		return e.ActorUserID
	}
	return e.UserID
}

// AppendNoCtx is a shim for code that wants the no-context form.
func (s *AuditService) AppendNoCtx(e AuditEntry) (*models.AuditLog, error) {
	return s.Append(context.Background(), e)
}

// WriteTx writes the audit row as part of the CALLER's transaction, so a
// state change (grant issued, request approved, session revoked, ...) and
// its audit row commit or roll back atomically. This is what every JIT
// lifecycle transition uses.
func (s *AuditService) WriteTx(tx *gorm.DB, e AuditEntry) error {
	_, err := s.appendCore(tx, e)
	return err
}

// Write is the fire-and-forget form: its own transaction, errors are logged
// and swallowed rather than returned. Used for post-commit side effects
// (IAM sync outcome, break-glass report generation) and handler-layer
// session/admin audit rows where the underlying state change already
// committed on its own — losing one of these audit rows is preferable to
// reversing a security action that has already taken effect.
func (s *AuditService) Write(e AuditEntry) {
	if _, err := s.Append(context.Background(), e); err != nil {
		s.logger.Error("audit.write.fail",
			zap.String("action", e.Action),
			zap.String("actor_user_id", e.resolvedUserID()),
			zap.Error(err),
		)
	}
}

// appendCore is the shared implementation behind Append and WriteTx. It
// operates on the given tx directly — the caller decides the transaction
// boundary (its own, for Append; the caller's, for WriteTx).
func (s *AuditService) appendCore(tx *gorm.DB, e AuditEntry) (*models.AuditLog, error) {
	if e.Action == "" {
		return nil, errors.New("audit: action is required")
	}
	org := e.OrgID
	if org == "" {
		org = s.defaultOrg
	}
	actorType := e.ActorType
	if actorType == "" {
		actorType = "USER"
	}
	severity := e.Severity
	if severity == "" {
		severity = models.AuditSeverityInfo
	}
	outcome := e.Outcome
	if outcome == "" {
		outcome = models.OutcomeSuccess
	}
	category := e.Category
	if category == "" {
		category = deriveCategoryFromAction(e.Action)
	}
	occurred := e.OccurredAt
	if occurred.IsZero() {
		occurred = time.Now().UTC()
	}
	// ActorUserID/ActorUsername (JIT branch's naming) win over UserID/Username
	// (compliance branch's naming) when both happen to be set; in practice
	// each call site only ever sets one pair.
	actorUserID, actorUsername := e.UserID, e.Username
	if e.ActorUserID != "" {
		actorUserID = e.ActorUserID
	}
	if e.ActorUsername != "" {
		actorUsername = e.ActorUsername
	}
	detailsStr, err := detailsToString(e.Details)
	if err != nil {
		return nil, fmt.Errorf("audit: encode details: %w", err)
	}

	// 1. Per-tenant advisory lock. hashtext() maps the org string to int4.
	//    Two orgs do not contend; within one org, appends are serialized.
	//
	//    Postgres only, and that is not a gap. pg_advisory_xact_lock exists to
	//    serialize concurrent appenders so the sequence number allocated in
	//    step 2 cannot be handed to two writers at once. SQLite — the only
	//    other dialect this runs on, in tests — serializes the entire database
	//    for writes already, so there is nothing left for a lock to add and
	//    the statement would simply fail ("no such function: hashtext").
	//
	//    Guarding rather than dropping it keeps the real protection where it
	//    is needed and makes the audit chain exercisable in tests, which it
	//    previously was not: no test could write an audit row at all, so the
	//    hash chain's own behaviour under append was only ever covered by
	//    pkg/auditchain's unit tests and never through this service.
	if tx.Dialector != nil && tx.Dialector.Name() == "postgres" {
		if err := tx.Exec("SELECT pg_advisory_xact_lock(hashtext(?))", "pam:audit:"+org).Error; err != nil {
			return nil, fmt.Errorf("advisory lock: %w", err)
		}
	}

	// 2. Allocate next sequence number. Race-free because of the lock above.
	var nextSeq int64
	if err := tx.Raw(
		fmt.Sprintf("SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM %s.pam_audit_log WHERE org_id = ?", getSchema()),
		org,
	).Scan(&nextSeq).Error; err != nil {
		return nil, fmt.Errorf("allocate seq: %w", err)
	}

	// 3. Read PrevHash of the chain head (or genesis if empty).
	var prevHash string
	if err := tx.Raw(
		fmt.Sprintf("SELECT entry_hash FROM %s.pam_audit_log WHERE org_id = ? ORDER BY sequence_number DESC LIMIT 1", getSchema()),
		org,
	).Scan(&prevHash).Error; err != nil {
		return nil, fmt.Errorf("read prev_hash: %w", err)
	}
	if prevHash == "" {
		prevHash = auditchain.GenesisHash
	}

	// 4. Compute the HMAC chain entry.
	in := auditchain.Inputs{
		OrgID:           org,
		SequenceNumber:  nextSeq,
		UserID:          actorUserID,
		Username:        actorUsername,
		Email:           e.Email,
		ServiceName:     e.ServiceName,
		ActorType:       actorType,
		Category:        string(category),
		Action:          e.Action,
		Outcome:         string(outcome),
		Severity:        severity,
		Resource:        e.Resource,
		ResourceType:    e.ResourceType,
		ResourceID:      e.ResourceID,
		ResourceName:    e.ResourceName,
		Details:         detailsStr,
		Justification:   e.Justification,
		SourceIP:        e.SourceIP,
		UserAgent:       e.UserAgent,
		RequestID:       e.RequestID,
		SessionID:       e.SessionID,
		GrantID:         e.GrantID,
		AuthzDecisionID: e.AuthzDecisionID,
		OccurredAt:      occurred,
		PrevHash:        prevHash,
	}
	_, entryHash, err := auditchain.Compute(s.hmacSecret, in)
	if err != nil {
		return nil, fmt.Errorf("compute hash: %w", err)
	}

	row := &models.AuditLog{
		SequenceNumber:  nextSeq,
		OrgID:           org,
		UserID:          actorUserID,
		Username:        actorUsername,
		Email:           e.Email,
		ServiceName:     nilIfEmpty(e.ServiceName),
		ActorType:       actorType,
		Category:        category,
		Action:          e.Action,
		Outcome:         outcome,
		Severity:        severity,
		Resource:        e.Resource,
		ResourceType:    e.ResourceType,
		ResourceID:      e.ResourceID,
		ResourceName:    e.ResourceName,
		Details:         detailsStr,
		Justification:   e.Justification,
		SourceIP:        e.SourceIP,
		UserAgent:       e.UserAgent,
		RequestID:       e.RequestID,
		SessionID:       e.SessionID,
		GrantID:         e.GrantID,
		AuthzDecisionID: e.AuthzDecisionID,
		PrevHash:        prevHash,
		EntryHash:       entryHash,
		HashVersion:     auditchain.CurrentCanonicalVersion,
		OccurredAt:      occurred,
	}

	// 5. Insert. A DB-level trigger (see migrations) blocks UPDATE/DELETE on
	//    this table later; INSERT is always allowed. We never call .Save()
	//    or .Updates() on AuditLog anywhere in this file.
	if err := tx.Create(row).Error; err != nil {
		return nil, fmt.Errorf("insert: %w", err)
	}
	return row, nil
}

// detailsToString normalises AuditEntry.Details (string | map | struct | nil)
// into the text form stored in the DB and fed into the hash.
func detailsToString(d interface{}) (string, error) {
	switch v := d.(type) {
	case nil:
		return "", nil
	case string:
		return v, nil
	default:
		b, err := json.Marshal(v)
		if err != nil {
			return "", err
		}
		return string(b), nil
	}
}

// deriveCategoryFromAction infers a Category for rows that only set Action
// (every JIT/grant/session lifecycle write never sets Category explicitly).
func deriveCategoryFromAction(action string) models.AuditCategory {
	switch {
	case len(action) >= 11 && action[:11] == "BREAKGLASS_":
		return models.BreakGlass
	case len(action) >= 4 && action[:4] == "JIT_":
		return models.JITAccess
	case len(action) >= 13 && action[:13] == "ACCESS_GRANT_":
		return models.JITAccess
	case len(action) >= 8 && action[:8] == "SESSION_":
		return models.SessionLifecycle
	case len(action) >= 6 && action[:6] == "AUTHZ_":
		return models.AuditAuthz
	default:
		return models.AuditOther
	}
}

// VerifyChain walks the entire chain for an org and returns the first
// sequence number that fails verification, or nil if the chain is intact.
// Run this on a daily cron (see AuditVerificationJob). If it returns an
// error, page the on-call.
func (s *AuditService) VerifyChain(ctx context.Context, orgID string) (*VerificationResult, error) {
	if orgID == "" {
		orgID = s.defaultOrg
	}
	var rows []models.AuditLog
	if err := s.db.WithContext(ctx).
		Where("org_id = ?", orgID).
		Order("sequence_number ASC").
		Find(&rows).Error; err != nil {
		return nil, fmt.Errorf("load chain: %w", err)
	}
	res := &VerificationResult{
		OrgID:     orgID,
		TotalRows: len(rows),
	}
	expectedPrev := auditchain.GenesisHash
	for i, r := range rows {
		// Sequence number must be contiguous.
		if int64(i+1) != r.SequenceNumber {
			res.Valid = false
			res.FirstBadSeq = r.SequenceNumber
			res.Reason = "sequence gap"
			return res, nil
		}
		if r.PrevHash != expectedPrev {
			res.Valid = false
			res.FirstBadSeq = r.SequenceNumber
			res.Reason = "prev_hash link broken"
			return res, nil
		}
		if err := auditchain.VerifyRow(s.hmacSecret, auditchain.Inputs{
			OrgID:           r.OrgID,
			SequenceNumber:  r.SequenceNumber,
			UserID:          r.UserID,
			Username:        r.Username,
			Email:           r.Email,
			ServiceName:     strOrEmpty(r.ServiceName),
			ActorType:       r.ActorType,
			Category:        string(r.Category),
			Action:          r.Action,
			Outcome:         string(r.Outcome),
			Severity:        r.Severity,
			Resource:        r.Resource,
			ResourceType:    r.ResourceType,
			ResourceID:      r.ResourceID,
			ResourceName:    r.ResourceName,
			Details:         r.Details,
			Justification:   r.Justification,
			SourceIP:        r.SourceIP,
			UserAgent:       r.UserAgent,
			RequestID:       r.RequestID,
			SessionID:       r.SessionID,
			GrantID:         r.GrantID,
			AuthzDecisionID: r.AuthzDecisionID,
			OccurredAt:      r.OccurredAt,
			PrevHash:        r.PrevHash,
		}, r.EntryHash); err != nil {
			res.Valid = false
			res.FirstBadSeq = r.SequenceNumber
			res.Reason = err.Error()
			return res, nil
		}
		expectedPrev = r.EntryHash
	}
	res.Valid = true
	return res, nil
}

// VerificationResult is what the daily chain job reports.
type VerificationResult struct {
	OrgID       string
	TotalRows   int
	Valid       bool
	FirstBadSeq int64
	Reason      string
}

// AuditFilter is the IAM admin dashboard's own audit-search input
// (admin_handler.go's ListAudit/GetJITRequest). It is deliberately simpler
// than AuditQueryService.SearchFilters (Feature 107's own tsvector-backed
// search, exposed at /api/v1/pam/audit): that one is the compliance team's
// full-text search surface, this one is the JIT/IAM console's own filter
// shape, matched field-for-field to what admin_handler.go already builds
// from query params. Kept as a second, smaller entry point on AuditService
// itself (rather than rewriting admin_handler.go to depend on
// AuditQueryService too) since AdminHandler is only constructed with an
// *AuditService.
type AuditFilter struct {
	ActorUserID string
	Action      string
	Outcome     string
	Severity    string
	ResourceID  string
	GrantID     string
	RequestID   string
	SessionID   string
	From        *time.Time
	To          *time.Time
	// Search is a plain substring match (ILIKE) over action/resource_name/
	// details/justification — not the GIN-indexed tsvector search
	// AuditQueryService.Search uses. Fine for the admin console's volumes;
	// swap for AuditQueryService if this needs to scale to Search's numbers.
	Search   string
	Page     int
	PageSize int
}

// List runs a filtered, paginated query against the audit log for the IAM
// admin dashboard. See AuditFilter's doc comment for how this differs from
// AuditQueryService.Search.
// ──────────────────────────────────────────────────────────────────────────
// AGGREGATES
// ──────────────────────────────────────────────────────────────────────────

// AuditStats is the dashboard's charts expressed as counts rather than rows.
//
// WHY THIS EXISTS. The dashboard used to build its charts by walking the audit
// list 200 rows at a time, up to 5,000, and computing everything in the
// browser. That capped what the charts could describe at 5,000 events, took 25
// round trips to get there, and shipped megabytes to do arithmetic a database
// does in one query. Past 5,000 the page was simply waiting.
//
// Counting server-side removes the cap entirely: the numbers describe EVERY
// event in the range, and the payload is a few hundred bytes whether that is
// five events or five million.
//
// TIME ZONE IS A PARAMETER, NOT AN ASSUMPTION. "Which hour did this happen in"
// has no answer without one, and the charts are read by a person sitting in a
// particular place. Rows are stored in UTC; the caller passes its IANA zone
// and every bucket is cut in that zone, so an event at 23:30 local does not
// land on tomorrow because the server happens to run in UTC.
type AuditStats struct {
	Total    int64            `json:"total"`
	Outcomes map[string]int64 `json:"outcomes"`
	Buckets  []AuditBucket    `json:"buckets"`
	Heat     []AuditHeatCell  `json:"heat"`
	Actors   int64            `json:"actors"`
	From     *time.Time       `json:"from,omitempty"`
	To       *time.Time       `json:"to,omitempty"`
}

// AuditBucket is one column of the activity-volume chart.
type AuditBucket struct {
	Start  time.Time `json:"start"`
	Count  int64     `json:"count"`
	Denied int64     `json:"denied"`
}

// AuditHeatCell is one square of the weekday/hour heatmap. Day is 0=Monday.
type AuditHeatCell struct {
	Day   int   `json:"day"`
	Hour  int   `json:"hour"`
	Count int64 `json:"count"`
}

// deniedOutcomes are the outcomes the console counts as "denied or failed".
// Kept as one list so the charts, the tiles and this query cannot disagree.
var deniedOutcomes = []string{
	string(models.AuditOutcomeDenied),
	string(models.OutcomeError),
	string(models.AuditOutcomeFailure),
}

// Stats computes the dashboard aggregates for a filter.
//
// span is "hour" or "day" and decides the bucket width. tz is an IANA zone
// name; an empty or unknown zone falls back to UTC rather than failing, since
// a chart cut in the wrong zone is a nuisance and a 500 is an outage.
func (s *AuditService) Stats(f AuditFilter, span, tz string) (*AuditStats, error) {
	if tz == "" {
		tz = "UTC"
	}
	if _, err := time.LoadLocation(tz); err != nil {
		tz = "UTC"
	}
	unit := "hour"
	if span == "day" {
		unit = "day"
	}

	base := func() *gorm.DB { return s.applyAuditFilter(s.db.Model(&models.AuditLog{}), f) }

	out := &AuditStats{Outcomes: map[string]int64{}, From: f.From, To: f.To}

	if err := base().Count(&out.Total).Error; err != nil {
		return nil, err
	}
	if err := base().Distinct("user_id").Count(&out.Actors).Error; err != nil {
		return nil, err
	}

	// Outcome totals in one grouped pass.
	var outcomeRows []struct {
		Outcome string
		N       int64
	}
	if err := base().Select("outcome, COUNT(*) AS n").Group("outcome").Scan(&outcomeRows).Error; err != nil {
		return nil, err
	}
	for _, r := range outcomeRows {
		out.Outcomes[strings.ToUpper(strings.TrimSpace(r.Outcome))] = r.N
	}

	// Time series. date_trunc runs on the timestamp converted into the
	// caller's zone, then the label is handed back as that local wall time.
	var bucketRows []struct {
		Bucket time.Time
		N      int64
		Denied int64
	}
	bucketExpr := fmt.Sprintf("date_trunc('%s', occurred_at AT TIME ZONE ?)", unit)
	if err := base().
		Select(bucketExpr+" AS bucket, COUNT(*) AS n, "+
			"COUNT(*) FILTER (WHERE UPPER(outcome) IN (?)) AS denied", tz, deniedOutcomes).
		Group("bucket").
		Order("bucket ASC").
		Scan(&bucketRows).Error; err != nil {
		return nil, err
	}
	out.Buckets = make([]AuditBucket, 0, len(bucketRows))
	for _, r := range bucketRows {
		out.Buckets = append(out.Buckets, AuditBucket{Start: r.Bucket, Count: r.N, Denied: r.Denied})
	}

	// Weekday/hour grid. Postgres DOW is 0=Sunday; the console's grid is
	// 0=Monday, so it is rotated here rather than in three chart components.
	var heatRows []struct {
		Dow  int
		Hour int
		N    int64
	}
	if err := base().
		Select("EXTRACT(DOW FROM occurred_at AT TIME ZONE ?)::int AS dow, "+
			"EXTRACT(HOUR FROM occurred_at AT TIME ZONE ?)::int AS hour, COUNT(*) AS n", tz, tz).
		Group("dow, hour").
		Scan(&heatRows).Error; err != nil {
		return nil, err
	}
	out.Heat = make([]AuditHeatCell, 0, len(heatRows))
	for _, r := range heatRows {
		out.Heat = append(out.Heat, AuditHeatCell{Day: (r.Dow + 6) % 7, Hour: r.Hour, Count: r.N})
	}

	return out, nil
}

// applyAuditFilter narrows a query by an AuditFilter.
//
// Shared by List and Stats on purpose: the charts and the table must describe
// the same rows. Two copies of this would drift, and the drift would show up as
// a total on the chart that disagrees with the count under the table, which is
// the kind of discrepancy that makes people stop trusting an audit screen.
func (s *AuditService) applyAuditFilter(q *gorm.DB, f AuditFilter) *gorm.DB {
	if f.ActorUserID != "" {
		q = q.Where("user_id = ?", f.ActorUserID)
	}
	if f.Action != "" {
		q = q.Where("action = ?", f.Action)
	}
	if f.Outcome != "" {
		q = q.Where("outcome = ?", f.Outcome)
	}
	if f.Severity != "" {
		q = q.Where("severity = ?", f.Severity)
	}
	if f.ResourceID != "" {
		q = q.Where("resource_id = ?", f.ResourceID)
	}
	if f.GrantID != "" {
		q = q.Where("grant_id = ?", f.GrantID)
	}
	if f.RequestID != "" {
		q = q.Where("request_id = ?", f.RequestID)
	}
	if f.SessionID != "" {
		q = q.Where("session_id = ?", f.SessionID)
	}
	if f.From != nil {
		q = q.Where("occurred_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("occurred_at <= ?", *f.To)
	}
	if f.Search != "" {
		like := "%" + f.Search + "%"
		q = q.Where(
			"action ILIKE ? OR resource_name ILIKE ? OR details ILIKE ? OR justification ILIKE ?",
			like, like, like, like,
		)
	}
	return q
}

func (s *AuditService) List(f AuditFilter) ([]models.AuditLog, int64, error) {
	page, size := normalisePaging(f.Page, f.PageSize)

	q := s.applyAuditFilter(s.db.Model(&models.AuditLog{}), f)

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, fmt.Errorf("audit.list.count: %w", err)
	}

	var rows []models.AuditLog
	if err := q.
		Order("sequence_number DESC").
		Offset((page - 1) * size).
		Limit(size).
		Find(&rows).Error; err != nil {
		return nil, 0, fmt.Errorf("audit.list.find: %w", err)
	}
	return rows, total, nil
}

// helpers --------------------------------------------------------------

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}
func strOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}
