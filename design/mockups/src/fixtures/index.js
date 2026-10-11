// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
// HARD RULE (Phase 5): no invented fields, no invented categories, no invented
// metrics. Every object below is shaped EXACTLY like the corresponding Go
// model's JSON in backend/internal/models/*.go, and every enum value comes
// from UI/src/config/constants.js. Resource types are the ten this deployment
// actually defines (postgresql, mongodb, redis, clickhouse, minio, qdrant,
// metabase, langfuse, web, oracle) — not AWS/GCP placeholders.
//
// Values are realistic, not real. Where the API returns nothing (e.g. history
// for a trend line) the fixtures return nothing either, so a mockup cannot
// accidentally draw a number the backend can't produce.

const now = Date.now()
const iso = (msFromNow) => new Date(now + msFromNow).toISOString()
const mins = (n) => n * 60_000
const hours = (n) => n * 3_600_000
const days = (n) => n * 86_400_000

// ── GET /api/v1/pam/admin/stats ────────────────────────────────────────────
// Exact shape from admin_handler.go#Stats. Point-in-time counts, no history:
// this is why no trend arrow or sparkline appears anywhere in these mockups.
export const adminStats = {
  pending_approvals: 7,
  active_sessions: 12,
  active_grants: 23,
  active_breakglass_grants: 1,
  active_resources: 34,
  generated_at: iso(-mins(0.2)),
  // Read by DashboardPage behind a null guard; present in the deployed API,
  // absent from the supplied backend.zip snapshot (Phase 1 version skew).
  awaiting_first_approval: 4,
  awaiting_second_approval: 3,
}

// ── models.PAMResource ─────────────────────────────────────────────────────
export const resources = [
  { id: 'res-01', name: 'prod-postgres-primary', description: 'Primary OLTP cluster', resource_type: 'postgresql', host: 'pg-prod-01.internal', port: 5432, database_name: 'core', connect_mode: 'web_terminal', vault_entry_id: 'cred-11', requires_jit: true, always_record: true, is_active: true, created_by: 'usr-root', created_at: iso(-days(210)) },
  { id: 'res-02', name: 'prod-postgres-replica', description: 'Read replica', resource_type: 'postgresql', host: 'pg-prod-02.internal', port: 5432, database_name: 'core', connect_mode: 'web_terminal', vault_entry_id: 'cred-12', requires_jit: false, always_record: true, is_active: true, created_by: 'usr-root', created_at: iso(-days(210)) },
  { id: 'res-03', name: 'analytics-clickhouse', description: 'Event warehouse', resource_type: 'clickhouse', host: 'ch-01.internal', port: 9000, database_name: 'events', connect_mode: 'web_terminal', vault_entry_id: 'cred-13', requires_jit: true, always_record: true, is_active: true, created_by: 'usr-002', created_at: iso(-days(160)) },
  { id: 'res-04', name: 'session-store-redis', description: 'Session + rate-limit store', resource_type: 'redis', host: 'redis-01.internal', port: 6379, connect_mode: 'web_terminal', vault_entry_id: 'cred-14', requires_jit: false, always_record: false, is_active: true, created_by: 'usr-002', created_at: iso(-days(150)) },
  { id: 'res-05', name: 'docstore-mongo', description: 'Document store', resource_type: 'mongodb', host: 'mongo-01.internal', port: 27017, database_name: 'docs', connect_mode: 'web_terminal', vault_entry_id: null, requires_jit: true, always_record: true, is_active: true, created_by: 'usr-002', created_at: iso(-days(120)) },
  { id: 'res-06', name: 'model-artifacts-minio', description: 'Object storage for model artifacts', resource_type: 'minio', host: 'minio-01.internal', port: 9000, connect_mode: 'console_url', console_url: 'https://minio-01.internal:9001', vault_entry_id: 'cred-16', requires_jit: false, always_record: false, is_active: true, created_by: 'usr-002', created_at: iso(-days(95)) },
  { id: 'res-07', name: 'embeddings-qdrant', description: 'Vector index', resource_type: 'qdrant', host: 'qdrant-01.internal', port: 6333, connect_mode: 'web_terminal', vault_entry_id: 'cred-17', requires_jit: false, always_record: false, is_active: true, created_by: 'usr-004', created_at: iso(-days(80)) },
  { id: 'res-08', name: 'metabase-bi', description: 'Business intelligence', resource_type: 'metabase', host: 'metabase.internal', port: 3000, connect_mode: 'console_url', console_url: 'https://metabase.internal', vault_entry_id: 'cred-18', requires_jit: false, always_record: false, is_active: true, created_by: 'usr-004', created_at: iso(-days(75)) },
  { id: 'res-09', name: 'langfuse-tracing', description: 'LLM trace store', resource_type: 'langfuse', host: 'langfuse.internal', port: 3000, connect_mode: 'console_url', console_url: 'https://langfuse.internal', vault_entry_id: null, requires_jit: false, always_record: false, is_active: true, created_by: 'usr-004', created_at: iso(-days(60)) },
  { id: 'res-10', name: 'legacy-oracle-fin', description: 'Finance system of record', resource_type: 'oracle', host: 'ora-fin-01.internal', port: 1521, database_name: 'FIN', connect_mode: 'web_terminal', vault_entry_id: 'cred-20', requires_jit: true, always_record: true, is_active: true, created_by: 'usr-root', created_at: iso(-days(400)) },
  { id: 'res-11', name: 'admin-portal-web', description: 'Internal admin portal', resource_type: 'web', host: 'admin.internal', port: 443, connect_mode: 'console_url', console_url: 'https://admin.internal', vault_entry_id: 'cred-21', requires_jit: true, always_record: true, is_active: true, created_by: 'usr-root', created_at: iso(-days(300)) },
  { id: 'res-12', name: 'staging-postgres', description: 'Staging database', resource_type: 'postgresql', host: 'pg-stg-01.internal', port: 5432, database_name: 'core', connect_mode: 'web_terminal', vault_entry_id: 'cred-22', requires_jit: false, always_record: false, is_active: false, created_by: 'usr-002', created_at: iso(-days(240)) },
]

