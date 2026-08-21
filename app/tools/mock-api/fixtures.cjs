// ---------------------------------------------------------------------------
// Fixtures for the local contract server.
// ---------------------------------------------------------------------------
// Shapes are copied from internal/models/*.go, so every field name here is a
// field the real API actually emits. Values are invented, field names are not.
//
// Deliberately awkward on purpose, because the layout has to survive it:
// long resource names, a 42 character safe description, a user with five
// roles, an audit detail blob, an empty safe, a failed recording.

const ORG = '11111111-1111-4111-8111-111111111111'

function iso(offsetMin) {
  return new Date(Date.now() + offsetMin * 60_000).toISOString()
}

const USERS = [
  {
    user_id: 'u-root-0001', org_id: ORG, username: 'root', email: 'root@bharatgen.dev',
    full_name: 'Root Operator', status: 'ACTIVE', mfa_enabled: true, is_protected: true,
    roles: ['root'], failed_login_attempts: 0, last_login_at: iso(-40), last_login_ip: '10.4.1.9',
    created_at: iso(-525600), updated_at: iso(-1440),
  },
  {
    user_id: 'u-admin-0002', org_id: ORG, username: 'p.raghavan', email: 'priya.raghavan@bharatgen.dev',
    full_name: 'Priya Raghavan', status: 'ACTIVE', mfa_enabled: true, is_protected: false,
    roles: ['admin', 'user'], failed_login_attempts: 0, last_login_at: iso(-12), last_login_ip: '10.4.2.31',
    created_at: iso(-262800), updated_at: iso(-60),
  },
  {
    user_id: 'u-admin-0003', org_id: ORG, username: 'd.okonkwo', email: 'daniel.okonkwo@bharatgen.dev',
    full_name: 'Daniel Okonkwo', status: 'ACTIVE', mfa_enabled: false, is_protected: false,
    roles: ['admin', 'user'], failed_login_attempts: 0, last_login_at: iso(-320), last_login_ip: '10.4.2.44',
    created_at: iso(-175200), updated_at: iso(-4300),
  },
  {
    user_id: 'u-user-0004', org_id: ORG, username: 's.mehta', email: 'sanjana.mehta@bharatgen.dev',
    full_name: 'Sanjana Mehta', status: 'ACTIVE', mfa_enabled: true, is_protected: false,
    roles: ['user', 'data-platform-oncall', 'release-manager', 'reporting-readonly', 'incident-commander'],
    failed_login_attempts: 0, last_login_at: iso(-3), last_login_ip: '10.4.7.102',
    created_at: iso(-87600), updated_at: iso(-3),
  },
  {
    user_id: 'u-user-0005', org_id: ORG, username: 'l.fernandes', email: 'lucas.fernandes@bharatgen.dev',
    full_name: 'Lucas Fernandes', status: 'LOCKED', mfa_enabled: false, is_protected: false,
    roles: ['user'], failed_login_attempts: 5, locked_until: iso(28), last_login_at: iso(-2880),
    last_login_ip: '203.0.113.77', created_at: iso(-43800), updated_at: iso(-30),
  },
  {
    user_id: 'u-user-0006', org_id: ORG, username: 'contractor.svc.ingestion-pipeline',
    email: 'ingestion-pipeline@contractor.example.com',
    full_name: 'Ingestion Pipeline Service Account (Contractor)', status: 'DISABLED',
    mfa_enabled: false, is_protected: false, roles: ['user'], failed_login_attempts: 0,
    last_login_at: null, last_login_ip: null, created_at: iso(-20000), updated_at: iso(-500),
  },
]

const ROLES = [
  { id: 'r-1', org_id: ORG, name: 'root', description: 'Owns the install', is_system: true, created_at: iso(-525600) },
  { id: 'r-2', org_id: ORG, name: 'admin', description: 'Administrative access to the console', is_system: true, created_at: iso(-525600) },
  { id: 'r-3', org_id: ORG, name: 'user', description: 'Baseline self-service access', is_system: true, created_at: iso(-525600) },
  { id: 'r-4', org_id: ORG, name: 'data-platform-oncall', description: 'Break-glass eligible on the analytics estate during a rostered on-call shift', is_system: false, created_at: iso(-90000) },
  { id: 'r-5', org_id: ORG, name: 'release-manager', description: 'Can read release credentials', is_system: false, created_at: iso(-70000) },
  { id: 'r-6', org_id: ORG, name: 'reporting-readonly', description: '', is_system: false, created_at: iso(-50000) },
  { id: 'r-7', org_id: ORG, name: 'incident-commander', description: 'Declares and closes incidents', is_system: false, created_at: iso(-30000) },
]

