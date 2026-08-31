// pam/internal/services/jit_service.go
//
// Just-In-Time access workflow, time-boxed grants, break-glass emergency access
// and auto-revocation.
//
// Design decisions worth knowing before editing:
//
//  1. PAM-local grants are AUTHORITATIVE for PAM actions. The optional push into
//     IAM (temporary policy attachment) is a projection so the IAM console/OPA
//     can see the entitlement too. If IAM is down, PAM still enforces correctly.
//     The reverse would be unsafe: it would make expiry depend on a remote system.
//
//  2. Enforcement never trusts `status` alone. A grant is usable only when
//     status == ACTIVE **and** now < expires_at. The sweeper flips ACTIVE →
//     EXPIRED asynchronously, so between the expiry instant and the next sweep
//     the row still says ACTIVE — the clock check closes that window.
//
//  3. The grant clock starts at APPROVAL, not at request time (same as Entra
//     PIM / CyberArk): an approval that sat in a queue for two hours must not
//     silently consume the requested window.
//
//  4. Break-glass skips the approver but NOT the controls: mandatory waiting
//     period, CRITICAL alert, forced recording, auto-generated report.
package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/yourorg/pam/internal/config"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/pkg/iamclient"
	"go.uber.org/zap"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// Domain errors. Handlers map these to HTTP status codes.
var (
	ErrJITNotFound   = errors.New("jit request not found")
	ErrGrantNotFound = errors.New("access grant not found")
	ErrInvalidState  = errors.New("request is not in a state that allows this operation")
	ErrSelfApproval  = errors.New("separation of duty: a request cannot be approved by its requester")
	// ErrDuplicateApprover is four-eyes refusing to count one person twice.
	// Surfaced as HTTP 409 so the console can say "you have already approved
	// this; a second approver is required" rather than a generic failure.
	ErrDuplicateApprover     = errors.New("four-eyes: you have already approved this request; a second, different approver is required")
	ErrDuplicateRequest      = errors.New("an open request or active grant already exists for this resource")
	ErrDurationExceeded      = errors.New("requested duration exceeds the configured maximum")
	ErrReasonTooShort        = errors.New("a justification of sufficient length is required")
	ErrResourceInactive      = errors.New("resource is not active")
	ErrNotBreakglassEligible = errors.New("resource has no break-glass credential configured")
	ErrNotRequestOwner       = errors.New("only the requester may perform this operation")
	ErrBreakglassNotReady    = errors.New("break-glass waiting period has not elapsed")
)

// JITService owns the request/approve/grant/revoke lifecycle.
type JITService struct {
	db     *gorm.DB
	audit  *AuditService
	res    *ResourceService
	iam    *iamclient.Client
	cfg    config.JITConfig
	logger *zap.Logger

	// notify is OPTIONAL and set after construction (SetNotifier), because the
	// notification service is built later in main.go and neither service may
	// depend on the other's constructor. Nil is a supported state: every use
	// goes through s.tell, which is a no-op without it, so the lifecycle this
	// file owns never depends on a notification being deliverable.
	//
	// The sweeper is why this exists at all. Grants expiring and requests
	// timing out are the two state changes NOBODY triggers: there is no HTTP
	// handler to hang a notification off, so without this the affected person
	// only finds out by trying to connect and failing.
	notify *NotificationService
}

// SetNotifier attaches the notification centre. Safe to skip entirely.
func (s *JITService) SetNotifier(n *NotificationService) { s.notify = n }

// tell delivers one notification if a notifier is attached, and does nothing
// at all if one is not.
func (s *JITService) tell(in NotifyInput, userIDs ...string) {
	if s.notify == nil {
		return
	}
	s.notify.Deliver(in, userIDs...)
}

// Notify is tell, exported for the handlers that already hold this service and
// would otherwise need the notification service threaded through their own
// constructor for a single call. Same nil-safe contract.
func (s *JITService) Notify(in NotifyInput, userIDs ...string) { s.tell(in, userIDs...) }

func NewJITService(
	db *gorm.DB,
	audit *AuditService,
	res *ResourceService,
	iam *iamclient.Client,
	cfg config.JITConfig,
	logger *zap.Logger,
) *JITService {
	return &JITService{db: db, audit: audit, res: res, iam: iam, cfg: cfg, logger: logger}
}

// Config exposes the effective JIT settings (used by handlers for hints).
func (s *JITService) Config() config.JITConfig { return s.cfg }

// ──────────────────────────────────────────────────────────────────────────
// INPUTS
// ──────────────────────────────────────────────────────────────────────────

// CreateRequestInput is the payload for a standard or break-glass request.
type CreateRequestInput struct {
	RequesterUserID   string
	RequesterUsername string
	ResourceID        string
	Action            string
	DurationMinutes   int
	Reason            string
	TicketRef         string
	SourceIP          string
	UserAgent         string
	AuthzDecisionID   string
	IdempotencyKey    string
}

// DecisionInput is an approve/deny payload.
type DecisionInput struct {
	RequestID        string
	ApproverUserID   string
	ApproverUsername string
	Reason           string
	SourceIP         string
	UserAgent        string

	// ApproverRoles is the approver's role names, used only to decide whether
	// this approval is final on its own (root) or needs a second person
	// (admin). Passed in rather than re-resolved here because the caller has
	// already authenticated and loaded them; re-reading would be a second
	// source of truth for the same fact.
	ApproverRoles []string
}

// approverRank maps the approver's roles to the rank recorded on the decision
// row, so an auditor can see WHY a lone approval was final — because it was
// root, not because quorum miscounted.
func approverRank(roles []string) int {
	best := 0
	for _, r := range roles {
		if got := RoleRank(r); got > best {
			best = got
		}
	}
	return best
}

// approvalQuorumTx answers "is this request approved yet" from the decision
// trail alone.
//
// The rule, in one place:
//   - any ROOT approval is final on its own, and
//   - otherwise two DISTINCT approvers are required.
//
// Distinctness is enforced by counting DISTINCT approver ids rather than rows,
// so even if a duplicate row were ever written it could not manufacture a
// quorum by itself.
func (s *JITService) approvalQuorumTx(tx *gorm.DB, requestID string) (bool, int64, error) {
	var rootApprovals int64
	if err := tx.Model(&models.JITApproval{}).
		Where("request_id = ? AND decision = ? AND approver_rank >= ?",
			requestID, models.JITApprovalDecisionApproved, models.JITApproverRankRoot).
		Count(&rootApprovals).Error; err != nil {
		return false, 0, err
	}

	var distinct int64
	if err := tx.Model(&models.JITApproval{}).
		Where("request_id = ? AND decision = ?", requestID, models.JITApprovalDecisionApproved).
		Distinct("approver_user_id").
		Count(&distinct).Error; err != nil {
		return false, 0, err
	}

	return rootApprovals > 0 || distinct >= 2, distinct, nil
}