// GET /api/v1/pam/resources/groups → models.ResourceGroup[]
export const resourceGroups = [
  { name: 'Databases', icon: 'database', resources: resources.filter((r) => ['postgresql', 'mongodb', 'oracle', 'clickhouse'].includes(r.resource_type)) },
  { name: 'Caches & stores', icon: 'layers', resources: resources.filter((r) => ['redis', 'minio', 'qdrant'].includes(r.resource_type)) },
  { name: 'Applications', icon: 'globe', resources: resources.filter((r) => ['metabase', 'langfuse', 'web'].includes(r.resource_type)) },
]

// ── models.JITRequest ──────────────────────────────────────────────────────
export const jitRequests = [
  { id: 'jit-1001', request_type: 'STANDARD', requester_user_id: 'usr-007', requester_username: 'p.venkatesh', resource_id: 'res-01', resource_name: 'prod-postgres-primary', resource_type: 'postgresql', action: 'pam:resource:Connect', duration_minutes: 60, reason: 'Investigating slow query on orders table, ticket OPS-4412', ticket_ref: 'OPS-4412', status: 'PARTIALLY_APPROVED', source_ip: '10.4.19.22', requested_at: iso(-mins(38)), request_expires_at: iso(hours(3.4)), decided_at: null, grant_id: null },
  { id: 'jit-1002', request_type: 'STANDARD', requester_user_id: 'usr-011', requester_username: 's.iyer', resource_id: 'res-10', resource_name: 'legacy-oracle-fin', resource_type: 'oracle', action: 'pam:resource:Connect', duration_minutes: 120, reason: 'Month-end reconciliation export', ticket_ref: 'FIN-882', status: 'PARTIALLY_APPROVED', source_ip: '10.4.7.9', requested_at: iso(-mins(52)), request_expires_at: iso(hours(3.1)), decided_at: null, grant_id: null },
  { id: 'jit-1003', request_type: 'STANDARD', requester_user_id: 'usr-014', requester_username: 'a.khan', resource_id: 'res-03', resource_name: 'analytics-clickhouse', resource_type: 'clickhouse', action: 'pam:resource:Connect', duration_minutes: 240, reason: 'Backfill for the Q3 attribution model', ticket_ref: 'DATA-201', status: 'PARTIALLY_APPROVED', source_ip: '10.4.22.4', requested_at: iso(-hours(1.4)), request_expires_at: iso(hours(2.6)), decided_at: null, grant_id: null },
  { id: 'jit-1004', request_type: 'STANDARD', requester_user_id: 'usr-009', requester_username: 'r.mehta', resource_id: 'res-05', resource_name: 'docstore-mongo', resource_type: 'mongodb', action: 'pam:resource:Connect', duration_minutes: 30, reason: 'Verify index build completed', ticket_ref: '', status: 'PENDING', source_ip: '10.4.19.51', requested_at: iso(-mins(12)), request_expires_at: iso(hours(3.8)), decided_at: null, grant_id: null },
  { id: 'jit-1005', request_type: 'STANDARD', requester_user_id: 'usr-016', requester_username: 'd.rao', resource_id: 'res-11', resource_name: 'admin-portal-web', resource_type: 'web', action: 'pam:resource:Connect', duration_minutes: 45, reason: 'Reproduce the tenant-switch bug reported by support', ticket_ref: 'SUP-9910', status: 'PENDING', source_ip: '10.4.31.7', requested_at: iso(-mins(21)), request_expires_at: iso(hours(3.6)), decided_at: null, grant_id: null },
  { id: 'jit-1006', request_type: 'STANDARD', requester_user_id: 'usr-021', requester_username: 'n.gupta', resource_id: 'res-01', resource_name: 'prod-postgres-primary', resource_type: 'postgresql', action: 'pam:resource:Connect', duration_minutes: 60, reason: 'Apply hotfix migration 0142', ticket_ref: 'REL-77', status: 'PENDING', source_ip: '10.4.12.88', requested_at: iso(-mins(29)), request_expires_at: iso(hours(3.5)), decided_at: null, grant_id: null },
  { id: 'jit-1007', request_type: 'STANDARD', requester_user_id: 'usr-030', requester_username: 'k.das', resource_id: 'res-03', resource_name: 'analytics-clickhouse', resource_type: 'clickhouse', action: 'pam:resource:Connect', duration_minutes: 90, reason: 'Dashboard numbers disagree with the warehouse', ticket_ref: 'DATA-233', status: 'PENDING', source_ip: '10.4.22.15', requested_at: iso(-mins(44)), request_expires_at: iso(hours(3.2)), decided_at: null, grant_id: null },
  { id: 'jit-1008', request_type: 'BREAKGLASS', requester_user_id: 'usr-011', requester_username: 's.iyer', resource_id: 'res-10', resource_name: 'legacy-oracle-fin', resource_type: 'oracle', action: 'pam:resource:Connect', duration_minutes: 60, reason: 'Payment batch stuck, finance close blocked', ticket_ref: 'INC-1180', status: 'WAITING', source_ip: '10.4.7.9', requested_at: iso(-mins(6)), request_expires_at: iso(hours(3.9)), available_at: iso(mins(9)), decided_at: null, grant_id: null },
  // Terminal history
  { id: 'jit-0996', request_type: 'STANDARD', requester_user_id: 'usr-007', requester_username: 'p.venkatesh', resource_id: 'res-02', resource_name: 'prod-postgres-replica', resource_type: 'postgresql', action: 'pam:resource:Connect', duration_minutes: 60, reason: 'Replica lag investigation', ticket_ref: 'OPS-4401', status: 'APPROVED', source_ip: '10.4.19.22', requested_at: iso(-hours(5)), request_expires_at: iso(-hours(1)), decided_at: iso(-hours(4.6)), approver_user_id: 'usr-002', approver_username: 'm.sharma', decision_reason: 'Read-only replica, low risk', grant_id: 'grant-501' },
  { id: 'jit-0994', request_type: 'STANDARD', requester_user_id: 'usr-030', requester_username: 'k.das', resource_id: 'res-01', resource_name: 'prod-postgres-primary', resource_type: 'postgresql', action: 'pam:resource:Connect', duration_minutes: 480, reason: 'Need standing access for the week', ticket_ref: '', status: 'DENIED', source_ip: '10.4.22.15', requested_at: iso(-hours(9)), request_expires_at: iso(-hours(5)), decided_at: iso(-hours(8.4)), approver_user_id: 'usr-002', approver_username: 'm.sharma', decision_reason: 'Eight hours on the primary is not just-in-time. Re-request scoped to the task.', grant_id: null },
  { id: 'jit-0991', request_type: 'STANDARD', requester_user_id: 'usr-014', requester_username: 'a.khan', resource_id: 'res-06', resource_name: 'model-artifacts-minio', resource_type: 'minio', action: 'pam:resource:Connect', duration_minutes: 60, reason: 'Pull the v3 checkpoint', ticket_ref: '', status: 'EXPIRED', source_ip: '10.4.22.4', requested_at: iso(-days(1.2)), request_expires_at: iso(-days(1)), decided_at: null, grant_id: null },
]