const POLICIES = [
  { id: 'p-1', org_id: ORG, name: 'pam-read-all', description: 'Read access across every PAM module', effect: 'allow', actions: ['pam:resource:List', 'pam:resource:Read', 'pam:audit:Read'], resources: ['*'], is_system: true, created_at: iso(-525600) },
  { id: 'p-2', org_id: ORG, name: 'vault-reveal-prod', description: 'Reveal production credentials, requires JIT', effect: 'allow', actions: ['pam:vault:Reveal'], resources: ['safe:prod/*'], is_system: false, created_at: iso(-120000) },
  { id: 'p-3', org_id: ORG, name: 'deny-oracle-direct', description: 'Blocks direct Oracle connections outside a grant', effect: 'deny', actions: ['pam:resource:Connect'], resources: ['resource:oracle-*'], is_system: false, created_at: iso(-60000) },
  { id: 'p-4', org_id: ORG, name: 'breakglass-analytics', description: '', effect: 'allow', actions: ['pam:breakglass:Use'], resources: ['resource:clickhouse-analytics-prod-01'], is_system: false, created_at: iso(-20000) },
  // The two policies the real backend seeds at first startup (see
  // opa/policies/default_bundle.json). They are here so the mock classifies
  // root and admin the same way a real install does, rather than reporting
  // the most privileged roles in the product as Low.
  { id: 'p-5', org_id: ORG, name: 'full-access', description: 'Unrestricted access to every PAM action and resource.', effect: 'allow', actions: ['*'], resources: ['*'], is_system: true, created_at: iso(-525600) },
  { id: 'p-6', org_id: ORG, name: 'standard-user-access', description: 'Baseline actions available to every standard user.', effect: 'allow', actions: ['pam:resource:List', 'pam:resource:Read', 'pam:resource:Connect', 'pam:session:Start', 'pam:session:End', 'pam:vault:List', 'pam:vault:Read', 'pam:vault:Create', 'pam:vault:Store', 'pam:vault:Reveal', 'pam:vault:Rotate', 'pam:jit:Request', 'pam:jit:Cancel', 'pam:audit:Read', 'pam:report:Generate'], resources: ['*'], is_system: true, created_at: iso(-525600) },
]