// RequestFilter drives read queries for both the user view and the IAM console.
type RequestFilter struct {
	RequesterUserID string
	Status          string
	RequestType     string
	ResourceID      string
	Search          string
	Page            int
	PageSize        int
}

// GrantFilter drives grant read queries.
type GrantFilter struct {
	UserID       string
	ResourceID   string
	Status       string
	IsBreakglass *bool
	ActiveOnly   bool
	Page         int
	PageSize     int
}

// ──────────────────────────────────────────────────────────────────────────
// CREATE (standard JIT request)
// ──────────────────────────────────────────────────────────────────────────

// CreateRequest stores a PENDING JIT request for an approver to action.
func (s *JITService) CreateRequest(ctx context.Context, in CreateRequestInput) (*models.JITRequest, error) {
	return s.createRequest(ctx, in, false)
}

// RequestBreakglass stores a WAITING emergency request. No approver is needed,
// but the grant only activates after the mandatory cooling-off period so a
// human still has time to intervene.
func (s *JITService) RequestBreakglass(ctx context.Context, in CreateRequestInput) (*models.JITRequest, error) {
	return s.createRequest(ctx, in, true)
}

func (s *JITService) createRequest(ctx context.Context, in CreateRequestInput, breakglass bool) (*models.JITRequest, error) {
	in.Reason = strings.TrimSpace(in.Reason)
	if len(in.Reason) < s.cfg.MinReasonLength {
		return nil, fmt.Errorf("%w (minimum %d characters)", ErrReasonTooShort, s.cfg.MinReasonLength)
	}
	if in.Action == "" {
		in.Action = "pam:resource:Connect"
	}

	maxDuration := s.cfg.MaxDurationMin
	if breakglass {
		maxDuration = s.cfg.BreakglassMaxDurationMin
	}
	if in.DurationMinutes <= 0 {
		in.DurationMinutes = s.cfg.DefaultDurationMin
	}
	if in.DurationMinutes > maxDuration {
		return nil, fmt.Errorf("%w (max %d minutes)", ErrDurationExceeded, maxDuration)
	}

	// Idempotency: replay of the same key by the same user returns the original.
	if in.IdempotencyKey != "" {
		var existing models.JITRequest
		err := s.db.Where("idempotency_key = ?", in.IdempotencyKey).First(&existing).Error
		if err == nil {
			if existing.RequesterUserID != in.RequesterUserID {
				return nil, ErrNotRequestOwner
			}
			return &existing, nil
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, err
		}
	}

	resource, err := s.res.GetResource(in.ResourceID)
	if err != nil {
		return nil, err
	}
	if !resource.IsActive {
		return nil, ErrResourceInactive
	}

	if breakglass {
		ok, err := s.hasBreakglassCredential(in.ResourceID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, ErrNotBreakglassEligible
		}
	}

	// Reject duplicates: an open request or a live grant already covers this.
	if dup, err := s.hasOpenRequestOrGrant(in.RequesterUserID, in.ResourceID); err != nil {
		return nil, err
	} else if dup {
		return nil, ErrDuplicateRequest
	}

	now := time.Now().UTC()
	req := &models.JITRequest{
		RequestType:       models.JITTypeStandard,
		RequesterUserID:   in.RequesterUserID,
		RequesterUsername: in.RequesterUsername,
		ResourceID:        resource.ID,
		ResourceName:      resource.Name,
		ResourceType:      resource.ResourceType,
		Action:            in.Action,
		DurationMinutes:   in.DurationMinutes,
		Reason:            in.Reason,
		TicketRef:         in.TicketRef,
		Status:            models.JITStatusPending,
		SourceIP:          in.SourceIP,
		UserAgent:         truncateStr(in.UserAgent, 512),
		RequestedAt:       now,
		RequestExpiresAt:  now.Add(time.Duration(s.cfg.RequestTTLMin) * time.Minute),
	}
	if in.IdempotencyKey != "" {
		key := in.IdempotencyKey
		req.IdempotencyKey = &key
	}
	if in.AuthzDecisionID != "" {
		d := in.AuthzDecisionID
		req.AuthzDecisionID = &d
	}

	auditAction := models.AuditJITRequested
	severity := models.AuditSeverityInfo

	if breakglass {
		availableAt := now.Add(time.Duration(s.cfg.BreakglassWaitMin) * time.Minute)
		req.RequestType = models.JITTypeBreakglass
		req.Status = models.JITStatusWaiting
		req.AvailableAt = &availableAt
		// The emergency request must be activated within the activation window,
		// otherwise it expires unused (prevents "pre-armed" standing access).
		req.RequestExpiresAt = availableAt.Add(time.Duration(s.cfg.BreakglassActivationWindowMin) * time.Minute)
		auditAction = models.AuditBreakglassRequested
		severity = models.AuditSeverityCritical
	}

	err = s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(req).Error; err != nil {
			return err
		}
		return s.audit.WriteTx(tx, AuditEntry{
			ActorUserID:     in.RequesterUserID,
			ActorUsername:   in.RequesterUsername,
			Action:          auditAction,
			Severity:        severity,
			ResourceType:    resource.ResourceType,
			ResourceID:      resource.ID,
			ResourceName:    resource.Name,
			RequestID:       req.ID,
			SourceIP:        in.SourceIP,
			UserAgent:       in.UserAgent,
			AuthzDecisionID: in.AuthzDecisionID,
			Details: map[string]interface{}{
				"request_type":     req.RequestType,
				"duration_minutes": req.DurationMinutes,
				"reason":           req.Reason,
				"ticket_ref":       req.TicketRef,
				"available_at":     req.AvailableAt,
				"action":           req.Action,
			},
		})
	})
	if err != nil {
		return nil, err
	}

	s.logger.Info("jit.request.created",
		zap.String("request_id", req.ID),
		zap.String("type", req.RequestType),
		zap.String("user", req.RequesterUsername),
		zap.String("resource", resource.Name),
		zap.Int("duration_min", req.DurationMinutes),
	)

	if breakglass {
		// CRITICAL alert must go out immediately — this is the whole point of
		// the waiting period: give a human a chance to intervene.
		s.sendAlert(ctx, iamclient.Alert{
			Severity:  models.AuditSeverityCritical,
			Event:     models.AuditBreakglassRequested,
			Message:   fmt.Sprintf("Break-glass access requested by %s for %s", req.RequesterUsername, resource.Name),
			UserID:    req.RequesterUserID,
			RequestID: req.ID,
			Metadata: map[string]string{
				"resource_id":   resource.ID,
				"resource_name": resource.Name,
				"reason":        req.Reason,
				"available_at":  req.AvailableAt.Format(time.RFC3339),
				"wait_minutes":  fmt.Sprintf("%d", s.cfg.BreakglassWaitMin),
			},
		})
	}
	return req, nil
}

// ──────────────────────────────────────────────────────────────────────────
// APPROVE / DENY / CANCEL
// ──────────────────────────────────────────────────────────────────────────