// Approvals trail — ONLY returned by GET /admin/jit-requests/:id.
// Keyed by request id; `null` for anything we haven't opened, because the
// list responses genuinely don't carry it (see lib/fourEyes.js).
export const approvalsByRequest = {
  'jit-1001': [{ approver_user_id: 'usr-002', approver_username: 'm.sharma', approver_rank: 80, decision: 'approved', reason: 'Query investigation is legitimate; 60 min is right-sized.', created_at: iso(-mins(31)) }],
  'jit-1002': [{ approver_user_id: 'usr-004', approver_username: 'j.pillai', approver_rank: 80, decision: 'approved', reason: 'Month-end, expected.', created_at: iso(-mins(47)) }],
  'jit-1003': [{ approver_user_id: 'usr-002', approver_username: 'm.sharma', approver_rank: 80, decision: 'approved', reason: '', created_at: iso(-hours(1.2)) }],
}

// ── models.AccessGrant ─────────────────────────────────────────────────────
export const grants = [
  { id: 'grant-501', request_id: 'jit-0996', user_id: 'usr-007', username: 'p.venkatesh', resource_id: 'res-02', resource_name: 'prod-postgres-replica', action: 'pam:resource:Connect', is_breakglass: false, recording_required: true, status: 'ACTIVE', granted_at: iso(-hours(4.6)), expires_at: iso(mins(23)), sessions_killed: 0, iam_sync_status: 'SYNCED' },
  { id: 'grant-502', request_id: 'jit-0988', user_id: 'usr-007', username: 'p.venkatesh', resource_id: 'res-04', resource_name: 'session-store-redis', action: 'pam:resource:Connect', is_breakglass: false, recording_required: false, status: 'ACTIVE', granted_at: iso(-hours(1.1)), expires_at: iso(hours(6.9)), sessions_killed: 0, iam_sync_status: 'SKIPPED' },
  { id: 'grant-503', request_id: 'jit-0984', user_id: 'usr-011', username: 's.iyer', resource_id: 'res-10', resource_name: 'legacy-oracle-fin', action: 'pam:resource:Connect', is_breakglass: true, recording_required: true, status: 'ACTIVE', granted_at: iso(-mins(41)), expires_at: iso(mins(19)), sessions_killed: 0, iam_sync_status: 'SYNCED' },
  { id: 'grant-504', request_id: 'jit-0980', user_id: 'usr-014', username: 'a.khan', resource_id: 'res-03', resource_name: 'analytics-clickhouse', action: 'pam:resource:Connect', is_breakglass: false, recording_required: true, status: 'ACTIVE', granted_at: iso(-hours(2.2)), expires_at: iso(hours(1.8)), sessions_killed: 0, iam_sync_status: 'SYNCED' },
  { id: 'grant-498', request_id: 'jit-0975', user_id: 'usr-030', username: 'k.das', resource_id: 'res-03', resource_name: 'analytics-clickhouse', action: 'pam:resource:Connect', is_breakglass: false, recording_required: true, status: 'REVOKED', granted_at: iso(-hours(20)), expires_at: iso(-hours(16)), revoked_at: iso(-hours(19)), revoked_by: 'usr-002', revoke_reason: 'Task completed early; grant no longer needed.', sessions_killed: 1, iam_sync_status: 'SYNCED' },
  { id: 'grant-495', request_id: 'jit-0970', user_id: 'usr-007', username: 'p.venkatesh', resource_id: 'res-01', resource_name: 'prod-postgres-primary', action: 'pam:resource:Connect', is_breakglass: false, recording_required: true, status: 'EXPIRED', granted_at: iso(-days(1.4)), expires_at: iso(-days(1.3)), sessions_killed: 0, iam_sync_status: 'SYNCED' },
]