const RESOURCES = [
  { id: 'res-01', vault_entry_id: 'cred-01', org_id: ORG, name: 'postgres-payments-prod-01', resource_type: 'postgresql', host: 'pg-payments-prod-01.internal.bharatgen.dev', port: 5432, database_name: 'payments', description: 'Primary payments ledger, PCI in scope', requires_jit: true, recording_required: true, always_record: true, connect_mode: 'web_terminal', is_active: true, created_at: iso(-200000) },
  { id: 'res-02', vault_entry_id: 'cred-03', org_id: ORG, name: 'clickhouse-analytics-prod-01', resource_type: 'clickhouse', host: 'ch-analytics-prod-01.internal.bharatgen.dev', port: 9000, database_name: 'events', description: '', requires_jit: true, recording_required: true, always_record: false, connect_mode: 'web_terminal', is_active: true, created_at: iso(-180000) },
  { id: 'res-03', org_id: ORG, name: 'mongodb-catalogue-staging', resource_type: 'mongodb', host: 'mongo-catalogue-staging.internal.bharatgen.dev', port: 27017, database_name: 'catalogue', description: 'Staging catalogue, safe to break', requires_jit: false, recording_required: false, always_record: false, connect_mode: 'web_terminal', is_active: true, created_at: iso(-150000) },
  { id: 'res-04', org_id: ORG, name: 'redis-sessions-prod', resource_type: 'redis', host: 'redis-sessions-prod.internal.bharatgen.dev', port: 6379, database_name: '', description: '', requires_jit: true, recording_required: false, always_record: false, connect_mode: 'web_terminal', is_active: true, created_at: iso(-140000) },
  { id: 'res-05', org_id: ORG, name: 'metabase-analytics', resource_type: 'metabase', host: 'metabase.bharatgen.dev', port: 443, database_name: '', description: 'BI console, SSO through the gateway', requires_jit: false, recording_required: false, always_record: false, connect_mode: 'embed_redirect', console_url: 'https://metabase.bharatgen.dev', is_active: true, created_at: iso(-120000) },
  { id: 'res-06', org_id: ORG, name: 'minio-model-artifacts', resource_type: 'minio', host: 'minio-artifacts.internal.bharatgen.dev', port: 9000, database_name: '', description: '', requires_jit: false, recording_required: false, always_record: false, connect_mode: 'web_terminal', is_active: true, created_at: iso(-100000) },
  { id: 'res-07', org_id: ORG, name: 'qdrant-embeddings-prod', resource_type: 'qdrant', host: 'qdrant-prod.internal.bharatgen.dev', port: 6333, database_name: '', description: '', requires_jit: true, recording_required: true, always_record: false, connect_mode: 'web_terminal', is_active: true, created_at: iso(-90000) },
  { id: 'res-08', vault_entry_id: 'cred-04', org_id: ORG, name: 'oracle-billing-legacy-eu-west-1-replica-03', resource_type: 'oracle', host: 'oracle-billing-legacy-eu-west-1-replica-03.internal.bharatgen.dev', port: 1521, database_name: 'BILLING', description: 'Legacy billing replica, decommission tracked in PLAT-4417', requires_jit: true, recording_required: true, always_record: true, connect_mode: 'web_terminal', is_active: false, created_at: iso(-80000) },
  { id: 'res-09', org_id: ORG, name: 'langfuse-traces', resource_type: 'langfuse', host: 'langfuse.bharatgen.dev', port: 443, database_name: '', description: '', requires_jit: false, recording_required: false, always_record: false, connect_mode: 'embed_redirect', console_url: 'https://langfuse.bharatgen.dev', is_active: true, created_at: iso(-60000) },
  { id: 'res-10', org_id: ORG, name: 'admin-portal-web', resource_type: 'web', host: 'admin.bharatgen.dev', port: 443, database_name: '', description: '', requires_jit: true, recording_required: true, always_record: true, connect_mode: 'embed_redirect', console_url: 'https://admin.bharatgen.dev', is_active: true, created_at: iso(-40000) },
]

const SAFES = [
  { id: 'safe-01', org_id: ORG, name: 'prod-databases', description: 'Every production database credential, rotated on a 30 day interval by the platform team', owner_id: 'u-admin-0002', created_at: iso(-200000), updated_at: iso(-1440) },
  { id: 'safe-02', org_id: ORG, name: 'release-signing', description: 'Signing keys and release tokens', owner_id: 'u-admin-0002', created_at: iso(-150000), updated_at: iso(-8000) },
  { id: 'safe-03', org_id: ORG, name: 'contractor-scratch', description: '', owner_id: 'u-admin-0003', created_at: iso(-20000), updated_at: iso(-20000) },
]

const FOLDERS = {
  'safe-01': [
    { id: 'fold-01', safe_id: 'safe-01', name: 'payments', parent_folder_id: null, path: '/payments', created_at: iso(-190000) },
    { id: 'fold-02', safe_id: 'safe-01', name: 'analytics', parent_folder_id: null, path: '/analytics', created_at: iso(-180000) },
  ],
  'safe-02': [{ id: 'fold-03', safe_id: 'safe-02', name: 'ci', parent_folder_id: null, path: '/ci', created_at: iso(-140000) }],
  'safe-03': [],
}