// Approve transitions PENDING → APPROVED and issues the time-boxed grant.
// Both the request update, the grant insert and the audit row commit atomically.
func (s *JITService) Approve(ctx context.Context, in DecisionInput) (*models.JITRequest, *models.AccessGrant, error) {
	var req models.JITRequest
	var grant models.AccessGrant

	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", in.RequestID).First(&req).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrJITNotFound
			}
			return err
		}
		// PARTIALLY_APPROVED is as valid an entry state as PENDING: it is
		// precisely the request that is waiting for its second approver.
		//
		// WAITING is deliberately excluded. That is break-glass, which has no
		// approvers at all by design — it is controlled by a mandatory waiting
		// period, a CRITICAL alert and forced recording instead. Letting an
		// approval land on it would quietly convert an emergency path into an
		// approved one and skip the wait.
		if req.Status != models.JITStatusPending && req.Status != models.JITStatusPartiallyApproved {
			return fmt.Errorf("%w (current status %s)", ErrInvalidState, req.Status)
		}
		if time.Now().UTC().After(req.RequestExpiresAt) {
			return fmt.Errorf("%w (request expired at %s)", ErrInvalidState, req.RequestExpiresAt.Format(time.RFC3339))
		}
		if s.cfg.RequireSeparationOfDuty && req.RequesterUserID == in.ApproverUserID {
			return ErrSelfApproval
		}

		now := time.Now().UTC()

		// ── Four-eyes (dual control) ──────────────────────────────────────
		//
		// Quorum is DERIVED from the decision rows, never stored as a counter
		// on the request: a counter can drift from the trail it summarises,
		// and the rule (2 admins, or 1 root) then has nowhere honest to live.
		//
		// The row is written FIRST and the quorum computed from what is then
		// in the table, so the decision that authorises the grant is the same
		// data an auditor reads back. The SELECT ... FOR UPDATE on the request
		// above serialises concurrent approvals of the same request, which is
		// what stops two simultaneous first-approvals from both counting
		// themselves as the second.
		rank := approverRank(in.ApproverRoles)

		var already int64
		if err := tx.Model(&models.JITApproval{}).
			Where("request_id = ? AND approver_user_id = ? AND decision = ?",
				req.ID, in.ApproverUserID, models.JITApprovalDecisionApproved).
			Count(&already).Error; err != nil {
			return err
		}
		if already > 0 {
			return ErrDuplicateApprover
		}

		if err := tx.Create(&models.JITApproval{
			RequestID:        req.ID,
			ApproverUserID:   in.ApproverUserID,
			ApproverUsername: in.ApproverUsername,
			ApproverRank:     rank,
			Decision:         models.JITApprovalDecisionApproved,
			Reason:           in.Reason,
			SourceIP:         in.SourceIP,
			UserAgent:        in.UserAgent,
		}).Error; err != nil {
			return err
		}

		quorumMet, approvals, err := s.approvalQuorumTx(tx, req.ID)
		if err != nil {
			return err
		}

		if !quorumMet {
			// One admin has approved. No grant is issued and nothing is
			// entitled yet — the request simply moves to the state that says
			// "waiting on a second, different approver".
			req.Status = models.JITStatusPartiallyApproved
			if err := tx.Model(&models.JITRequest{}).Where("id = ?", req.ID).
				Update("status", req.Status).Error; err != nil {
				return err
			}
			return s.audit.WriteTx(tx, AuditEntry{
				ActorUserID:   in.ApproverUserID,
				ActorUsername: in.ApproverUsername,
				Action:        models.AuditJITApproved,
				Severity:      models.AuditSeverityInfo,
				ResourceType:  req.ResourceType,
				ResourceID:    req.ResourceID,
				ResourceName:  req.ResourceName,
				RequestID:     req.ID,
				SourceIP:      in.SourceIP,
				UserAgent:     in.UserAgent,
				Details: map[string]interface{}{
					"requester":      req.RequesterUsername,
					"four_eyes":      "partial",
					"approvals":      approvals,
					"approver_rank":  rank,
					"grant_issued":   false,
					"outcome_status": req.Status,
				},
			})
		}

		g, err := s.issueGrantTx(tx, &req, now, false)
		if err != nil {
			return err
		}
		grant = *g

		req.Status = models.JITStatusApproved
		req.DecidedAt = &now
		req.ApproverUserID = &in.ApproverUserID
		req.ApproverUsername = &in.ApproverUsername
		req.DecisionReason = in.Reason
		req.GrantID = &grant.ID

		if err := tx.Model(&models.JITRequest{}).Where("id = ?", req.ID).Updates(map[string]interface{}{
			"status":            req.Status,
			"decided_at":        req.DecidedAt,
			"approver_user_id":  req.ApproverUserID,
			"approver_username": req.ApproverUsername,
			"decision_reason":   req.DecisionReason,
			"grant_id":          req.GrantID,
		}).Error; err != nil {
			return err
		}

		return s.audit.WriteTx(tx, AuditEntry{
			ActorUserID:   in.ApproverUserID,
			ActorUsername: in.ApproverUsername,
			Action:        models.AuditJITApproved,
			Severity:      models.AuditSeverityWarn,
			ResourceType:  req.ResourceType,
			ResourceID:    req.ResourceID,
			ResourceName:  req.ResourceName,
			RequestID:     req.ID,
			GrantID:       grant.ID,
			SourceIP:      in.SourceIP,
			UserAgent:     in.UserAgent,
			Details: map[string]interface{}{
				"requester":        req.RequesterUsername,
				"duration_minutes": req.DurationMinutes,
				"expires_at":       grant.ExpiresAt,
				"decision_reason":  in.Reason,
			},
		})
	})
	if err != nil {
		return nil, nil, err
	}

	// Four-eyes, first approval: quorum was not met, so no grant exists.
	// Return a NIL grant rather than the zero-valued struct — a zero
	// AccessGrant reads like a real one at a glance (it has an ID field, an
	// ExpiresAt, everything), and every caller that checks "did I get a grant"
	// by nil-ness would conclude access had been issued when nothing was.
	if req.Status == models.JITStatusPartiallyApproved {
		s.logger.Info("jit.request.partially_approved",
			zap.String("request_id", req.ID),
			zap.String("approver", in.ApproverUsername),
			zap.String("awaiting", "a second, different approver"),
		)
		return &req, nil, nil
	}

	s.logger.Info("jit.request.approved",
		zap.String("request_id", req.ID),
		zap.String("grant_id", grant.ID),
		zap.String("approver", in.ApproverUsername),
		zap.Time("expires_at", grant.ExpiresAt),
	)

	s.projectGrantToIAM(grant, req.Reason)
	return &req, &grant, nil
}

