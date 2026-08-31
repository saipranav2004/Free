// pam/internal/services/session_service.go
//
// Grant-aware session lifecycle. These methods extend ResourceService rather
// than introducing a second service, so there is exactly one owner of
// pam_connection_sessions.
//
// Why this file exists: without a way to OPEN a tracked session, "auto-revoke
// kills active sessions" is untestable — there is nothing to kill. StartTracked
// binds a session to the grant that authorised it, which is what makes
// cascading revocation possible.
package services

import (
	"context"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/yourorg/pam/internal/models"
	"go.uber.org/zap"
	"gorm.io/gorm"
)

var (
	ErrSessionNotFound   = errors.New("session not found")
	ErrSessionNotOwned   = errors.New("session belongs to a different user")
	ErrRecordingNotFound = errors.New("recording not found")
)

// StartSessionInput opens a tracked connection session.
type StartSessionInput struct {
	UserID          string
	Username        string
	ResourceID      string
	SourceIP        string
	Protocol        string
	AuthzDecisionID string

	// Grant binding — set by the RequireActiveGrant middleware when the
	// resource is JIT-gated. Empty for resources that are not JIT-gated.
	GrantID           string
	JITRequestID      string
	IsBreakglass      bool
	RecordingRequired bool
}

// SessionFilter drives session read queries (user view and IAM console).
type SessionFilter struct {
	UserID       string
	ResourceID   string
	Status       string
	GrantID      string
	ActiveOnly   bool
	IsBreakglass *bool
	From         *time.Time
	To           *time.Time
	Search       string
	Page         int
	PageSize     int

	// ScopeResourceIDs confines the result to a set of resources, set from the
	// caller's delegated admin scope rather than from any request parameter.
	// Applied in the QUERY: filtering the returned page instead would leave
	// total and the pager describing rows the caller may not see.
	ScopeResourceIDs []string
}

// RecordingFilter drives recording metadata queries.
type RecordingFilter struct {
	UserID       string
	ResourceID   string
	SessionID    string
	GrantID      string
	Status       string
	IsBreakglass *bool
	Page         int
	PageSize     int

	// ScopeResourceIDs confines the result to a set of resources, set from the
	// caller's delegated admin scope rather than from any request parameter.
	// Applied in the QUERY: filtering the returned page instead would leave
	// total and the pager describing rows the caller may not see.
	ScopeResourceIDs []string
}

// StartTrackedSession creates the session record (and, when the grant mandates
// it, the recording obligation) in a single transaction.
func (s *ResourceService) StartTrackedSession(in StartSessionInput) (*models.ConnectionSession, *models.SessionRecording, error) {
	resource, err := s.GetResource(in.ResourceID)
	if err != nil {
		return nil, nil, err
	}
	if !resource.IsActive {
		return nil, nil, ErrResourceInactive
	}

	// A resource can force recording regardless of how access was granted.
	recordingRequired := in.RecordingRequired || resource.AlwaysRecord || in.IsBreakglass

	protocol := in.Protocol
	if protocol == "" {
		protocol = resource.ResourceType
	}

	allowed := true
	session := &models.ConnectionSession{
		UserID:            in.UserID,
		Username:          in.Username,
		ResourceID:        resource.ID,
		ResourceName:      resource.Name,
		ResourceType:      resource.ResourceType,
		Protocol:          protocol,
		SourceIP:          in.SourceIP,
		Status:            "ACTIVE",
		IsBreakglass:      in.IsBreakglass,
		RecordingRequired: recordingRequired,
		AuthzAllowed:      &allowed,
	}
	if in.AuthzDecisionID != "" {
		d := in.AuthzDecisionID
		session.AuthzDecisionID = &d
	}
	if in.GrantID != "" {
		g := in.GrantID
		session.GrantID = &g
	}
	if in.JITRequestID != "" {
		r := in.JITRequestID
		session.JITRequestID = &r
	}

	var recording *models.SessionRecording

	err = s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Create(session).Error; err != nil {
			return fmt.Errorf("failed to create session: %w", err)
		}
		if !recordingRequired {
			return nil
		}
		rec := &models.SessionRecording{
			SessionID:    session.ID,
			UserID:       in.UserID,
			Username:     in.Username,
			ResourceID:   resource.ID,
			ResourceName: resource.Name,
			IsBreakglass: in.IsBreakglass,
			Format:       "asciicast",
			Status:       models.RecordingStatusPending,
			StartedAt:    time.Now().UTC(),
		}
		if in.GrantID != "" {
			g := in.GrantID
			rec.GrantID = &g
		}
		if err := tx.Create(rec).Error; err != nil {
			return fmt.Errorf("failed to create recording obligation: %w", err)
		}
		if err := tx.Model(&models.ConnectionSession{}).Where("id = ?", session.ID).
			Update("recording_id", rec.ID).Error; err != nil {
			return err
		}
		session.RecordingID = &rec.ID
		recording = rec
		return nil
	})
	if err != nil {
		return nil, nil, err
	}

	s.logger.Info("session.started",
		zap.String("session_id", session.ID),
		zap.String("user", in.Username),
		zap.String("resource", resource.Name),
		zap.String("grant_id", in.GrantID),
		zap.Bool("breakglass", in.IsBreakglass),
		zap.Bool("recording_required", recordingRequired),
	)
	return session, recording, nil
}