const CREDENTIALS = {
  'safe-01': [
    { id: 'cred-01', safe_id: 'safe-01', folder_id: 'fold-01', account_name: 'payments_app_rw', credential_type: 'password', resource_id: 'res-01', version: 7, rotation_interval_days: 30, last_rotated_at: iso(-14400), next_rotation_at: iso(28800), created_at: iso(-190000), updated_at: iso(-14400) },
    { id: 'cred-02', safe_id: 'safe-01', folder_id: 'fold-01', account_name: 'payments_readonly_reporting_service_account', credential_type: 'connection_string', resource_id: 'res-01', version: 2, rotation_interval_days: 90, last_rotated_at: iso(-60000), next_rotation_at: iso(-1200), created_at: iso(-180000), updated_at: iso(-60000) },
    { id: 'cred-03', safe_id: 'safe-01', folder_id: 'fold-02', account_name: 'clickhouse_etl', credential_type: 'password', resource_id: 'res-02', version: 3, rotation_interval_days: 30, last_rotated_at: iso(-20000), next_rotation_at: iso(23200), created_at: iso(-170000), updated_at: iso(-20000) },
    { id: 'cred-04', safe_id: 'safe-01', folder_id: null, account_name: 'oracle_billing_dba', credential_type: 'password', resource_id: 'res-08', version: 1, rotation_interval_days: 0, last_rotated_at: null, next_rotation_at: null, created_at: iso(-80000), updated_at: iso(-80000) },
  ],
  'safe-02': [
    { id: 'cred-05', safe_id: 'safe-02', folder_id: 'fold-03', account_name: 'ci-release-bot', credential_type: 'api_key', resource_id: null, version: 4, rotation_interval_days: 60, last_rotated_at: iso(-40000), next_rotation_at: iso(46400), created_at: iso(-140000), updated_at: iso(-40000) },
    { id: 'cred-06', safe_id: 'safe-02', folder_id: 'fold-03', account_name: 'artifact-signing-key', credential_type: 'ssh_key', resource_id: null, version: 1, rotation_interval_days: 0, last_rotated_at: null, next_rotation_at: null, created_at: iso(-140000), updated_at: iso(-140000) },
  ],
  'safe-03': [],
}

const JIT_REQUESTS = [
  { id: 'jit-01', org_id: ORG, requester_user_id: 'u-user-0004', requester_username: 's.mehta', resource_id: 'res-01', resource_name: 'postgres-payments-prod-01', request_type: 'STANDARD', status: 'PENDING', justification: 'PLAT-4419: reconcile the duplicate settlement rows reported by finance for 18 August, read only queries against the ledger.', duration_minutes: 60, requested_at: iso(-22), request_expires_at: iso(98), ticket_ref: 'PLAT-4419' },
  { id: 'jit-02', org_id: ORG, requester_user_id: 'u-user-0005', requester_username: 'l.fernandes', resource_id: 'res-02', resource_name: 'clickhouse-analytics-prod-01', request_type: 'STANDARD', status: 'PARTIALLY_APPROVED', justification: 'Backfill the events table for the 17 August ingestion gap.', duration_minutes: 120, requested_at: iso(-140), request_expires_at: iso(40), ticket_ref: 'DATA-882' },
  { id: 'jit-03', org_id: ORG, requester_user_id: 'u-user-0004', requester_username: 's.mehta', resource_id: 'res-02', resource_name: 'clickhouse-analytics-prod-01', request_type: 'BREAKGLASS', status: 'WAITING', justification: 'INC-2211, analytics cluster is refusing writes and the on-call runbook step 6 needs cluster level access.', duration_minutes: 60, requested_at: iso(-6), available_at: iso(9), request_expires_at: iso(54), breakglass_note: 'Paged at 02:14, incident bridge open.', ticket_ref: 'INC-2211' },
  { id: 'jit-04', org_id: ORG, requester_user_id: 'u-user-0004', requester_username: 's.mehta', resource_id: 'res-07', resource_name: 'qdrant-embeddings-prod', request_type: 'STANDARD', status: 'APPROVED', justification: 'Re-index the embeddings collection after the model swap.', duration_minutes: 90, requested_at: iso(-400), decided_at: iso(-380), request_expires_at: iso(-310) },
  { id: 'jit-05', org_id: ORG, requester_user_id: 'u-user-0006', requester_username: 'contractor.svc.ingestion-pipeline', resource_id: 'res-08', resource_name: 'oracle-billing-legacy-eu-west-1-replica-03', request_type: 'STANDARD', status: 'DENIED', justification: 'Scheduled export run.', duration_minutes: 480, requested_at: iso(-1500), decided_at: iso(-1480), decision_reason: 'Automated export must go through the batch service account, not an interactive grant.' },
  { id: 'jit-06', org_id: ORG, requester_user_id: 'u-user-0005', requester_username: 'l.fernandes', resource_id: 'res-03', resource_name: 'mongodb-catalogue-staging', request_type: 'STANDARD', status: 'CANCELLED', justification: 'Not needed after all, the staging reset fixed it.', duration_minutes: 30, requested_at: iso(-2200), decided_at: iso(-2180) },
  { id: 'jit-07', org_id: ORG, requester_user_id: 'u-user-0004', requester_username: 's.mehta', resource_id: 'res-04', resource_name: 'redis-sessions-prod', request_type: 'STANDARD', status: 'EXPIRED', justification: 'Clear the stale session keys flagged by the cache audit.', duration_minutes: 45, requested_at: iso(-5000), request_expires_at: iso(-4880) },
]