// Deny transitions PENDING → DENIED. No grant is created.
func (s *JITService) Deny(ctx context.Context, in DecisionInput) (*models.JITRequest, error) {
	var req models.JITRequest
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", in.RequestID).First(&req).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrJITNotFound
			}
			return err
		}
		if req.Status != models.JITStatusPending && req.Status != models.JITStatusWaiting {
			return fmt.Errorf("%w (current status %s)", ErrInvalidState, req.Status)
		}

		now := time.Now().UTC()
		req.Status = models.JITStatusDenied
		req.DecidedAt = &now
		req.ApproverUserID = &in.ApproverUserID
		req.ApproverUsername = &in.ApproverUsername
		req.DecisionReason = in.Reason

		if err := tx.Model(&models.JITRequest{}).Where("id = ?", req.ID).Updates(map[string]interface{}{
			"status":            req.Status,
			"decided_at":        req.DecidedAt,
			"approver_user_id":  req.ApproverUserID,
			"approver_username": req.ApproverUsername,
			"decision_reason":   req.DecisionReason,
		}).Error; err != nil {
			return err
		}

		severity := models.AuditSeverityInfo
		if req.RequestType == models.JITTypeBreakglass {
			// Cancelling an armed break-glass request is itself notable.
			severity = models.AuditSeverityCritical
		}
		return s.audit.WriteTx(tx, AuditEntry{
			ActorUserID:   in.ApproverUserID,
			ActorUsername: in.ApproverUsername,
			Action:        models.AuditJITDenied,
			Outcome:       models.AuditOutcomeDenied,
			Severity:      severity,
			ResourceType:  req.ResourceType,
			ResourceID:    req.ResourceID,
			ResourceName:  req.ResourceName,
			RequestID:     req.ID,
			SourceIP:      in.SourceIP,
			UserAgent:     in.UserAgent,
			Details: map[string]interface{}{
				"requester":       req.RequesterUsername,
				"request_type":    req.RequestType,
				"decision_reason": in.Reason,
			},
		})
	})
	if err != nil {
		return nil, err
	}
	s.logger.Info("jit.request.denied",
		zap.String("request_id", req.ID),
		zap.String("approver", in.ApproverUsername),
	)
	return &req, nil
}

// Cancel lets the requester withdraw their own open request.
func (s *JITService) Cancel(ctx context.Context, requestID, userID, username, reason, sourceIP string) (*models.JITRequest, error) {
	var req models.JITRequest
	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", requestID).First(&req).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrJITNotFound
			}
			return err
		}
		if req.RequesterUserID != userID {
			return ErrNotRequestOwner
		}
		if req.Status != models.JITStatusPending && req.Status != models.JITStatusWaiting {
			return fmt.Errorf("%w (current status %s)", ErrInvalidState, req.Status)
		}

		now := time.Now().UTC()
		req.Status = models.JITStatusCancelled
		req.DecidedAt = &now
		req.DecisionReason = reason

		if err := tx.Model(&models.JITRequest{}).Where("id = ?", req.ID).Updates(map[string]interface{}{
			"status":          req.Status,
			"decided_at":      req.DecidedAt,
			"decision_reason": req.DecisionReason,
		}).Error; err != nil {
			return err
		}
		return s.audit.WriteTx(tx, AuditEntry{
			ActorUserID:   userID,
			ActorUsername: username,
			Action:        models.AuditJITCancelled,
			ResourceType:  req.ResourceType,
			ResourceID:    req.ResourceID,
			ResourceName:  req.ResourceName,
			RequestID:     req.ID,
			SourceIP:      sourceIP,
			Details:       map[string]interface{}{"reason": reason, "request_type": req.RequestType},
		})
	})
	if err != nil {
		return nil, err
	}
	return &req, nil
}

// ──────────────────────────────────────────────────────────────────────────
// GRANTS
// ──────────────────────────────────────────────────────────────────────────

// issueGrantTx creates the ACTIVE grant row. Caller must hold the request lock.
func (s *JITService) issueGrantTx(tx *gorm.DB, req *models.JITRequest, now time.Time, breakglass bool) (*models.AccessGrant, error) {
	recording := breakglass
	if !recording {
		var resource models.PAMResource
		if err := tx.Where("id = ?", req.ResourceID).First(&resource).Error; err == nil {
			recording = resource.AlwaysRecord
		}
	}

	grant := &models.AccessGrant{
		RequestID:         req.ID,
		UserID:            req.RequesterUserID,
		Username:          req.RequesterUsername,
		ResourceID:        req.ResourceID,
		ResourceName:      req.ResourceName,
		Action:            req.Action,
		IsBreakglass:      breakglass,
		RecordingRequired: recording,
		Status:            models.GrantStatusActive,
		GrantedAt:         now,
		ExpiresAt:         now.Add(time.Duration(req.DurationMinutes) * time.Minute),
		IAMSyncStatus:     models.IAMSyncSkipped,
	}
	if s.iam != nil && s.iam.GrantConfigured() {
		grant.IAMSyncStatus = models.IAMSyncPending
	}
	if err := tx.Create(grant).Error; err != nil {
		return nil, err
	}

	if err := s.audit.WriteTx(tx, AuditEntry{
		ActorUserID:   req.RequesterUserID,
		ActorUsername: req.RequesterUsername,
		ActorType:     "SYSTEM",
		Action:        models.AuditGrantCreated,
		Severity:      severityFor(breakglass),
		ResourceType:  req.ResourceType,
		ResourceID:    req.ResourceID,
		ResourceName:  req.ResourceName,
		RequestID:     req.ID,
		GrantID:       grant.ID,
		Details: map[string]interface{}{
			"expires_at":         grant.ExpiresAt,
			"duration_minutes":   req.DurationMinutes,
			"is_breakglass":      breakglass,
			"recording_required": grant.RecordingRequired,
			"action":             grant.Action,
		},
	}); err != nil {
		return nil, err
	}
	return grant, nil
}

// ActiveGrantFor returns the usable grant for (user, resource), if any.
// This is the hot path called by the RequireActiveGrant PEP middleware — it is
// deliberately NOT cached so revocation takes effect on the very next request.
func (s *JITService) ActiveGrantFor(userID, resourceID string) (*models.AccessGrant, error) {
	now := time.Now().UTC()
	var grant models.AccessGrant
	err := s.db.
		Where("user_id = ? AND resource_id = ? AND status = ? AND expires_at > ?",
			userID, resourceID, models.GrantStatusActive, now).
		Order("expires_at DESC").
		First(&grant).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrGrantNotFound
		}
		return nil, err
	}
	return &grant, nil
}

// GetGrant fetches one grant by id.
func (s *JITService) GetGrant(id string) (*models.AccessGrant, error) {
	var g models.AccessGrant
	if err := s.db.Where("id = ?", id).First(&g).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrGrantNotFound
		}
		return nil, err
	}
	return &g, nil
}