// MarkRecordingActive flips a recording obligation from PENDING to
// RECORDING once the in-browser terminal gateway has actually opened the
// target connection and started capturing. Distinguishing "obligated" from
// "actively capturing right now" matters for an admin watching live
// sessions — PENDING alone was ambiguous about whether capture had even
// started.
func (s *ResourceService) MarkRecordingActive(recordingID string) error {
	if recordingID == "" {
		return nil
	}
	return s.db.Model(&models.SessionRecording{}).
		Where("id = ? AND status = ?", recordingID, models.RecordingStatusPending).
		Update("status", models.RecordingStatusRecording).Error
}

// SetRecordingFormat records which replay format this recording's artifact is
// in ("asciicast" for a terminal transcript, "rrweb" for a visual web session
// replay). A player selects its renderer off this field, so it has to be
// correct before the row is marked COMPLETED and becomes visible to one.
//
// Guarded to the same pre-completion states as AttachRecordingArtifact so a
// late writer cannot relabel a recording an admin has already been shown.
func (s *ResourceService) SetRecordingFormat(recordingID, format string) error {
	return s.db.Model(&models.SessionRecording{}).
		Where("id = ? AND status IN ?", recordingID,
			[]string{models.RecordingStatusPending, models.RecordingStatusRecording}).
		Update("format", format).Error
}

// AttachRecordingProgress points a still-open recording at the artifact
// written for it SO FAR, without resolving its status.
//
// This is what makes a session recording durable while the session is still
// running. Previously an artifact existed only after End: the whole stream sat
// in process memory and was written once, at the end, so a crash, a restart, a
// deploy — or any bug at all in the end-of-session path — lost the entire
// recording and left the row to be orphaned to FAILED with nothing behind it.
// For a compliance artifact that is the wrong durability model, and it is not
// what enterprise PAM products do: they stream to storage continuously.
//
// Status is deliberately NOT touched. The recording stays RECORDING so it is
// still understood to be in flight; what changes is that from the first flush
// onward there is always a real, replayable object to fall back on.
//
// Guarded to the pre-completion states so a late flush can never disturb a
// recording that End (or the orphan sweep) has already resolved.
func (s *ResourceService) AttachRecordingProgress(recordingID, storageLabel, storageKey string, sizeBytes int64, sha256Hex string) error {
	if recordingID == "" {
		return nil
	}
	return s.db.Model(&models.SessionRecording{}).
		Where("id = ? AND status IN ?", recordingID,
			[]string{models.RecordingStatusPending, models.RecordingStatusRecording}).
		Updates(map[string]interface{}{
			"storage_bucket": storageLabel,
			"storage_key":    storageKey,
			"size_bytes":     sizeBytes,
			"sha256":         sha256Hex,
		}).Error
}

// AttachRecordingTranscript records the secondary artifact key for a
// recording whose primary is a visual replay. Unguarded by status, unlike
// AttachRecordingArtifact: this is supplementary evidence that only ever adds
// to a row, so attaching it late (or to a row already resolved to FAILED)
// costs nothing and loses nothing.
func (s *ResourceService) AttachRecordingTranscript(recordingID, storageKey string) error {
	return s.db.Model(&models.SessionRecording{}).
		Where("id = ?", recordingID).
		Update("transcript_key", storageKey).Error
}