// ── models.ConnectionSession ───────────────────────────────────────────────
export const sessions = [
  { id: 'sess-9001', user_id: 'usr-011', username: 's.iyer', resource_id: 'res-10', resource_name: 'legacy-oracle-fin', resource_type: 'oracle', protocol: 'sqlplus', source_ip: '10.4.7.9', status: 'ACTIVE', started_at: iso(-mins(38)), duration_seconds: 2280, grant_id: 'grant-503', jit_request_id: 'jit-0984', is_breakglass: true, recording_required: true, recording_id: 'rec-401', authz_allowed: true },
  { id: 'sess-9002', user_id: 'usr-007', username: 'p.venkatesh', resource_id: 'res-02', resource_name: 'prod-postgres-replica', resource_type: 'postgresql', protocol: 'psql', source_ip: '10.4.19.22', status: 'ACTIVE', started_at: iso(-mins(64)), duration_seconds: 3840, grant_id: 'grant-501', jit_request_id: 'jit-0996', is_breakglass: false, recording_required: true, recording_id: 'rec-402', authz_allowed: true },
  { id: 'sess-9003', user_id: 'usr-014', username: 'a.khan', resource_id: 'res-03', resource_name: 'analytics-clickhouse', resource_type: 'clickhouse', protocol: 'clickhouse-client', source_ip: '10.4.22.4', status: 'ACTIVE', started_at: iso(-mins(17)), duration_seconds: 1020, grant_id: 'grant-504', jit_request_id: 'jit-0980', is_breakglass: false, recording_required: true, recording_id: 'rec-403', authz_allowed: true },
  { id: 'sess-9004', user_id: 'usr-022', username: 'automation.etl', resource_id: 'res-04', resource_name: 'session-store-redis', resource_type: 'redis', protocol: 'redis-cli', source_ip: '10.6.1.40', status: 'ACTIVE', started_at: iso(-hours(3.2)), duration_seconds: 11520, is_breakglass: false, recording_required: false, authz_allowed: true },
  { id: 'sess-9005', user_id: 'usr-016', username: 'd.rao', resource_id: 'res-08', resource_name: 'metabase-bi', resource_type: 'metabase', protocol: 'https', source_ip: '10.4.31.7', status: 'ACTIVE', started_at: iso(-mins(9)), duration_seconds: 540, is_breakglass: false, recording_required: false, authz_allowed: true },
  { id: 'sess-9006', user_id: 'usr-007', username: 'p.venkatesh', resource_id: 'res-04', resource_name: 'session-store-redis', resource_type: 'redis', protocol: 'redis-cli', source_ip: '10.4.19.22', status: 'ACTIVE', started_at: iso(-mins(3)), duration_seconds: 180, grant_id: 'grant-502', is_breakglass: false, recording_required: false, authz_allowed: true },
  { id: 'sess-8990', user_id: 'usr-030', username: 'k.das', resource_id: 'res-03', resource_name: 'analytics-clickhouse', resource_type: 'clickhouse', protocol: 'clickhouse-client', source_ip: '10.4.22.15', status: 'KILLED', started_at: iso(-hours(19.4)), ended_at: iso(-hours(19)), duration_seconds: 1440, grant_id: 'grant-498', is_breakglass: false, recording_required: true, recording_id: 'rec-390', kill_reason: 'Grant revoked — task completed early.', killed_by: 'usr-002', authz_allowed: true },
  { id: 'sess-8988', user_id: 'usr-007', username: 'p.venkatesh', resource_id: 'res-01', resource_name: 'prod-postgres-primary', resource_type: 'postgresql', protocol: 'psql', source_ip: '10.4.19.22', status: 'ENDED', started_at: iso(-days(1.4)), ended_at: iso(-days(1.35)), duration_seconds: 4320, grant_id: 'grant-495', is_breakglass: false, recording_required: true, recording_id: 'rec-380', authz_allowed: true },
]

// ── models.SessionRecording ────────────────────────────────────────────────
export const recordings = [
  { id: 'rec-401', session_id: 'sess-9001', grant_id: 'grant-503', user_id: 'usr-011', username: 's.iyer', resource_id: 'res-10', resource_name: 'legacy-oracle-fin', is_breakglass: true, format: 'asciicast', storage_bucket: 'pam-recordings', storage_key: 'org-1/2026/08/rec-401.cast', size_bytes: 184320, sha256: '9f2c41ab7de0…c118', status: 'RECORDING', started_at: iso(-mins(38)), duration_seconds: 2280 },
  { id: 'rec-402', session_id: 'sess-9002', grant_id: 'grant-501', user_id: 'usr-007', username: 'p.venkatesh', resource_id: 'res-02', resource_name: 'prod-postgres-replica', is_breakglass: false, format: 'asciicast', storage_bucket: 'pam-recordings', storage_key: 'org-1/2026/08/rec-402.cast', size_bytes: 291840, sha256: '3a71b0ff42c9…8ee1', status: 'RECORDING', started_at: iso(-mins(64)), duration_seconds: 3840 },
  { id: 'rec-390', session_id: 'sess-8990', grant_id: 'grant-498', user_id: 'usr-030', username: 'k.das', resource_id: 'res-03', resource_name: 'analytics-clickhouse', is_breakglass: false, format: 'asciicast', storage_bucket: 'pam-recordings', storage_key: 'org-1/2026/08/rec-390.cast', size_bytes: 128512, sha256: 'be04d7159a22…41c0', status: 'COMPLETED', started_at: iso(-hours(19.4)), ended_at: iso(-hours(19)), duration_seconds: 1440 },
  { id: 'rec-380', session_id: 'sess-8988', grant_id: 'grant-495', user_id: 'usr-007', username: 'p.venkatesh', resource_id: 'res-01', resource_name: 'prod-postgres-primary', is_breakglass: false, format: 'asciicast', storage_bucket: 'pam-recordings', storage_key: 'org-1/2026/08/rec-380.cast', size_bytes: 512000, sha256: '77aa0c31bb85…d902', status: 'COMPLETED', started_at: iso(-days(1.4)), ended_at: iso(-days(1.35)), duration_seconds: 4320 },
]