// RevokeGrant immediately terminates a grant and kills its live sessions.
func (s *JITService) RevokeGrant(ctx context.Context, grantID, revokedBy, revokedByName, reason, sourceIP string) (*models.AccessGrant, int, error) {
	var grant models.AccessGrant
	killed := 0

	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("id = ?", grantID).First(&grant).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return ErrGrantNotFound
			}
			return err
		}
		if grant.Status != models.GrantStatusActive {
			return fmt.Errorf("%w (grant already %s)", ErrInvalidState, grant.Status)
		}

		now := time.Now().UTC()
		n, err := s.res.KillSessionsByGrantTx(tx, grant.ID, revokedBy, "access grant revoked: "+reason)
		if err != nil {
			return err
		}
		killed = n

		if err := tx.Model(&models.AccessGrant{}).Where("id = ?", grant.ID).Updates(map[string]interface{}{
			"status":          models.GrantStatusRevoked,
			"revoked_at":      now,
			"revoked_by":      revokedBy,
			"revoke_reason":   reason,
			"sessions_killed": killed,
		}).Error; err != nil {
			return err
		}
		grant.Status = models.GrantStatusRevoked
		grant.RevokedAt = &now
		grant.RevokedBy = &revokedBy
		grant.RevokeReason = reason
		grant.SessionsKille = killed

		return s.audit.WriteTx(tx, AuditEntry{
			ActorUserID:   revokedBy,
			ActorUsername: revokedByName,
			Action:        models.AuditGrantRevoked,
			Severity:      models.AuditSeverityCritical,
			ResourceID:    grant.ResourceID,
			ResourceName:  grant.ResourceName,
			RequestID:     grant.RequestID,
			GrantID:       grant.ID,
			SourceIP:      sourceIP,
			Details: map[string]interface{}{
				"revoked_from":    grant.Username,
				"reason":          reason,
				"sessions_killed": killed,
				"was_breakglass":  grant.IsBreakglass,
			},
		})
	})
	if err != nil {
		return nil, 0, err
	}

	s.afterGrantTerminated(grant, "revoked")
	s.logger.Warn("jit.grant.revoked",
		zap.String("grant_id", grant.ID),
		zap.String("by", revokedByName),
		zap.Int("sessions_killed", killed),
	)
	return &grant, killed, nil
}

// ──────────────────────────────────────────────────────────────────────────
// SWEEPER JOBS (auto-revoke)
// ──────────────────────────────────────────────────────────────────────────

// SweepResult reports what one sweeper pass did.
type SweepResult struct {
	GrantsExpired            int `json:"grants_expired"`
	SessionsKilled           int `json:"sessions_killed"`
	RequestsExpired          int `json:"requests_expired"`
	BreakglassActivated      int `json:"breakglass_activated"`
	OrphanedRecordingsFailed int `json:"orphaned_recordings_failed"`
	Errors                   int `json:"errors"`

	// ReconciledByName counts what each registered Sweeper.ExpiryReconciler
	// closed this pass, keyed by its Name() — e.g. {"webproxy": 3} for three
	// brokered web sessions that expired or went idle. A map rather than
	// more named fields so a new subsystem can be swept without changing
	// this struct.
	ReconciledByName map[string]int `json:"reconciled_by_name,omitempty"`
}

// ExpireDueGrants flips ACTIVE grants past expires_at to EXPIRED and kills any
// sessions still open under them.
//
// Rows are locked FOR UPDATE SKIP LOCKED so several PAM replicas can run the
// sweeper concurrently without processing the same grant twice.
func (s *JITService) ExpireDueGrants(ctx context.Context) (expired int, sessionsKilled int, errCount int) {
	now := time.Now().UTC()
	var due []models.AccessGrant

	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).
			Where("status = ? AND expires_at <= ?", models.GrantStatusActive, now).
			Order("expires_at ASC").
			Limit(s.cfg.SweepBatchSize).
			Find(&due).Error; err != nil {
			return err
		}
		for i := range due {
			g := due[i]
			killed, err := s.res.KillSessionsByGrantTx(tx, g.ID, "system", "access grant expired")
			if err != nil {
				errCount++
				s.logger.Error("jit.sweep.kill_sessions.fail", zap.String("grant_id", g.ID), zap.Error(err))
				return err
			}
			if err := tx.Model(&models.AccessGrant{}).Where("id = ?", g.ID).Updates(map[string]interface{}{
				"status":          models.GrantStatusExpired,
				"sessions_killed": gorm.Expr("sessions_killed + ?", killed),
			}).Error; err != nil {
				return err
			}
			if err := s.audit.WriteTx(tx, AuditEntry{
				ActorUserID:   g.UserID,
				ActorUsername: g.Username,
				ActorType:     "SYSTEM",
				Action:        models.AuditGrantExpired,
				Severity:      severityFor(g.IsBreakglass),
				ResourceID:    g.ResourceID,
				ResourceName:  g.ResourceName,
				RequestID:     g.RequestID,
				GrantID:       g.ID,
				Details: map[string]interface{}{
					"expired_at":      g.ExpiresAt,
					"sessions_killed": killed,
					"was_breakglass":  g.IsBreakglass,
				},
			}); err != nil {
				return err
			}
			expired++
			sessionsKilled += killed
		}
		return nil
	})
	if err != nil {
		s.logger.Error("jit.sweep.expire_grants.fail", zap.Error(err))
		return 0, 0, errCount + 1
	}

	// Post-commit side effects (IAM detach, cache invalidation, break-glass report).
	for i := range due {
		g := due[i]
		g.Status = models.GrantStatusExpired
		s.afterGrantTerminated(g, "expired")
		s.tell(NotifyInput{
			Category:   models.NotifyCategoryAccess,
			Severity:   models.NotifySeverityInfo,
			Title:      "Access expired",
			Body:       "Your time-boxed access to " + g.ResourceName + " has ended. Request it again if you still need it.",
			Link:       "/jit",
			EntityType: "access_grant",
			EntityID:   g.ID,
			DedupeKey:  "grant.expired." + g.ID,
		}, g.UserID)
	}
	return expired, sessionsKilled, errCount
}