// AttachRecordingArtifact records where a finished recording's bytes ended
// up (see internal/recorder.Storage) once they have been durably persisted.
// This is the SOLE place a recording is ever marked COMPLETED — see the
// comment on closeRecordingTx below for why that status can never be set any
// earlier than this, when the bytes are actually known-persisted.
func (s *ResourceService) AttachRecordingArtifact(recordingID, storageLabel, storageKey string, sizeBytes int64, sha256Hex string, truncated bool) error {
	updates := map[string]interface{}{
		"status":         models.RecordingStatusCompleted,
		"storage_bucket": storageLabel,
		"storage_key":    storageKey,
		"size_bytes":     sizeBytes,
		"sha256":         sha256Hex,
	}
	if truncated {
		updates["failure_reason"] = "recording exceeded the configured size limit and was truncated"
	}
	// Status-guarded: if ReconcileOrphanedRecordings already resolved this row
	// to FAILED (finalize took longer than orphanRecordingGracePeriod), a
	// late-arriving successful save must not silently flip it back to
	// COMPLETED — that would erase the FAILED audit trail an admin may have
	// already seen/acted on. Log it instead so the artifact in storage isn't
	// lost track of, but leave the row's status alone.
	res := s.db.Model(&models.SessionRecording{}).
		Where("id = ? AND status IN ?", recordingID, []string{models.RecordingStatusPending, models.RecordingStatusRecording}).
		Updates(updates)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		// Not fatal to the session, but worth knowing about — either the row
		// couldn't be found (which would otherwise reproduce a "COMPLETED (or
		// stuck) with everything NULL" symptom silently), or it was already
		// resolved (e.g. marked orphaned) before this save completed.
		s.logger.Warn("recording.attach_artifact.no_matching_row",
			zap.String("recording_id", recordingID),
			zap.String("storage_bucket", storageLabel),
			zap.String("storage_key", storageKey))
	}
	return nil
}

// MarkRecordingFailed leaves an auditable trail when a recording could not
// be persisted — e.g. the storage backend was unreachable or disk-full.
// This deliberately does NOT touch the underlying ConnectionSession: a
// capture failure is a compliance gap to flag, not a reason to have killed
// (or to now retroactively invalidate) the user's actual work.
func (s *ResourceService) MarkRecordingFailed(recordingID, reason string) error {
	if recordingID == "" {
		return nil
	}
	now := time.Now().UTC()
	return s.db.Model(&models.SessionRecording{}).
		Where("id = ?", recordingID).
		Updates(map[string]interface{}{
			"status":           models.RecordingStatusFailed,
			"failure_reason":   reason,
			"ended_at":         now,
			"duration_seconds": gorm.Expr("GREATEST(0, EXTRACT(EPOCH FROM (? - started_at))::int)", now),
		}).Error
}

// GetRecording fetches one recording's metadata by id.
func (s *ResourceService) GetRecording(id string) (*models.SessionRecording, error) {
	var rec models.SessionRecording
	if err := s.db.Where("id = ?", id).First(&rec).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrRecordingNotFound
		}
		return nil, err
	}
	return &rec, nil
}

// AppendRecordingCommand inserts one recorded command row. Called once per
// command executed inside a recorded session — see internal/gateway's
// logCommand closure.
func (s *ResourceService) AppendRecordingCommand(cmd *models.SessionRecordingCommand) error {
	return s.db.Create(cmd).Error
}

// ListRecordingCommands returns the structured, searchable command log for
// one recording, oldest first — the counterpart to the raw cast replay
// blob, and the thing that actually answers "what did this user run."
func (s *ResourceService) ListRecordingCommands(recordingID string, page, pageSize int) ([]models.SessionRecordingCommand, int64, error) {
	page, size := normalisePaging(page, pageSize)

	q := s.db.Model(&models.SessionRecordingCommand{}).Where("recording_id = ?", recordingID)
	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []models.SessionRecordingCommand
	err := q.Order("sequence ASC").Limit(size).Offset((page - 1) * size).Find(&rows).Error
	return rows, total, err
}

// GetSession fetches a session by id.
func (s *ResourceService) GetSession(id string) (*models.ConnectionSession, error) {
	var sess models.ConnectionSession
	if err := s.db.Where("id = ?", id).First(&sess).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, ErrSessionNotFound
		}
		return nil, err
	}
	return &sess, nil
}