const APPROVALS = {
  'jit-02': [
    { id: 'ap-1', jit_request_id: 'jit-02', approver_user_id: 'u-admin-0002', approver_username: 'p.raghavan', approver_rank: 80, decision: 'APPROVE', reason: 'Backfill window agreed with the data team.', decided_at: iso(-130) },
  ],
  'jit-04': [
    { id: 'ap-2', jit_request_id: 'jit-04', approver_user_id: 'u-admin-0002', approver_username: 'p.raghavan', approver_rank: 80, decision: 'APPROVE', reason: 'Routine re-index.', decided_at: iso(-385) },
    { id: 'ap-3', jit_request_id: 'jit-04', approver_user_id: 'u-admin-0003', approver_username: 'd.okonkwo', approver_rank: 80, decision: 'APPROVE', reason: 'Second approval, scope is one collection.', decided_at: iso(-380) },
  ],
  'jit-05': [
    { id: 'ap-4', jit_request_id: 'jit-05', approver_user_id: 'u-root-0001', approver_username: 'root', approver_rank: 100, decision: 'DENY', reason: 'Automated export must go through the batch service account.', decided_at: iso(-1480) },
  ],
}

const GRANTS = [
  { id: 'gr-01', org_id: ORG, jit_request_id: 'jit-04', user_id: 'u-user-0004', username: 's.mehta', resource_id: 'res-07', resource_name: 'qdrant-embeddings-prod', status: 'ACTIVE', is_breakglass: false, granted_at: iso(-40), expires_at: iso(50), granted_by: 'u-admin-0003' },
  { id: 'gr-02', org_id: ORG, jit_request_id: 'jit-03', user_id: 'u-user-0004', username: 's.mehta', resource_id: 'res-02', resource_name: 'clickhouse-analytics-prod-01', status: 'ACTIVE', is_breakglass: true, granted_at: iso(-8), expires_at: iso(52), granted_by: 'u-root-0001' },
  { id: 'gr-03', org_id: ORG, jit_request_id: 'jit-07', user_id: 'u-user-0005', username: 'l.fernandes', resource_id: 'res-04', resource_name: 'redis-sessions-prod', status: 'EXPIRED', is_breakglass: false, granted_at: iso(-5000), expires_at: iso(-4900), granted_by: 'u-admin-0002' },
  { id: 'gr-04', org_id: ORG, jit_request_id: 'jit-06', user_id: 'u-user-0006', username: 'contractor.svc.ingestion-pipeline', resource_id: 'res-03', resource_name: 'mongodb-catalogue-staging', status: 'REVOKED', is_breakglass: false, granted_at: iso(-9000), expires_at: iso(-8500), revoked_at: iso(-8800), revoked_by: 'u-admin-0002', revoke_reason: 'Contract ended.' },
]