// ── models.AuditLog ────────────────────────────────────────────────────────
const auditSeed = [
  ['pam:jit:Approve', 'AUTHZ', 'SUCCESS', 'INFO', 'm.sharma', 'usr-002', 'pam:jit/jit-1003', mins(72)],
  ['pam:vault:Reveal', 'VAULT', 'SUCCESS', 'INFO', 'p.venkatesh', 'usr-007', 'pam:vault/cred-11', mins(84)],
  ['pam:session:Start', 'SESSION', 'SUCCESS', 'INFO', 'a.khan', 'usr-014', 'pam:resource/res-03', mins(17)],
  ['pam:resource:Connect', 'AUTHZ', 'DENIED', 'WARN', 'k.das', 'usr-030', 'pam:resource/res-01', mins(96)],
  ['pam:auth:Login', 'AUTH', 'SUCCESS', 'INFO', 'd.rao', 'usr-016', 'pam:auth', mins(11)],
  ['pam:auth:Login', 'AUTH', 'DENIED', 'WARN', 'n.gupta', 'usr-021', 'pam:auth', mins(140)],
  ['pam:breakglass:Request', 'BREAK_GLASS', 'PENDING', 'CRITICAL', 's.iyer', 'usr-011', 'pam:resource/res-10', mins(6)],
  ['pam:vault:Rotate', 'VAULT', 'SUCCESS', 'INFO', 'automation.rotate', 'usr-040', 'pam:vault/cred-14', hours(6)],
  ['pam:jit:Deny', 'AUTHZ', 'SUCCESS', 'INFO', 'm.sharma', 'usr-002', 'pam:jit/jit-0994', hours(8.4)],
  ['pam:identity:ResetPassword', 'ADMIN', 'SUCCESS', 'WARN', 'j.pillai', 'usr-004', 'pam:identity/usr-030', hours(11)],
  ['pam:session:Kill', 'SESSION', 'SUCCESS', 'WARN', 'm.sharma', 'usr-002', 'pam:session/sess-8990', hours(19)],
  ['pam:vault:Reveal', 'VAULT', 'DENIED', 'WARN', 'k.das', 'usr-030', 'pam:vault/cred-20', hours(21)],
  ['pam:report:Generate', 'REPORT', 'SUCCESS', 'INFO', 'j.pillai', 'usr-004', 'pam:audit/report', hours(26)],
  ['pam:identity:DelegateAdmin', 'ADMIN', 'SUCCESS', 'CRITICAL', 'root', 'usr-root', 'pam:identity/usr-004', days(3)],
]

export const auditEvents = auditSeed.map(([action, category, outcome, severity, username, user_id, resource, ago], i) => ({
  sequence_number: 184_200 - i,
  id: `evt-${184_200 - i}`,
  org_id: 'org-1',
  user_id,
  username,
  email: `${username}@bharatgen.internal`,
  actor_type: username.startsWith('automation') ? 'SERVICE' : 'USER',
  category,
  action,
  outcome,
  severity,
  resource,
  source_ip: '10.4.19.22',
  request_id: `req-${(84_000 + i).toString(16)}`,
  session_id: '',
  prev_hash: `${(0x7f2a + i).toString(16)}…9c41`,
  entry_hash: `${(0x91bd + i).toString(16)}…e07a`,
  hash_version: 1,
  details: '',
  justification: '',
  occurred_at: iso(-ago),
}))

// GET /admin/audit/verify → data.verification
export const auditVerification = {
  verified: true,
  entries_checked: 184_200,
  first_sequence: 1,
  last_sequence: 184_200,
  broken_at: null,
  verified_at: iso(-mins(4)),
}