// EndTrackedSession closes a session. Users may only end their own sessions;
// pass allowAnyOwner=true for admin/system callers.
func (s *ResourceService) EndTrackedSession(sessionID, userID string, allowAnyOwner bool) (*models.ConnectionSession, error) {
	sess, err := s.GetSession(sessionID)
	if err != nil {
		return nil, err
	}
	if !allowAnyOwner && sess.UserID != userID {
		return nil, ErrSessionNotOwned
	}
	if sess.Status != "ACTIVE" {
		// Idempotent: ending an already-closed session is not an error.
		return sess, nil
	}

	now := time.Now().UTC()
	err = s.db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Model(&models.ConnectionSession{}).
			Where("id = ? AND status = 'ACTIVE'", sessionID).
			Updates(map[string]interface{}{
				"status":           "COMPLETED",
				"ended_at":         now,
				"duration_seconds": gorm.Expr("GREATEST(0, EXTRACT(EPOCH FROM (? - started_at))::int)", now),
			}).Error; err != nil {
			return err
		}
		return closeRecordingTx(tx, sessionID, now)
	})
	if err != nil {
		return nil, err
	}
	return s.GetSession(sessionID)
}

// KillSessionsByGrantTx terminates every ACTIVE session opened under a grant.
// It runs inside the caller's transaction so revocation is atomic: either the
// grant is revoked AND its sessions are killed, or neither happens.
func (s *ResourceService) KillSessionsByGrantTx(tx *gorm.DB, grantID, killedBy, reason string) (int, error) {
	now := time.Now().UTC()

	var ids []string
	if err := tx.Model(&models.ConnectionSession{}).
		Where("grant_id = ? AND status = 'ACTIVE'", grantID).
		Pluck("id", &ids).Error; err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, nil
	}

	if err := tx.Model(&models.ConnectionSession{}).
		Where("id IN ? AND status = 'ACTIVE'", ids).
		Updates(map[string]interface{}{
			"status":           "KILLED",
			"ended_at":         now,
			"kill_reason":      reason,
			"killed_by":        killedBy,
			"duration_seconds": gorm.Expr("GREATEST(0, EXTRACT(EPOCH FROM (? - started_at))::int)", now),
		}).Error; err != nil {
		return 0, err
	}

	// Stamp when these recording obligations' sessions ended. Status is
	// deliberately left untouched here — see the comment on closeRecordingTx
	// in this file. gateway.go's Connect() goroutine for each of these
	// sessions is still running (KillLiveSession below only force-closes the
	// socket; it doesn't stop that goroutine), and it will call
	// finalizeRecording once the socket close is observed, which is the only
	// place that should ever mark these COMPLETED (on a successful save) or
	// FAILED (on an encode/storage error) — not this bulk kill path, which
	// has no idea yet whether the artifact will actually save successfully.
	if err := tx.Model(&models.SessionRecording{}).
		Where("session_id IN ? AND status IN ?", ids,
			[]string{models.RecordingStatusPending, models.RecordingStatusRecording}).
		Updates(map[string]interface{}{
			"ended_at":         now,
			"duration_seconds": gorm.Expr("GREATEST(0, EXTRACT(EPOCH FROM (? - started_at))::int)", now),
		}).Error; err != nil {
		return 0, err
	}

	// Force-close any of these that are live web-terminal sockets (see
	// ResourceService.liveSessions) — a grant revoke/expiry should not leave
	// the underlying connection open just because it isn't in the same
	// transaction as the DB update above; KillLiveSession is a separate,
	// non-transactional, in-process call and safe to run even if the
	// surrounding tx later rolls back (worst case: a socket got closed for a
	// grant that turned out not to be revoked, which the user can simply
	// reopen — never a security problem, only a UX one, and one that in
	// practice does not happen since this only runs from paths that commit).
	for _, id := range ids {
		s.KillLiveSession(id)
	}

	return len(ids), nil
}