const SESSIONS = [
  { id: 'sess-01', org_id: ORG, user_id: 'u-user-0004', username: 's.mehta', resource_id: 'res-07', resource_name: 'qdrant-embeddings-prod', grant_id: 'gr-01', protocol: 'http', status: 'ACTIVE', started_at: iso(-38), source_ip: '10.4.7.102', recording_id: 'rec-01' },
  { id: 'sess-02', org_id: ORG, user_id: 'u-user-0004', username: 's.mehta', resource_id: 'res-02', resource_name: 'clickhouse-analytics-prod-01', grant_id: 'gr-02', protocol: 'tcp', status: 'ACTIVE', started_at: iso(-7), source_ip: '10.4.7.102', recording_id: 'rec-02' },
  { id: 'sess-03', org_id: ORG, user_id: 'u-admin-0002', username: 'p.raghavan', resource_id: 'res-01', resource_name: 'postgres-payments-prod-01', grant_id: null, protocol: 'tcp', status: 'COMPLETED', started_at: iso(-1200), ended_at: iso(-1140), duration_seconds: 3600, source_ip: '10.4.2.31', recording_id: 'rec-03' },
  { id: 'sess-04', org_id: ORG, user_id: 'u-user-0005', username: 'l.fernandes', resource_id: 'res-04', resource_name: 'redis-sessions-prod', grant_id: 'gr-03', protocol: 'tcp', status: 'KILLED', started_at: iso(-4980), ended_at: iso(-4960), duration_seconds: 1200, source_ip: '203.0.113.77', kill_reason: 'Session ran past the approved window.', killed_by: 'u-admin-0002', recording_id: null },
  { id: 'sess-05', org_id: ORG, user_id: 'u-user-0006', username: 'contractor.svc.ingestion-pipeline', resource_id: 'res-03', resource_name: 'mongodb-catalogue-staging', grant_id: 'gr-04', protocol: 'tcp', status: 'FAILED', started_at: iso(-8900), ended_at: iso(-8899), duration_seconds: 42, source_ip: '198.51.100.14', recording_id: null },
]

const RECORDINGS = [
  { id: 'rec-01', session_id: 'sess-01', org_id: ORG, status: 'RECORDING', format: 'asciicast', started_at: iso(-38), size_bytes: 18442, retention_days: 365, storage_bucket: 'pam-recordings', storage_key: 'org/rec-01.cast' },
  { id: 'rec-02', session_id: 'sess-02', org_id: ORG, status: 'PENDING', format: 'asciicast', started_at: iso(-7), size_bytes: 0, retention_days: 365, storage_bucket: 'pam-recordings', storage_key: 'org/rec-02.cast' },
  { id: 'rec-03', session_id: 'sess-03', org_id: ORG, status: 'COMPLETED', format: 'asciicast', started_at: iso(-1200), ended_at: iso(-1140), duration_seconds: 3600, size_bytes: 412553, sha256: 'b9f2c1a4e7d05386ab441fd2c3e9187a5b0d6c4f8e2a9137b6d0c5e4f3a2b1c0', retention_days: 365, storage_bucket: 'pam-recordings', storage_key: 'org/rec-03.cast' },
  { id: 'rec-04', session_id: 'sess-04', org_id: ORG, status: 'FAILED', format: 'asciicast', started_at: iso(-4980), ended_at: iso(-4979), size_bytes: 0, retention_days: 365, storage_bucket: 'pam-recordings', storage_key: '' },
]

// The action vocabulary the REAL backend writes. middleware/audit.go classifies
// every request into a pam:<domain>:<Verb> action (see its classify()), and the
// criticality engine matches a role's granted actions against exactly these
// strings to work out whether anybody is still exercising the role. The mock
// used a friendlier dotted event name here, which meant usage never resolved
// in dev and every role looked dormant. Mirroring the real vocabulary is the
// whole point of this file.
const AUDIT_ACTIONS = [
  ['JIT', 'pam:jit:Request', 'SUCCESS', 'INFO'],
  ['JIT', 'pam:jit:Request', 'SUCCESS', 'INFO'],
  ['JIT', 'pam:jit:Cancel', 'DENIED', 'WARN'],
  ['VAULT', 'pam:vault:Reveal', 'SUCCESS', 'WARN'],
  ['VAULT', 'pam:vault:Rotate', 'SUCCESS', 'INFO'],
  ['SESSION', 'pam:session:Start', 'SUCCESS', 'INFO'],
  ['SESSION', 'pam:session:Kill', 'SUCCESS', 'WARN'],
  ['AUTH', 'pam:auth:Login', 'SUCCESS', 'INFO'],
  ['AUTH', 'pam:auth:Login', 'FAILURE', 'WARN'],
  ['AUTHZ', 'pam:resource:Connect', 'DENIED', 'WARN'],
  ['BREAK_GLASS', 'pam:breakglass:Use', 'SUCCESS', 'CRITICAL'],
  ['ADMIN', 'pam:auth:Me', 'SUCCESS', 'INFO'],
  ['RESOURCE', 'pam:resource:Read', 'SUCCESS', 'INFO'],
  ['RESOURCE', 'pam:resource:List', 'SUCCESS', 'INFO'],
  ['VAULT', 'pam:vault:List', 'SUCCESS', 'INFO'],
  ['SESSION', 'pam:session:End', 'SUCCESS', 'INFO'],
  ['AUDIT', 'pam:audit:Read', 'SUCCESS', 'INFO'],
]