// ── models.User (+ GET /admin/identity/users/:id → { user, access }) ────────
export const users = [
  { user_id: 'usr-root', username: 'root', email: 'root@bharatgen.internal', full_name: 'System Root', status: 'ACTIVE', mfa_enabled: true, failed_login_attempts: 0, last_login_at: iso(-hours(2)), last_login_ip: '10.4.1.2', is_protected: true, created_at: iso(-days(420)), roles: ['root'] },
  { user_id: 'usr-002', username: 'm.sharma', email: 'm.sharma@bharatgen.internal', full_name: 'Meera Sharma', status: 'ACTIVE', mfa_enabled: true, failed_login_attempts: 0, last_login_at: iso(-mins(26)), last_login_ip: '10.4.2.14', is_protected: false, created_at: iso(-days(380)), roles: ['admin'] },
  { user_id: 'usr-004', username: 'j.pillai', email: 'j.pillai@bharatgen.internal', full_name: 'Jaya Pillai', status: 'ACTIVE', mfa_enabled: true, failed_login_attempts: 0, last_login_at: iso(-hours(5)), last_login_ip: '10.4.2.19', is_protected: false, created_at: iso(-days(300)), roles: ['admin'] },
  { user_id: 'usr-007', username: 'p.venkatesh', email: 'p.venkatesh@bharatgen.internal', full_name: 'Priya Venkatesh', status: 'ACTIVE', mfa_enabled: true, failed_login_attempts: 0, last_login_at: iso(-mins(64)), last_login_ip: '10.4.19.22', is_protected: false, created_at: iso(-days(240)), roles: ['user'] },
  { user_id: 'usr-009', username: 'r.mehta', email: 'r.mehta@bharatgen.internal', full_name: 'Rohan Mehta', status: 'ACTIVE', mfa_enabled: false, failed_login_attempts: 0, last_login_at: iso(-hours(30)), last_login_ip: '10.4.19.51', is_protected: false, created_at: iso(-days(180)), roles: ['user'] },
  { user_id: 'usr-011', username: 's.iyer', email: 's.iyer@bharatgen.internal', full_name: 'Sanjay Iyer', status: 'ACTIVE', mfa_enabled: true, failed_login_attempts: 0, last_login_at: iso(-mins(48)), last_login_ip: '10.4.7.9', is_protected: false, created_at: iso(-days(170)), roles: ['user'] },
  { user_id: 'usr-014', username: 'a.khan', email: 'a.khan@bharatgen.internal', full_name: 'Adil Khan', status: 'ACTIVE', mfa_enabled: true, failed_login_attempts: 0, last_login_at: iso(-mins(22)), last_login_ip: '10.4.22.4', is_protected: false, created_at: iso(-days(150)), roles: ['user', 'data-analyst'] },
  { user_id: 'usr-016', username: 'd.rao', email: 'd.rao@bharatgen.internal', full_name: 'Divya Rao', status: 'ACTIVE', mfa_enabled: false, failed_login_attempts: 1, last_login_at: iso(-mins(11)), last_login_ip: '10.4.31.7', is_protected: false, created_at: iso(-days(120)), roles: ['user', 'db-operator'] },
  { user_id: 'usr-021', username: 'n.gupta', email: 'n.gupta@bharatgen.internal', full_name: 'Nikhil Gupta', status: 'LOCKED', mfa_enabled: true, failed_login_attempts: 5, locked_until: iso(mins(18)), last_login_at: iso(-hours(30)), last_login_ip: '10.4.12.88', is_protected: false, created_at: iso(-days(90)), roles: ['user'] },
  { user_id: 'usr-022', username: 'automation.etl', email: 'etl@bharatgen.internal', full_name: 'ETL Service Account', status: 'ACTIVE', mfa_enabled: false, failed_login_attempts: 0, last_login_at: iso(-hours(3.2)), last_login_ip: '10.6.1.40', is_protected: false, created_at: iso(-days(200)), roles: ['user', 'db-operator'] },
  { user_id: 'usr-030', username: 'k.das', email: 'k.das@bharatgen.internal', full_name: 'Kabir Das', status: 'SUSPENDED', mfa_enabled: true, failed_login_attempts: 0, last_login_at: iso(-hours(19)), last_login_ip: '10.4.22.15', is_protected: false, created_at: iso(-days(70)), roles: ['user'] },
  { user_id: 'usr-040', username: 'automation.rotate', email: 'rotate@bharatgen.internal', full_name: 'Rotation Service Account', status: 'ACTIVE', mfa_enabled: false, failed_login_attempts: 0, last_login_at: iso(-hours(6)), last_login_ip: '10.6.1.41', is_protected: false, created_at: iso(-days(160)), roles: ['user'] },
]

// ── models.Role / models.Policy ────────────────────────────────────────────
export const roles = [
  { id: 'role-1', name: 'root', description: 'Full system bypass. Reserved for the seeded superuser account created at first startup. Cannot be deleted.', is_system: true, created_at: iso(-days(420)) },
  { id: 'role-2', name: 'admin', description: 'Administrative access to the PAM Admin Center: identity management, RBAC/PBAC, resource management, JIT approval, org-wide sessions, and audit.', is_system: true, created_at: iso(-days(420)) },
  { id: 'role-3', name: 'user', description: 'Standard PAM user: request time-boxed access, use the credential vault, connect to resources they hold an active grant for.', is_system: true, created_at: iso(-days(420)) },
  { id: 'role-4', name: 'data-analyst', description: 'Read access to the analytics estate without JIT for non-production stores.', is_system: false, created_at: iso(-days(140)) },
  { id: 'role-5', name: 'db-operator', description: 'Database operations on production stores, always JIT-gated and recorded.', is_system: false, created_at: iso(-days(130)) },
]