// KillSessionsForUserResourceTx is the containment hammer: kill every ACTIVE
// session a user holds on a resource, whether or not it came from a grant.
func (s *ResourceService) KillSessionsForUserResourceTx(tx *gorm.DB, userID, resourceID, killedBy, reason string) (int, error) {
	now := time.Now().UTC()

	var ids []string
	if err := tx.Model(&models.ConnectionSession{}).
		Where("user_id = ? AND resource_id = ? AND status = 'ACTIVE'", userID, resourceID).
		Pluck("id", &ids).Error; err != nil {
		return 0, err
	}
	if len(ids) == 0 {
		return 0, nil
	}

	res := tx.Model(&models.ConnectionSession{}).
		Where("id IN ?", ids).
		Updates(map[string]interface{}{
			"status":           "KILLED",
			"ended_at":         now,
			"kill_reason":      reason,
			"killed_by":        killedBy,
			"duration_seconds": gorm.Expr("GREATEST(0, EXTRACT(EPOCH FROM (? - started_at))::int)", now),
		})
	if res.Error != nil {
		return 0, res.Error
	}
	for _, id := range ids {
		s.KillLiveSession(id)
	}
	return int(res.RowsAffected), nil
}

// ReconcileStaleSessionsOnStartup closes out every ConnectionSession this
// process finds still marked ACTIVE, and every SessionRecording still
// PENDING/RECORDING, at boot — BEFORE the HTTP server starts accepting
// connections. Call exactly once, at startup, never from the periodic
// sweeper.
//
// Why this is safe and necessary: ResourceService.liveSessions (the
// in-process registry a live web-terminal goroutine registers itself in —
// see gateway.go's Connect) always starts empty on a fresh process. If any
// ConnectionSession row is still ACTIVE at the moment this process boots,
// there is categorically no goroutine anywhere that could actually be
// holding that connection open anymore — the only way to reach ACTIVE
// without a live owner is a prior process crashing or being killed (SIGKILL,
// OOM, a hard container restart) before it could mark the session
// COMPLETED/KILLED. ReconcileOrphanedRecordings (below) closes the narrower
// gap where the SESSION already finished but its RECORDING didn't; this
// closes the wider gap where the crash happened before even the session
// itself got closed out, which ReconcileOrphanedRecordings' query
// deliberately excludes (it only ever touches recordings whose session has
// ALREADY ended — a currently-ACTIVE session is, by that query's design,
// assumed to still be legitimately live). That assumption is only true
// during steady-state operation; it is never true in the instant this
// process starts.
func (s *ResourceService) ReconcileStaleSessionsOnStartup(ctx context.Context) (sessionsClosed int, recordingsFailed int, err error) {
	now := time.Now().UTC()
	const reason = "orphaned: the server restarted (crash, OOM, or manual kill) while this session was still marked active — no process was left running to close it out cleanly"

	res := s.db.WithContext(ctx).
		Model(&models.ConnectionSession{}).
		Where("status = 'ACTIVE'").
		Updates(map[string]interface{}{
			"status":           "FAILED",
			"ended_at":         now,
			"kill_reason":      reason,
			"duration_seconds": gorm.Expr("GREATEST(0, EXTRACT(EPOCH FROM (? - started_at))::int)", now),
		})
	if res.Error != nil {
		return 0, 0, res.Error
	}
	sessionsClosed = int(res.RowsAffected)

	res2 := s.db.WithContext(ctx).
		Model(&models.SessionRecording{}).
		Where("status IN ?", []string{models.RecordingStatusPending, models.RecordingStatusRecording}).
		Updates(map[string]interface{}{
			"status":           models.RecordingStatusFailed,
			"failure_reason":   reason,
			"ended_at":         now,
			"duration_seconds": gorm.Expr("GREATEST(0, EXTRACT(EPOCH FROM (? - started_at))::int)", now),
		})
	if res2.Error != nil {
		return sessionsClosed, 0, res2.Error
	}
	recordingsFailed = int(res2.RowsAffected)

	if sessionsClosed > 0 || recordingsFailed > 0 {
		s.logger.Warn("session.reconcile_stale_on_startup",
			zap.Int("sessions_closed", sessionsClosed),
			zap.Int("recordings_failed", recordingsFailed))
	}
	return sessionsClosed, recordingsFailed, nil
}