// ExpireStaleRequests closes PENDING/WAITING requests whose TTL elapsed.
func (s *JITService) ExpireStaleRequests(ctx context.Context) (int, int) {
	now := time.Now().UTC()
	var stale []models.JITRequest
	errCount := 0

	err := s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).
			Where("status IN ? AND request_expires_at <= ?",
				[]string{models.JITStatusPending, models.JITStatusWaiting}, now).
			Limit(s.cfg.SweepBatchSize).
			Find(&stale).Error; err != nil {
			return err
		}
		for i := range stale {
			r := stale[i]
			if err := tx.Model(&models.JITRequest{}).Where("id = ?", r.ID).Updates(map[string]interface{}{
				"status":     models.JITStatusExpired,
				"decided_at": now,
			}).Error; err != nil {
				return err
			}
			if err := s.audit.WriteTx(tx, AuditEntry{
				ActorUserID:   r.RequesterUserID,
				ActorUsername: r.RequesterUsername,
				ActorType:     "SYSTEM",
				Action:        models.AuditJITExpired,
				Outcome:       models.AuditOutcomeFailure,
				Severity:      severityFor(r.RequestType == models.JITTypeBreakglass),
				ResourceType:  r.ResourceType,
				ResourceID:    r.ResourceID,
				ResourceName:  r.ResourceName,
				RequestID:     r.ID,
				Details: map[string]interface{}{
					"request_type":  r.RequestType,
					"expired_at":    r.RequestExpiresAt,
					"never_decided": true,
				},
			}); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		s.logger.Error("jit.sweep.expire_requests.fail", zap.Error(err))
		return 0, errCount + 1
	}

	// After the commit, never inside it: a notification write must not be able
	// to roll back an expiry that has already been audited.
	for i := range stale {
		r := stale[i]
		s.tell(NotifyInput{
			Category:   models.NotifyCategoryRequest,
			Severity:   models.NotifySeverityWarning,
			Title:      "Access request expired",
			Body:       "Your request for " + r.ResourceName + " timed out before anyone decided it. Raise it again if you still need access.",
			Link:       "/jit",
			EntityType: "jit_request",
			EntityID:   r.ID,
			DedupeKey:  "jit.timeout." + r.ID,
		}, r.RequesterUserID)
	}
	return len(stale), errCount
}

// ActivateDueBreakglass promotes WAITING emergency requests whose cooling-off
// period has elapsed into APPROVED requests with an ACTIVE grant.
func (s *JITService) ActivateDueBreakglass(ctx context.Context) (int, int) {
	now := time.Now().UTC()
	type activated struct {
		req   models.JITRequest
		grant models.AccessGrant
	}
	var out []activated
	errCount := 0

	err := s.db.Transaction(func(tx *gorm.DB) error {
		var due []models.JITRequest
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).
			Where("status = ? AND request_type = ? AND available_at IS NOT NULL AND available_at <= ? AND request_expires_at > ?",
				models.JITStatusWaiting, models.JITTypeBreakglass, now, now).
			Limit(s.cfg.SweepBatchSize).
			Find(&due).Error; err != nil {
			return err
		}
		for i := range due {
			r := due[i]
			g, err := s.issueGrantTx(tx, &r, now, true)
			if err != nil {
				return err
			}
			if err := tx.Model(&models.JITRequest{}).Where("id = ?", r.ID).Updates(map[string]interface{}{
				"status":            models.JITStatusApproved,
				"decided_at":        now,
				"approver_username": "SYSTEM (break-glass auto-activation)",
				"decision_reason":   "break-glass waiting period elapsed with no intervention",
				"grant_id":          g.ID,
			}).Error; err != nil {
				return err
			}
			if err := s.audit.WriteTx(tx, AuditEntry{
				ActorUserID:   r.RequesterUserID,
				ActorUsername: r.RequesterUsername,
				ActorType:     "SYSTEM",
				Action:        models.AuditBreakglassActivated,
				Severity:      models.AuditSeverityCritical,
				ResourceType:  r.ResourceType,
				ResourceID:    r.ResourceID,
				ResourceName:  r.ResourceName,
				RequestID:     r.ID,
				GrantID:       g.ID,
				Details: map[string]interface{}{
					"waited_minutes": s.cfg.BreakglassWaitMin,
					"expires_at":     g.ExpiresAt,
					"reason":         r.Reason,
					"recording":      g.RecordingRequired,
				},
			}); err != nil {
				return err
			}
			r.Status = models.JITStatusApproved
			out = append(out, activated{req: r, grant: *g})
		}
		return nil
	})
	if err != nil {
		s.logger.Error("jit.sweep.activate_breakglass.fail", zap.Error(err))
		return 0, errCount + 1
	}

	for _, a := range out {
		s.logger.Warn("breakglass.activated",
			zap.String("request_id", a.req.ID),
			zap.String("grant_id", a.grant.ID),
			zap.String("user", a.req.RequesterUsername),
			zap.String("resource", a.req.ResourceName),
			zap.Time("expires_at", a.grant.ExpiresAt),
		)
		s.sendAlert(ctx, iamclient.Alert{
			Severity:  models.AuditSeverityCritical,
			Event:     models.AuditBreakglassActivated,
			Message:   fmt.Sprintf("BREAK-GLASS ACTIVE: %s now has emergency access to %s", a.req.RequesterUsername, a.req.ResourceName),
			UserID:    a.req.RequesterUserID,
			RequestID: a.req.ID,
			GrantID:   a.grant.ID,
			Metadata: map[string]string{
				"resource_id": a.req.ResourceID,
				"expires_at":  a.grant.ExpiresAt.Format(time.RFC3339),
				"recording":   fmt.Sprintf("%t", a.grant.RecordingRequired),
			},
		})
		s.projectGrantToIAM(a.grant, a.req.Reason)
		s.tell(NotifyInput{
			Category:   models.NotifyCategoryAccess,
			Severity:   models.NotifySeverityCritical,
			Title:      "Break-glass access is now active",
			Body:       "Emergency access to " + a.req.ResourceName + " activated. Every action is recorded and reported.",
			Link:       "/jit",
			EntityType: "access_grant",
			EntityID:   a.grant.ID,
			DedupeKey:  "grant.breakglass.active." + a.grant.ID,
		}, a.req.RequesterUserID)
	}
	return len(out), errCount
}

// ──────────────────────────────────────────────────────────────────────────
// POST-COMMIT SIDE EFFECTS
// ──────────────────────────────────────────────────────────────────────────

// projectGrantToIAM pushes the temporary policy attachment to IAM out of band.
// Failure is recorded on the grant row (iam_sync_status = FAILED) and audited,
// but never blocks or reverses PAM-side enforcement.
func (s *JITService) projectGrantToIAM(grant models.AccessGrant, reason string) {
	if s.iam == nil || !s.iam.GrantConfigured() {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()

		resp, err := s.iam.PushGrant(ctx, iamclient.GrantRequest{
			GrantID:      grant.ID,
			UserID:       grant.UserID,
			Action:       grant.Action,
			ResourceARN:  fmt.Sprintf("pam:resource/%s", grant.ResourceID),
			ExpiresAt:    grant.ExpiresAt,
			Reason:       reason,
			IsBreakglass: grant.IsBreakglass,
			RequestID:    grant.RequestID,
		})

		updates := map[string]interface{}{}
		outcome := models.AuditOutcomeSuccess
		detail := map[string]interface{}{"grant_id": grant.ID}

		if err != nil {
			updates["iam_sync_status"] = models.IAMSyncFailed
			updates["iam_sync_error"] = truncateStr(err.Error(), 900)
			outcome = models.AuditOutcomeFailure
			detail["error"] = err.Error()
			s.logger.Error("jit.grant.iam_sync.fail", zap.String("grant_id", grant.ID), zap.Error(err))
		} else {
			updates["iam_sync_status"] = models.IAMSyncSynced
			updates["iam_sync_error"] = ""
			if resp != nil && resp.Data.PolicyID != "" {
				updates["iam_policy_id"] = resp.Data.PolicyID
				detail["iam_policy_id"] = resp.Data.PolicyID
			}
		}

		if err := s.db.Model(&models.AccessGrant{}).Where("id = ?", grant.ID).
			Updates(updates).Error; err != nil {
			s.logger.Error("jit.grant.iam_sync.persist.fail", zap.String("grant_id", grant.ID), zap.Error(err))
		}

		s.audit.Write(AuditEntry{
			ActorType:     "SYSTEM",
			ActorUserID:   grant.UserID,
			ActorUsername: grant.Username,
			Action:        models.AuditGrantIAMSync,
			Outcome:       outcome,
			Severity:      severityFor(outcome == models.AuditOutcomeFailure),
			ResourceID:    grant.ResourceID,
			ResourceName:  grant.ResourceName,
			RequestID:     grant.RequestID,
			GrantID:       grant.ID,
			Details:       detail,
		})
	}()
}