export const policies = [
  { id: 'pol-1', name: 'full-access', description: 'Unrestricted access to every PAM action and resource. Attached to the admin role.', effect: 'allow', actions: ['*'], resources: ['*'], is_system: true, created_at: iso(-days(420)) },
  { id: 'pol-2', name: 'standard-user-access', description: 'Baseline actions available to every standard user.', effect: 'allow', actions: ['pam:resource:List', 'pam:resource:Read', 'pam:resource:Connect', 'pam:session:Start', 'pam:session:End', 'pam:vault:List', 'pam:vault:Read', 'pam:vault:Create', 'pam:vault:Store', 'pam:vault:Reveal', 'pam:vault:Rotate', 'pam:jit:Request', 'pam:jit:Cancel', 'pam:audit:Read', 'pam:report:Generate'], resources: ['*'], is_system: true, created_at: iso(-days(420)) },
  { id: 'pol-3', name: 'analytics-read', description: 'Read the analytics estate.', effect: 'allow', actions: ['pam:resource:Read', 'pam:resource:Connect'], resources: ['pam:resource/res-03', 'pam:resource/res-07', 'pam:resource/res-08'], is_system: false, created_at: iso(-days(140)) },
  { id: 'pol-4', name: 'deny-legacy-finance', description: 'Explicit deny on the finance system of record for non-finance roles.', effect: 'deny', actions: ['pam:resource:Connect'], resources: ['pam:resource/res-10'], is_system: false, created_at: iso(-days(100)) },
]

// ── GET /admin/mfa-policy + /compliance ────────────────────────────────────
export const mfaPolicy = {
  rules: [
    { role_name: 'root', mode: 'enforce', grace_period_days: 0, updated_at: iso(-days(90)), updated_by: 'root' },
    { role_name: 'admin', mode: 'enforce', grace_period_days: 0, updated_at: iso(-days(90)), updated_by: 'root' },
    { role_name: 'db-operator', mode: 'grace', grace_period_days: 14, updated_at: iso(-days(12)), updated_by: 'm.sharma' },
    { role_name: 'user', mode: 'monitor', grace_period_days: 0, updated_at: iso(-days(40)), updated_by: 'm.sharma' },
  ],
  modes: ['off', 'monitor', 'grace', 'enforce'],
  summary: { roles_covered: 4, roles_total: 5 },
}

export const mfaCompliance = {
  accounts: users.map((u) => ({
    user_id: u.user_id,
    username: u.username,
    roles: u.roles,
    mfa_enabled: u.mfa_enabled,
    gated: u.roles.some((r) => ['root', 'admin', 'db-operator'].includes(r)),
    would_lock_out: !u.mfa_enabled && u.roles.some((r) => ['root', 'admin', 'db-operator'].includes(r)),
  })),
}

// ── models.Safe / Folder / Credential ──────────────────────────────────────
export const safes = [
  { id: 'safe-1', name: 'production', description: 'Production credentials. Dual-control reveal.', owner_id: 'usr-root', is_default: false, retention_days: 730, created_at: iso(-days(410)) },
  { id: 'safe-2', name: 'analytics', description: 'Analytics estate credentials.', owner_id: 'usr-002', is_default: false, retention_days: 365, created_at: iso(-days(150)) },
  { id: 'safe-3', name: 'default', description: 'Everything not yet filed.', owner_id: 'usr-root', is_default: true, retention_days: 365, created_at: iso(-days(420)) },
]

export const folders = [
  { id: 'fld-1', safe_id: 'safe-1', parent_folder_id: null, name: 'prod-databases', path: '/prod-databases', created_at: iso(-days(400)) },
  { id: 'fld-2', safe_id: 'safe-1', parent_folder_id: 'fld-1', name: 'postgres', path: '/prod-databases/postgres', created_at: iso(-days(400)) },
  { id: 'fld-3', safe_id: 'safe-1', parent_folder_id: 'fld-1', name: 'oracle', path: '/prod-databases/oracle', created_at: iso(-days(390)) },
  { id: 'fld-4', safe_id: 'safe-1', parent_folder_id: null, name: 'applications', path: '/applications', created_at: iso(-days(300)) },
]

export const credentials = [
  { id: 'cred-11', safe_id: 'safe-1', folder_id: 'fld-2', resource_id: 'res-01', name: 'prod-postgres-primary admin', account_name: 'pam_admin', credential_type: 'password', is_breakglass: false, status: 'active', version: 7, last_rotated_at: iso(-days(21)), next_rotation_at: iso(days(9)), rotation_interval_days: 30, created_by: 'usr-root', updated_by: 'usr-040', created_at: iso(-days(210)) },
  { id: 'cred-12', safe_id: 'safe-1', folder_id: 'fld-2', resource_id: 'res-02', name: 'prod-postgres-replica reader', account_name: 'pam_reader', credential_type: 'password', is_breakglass: false, status: 'active', version: 4, last_rotated_at: iso(-days(28)), next_rotation_at: iso(days(2)), rotation_interval_days: 30, created_by: 'usr-root', updated_by: 'usr-040', created_at: iso(-days(210)) },
  { id: 'cred-20', safe_id: 'safe-1', folder_id: 'fld-3', resource_id: 'res-10', name: 'legacy-oracle-fin break-glass', account_name: 'SYS', credential_type: 'password', is_breakglass: true, breakglass_note: 'Finance close emergency only. Every reveal pages the on-call security lead.', status: 'active', version: 2, last_rotated_at: iso(-days(88)), next_rotation_at: iso(-days(2)), rotation_interval_days: 90, created_by: 'usr-root', updated_by: 'usr-root', created_at: iso(-days(400)) },
  { id: 'cred-21', safe_id: 'safe-1', folder_id: 'fld-4', resource_id: 'res-11', name: 'admin-portal service token', account_name: 'svc-admin-portal', credential_type: 'api_key', is_breakglass: false, status: 'active', version: 3, last_rotated_at: iso(-days(15)), next_rotation_at: iso(days(75)), rotation_interval_days: 90, created_by: 'usr-002', updated_by: 'usr-002', created_at: iso(-days(300)) },
  { id: 'cred-13', safe_id: 'safe-2', folder_id: null, resource_id: 'res-03', name: 'analytics-clickhouse operator', account_name: 'ch_operator', credential_type: 'password', is_breakglass: false, status: 'active', version: 2, last_rotated_at: iso(-days(40)), next_rotation_at: null, rotation_interval_days: 0, created_by: 'usr-002', updated_by: 'usr-002', created_at: iso(-days(160)) },
  { id: 'cred-17', safe_id: 'safe-2', folder_id: null, resource_id: 'res-07', name: 'embeddings-qdrant api key', account_name: 'qdrant-svc', credential_type: 'api_key', is_breakglass: false, status: 'active', version: 1, last_rotated_at: null, next_rotation_at: null, rotation_interval_days: 0, created_by: 'usr-004', updated_by: 'usr-004', created_at: iso(-days(80)) },
]