// ReconcileOrphanedRecordings finds SessionRecording rows still sitting in
// PENDING or RECORDING whose underlying ConnectionSession has already ended
// (COMPLETED/KILLED/FAILED — anything but ACTIVE) or no longer exists.
//
// This closes the last gap left by the closeRecordingTx/AttachRecordingArtifact
// fix below: that fix correctly stops stamping COMPLETED before the artifact
// is known-saved, but it also means a row can now legitimately get stuck at
// PENDING/RECORDING forever if the server crashes or is killed between the
// session ending and gateway.go's finalizeRecording running (finalizeRecording
// lives in the same in-memory goroutine as the WebSocket handler — it does
// not survive a process restart). Without this reconciliation, an admin would
// see a recording sitting at "RECORDING" indefinitely with no way to tell
// whether it's a live session or an orphan from a crash. Called on startup
// and on every sweeper pass (see Sweeper.RunOnce) so orphans surface within
// one sweep interval, not just whenever someone happens to look.
// orphanRecordingGracePeriod bounds the window between a session ending
// (closeRecordingTx/KillSessionsByGrantTx stamping the recording's ended_at)
// and gateway.go's finalizeRecording actually finishing (encode + upload +
// AttachRecordingArtifact). That gap is normal — not every sweep tick that
// lands inside it means a crash — so ReconcileOrphanedRecordings must not
// flag a recording until it has been sitting past ended_at for at least this
// long. Set well above any realistic encode/upload time so only recordings
// finalizeRecording actually never got to run for (crash/restart) get caught.
//
// The cutoff is evaluated against the SESSION's own ended_at, not the
// recording's — deliberately. KillSession (admin "Kill Session", the third
// place a session can end) never touches pam_session_recordings at all, so a
// recording's own ended_at can be permanently NULL even though its session
// ended cleanly. Keying off the session's ended_at instead means this sweep
// still finds and resolves that recording instead of leaving it stuck at
// PENDING/RECORDING forever, with no dependency on every current and future
// "a session can end" code path remembering to stamp the recording row too.
const orphanRecordingGracePeriod = 2 * time.Minute

func (s *ResourceService) ReconcileOrphanedRecordings(ctx context.Context) (int, error) {
	now := time.Now().UTC()
	cutoff := now.Add(-orphanRecordingGracePeriod)

	// Select first, then resolve each row. The previous version did this as one
	// set-based UPDATE, which was tighter but computed duration_seconds with
	// EXTRACT(EPOCH FROM ...) — Postgres-only syntax that made this function
	// impossible to exercise against any other engine, so the rules below
	// (the ones deciding whether a session's evidence is kept or discarded)
	// had no test coverage at all. The row count is a handful per sweep.
	var orphans []models.SessionRecording
	if err := s.db.WithContext(ctx).
		Where(`status IN ? AND session_id IN (
			SELECT id FROM pam_connection_sessions WHERE status <> 'ACTIVE' AND ended_at IS NOT NULL AND ended_at <= ?
			UNION
			SELECT r.session_id FROM pam_session_recordings r
			LEFT JOIN pam_connection_sessions cs ON cs.id = r.session_id
			WHERE cs.id IS NULL AND r.started_at <= ?
		)`, []string{models.RecordingStatusPending, models.RecordingStatusRecording}, cutoff, cutoff).
		Find(&orphans).Error; err != nil {
		return 0, err
	}
	// Independent of the orphan set: a mislabelled row outlives whatever
	// created it, and gating the repair on "is there also an orphan this
	// sweep" made it fire only by coincidence.
	repaired := s.repairMislabelledRecordings(ctx, now)

	if len(orphans) == 0 {
		return repaired, nil
	}

	open := []string{models.RecordingStatusPending, models.RecordingStatusRecording}
	completed, failed := 0, 0

	for i := range orphans {
		rec := &orphans[i]

		duration := int(now.Sub(rec.StartedAt).Seconds())
		if duration < 0 {
			duration = 0
		}

		// The artifact test goes in the UPDATE's own WHERE clause, not in an
		// if statement over the row we selected.
		//
		// Read from the snapshot, it was a race with a real consequence:
		// write-through flushing can set storage_key between this function's
		// SELECT and its UPDATE, and the UPDATE's status guard still matched,
		// so a recording that had just acquired a perfectly good artifact was
		// stamped FAILED with "no artifact exists for it". The console then
		// showed a recording marked FAILED that played fine — evidence
		// present, label wrong, which is worse than either being consistently
		// true because it teaches an auditor to distrust the status column.
		//
		// Deciding inside the database makes the artifact check and the status
		// transition atomic, so the outcome is correct under any interleaving.
		res := s.db.WithContext(ctx).
			Model(&models.SessionRecording{}).
			Where("id = ? AND status IN ? AND storage_key <> ''", rec.ID, open).
			Updates(map[string]interface{}{
				"status": models.RecordingStatusCompleted,
				"failure_reason": "interrupted: the session ended without a clean finalize (restart, crash, or kill) — " +
					"this artifact holds everything captured up to the last flush and may be missing the final seconds",
				"ended_at":         now,
				"duration_seconds": duration,
			})
		if res.Error != nil {
			s.logger.Warn("recording.reconcile.complete_fail",
				zap.String("recording_id", rec.ID), zap.Error(res.Error))
			continue
		}
		if res.RowsAffected > 0 {
			completed++
			continue
		}

		// No artifact: this recording genuinely lost its session's evidence.
		res = s.db.WithContext(ctx).
			Model(&models.SessionRecording{}).
			Where("id = ? AND status IN ? AND (storage_key IS NULL OR storage_key = '')", rec.ID, open).
			Updates(map[string]interface{}{
				"status": models.RecordingStatusFailed,
				"failure_reason": "orphaned: the session ended without this recording ever being finalized " +
					"(likely a server restart/crash mid-session) — no artifact exists for it",
				"ended_at":         now,
				"duration_seconds": duration,
			})
		if res.Error != nil {
			s.logger.Warn("recording.reconcile.fail_fail",
				zap.String("recording_id", rec.ID), zap.Error(res.Error))
			continue
		}
		if res.RowsAffected > 0 {
			failed++
		}
		// Zero rows on both means another writer resolved it first, which is
		// the correct outcome — that writer knew more than this sweep does.
	}

	if completed > 0 {
		s.logger.Warn("recording.reconcile.partials_completed",
			zap.Int("count", completed),
			zap.String("detail", "recordings interrupted mid-session were completed from their last flush"))
	}
	if failed > 0 {
		s.logger.Warn("recording.reconcile.orphans_marked_failed", zap.Int("count", failed))
	}
	return completed + failed + repaired, nil
}