// afterGrantTerminated performs the non-transactional cleanup that follows a
// grant ending: drop cached ALLOW decisions, detach the IAM policy, and for
// break-glass, generate the mandatory emergency-access report.
func (s *JITService) afterGrantTerminated(grant models.AccessGrant, how string) {
	if s.iam != nil {
		s.iam.InvalidateUser(grant.UserID)
	}

	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()

		if s.iam != nil && s.iam.RevokeConfigured() {
			if err := s.iam.RevokeGrant(ctx, grant.ID); err != nil && !errors.Is(err, iamclient.ErrNotConfigured) {
				s.logger.Error("jit.grant.iam_revoke.fail", zap.String("grant_id", grant.ID), zap.Error(err))
				s.db.Model(&models.AccessGrant{}).Where("id = ?", grant.ID).Updates(map[string]interface{}{
					"iam_sync_status": models.IAMSyncFailed,
					"iam_sync_error":  truncateStr("revoke: "+err.Error(), 900),
				})
			}
		}

		if grant.IsBreakglass {
			report, err := s.BuildBreakglassReport(grant.ID)
			if err != nil {
				s.logger.Error("breakglass.report.fail", zap.String("grant_id", grant.ID), zap.Error(err))
				return
			}
			s.audit.Write(AuditEntry{
				ActorType:     "SYSTEM",
				ActorUserID:   grant.UserID,
				ActorUsername: grant.Username,
				Action:        models.AuditBreakglassReportBuilt,
				Severity:      models.AuditSeverityCritical,
				ResourceID:    grant.ResourceID,
				ResourceName:  grant.ResourceName,
				RequestID:     grant.RequestID,
				GrantID:       grant.ID,
				Details: map[string]interface{}{
					"terminated_by":       how,
					"sessions":            len(report.Sessions),
					"recordings":          len(report.Recordings),
					"audit_events":        len(report.AuditTrail),
					"granted_at":          report.Grant.GrantedAt,
					"ended_at":            report.EndedAt,
					"access_seconds":      report.AccessSeconds,
					"recording_satisfied": report.RecordingSatisfied,
				},
			})
			s.sendAlert(ctx, iamclient.Alert{
				Severity: models.AuditSeverityCritical,
				Event:    models.AuditBreakglassReportBuilt,
				Message: fmt.Sprintf("Break-glass access by %s on %s has ended (%s). Emergency report generated.",
					grant.Username, grant.ResourceName, how),
				UserID:    grant.UserID,
				RequestID: grant.RequestID,
				GrantID:   grant.ID,
			})
		}
	}()
}

func (s *JITService) sendAlert(ctx context.Context, a iamclient.Alert) {
	if s.iam == nil || !s.iam.AlertConfigured() {
		// No alert sink configured — the CRITICAL audit row and the WARN log
		// line remain the record of the event.
		s.logger.Warn("iam.alert.not_configured",
			zap.String("event", a.Event),
			zap.String("message", a.Message),
		)
		return
	}
	if err := s.iam.SendAlert(ctx, a); err != nil && !errors.Is(err, iamclient.ErrNotConfigured) {
		s.logger.Error("iam.alert.fail", zap.String("event", a.Event), zap.Error(err))
	}
}

// ──────────────────────────────────────────────────────────────────────────
// READ QUERIES
// ──────────────────────────────────────────────────────────────────────────

// GetRequest fetches one request by id.
func (s *JITService) GetRequest(id string) (*models.JITRequest, error) {
	var r models.JITRequest
	if err := s.db.Where("id = ?", id).First(&r).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrJITNotFound
		}
		return nil, err
	}
	return &r, nil
}