// Credential versions — POST /credentials/:id/versions writes these.
export const credentialVersions = [
  { id: 'ver-7', credential_id: 'cred-11', version: 7, reason: 'Scheduled 30-day rotation', created_by: 'automation.rotate', created_at: iso(-days(21)) },
  { id: 'ver-6', credential_id: 'cred-11', version: 6, reason: 'Scheduled 30-day rotation', created_by: 'automation.rotate', created_at: iso(-days(51)) },
  { id: 'ver-5', credential_id: 'cred-11', version: 5, reason: 'Rotated after p.venkatesh offboarding review', created_by: 'm.sharma', created_at: iso(-days(74)) },
  { id: 'ver-20b', credential_id: 'cred-20', version: 2, reason: 'Rotated after the March incident review', created_by: 'root', created_at: iso(-days(88)) },
  { id: 'ver-20a', credential_id: 'cred-20', version: 1, reason: 'Initial break-glass credential', created_by: 'root', created_at: iso(-days(400)) },
]

// ── models.AgentDevice ─────────────────────────────────────────────────────
export const agentDevices = [
  { id: 'dev-1', user_id: 'usr-007', device_name: 'priya-mbp', status: 'ACTIVE', last_seen_at: iso(-mins(4)), created_at: iso(-days(60)) },
  { id: 'dev-2', user_id: 'usr-007', device_name: 'priya-linux-vm', status: 'ACTIVE', last_seen_at: iso(-days(9)), created_at: iso(-days(120)) },
]

// ── Signed-in identities the mockup can switch between ─────────────────────
export const viewers = {
  root: users.find((u) => u.username === 'root'),
  admin: users.find((u) => u.username === 'm.sharma'),
  user: users.find((u) => u.username === 'p.venkatesh'),
}

// A longer tail of the SAME shape, so views that legitimately derive a
// distribution from real returned rows (e.g. "events per hour, computed from
// the last N entries" — which is what the current DashboardPage already does
// with fetchAuditSample) have enough rows to be meaningful. Same fields, same
// enums; only the timestamps and the actor rotate.
const tailActors = [
  ['m.sharma', 'usr-002'], ['p.venkatesh', 'usr-007'], ['a.khan', 'usr-014'],
  ['s.iyer', 'usr-011'], ['d.rao', 'usr-016'], ['k.das', 'usr-030'],
  ['automation.etl', 'usr-022'], ['j.pillai', 'usr-004'],
]
const tailActions = [
  ['pam:resource:Connect', 'AUTHZ', 'SUCCESS', 'INFO'],
  ['pam:session:Start', 'SESSION', 'SUCCESS', 'INFO'],
  ['pam:session:End', 'SESSION', 'SUCCESS', 'INFO'],
  ['pam:vault:Reveal', 'VAULT', 'SUCCESS', 'INFO'],
  ['pam:auth:Login', 'AUTH', 'SUCCESS', 'INFO'],
  ['pam:resource:Connect', 'AUTHZ', 'DENIED', 'WARN'],
  ['pam:vault:Reveal', 'VAULT', 'DENIED', 'WARN'],
  ['pam:auth:Login', 'AUTH', 'DENIED', 'WARN'],
  ['pam:jit:Request', 'AUTHZ', 'SUCCESS', 'INFO'],
]

for (let i = 0; i < 130; i += 1) {
  const [username, user_id] = tailActors[i % tailActors.length]
  // Co-prime strides against each list length, so actor / action / resource
  // don't fall into lockstep and a filtered view stays varied.
  const [action, category, outcome, severity] = tailActions[(i * 5 + 2) % tailActions.length]
  const seq = 184_186 - i
  const res = resources[(i * 7 + 3) % resources.length]
  auditEvents.push({
    sequence_number: seq,
    id: `evt-${seq}`,
    org_id: 'org-1',
    user_id,
    username,
    email: `${username}@bharatgen.internal`,
    actor_type: username.startsWith('automation') ? 'SERVICE' : 'USER',
    category,
    action,
    outcome,
    severity,
    resource: `pam:resource/${res.id}`,
    resource_name: res.name,
    source_ip: `10.4.${(i % 30) + 1}.${(i * 7) % 200}`,
    request_id: `req-${(70_000 + i).toString(16)}`,
    session_id: '',
    prev_hash: `${(0x4c11 + i).toString(16)}…7b20`,
    entry_hash: `${(0x62df + i).toString(16)}…1af8`,
    hash_version: 1,
    details: '',
    justification: '',
    // Spread across the last 24h, denser in the recent hours — the shape a
    // working day actually produces.
    occurred_at: iso(-mins(6 + i * 10 + (i % 5) * 3)),
  })
}