// repairMislabelledRecordings corrects rows that say FAILED while holding a
// usable artifact.
//
// Such a row should not exist, and every path that could create one has been
// closed — but the state is worth actively repairing rather than merely
// prevented, for two reasons. It is unambiguous: a stored artifact with a
// recorded size is either replayable or it is not, and the status column is
// the only thing claiming otherwise. And it is corrosive: an auditor who finds
// one recording marked FAILED that plays perfectly has no reason to trust the
// status of any other, which costs far more than the row itself.
//
// Scoped tightly to rows whose failure_reason is the orphan message, so a
// genuine encode or upload failure — where the artifact really is absent or
// corrupt — is never quietly relabelled as fine.
func (s *ResourceService) repairMislabelledRecordings(ctx context.Context, now time.Time) int {
	res := s.db.WithContext(ctx).
		Model(&models.SessionRecording{}).
		Where("status = ? AND storage_key <> '' AND size_bytes > 0 AND failure_reason LIKE ?",
			models.RecordingStatusFailed, "orphaned:%").
		Updates(map[string]interface{}{
			"status": models.RecordingStatusCompleted,
			"failure_reason": "interrupted: the session ended without a clean finalize — this artifact " +
				"holds everything captured up to the last flush and may be missing the final seconds",
		})
	if res.Error != nil {
		s.logger.Warn("recording.reconcile.repair_fail", zap.Error(res.Error))
		return 0
	}
	if res.RowsAffected > 0 {
		s.logger.Warn("recording.reconcile.mislabelled_repaired",
			zap.Int64("count", res.RowsAffected),
			zap.String("detail", "recordings marked FAILED while holding a replayable artifact were corrected to COMPLETED"))
	}
	return int(res.RowsAffected)
}