const AUDIT = Array.from({ length: 137 }, (_, i) => {
  const [category, action, outcome, severity] = AUDIT_ACTIONS[i % AUDIT_ACTIONS.length]
  const actor = USERS[i % USERS.length]
  const res = RESOURCES[i % RESOURCES.length]
  return {
    id: `aud-${String(i + 1).padStart(4, '0')}`,
    org_id: ORG,
    sequence_number: 4820 - i,
    // Spread across roughly three months. The old 17 minute step packed 137
    // events into 39 hours, which made every window look identically busy and
    // meant nothing could ever fall outside the 90 day dormancy review.
    occurred_at: iso(-(i * 900 + 2)),
    actor_type: 'USER',
    // USERS rows key on user_id, not id. This read undefined, so every audit
    // row was unattributable and no usage lookup could ever match a holder.
    user_id: actor.user_id,
    username: actor.username,
    category,
    action,
    outcome,
    severity,
    resource: `resource:${res.name}`,
    resource_id: res.id,
    resource_type: res.resource_type,
    source_ip: actor.last_login_ip || '10.4.0.1',
    user_agent: 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36',
    session_id: i % 5 === 0 ? 'sess-03' : null,
    request_id: `req-${String(i + 1).padStart(6, '0')}`,
    authz_allowed: outcome === 'SUCCESS',
    authz_decision_id: `dec-${String(i + 1).padStart(6, '0')}`,
    details: {
      reason: outcome === 'DENIED' ? 'No active grant covers this resource' : 'Policy pam-read-all matched',
      duration_minutes: 60,
      ticket_ref: 'PLAT-4419',
    },
    prev_hash: `0000${(i + 1).toString(16).padStart(60, 'a')}`,
    entry_hash: `0000${(i + 2).toString(16).padStart(60, 'b')}`,
    hash_version: 1,
  }
})

const AGENT_DEVICES = [
  { id: 'dev-01', device_name: 'sanjana-macbook-pro', user_id: 'u-user-0004', status: 'ACTIVE', last_seen_at: iso(-4), activated_at: iso(-40000), created_at: iso(-40000) },
  { id: 'dev-02', device_name: 'ops-jump-host-01', user_id: 'u-user-0004', status: 'REVOKED', last_seen_at: iso(-9000), activated_at: iso(-90000), revoked_at: iso(-8000), created_at: iso(-90000) },
]

const MFA_RULES = [
  { role_name: 'root', mode: 'enforce', grace_hours: 0, reason: 'Root always carries a second factor.', updated_at: iso(-40000), updated_by: 'root' },
  { role_name: 'admin', mode: 'enforce', grace_hours: 72, reason: 'Rolling out to the admin group this quarter.', updated_at: iso(-2000), updated_by: 'root' },
  { role_name: 'data-platform-oncall', mode: 'monitor', grace_hours: 0, reason: '', updated_at: iso(-500), updated_by: 'p.raghavan' },
]

module.exports = {
  ORG, iso, USERS, ROLES, POLICIES, RESOURCES, SAFES, FOLDERS, CREDENTIALS,
  JIT_REQUESTS, APPROVALS, GRANTS, SESSIONS, RECORDINGS, AUDIT, AGENT_DEVICES,
  MFA_RULES,
}