// ListRequests returns a filtered page of JIT requests plus the total count.
func (s *JITService) ListRequests(f RequestFilter) ([]models.JITRequest, int64, error) {
	page, size := normalisePaging(f.Page, f.PageSize)

	q := s.db.Model(&models.JITRequest{})
	if f.RequesterUserID != "" {
		q = q.Where("requester_user_id = ?", f.RequesterUserID)
	}
	if f.Status != "" {
		q = q.Where("status = ?", strings.ToUpper(f.Status))
	}
	if f.RequestType != "" {
		q = q.Where("request_type = ?", strings.ToUpper(f.RequestType))
	}
	if f.ResourceID != "" {
		q = q.Where("resource_id = ?", f.ResourceID)
	}
	if f.Search != "" {
		like := "%" + strings.ToLower(f.Search) + "%"
		q = q.Where("LOWER(requester_username) LIKE ? OR LOWER(resource_name) LIKE ? OR LOWER(reason) LIKE ? OR LOWER(ticket_ref) LIKE ?",
			like, like, like, like)
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []models.JITRequest
	err := q.Order("requested_at DESC").Limit(size).Offset((page - 1) * size).Find(&rows).Error
	return rows, total, err
}

// ListGrants returns a filtered page of grants plus the total count.
func (s *JITService) ListGrants(f GrantFilter) ([]models.AccessGrant, int64, error) {
	page, size := normalisePaging(f.Page, f.PageSize)

	q := s.db.Model(&models.AccessGrant{})
	if f.UserID != "" {
		q = q.Where("user_id = ?", f.UserID)
	}
	if f.ResourceID != "" {
		q = q.Where("resource_id = ?", f.ResourceID)
	}
	if f.Status != "" {
		q = q.Where("status = ?", strings.ToUpper(f.Status))
	}
	if f.IsBreakglass != nil {
		q = q.Where("is_breakglass = ?", *f.IsBreakglass)
	}
	if f.ActiveOnly {
		q = q.Where("status = ? AND expires_at > ?", models.GrantStatusActive, time.Now().UTC())
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []models.AccessGrant
	err := q.Order("granted_at DESC").Limit(size).Offset((page - 1) * size).Find(&rows).Error
	return rows, total, err
}

// PendingApprovalCount powers the IAM admin console badge.
func (s *JITService) PendingApprovalCount() (int64, error) {
	var n int64
	err := s.db.Model(&models.JITRequest{}).
		Where("status IN ?", []string{models.JITStatusPending, models.JITStatusWaiting}).
		Count(&n).Error
	return n, err
}

// ──────────────────────────────────────────────────────────────────────────
// BREAK-GLASS REPORT
// ──────────────────────────────────────────────────────────────────────────

// BreakglassReport is the auto-generated emergency-access report. It is the
// artefact an auditor asks for after any use of emergency access.
type BreakglassReport struct {
	GeneratedAt time.Time `json:"generated_at"`

	Request models.JITRequest  `json:"request"`
	Grant   models.AccessGrant `json:"grant"`

	WaitingPeriodMinutes int        `json:"waiting_period_minutes"`
	RequestedAt          time.Time  `json:"requested_at"`
	ActivatedAt          time.Time  `json:"activated_at"`
	EndedAt              *time.Time `json:"ended_at,omitempty"`
	AccessSeconds        int        `json:"access_seconds"`

	Sessions   []models.ConnectionSession `json:"sessions"`
	Recordings []models.SessionRecording  `json:"recordings"`
	AuditTrail []models.AuditLog          `json:"audit_trail"`

	RecordingSatisfied bool     `json:"recording_satisfied"`
	Findings           []string `json:"findings"`
}

// BuildBreakglassReport assembles the emergency-access report for a grant.
func (s *JITService) BuildBreakglassReport(grantID string) (*BreakglassReport, error) {
	grant, err := s.GetGrant(grantID)
	if err != nil {
		return nil, err
	}
	req, err := s.GetRequest(grant.RequestID)
	if err != nil {
		return nil, err
	}

	var sessions []models.ConnectionSession
	if err := s.db.Where("grant_id = ?", grant.ID).Order("started_at ASC").Find(&sessions).Error; err != nil {
		return nil, err
	}
	var recordings []models.SessionRecording
	if err := s.db.Where("grant_id = ?", grant.ID).Order("started_at ASC").Find(&recordings).Error; err != nil {
		return nil, err
	}
	var trail []models.AuditLog
	if err := s.db.Where("grant_id = ? OR request_id = ?", grant.ID, req.ID).
		Order("sequence_number ASC").Limit(1000).Find(&trail).Error; err != nil {
		return nil, err
	}

	endedAt := grant.RevokedAt
	if endedAt == nil && !grant.IsUsable(time.Now().UTC()) {
		e := grant.ExpiresAt
		endedAt = &e
	}
	accessSeconds := 0
	if endedAt != nil {
		accessSeconds = int(endedAt.Sub(grant.GrantedAt).Seconds())
	} else {
		accessSeconds = int(time.Now().UTC().Sub(grant.GrantedAt).Seconds())
	}
	if accessSeconds < 0 {
		accessSeconds = 0
	}

	rep := &BreakglassReport{
		GeneratedAt:          time.Now().UTC(),
		Request:              *req,
		Grant:                *grant,
		WaitingPeriodMinutes: s.cfg.BreakglassWaitMin,
		RequestedAt:          req.RequestedAt,
		ActivatedAt:          grant.GrantedAt,
		EndedAt:              endedAt,
		AccessSeconds:        accessSeconds,
		Sessions:             sessions,
		Recordings:           recordings,
		AuditTrail:           trail,
	}

	// Findings: things a reviewer must look at.
	rep.RecordingSatisfied = !grant.RecordingRequired || len(recordings) >= len(sessions)
	if grant.RecordingRequired && len(sessions) > 0 && len(recordings) == 0 {
		rep.Findings = append(rep.Findings, "Recording was mandatory but no recording metadata exists for the sessions opened under this grant.")
	}
	for i := range recordings {
		if recordings[i].Status != models.RecordingStatusCompleted {
			rep.Findings = append(rep.Findings,
				fmt.Sprintf("Recording %s is in status %s (not COMPLETED).", recordings[i].ID, recordings[i].Status))
		}
	}
	if len(sessions) == 0 {
		rep.Findings = append(rep.Findings, "Emergency access was granted but never used — review whether it was necessary.")
	}
	if req.AvailableAt != nil && grant.GrantedAt.Before(*req.AvailableAt) {
		rep.Findings = append(rep.Findings, "Grant activated before the configured waiting period elapsed — investigate.")
	}
	if grant.Status == models.GrantStatusRevoked {
		rep.Findings = append(rep.Findings, "Access was force-revoked before its natural expiry: "+grant.RevokeReason)
	}
	return rep, nil
}

// ──────────────────────────────────────────────────────────────────────────
// INTERNAL HELPERS
// ──────────────────────────────────────────────────────────────────────────

func (s *JITService) hasBreakglassCredential(resourceID string) (bool, error) {
	var n int64
	err := s.db.Model(&models.VaultEntry{}).
		Where("resource_id = ? AND is_breakglass = ?", resourceID, true).
		Count(&n).Error
	return n > 0, err
}

func (s *JITService) hasOpenRequestOrGrant(userID, resourceID string) (bool, error) {
	var open int64
	if err := s.db.Model(&models.JITRequest{}).
		Where("requester_user_id = ? AND resource_id = ? AND status IN ?",
			userID, resourceID, []string{models.JITStatusPending, models.JITStatusWaiting}).
		Count(&open).Error; err != nil {
		return false, err
	}
	if open > 0 {
		return true, nil
	}

	var live int64
	if err := s.db.Model(&models.AccessGrant{}).
		Where("user_id = ? AND resource_id = ? AND status = ? AND expires_at > ?",
			userID, resourceID, models.GrantStatusActive, time.Now().UTC()).
		Count(&live).Error; err != nil {
		return false, err
	}
	return live > 0, nil
}

func severityFor(critical bool) string {
	if critical {
		return models.AuditSeverityCritical
	}
	return models.AuditSeverityInfo
}

// normalisePaging clamps page/pageSize to safe bounds. Defensive duplicate of
// the same defaults handlers/jit_handler.go's pagingFrom applies at the HTTP
// layer (page >= 1, 1 <= size <= 200, default size 50) — kept here too since
// ListRequests/ListGrants/ListSessions/ListRecordings are also callable
// directly (e.g. from admin_handler.go's Stats, which passes PageSize: 1)
// without going through pagingFrom first.
func normalisePaging(page, size int) (int, int) {
	if page < 1 {
		page = 1
	}
	if size <= 0 {
		size = 50
	}
	if size > 200 {
		size = 200
	}
	return page, size
}

// truncateStr caps a string at max bytes, appending "..." if it was cut.
// Used to keep untrusted/free-form values (User-Agent headers, IAM sync
// error strings) from blowing past column limits. Defined here rather than
// reusing audit_report_service.go's own truncate() because that one has no
// ellipsis-on-cut behavior tuned for this use case and the two are
// independent helpers that happened to be named similarly across branches.
func truncateStr(s string, max int) string {
	if len(s) <= max {
		return s
	}
	if max <= 3 {
		return s[:max]
	}
	return s[:max-3] + "..."
}