// closeRecordingTx stamps ended_at/duration_seconds on an open recording
// obligation when its underlying session ends.
//
// This deliberately does NOT flip status to COMPLETED here: that would make
// COMPLETED a lie the moment it was written, since gateway.go's
// finalizeRecording has not yet actually encoded the cast, saved it to
// storage, or confirmed success via AttachRecordingArtifact at this point —
// a recording is only really "complete" once its bytes are persisted (see
// the doc comment on models.SessionRecording), not just because the session
// it belongs to closed. Stamping COMPLETED here would race with (or, on a
// server restart/crash between this stamp and finalizeRecording running,
// permanently beat) the real finalize step, leaving rows stuck at COMPLETED
// with storage_key/sha256/failure_reason all NULL forever. AttachRecordingArtifact
// (success) and MarkRecordingFailed (failure) are the only two places that
// ever set a recording to COMPLETED or FAILED, and both only run once the
// outcome is actually known; ReconcileOrphanedRecordings above is the
// backstop for when neither ever gets the chance to run (process crash).
func closeRecordingTx(tx *gorm.DB, sessionID string, now time.Time) error {
	return tx.Model(&models.SessionRecording{}).
		Where("session_id = ? AND status IN ?", sessionID,
			[]string{models.RecordingStatusPending, models.RecordingStatusRecording}).
		Updates(map[string]interface{}{
			"ended_at":         now,
			"duration_seconds": gorm.Expr("GREATEST(0, EXTRACT(EPOCH FROM (? - started_at))::int)", now),
		}).Error
}

// ──────────────────────────────────────────────────────────────────────────
// READ QUERIES (IAM admin console + user view)
// ──────────────────────────────────────────────────────────────────────────

// ListSessions returns a filtered, paginated set of sessions plus total count.
func (s *ResourceService) ListSessions(f SessionFilter) ([]models.ConnectionSession, int64, error) {
	page, size := normalisePaging(f.Page, f.PageSize)

	q := s.db.Model(&models.ConnectionSession{})
	if f.UserID != "" {
		q = q.Where("user_id = ?", f.UserID)
	}
	if f.ResourceID != "" {
		q = q.Where("resource_id = ?", f.ResourceID)
	}
	if f.GrantID != "" {
		q = q.Where("grant_id = ?", f.GrantID)
	}
	if f.ActiveOnly {
		q = q.Where("status = ?", "ACTIVE")
	} else if f.Status != "" {
		q = q.Where("status = ?", strings.ToUpper(f.Status))
	}
	if len(f.ScopeResourceIDs) > 0 {
		q = q.Where("resource_id IN ?", f.ScopeResourceIDs)
	}
	if f.IsBreakglass != nil {
		q = q.Where("is_breakglass = ?", *f.IsBreakglass)
	}
	if f.From != nil {
		q = q.Where("started_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("started_at <= ?", *f.To)
	}
	if f.Search != "" {
		like := "%" + strings.ToLower(f.Search) + "%"
		q = q.Where("LOWER(username) LIKE ? OR LOWER(resource_name) LIKE ? OR LOWER(source_ip) LIKE ?",
			like, like, like)
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []models.ConnectionSession
	err := q.Order("started_at DESC").Limit(size).Offset((page - 1) * size).Find(&rows).Error
	return rows, total, err
}

// ListRecordings returns recording metadata for the IAM admin console.
func (s *ResourceService) ListRecordings(f RecordingFilter) ([]models.SessionRecording, int64, error) {
	page, size := normalisePaging(f.Page, f.PageSize)

	q := s.db.Model(&models.SessionRecording{})
	if f.UserID != "" {
		q = q.Where("user_id = ?", f.UserID)
	}
	if f.ResourceID != "" {
		q = q.Where("resource_id = ?", f.ResourceID)
	}
	if f.SessionID != "" {
		q = q.Where("session_id = ?", f.SessionID)
	}
	if f.GrantID != "" {
		q = q.Where("grant_id = ?", f.GrantID)
	}
	if f.Status != "" {
		q = q.Where("status = ?", strings.ToUpper(f.Status))
	}
	if len(f.ScopeResourceIDs) > 0 {
		q = q.Where("resource_id IN ?", f.ScopeResourceIDs)
	}
	if f.IsBreakglass != nil {
		q = q.Where("is_breakglass = ?", *f.IsBreakglass)
	}

	var total int64
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	var rows []models.SessionRecording
	err := q.Order("started_at DESC").Limit(size).Offset((page - 1) * size).Find(&rows).Error
	return rows, total, err
}

// CountActiveSessions powers the IAM admin dashboard tiles.
func (s *ResourceService) CountActiveSessions() (int64, error) {
	var n int64
	err := s.db.Model(&models.ConnectionSession{}).Where("status = ?", "ACTIVE").Count(&n).Error
	return n, err
}

// CountResources powers the IAM admin dashboard tiles.
func (s *ResourceService) CountResources() (int64, error) {
	var n int64
	err := s.db.Model(&models.PAMResource{}).Where("is_active = ?", true).Count(&n).Error
	return n, err
}
