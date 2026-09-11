// pam/cmd/pam-api/main.go
//
// Entry point for the merged PAM backend. Wires together all three original
// feature branches plus the Admin Center added afterward:
//
//   - team-vault:  auth/JWT/MFA, the hardened envelope vault (Safes/Folders/
//     Credentials), password policy, automated rotation,
//     encrypted backup/restore.
//   - team-audit:  the tamper-evident HMAC-SHA256 audit chain, searchable
//     audit logs, compliance report export (PDF/CSV), periodic
//     chain verification.
//   - team-jit:    JIT access request workflow, time-boxed grants with
//     auto-revoke, break-glass emergency access.
//   - admin-center: PAM's own Identity Management (RBAC/PBAC), an embedded
//     policy engine (opa/engine.go) replacing the external IAM
//     service entirely, and the central Admin Center surface for
//     resource management, JIT approval, org-wide sessions, and
//     the full audit trail.
//
// PAM depends on no other running service. Authentication (password + TOTP
// MFA) and authorization (RBAC/PBAC via the embedded policy engine) are both
// fully local — see internal/services/auth_service.go and
// internal/services/policy_engine_service.go.
//
// Construction order matters in one place: auditService must exist before
// jitService, because every JIT state change writes an audit row inside the
// SAME transaction as the state change itself (see services/jit_service.go).
package main

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	"github.com/yourorg/pam/internal/agentdist"
	"github.com/yourorg/pam/internal/api/handlers"
	"github.com/yourorg/pam/internal/config"
	"github.com/yourorg/pam/internal/database"
	"github.com/yourorg/pam/internal/gateway"
	"github.com/yourorg/pam/internal/middleware"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/recorder"
	"github.com/yourorg/pam/internal/services"
	"github.com/yourorg/pam/internal/services/graph"
	"github.com/yourorg/pam/internal/webproxy"
	pamjwt "github.com/yourorg/pam/pkg/jwt"
	"go.uber.org/zap"
)

func main() {
	// ── Load .env file into OS environment (Go doesn't do this automatically) ──
	// Try: current dir → parent (project root) → ../..
	godotenv.Load()
	godotenv.Load("../.env")
	godotenv.Load("../../.env")

	// ── Logger ──
	var logger *zap.Logger
	var err error
	if os.Getenv("PAM_SERVER_ENV") == "production" {
		logger, _ = zap.NewProduction()
		gin.SetMode(gin.ReleaseMode)
	} else {
		logger, _ = zap.NewDevelopment()
	}
	defer logger.Sync()

	// ── Config ──
	cfg, err := config.Load()
	if err != nil {
		logger.Fatal("config.load.fail", zap.Error(err))
	}

	// Envelope vault uses local-dev KMS with PAM_VAULT_ENCRYPTION_KEY as master KEK.
	// (No AWS/Azure required for development.)
	if os.Getenv("PAM_KMS_PROVIDER") == "" {
		_ = os.Setenv("PAM_KMS_PROVIDER", "local-dev")
	}
	if os.Getenv("PAM_ENV") == "" {
		_ = os.Setenv("PAM_ENV", cfg.Server.Env)
	}

	// ── Database ──
	db, err := database.Connect(cfg.Database)
	if err != nil {
		logger.Fatal("db.connect.fail", zap.Error(err))
	}

	// AutoMigrate PAM-specific tables. Automatic outside production, because
	// that is what makes a fresh checkout run; opt-in inside it, because
	// automigration can silently widen a column or add a nullable one in a
	// way nobody reviewed.
	//
	// The opt-in matters: production used to skip this block outright, and
	// nothing else in the tree creates these tables, so a first production
	// deploy against an empty database died a few lines below on
	// "relation pam.pam_audit_log does not exist" with no way forward.
	// PAM_DATABASE_AUTO_MIGRATE=true is that way forward: set it once to
	// create the schema, then take it back off.
	if cfg.ShouldAutoMigrate() {
		if err := db.AutoMigrate(
			// ── Identity, RBAC & PBAC (Admin Center) ──
			// User now lives here too: it used to be a read-only mirror of
			// an external IAM service's table and was deliberately excluded
			// from PAM's own migrations. That dependency is gone — PAM owns
			// user lifecycle end to end now (see identity_service.go).
			&models.User{},
			&models.Role{},
			&models.Policy{},
			&models.UserRole{},
			&models.RolePolicy{},
			&models.UserPolicy{},

			// ── Auth / MFA ──
			&models.PAMMFA{},
			&models.PAMMFABackupCode{},
			&models.PAMUserSession{},

			// ── Resources & connection sessions ──
			&models.PAMResource{},
			&models.Notification{},
			&models.RefreshToken{},
			// Machine data plane. Without these the service identity, its
			// tokens and its path grants have no tables, and every machine
			// read fails at the database layer rather than at authorization,
			// which is a confusing way to discover a missing migration.
			&models.ServiceIdentity{},
			&models.ServiceToken{},
			&models.ServiceGrant{},
			&models.ConnectionSession{},

			// ── Brokered web-application gateway (internal/webproxy) ──
			&models.WebProxySession{},
			&models.WebProxyActivity{},

			// ── Vault (envelope-encrypted credential store) ──
			&models.Safe{},
			&models.Folder{},
			&models.Credential{},
			&models.CredentialVersion{},
			&models.PasswordPolicy{},

			// ── Automated rotation ──
			&models.RotationJob{},
			&models.RotationDependency{},
			&models.RotationHistory{},

			// ── JIT access workflow + time-boxed grants ──
			&models.JITRequest{},
			&models.AccessGrant{},

			// NOTE: the four-eyes and role-criticality tables are NOT listed
			// here. They are additive tables their own features own, and they
			// migrate unconditionally further down, so a production boot that
			// has this block switched off still gets them. See there.

			// ── Tamper-evident audit chain + session recording metadata ──
			&models.AuditLog{},
			&models.SessionRecording{},
			&models.SessionRecordingCommand{},

			// ── Local agent (native desktop/CLI launch) ──
			&models.AgentDevice{},
			&models.AgentPairingCode{},
			&models.LaunchToken{},
		); err != nil {
			// A failed migration leaves the schema in an unknown state — refuse
			// to serve rather than fail later on the first privileged request.
			logger.Fatal("db.migrate.fail", zap.Error(err))
		}
		logger.Info("db.migrated.pam_tables",
			zap.Bool("production", cfg.IsProduction()),
		)
	} else if err := database.AssertSchemaPresent(db, cfg.Database.Schema); err != nil {
		// Nothing in this process is going to create the schema, so say that
		// plainly here rather than letting the next statement fail on a raw
		// SQLSTATE that reads like a database outage.
		logger.Fatal("db.schema.missing",
			zap.Error(err),
			zap.String("schema", cfg.Database.Schema),
			zap.String("database", cfg.Database.Name),
			zap.String("fix", "run the schema migration, or set PAM_DATABASE_AUTO_MIGRATE=true for one boot to create it"),
		)
	}

	// The audit log's full-text search (Feature 107, audit_query_service.go's
	// Search()) queries a generated tsvector column that AutoMigrate cannot
	// create — see EnsureAuditSearchVector's doc comment. This runs in every
	// environment (including production), unlike AutoMigrate above, because
	// it is a fixed, reviewed, idempotent DDL statement rather than
	// schema-inference from Go structs.
	if err := database.EnsureAuditSearchVector(db, cfg.Database.Schema); err != nil {
		logger.Fatal("audit_search_vector.migrate.fail", zap.Error(err))
	}

	// ── Seed the default RBAC/PBAC bundle + bootstrap root account ──
	// Idempotent: safe to run on every startup against an already-seeded
	// database. See opa/policies/default_bundle.json for exactly what gets
	// created, and internal/services/seed_service.go for the upsert logic.
	if err := services.SeedRBACDefaults(db, logger); err != nil {
		logger.Fatal("seed.rbac.fail", zap.Error(err))
	}
	if err := services.SeedRootAccount(db, cfg.IsProduction(), logger); err != nil {
		logger.Fatal("seed.root_account.fail", zap.Error(err))
	}
	// The safe every credential falls back to. Without it, anything attached
	// from the Resources screen points at a safe id with no row behind it and
	// never appears in the Vault. See SeedDefaultSafe.
	if err := services.SeedDefaultSafe(db, logger); err != nil {
		logger.Fatal("seed.default_safe.fail", zap.Error(err))
	}

	// ── PAM JWT Issuer (HS256, self-signed) ──
	jwtIssuer := pamjwt.New(
		cfg.JWT.SecretKey,
		"pam.yourorg.com",
		cfg.JWT.AccessTTLMin,
		cfg.JWT.RefreshTTLDays,
	)

	// ── Embedded policy engine (PDP) — replaces the external IAM service ──
	// See opa/engine.go for why this is a small hand-written engine rather
	// than a dependency on the upstream OPA Go module, and
	// policy_engine_service.go for how it resolves a user's RBAC/PBAC
	// policies before evaluating.
	policyEngine := services.NewPolicyEngineService(db, logger)

	// ── Audit service (must exist before JIT — see package doc comment) ──
	hmacSecret := []byte(cfg.Audit.HMACSecret)
	if !cfg.IsProduction() && len(hmacSecret) == 0 {
		hmacSecret = []byte("dev-only-do-not-use-in-prod-32bytes!!")
		logger.Warn("audit.hmac_secret.using_dev_fallback")
	}
	auditService := services.NewAuditService(db, hmacSecret, cfg.Audit.DefaultOrg, logger)
	auditQuery := services.NewAuditQueryService(db)
	reportSvc := services.NewReportService(auditQuery, auditService)

	verifyJob := services.NewAuditVerificationJob(
		auditService,
		time.Duration(cfg.Audit.VerifyIntervalMinutes)*time.Minute,
		logger,
	)
	verifyJob.Start()
	defer verifyJob.Stop()

	// ── Core services ──
	authService := services.NewAuthService(
		db, jwtIssuer, policyEngine, cfg.Vault.EncryptionKey,
		cfg.Security.MaxLoginAttempts,
		cfg.Security.LockoutMinutes,
		logger,
	)
	resourceService := services.NewResourceService(db, logger)

	// Session-recording storage backend (DAM — see internal/recorder and
	// internal/gateway). AES-256-GCM-encrypted at rest reusing the same
	// PAM_VAULT_ENCRYPTION_KEY already required for everything else this
	// codebase encrypts (vault credentials, MFA/TOTP seeds) — recordings are
	// session transcripts of privileged access and deserve the same bar, not
	// a second key to provision and rotate. An empty encryption key is only
	// possible in non-production (see config.validate) and is logged loudly
	// here as a compliance gap rather than silently accepted.
	//
	// Backend choice (PAM_RECORDING_BACKEND) picks LocalStorage (default —
	// this server's own filesystem) or MinIOStorage (a real SigV4-signed
	// client against PAM_S3_* — see internal/recorder/minio_storage.go, and
	// contrast with backup_service.go's unsigned S3 PUT/GET). Keystroke/
	// command logs never touch this backend either way — they're always
	// Postgres rows via ResourceService.AppendRecordingCommand.
	var recordingStorage recorder.Storage
	switch cfg.Recording.Backend {
	case "minio", "s3":
		recordingStorage, err = recorder.NewMinIOStorage(
			context.Background(),
			cfg.S3.Endpoint, cfg.S3.AccessKey, cfg.S3.SecretKey, cfg.S3.Region, cfg.S3.Bucket, cfg.S3.UseSSL,
			cfg.Vault.EncryptionKey,
		)
		if err != nil {
			logger.Fatal("recording.storage.init.fail", zap.String("backend", cfg.Recording.Backend), zap.Error(err))
		}
		logger.Info("recording.storage.backend", zap.String("backend", "minio"), zap.String("bucket", cfg.S3.Bucket))
	default:
		recordingStorage, err = recorder.NewLocalStorage(cfg.Recording.StorageDir, cfg.Vault.EncryptionKey)
		if err != nil {
			logger.Fatal("recording.storage.init.fail", zap.String("backend", "local"), zap.Error(err))
		}
		logger.Info("recording.storage.backend", zap.String("backend", "local"), zap.String("dir", cfg.Recording.StorageDir))
	}
	if cfg.Vault.EncryptionKey == "" {
		logger.Warn("recording.storage.unencrypted",
			zap.String("impact", "session recordings are being written WITHOUT encryption at rest"))
	}

	// Close out anything left ACTIVE/RECORDING by a previous instance of this
	// process crashing or being killed. Must run exactly once, here at
	// startup before the server accepts connections — see the doc comment on
	// ReconcileStaleSessionsOnStartup for why a currently-ACTIVE row can only
	// mean that at this exact point in the process lifecycle.
	if _, _, err := resourceService.ReconcileStaleSessionsOnStartup(context.Background()); err != nil {
		logger.Error("session.reconcile_stale_on_startup.fail", zap.Error(err))
	}

	// Hardened vault (envelope) — uses PAM_VAULT_ENCRYPTION_KEY via local-dev KMS.
	vaultService, err := services.NewVaultService(db, cfg.Vault.EncryptionKey, logger)
	if err != nil {
		logger.Fatal("vault.init.fail", zap.Error(err))
	}
	rotationService := services.NewRotationService(db, vaultService, logger)

	// ONE CREDENTIAL STORE. The Resources screen files its credentials in the
	// vault rather than keeping a second, weaker copy of the encryption logic
	// of its own. See ResourceService.WithVault for what the second one was
	// and what it broke.
	resourceService.WithVault(vaultService)

	// ── MACHINE DATA PLANE ────────────────────────────────────────────────
	//
	// Applications never hold a human session. They authenticate as a service
	// identity with a service token and read secrets through path-scoped
	// grants, which is a different plane from the console's JWT + MFA + OPA
	// path and shares nothing with it but the vault itself.
	//
	// THE PEPPER IS DERIVED, NOT DEFAULTED, in development. A literal fallback
	// committed to the tree is how the vault encryption key ended up being a
	// published constant; deriving it from the encryption key gives a dev run
	// determinism (tokens minted in one run still verify in the next) without
	// a usable secret existing in source. config.validate() refuses to start
	// production without a real pepper, so this branch cannot be reached there.
	tokenPepper := []byte(cfg.Vault.ServiceTokenPepper)
	if len(tokenPepper) < 32 {
		sum := sha256.Sum256([]byte("pam.service-token-pepper.dev|" + cfg.Vault.EncryptionKey))
		tokenPepper = sum[:]
		logger.Warn("service_token.pepper.using_dev_derivation",
			zap.String("action", "set PAM_VAULT_SERVICE_TOKEN_PEPPER of at least 32 bytes before production"))
	}

	serviceIdentitySvc, err := services.NewServiceIdentityService(db, tokenPepper, auditService, logger)
	if err != nil {
		logger.Fatal("service_identity.init.fail", zap.Error(err))
	}

	secretAccessSvc := services.NewSecretAccessService(
		db,
		vaultService.KMS(),
		serviceIdentitySvc,
		auditService,
		cfg.Vault.DefaultSecretTTLSec,
		logger,
	)

	// Start Automated Rotation Background Scheduler (Cron)
	_ = rotationService.StartCronScheduler(context.Background())

	// JIT service depends on audit + resource, so it is constructed last.
	// The IAM projection client is passed as nil deliberately: PAM's JIT
	// grants no longer project themselves into any external system (there
	// is nothing to project into) — every call site inside jit_service.go
	// already treats a nil/unconfigured client as "skip this, PAM is the
	// sole source of truth," which is exactly the desired behaviour here.
	jitService := services.NewJITService(db, auditService, resourceService, nil, cfg.JIT, logger)

	// Local agent (native desktop/CLI launch) — depends on resourceService
	// for credential resolution and grant-aware tracked-session creation
	// (StartTrackedSession), exactly like the browser session gateway.
	// recordingStorage is shared with the browser gateway below — a
	// ConPTY-capable agent uploads its locally-captured recording through
	// this same storage backend (see AgentService.UploadLaunchRecording).
	agentService := services.NewAgentService(db, resourceService, recordingStorage, auditService, logger)

	// Brokered web-application gateway — the "open in browser, already
	// logged in" path. Establishes the target's session server-side and
	// reverse-proxies the app under its own subdomain, so the target's
	// credential and session cookie never reach the browser at all. See
	// internal/webproxy's package docs for the full trust model.
	webProxyService := webproxy.NewService(
		db, resourceService, auditService, cfg.WebProxy, cfg.Vault.EncryptionKey,
		recordingStorage, cfg.Recording.MaxCastBytes, cfg.Recording.MaxReplayBytes, logger)

	// Same startup-reconciliation rationale as
	// ReconcileStaleSessionsOnStartup above: a brokered web session left
	// ACTIVE by a crashed process has no owner to close it, and would
	// otherwise sit there holding a decrypted-on-demand upstream credential
	// until its full TTL elapsed.
	// State the EFFECTIVE config out loud, once, at boot.
	//
	// Every brokered session is routed by Host header alone, so a base domain
	// that does not match the hostname the load balancer actually delivers
	// produces a symptom that looks like anything but a config problem: DNS
	// resolves, TLS verifies, the request reaches this process, and it answers
	// a bare 404 from NoRoute because IsProxyHost said no. Nothing in that
	// chain names the setting responsible.
	//
	// This line is deliberately logged whether the proxy is on or off, and
	// prints the values AFTER normalisation (lower-cased, dots trimmed), so
	// "what is this process actually configured with" is answerable from the
	// container log in one look instead of by inference from the outside.
	logger.Info("webproxy.effective_config",
		zap.Bool("enabled", cfg.WebProxy.Enabled),
		zap.String("base_domain", cfg.WebProxy.BaseDomain),
		zap.String("scheme", cfg.WebProxy.Scheme),
		zap.Int("public_port", cfg.WebProxy.PublicPort),
		zap.Strings("reserved_subdomains", cfg.WebProxy.ReservedSubdomains),
		zap.String("sessions_served_at", func() string {
			if !cfg.WebProxy.Enabled {
				return "(disabled — set PAM_WEBPROXY_ENABLED=true)"
			}
			if cfg.WebProxy.BaseDomain == "" {
				return "(no base domain — set PAM_WEBPROXY_BASE_DOMAIN)"
			}
			return "<slug>." + cfg.WebProxy.BaseDomain
		}()))

	if cfg.WebProxy.Enabled {
		if _, err := webProxyService.ReconcileExpired(context.Background()); err != nil {
			logger.Error("webproxy.reconcile_on_startup.fail", zap.Error(err))
		}
		logger.Info("webproxy.enabled",
			zap.String("base_domain", cfg.WebProxy.BaseDomain),
			zap.String("scheme", cfg.WebProxy.Scheme),
			zap.Int("public_port", cfg.WebProxy.PublicPort),
			zap.Int("session_ttl_min", cfg.WebProxy.SessionTTLMin),
			zap.Int("idle_timeout_min", cfg.WebProxy.IdleTimeoutMin))

		// The launch URL is built from base_domain + public_port. Serving the
		// API on a non-default port while leaving public_port unset produces
		// URLs pointing at 80/443, where nothing is listening — and the
		// failure surfaces in the operator's browser as a blank tab, several
		// layers away from the cause. Warn loudly at the one moment someone
		// is reading the log.
		if cfg.WebProxy.PublicPort == 0 && cfg.Server.Port != "80" && cfg.Server.Port != "443" {
			logger.Warn("webproxy.public_port.unset",
				zap.String("server_port", cfg.Server.Port),
				zap.String("impact", "brokered session launch URLs will omit the port and point at "+
					"80/443; set PAM_WEBPROXY_PUBLIC_PORT="+cfg.Server.Port+
					" unless a reverse proxy fronts this server on a default port"))
		}
	}

	// ── Identity / RBAC / PBAC services (Admin Center) ──
	identityService := services.NewIdentityService(db, logger)
	roleService := services.NewRoleService(db, logger)
	policyService := services.NewPolicyService(db, logger)

	// ── Role-gated MFA policy ──
	// policyEngine satisfies services.RoleResolver (RoleNamesForUser), which
	// is the only thing this needs: the rules are keyed by role name, so the
	// policy cannot be evaluated without resolving the actor's roles first.
	// It migrates its own rule table in the constructor.
	mfaPolicyService := services.NewMFAPolicyService(db, policyEngine, logger)
	// Seeded HERE, not beside the other seeders above: NewMFAPolicyService is
	// what creates pam_mfa_policy_rules, so seeding earlier writes into a table
	// that does not exist yet.
	//
	// Not fatal. A missing default leaves the install exactly as it was before
	// this seeder existed, which is a weaker posture but a working server;
	// refusing to boot over it would be the wrong trade.
	if err := services.SeedMFAPolicyDefaults(db, logger); err != nil {
		logger.Error("seed.mfa_policy.fail", zap.Error(err))
	}

	// Role-gated MFA is only a control once LOGIN consults it. Without this
	// line the rules are stored, rendered in the console, and never enforced:
	// a user in a gated role who never enrolled signs straight in, because the
	// pre-existing check only challenges accounts that ALREADY hold a factor.
	authService.SetMFAPolicy(mfaPolicyService)

	// ── Role criticality ──
	// Audited, because changing how critical a role is changes who the
	// privilege graph reports as dangerous — that is a security-relevant
	// edit and belongs in the chain like any other.
	roleCriticalityService := services.NewRoleCriticalityService(db, auditService, logger)
	if err := roleCriticalityService.Migrate(); err != nil {
		logger.Error("role_criticality.migrate.fail", zap.Error(err))
	}

	// Four-eyes decision trail, migrated OUTSIDE the !IsProduction() block
	// above — deliberately, and this is not a shortcut around the reviewed-SQL
	// rule that block exists to enforce.
	//
	// pam_jit_approvals is a new, additive table with no foreign keys and no
	// effect on any existing column. Every JIT approval INSERTs into it inside
	// the approval transaction, so if the table is absent the insert fails and
	// the whole transaction rolls back: approving access would be broken
	// outright, not degraded. Leaving its creation to a separate migration
	// step means one forgotten step takes JIT approval down in production.
	//
	// This is fatal rather than logged: a running server that cannot record an
	// approval decision must not accept approvals, because the decision trail
	// IS the control — quorum is derived from these rows.
	if err := db.AutoMigrate(&models.JITApproval{}); err != nil {
		logger.Fatal("jit_approvals.migrate.fail",
			zap.Error(err),
			zap.String("impact", "four-eyes approval cannot function without pam_jit_approvals"))
	}

	// ── Identity / privilege-path graph ──
	// Snapshot-based: building the graph walks the whole identity model, so
	// it is far too heavy to do per-request. Handlers read the last snapshot
	// and report its age (see PrivPathHandler.withFreshness); the job below
	// keeps it current.
	privPathService := graph.NewPrivilegePathService(db, graph.DefaultTierRules(), logger)

	// ── Handlers ──
	// The console reads its own MFA posture off /auth/me (see the handler for
	// why it cannot come from the login response alone). Resolved live from
	// the policy rules and the device table, with the roles the request
	// arrived with, so a rule attached a minute ago reaches an open session.
	mfaPostureFor := func(userID string, roles []string) (handlers.MFAPosture, error) {
		var mfa models.PAMMFA
		enrolled := db.Where("user_id = ?", userID).First(&mfa).Error == nil && mfa.Status == "ACTIVE"
		d, err := mfaPolicyService.Evaluate(userID, roles, enrolled, time.Now().UTC())
		if err != nil {
			return handlers.MFAPosture{}, err
		}
		p := handlers.MFAPosture{
			Required:          d.Required,
			Mode:              d.Mode,
			Enrolled:          enrolled,
			EnrolmentRequired: d.Block,
			PolicyRoles:       d.MatchedRoles,
			GraceUntil:        d.GraceUntil,
		}
		// The device row already carries when it went live, so the console can
		// say "since 3 March" rather than only "on".
		if enrolled {
			p.EnrolledAt = mfa.ActivatedAt
		}
		return p, nil
	}

	authHandler := handlers.NewAuthHandler(authService, mfaPostureFor, logger).
		WithDelegationScope(identityService.DelegationScopeFor).
		WithIdleTimeout(cfg.JWT.IdleTimeoutMin)
	resourceHandler := handlers.NewResourceHandler(resourceService, agentService, policyEngine, cfg.WebProxy.Enabled, logger)
	vaultHandler := handlers.NewVaultHandler(vaultService, rotationService, cfg.S3, logger)
	secretAccessHandler := handlers.NewSecretAccessHandler(secretAccessSvc, logger)
	serviceIdentityHandler := handlers.NewServiceIdentityHandler(serviceIdentitySvc, logger)
	auditHandler := handlers.NewAuditHandler(auditQuery, reportSvc, auditService, logger)
	notificationService := services.NewNotificationService(db, logger)
	// Attached after construction because JITService is built long before this
	// point (it is a dependency of the middleware wired above) and neither
	// service may take the other in its constructor. The sweeper's expiry and
	// timeout notifications go through this; without it they are silently
	// skipped rather than failing.
	jitService.SetNotifier(notificationService)
	notificationHandler := handlers.NewNotificationHandler(notificationService, logger)
	jitHandler := handlers.NewJITHandler(jitService, notificationService, identityService.ApproverUserIDs, logger)
	sessionHandler := handlers.NewSessionHandler(resourceService, auditService, logger)
	adminHandler := handlers.NewAdminHandler(jitService, resourceService, auditService, recordingStorage, logger)
	identityHandler := handlers.NewIdentityHandler(identityService, logger)
	roleHandler := handlers.NewRoleHandler(roleService, logger)
	policyHandler := handlers.NewPolicyHandler(policyService, logger)
	agentHandler := handlers.NewAgentHandler(agentService, cfg.Server.PublicURL, logger)

	// One-click agent enrolment. The store scans the configured directory
	// once at boot (hashing each binary, so an installer can pin the exact
	// bytes it expects); an unset directory disables the feature and the
	// console falls back to manual pairing instructions rather than showing
	// a platform button that would 404.
	agentBinaries := agentdist.NewStore(cfg.Agent.BinaryDir, logger)
	agentInstallHandler := handlers.NewAgentInstallHandler(
		agentHandler, agentBinaries, cfg.Agent.EnrolTTLMinutes, logger)
	webProxyHandler := handlers.NewWebProxyHandler(webProxyService, logger)
	mfaPolicyHandler := handlers.NewMFAPolicyHandler(mfaPolicyService, logger)
	roleCriticalityHandler := handlers.NewRoleCriticalityHandler(roleCriticalityService, logger)
	privPathHandler := handlers.NewPrivPathHandler(privPathService, logger)
	webProxyGateway := webproxy.NewHandler(webProxyService, logger)

	// In-browser terminal (redis/postgresql/mongodb) — the WebSocket gateway
	// that actually captures the screen recording + keystroke/command log
	// for any session it brokers. See internal/gateway's doc comment for why
	// this exists as a third connection path alongside the console-link and
	// native-agent methods above.
	gatewayHandler := gateway.NewHandler(resourceService, auditService, cfg.Server.AllowedOrigins, recordingStorage, cfg.Recording.MaxCastBytes, logger)

	// ── Auto-revocation worker (expiry, break-glass activation) ──
	sweeperCtx, stopSweeper := context.WithCancel(context.Background())
	defer stopSweeper()
	sweeper := services.NewSweeper(jitService, resourceService,
		time.Duration(cfg.JIT.SweepIntervalSec)*time.Second, logger)
	// Brokered web sessions age out (max lifetime) and go idle (abandoned
	// browser tab) on the same cadence grants expire on — an abandoned tab
	// must not hold privileged access open indefinitely.
	if cfg.WebProxy.Enabled {
		sweeper.Register(webProxyService)
	}
	// Keep the privilege-path snapshot fresh. Six hours by default (NewJob's
	// own fallback): the graph answers "who could reach the crown jewels",
	// which changes when roles and grants change, not second to second. An
	// admin who needs it now has POST .../privilege-paths/rebuild.
	privPathJob := graph.NewJob(privPathService, 0, logger)
	privPathJob.Start()
	defer privPathJob.Stop(10 * time.Second)

	if cfg.JIT.SweeperEnabled {
		sweeper.Start(sweeperCtx)
	} else {
		logger.Warn("sweeper.disabled",
			zap.String("impact", "grants will not auto-expire and break-glass will never activate"))
	}

	// ── Gin Engine ──
	r := gin.New()

	// WHO IS ALLOWED TO SET X-Forwarded-For. This single call decides whether
	// c.ClientIP() is a fact or a value the caller chose.
	//
	// Gin's default trusts that header from 0.0.0.0/0 and ::/0, so before this
	// existed any client could send "X-Forwarded-For: 203.0.113.10" and become
	// that address, which forged every SourceIP in the audit trail and would
	// have made the network allowlist below decorative. nil (the "none"
	// sentinel, or no proxies configured) means trust nothing and use the
	// socket peer, which is the correct behaviour when this process is reached
	// directly. config.validateNetwork refuses to boot with the allowlist on
	// and this question unanswered.
	if err := r.SetTrustedProxies(cfg.Network.TrustedProxyCIDRs()); err != nil {
		logger.Fatal("network.trusted_proxies.invalid",
			zap.String("value", cfg.Network.TrustedProxies), zap.Error(err))
	}
	logger.Info("network.trusted_proxies",
		zap.Strings("cidrs", cfg.Network.TrustedProxyCIDRs()),
		zap.String("meaning", "X-Forwarded-For is believed only from these sources"))

	r.Use(gin.Recovery())

	// ── Corporate network allowlist ──
	//
	// FIRST in the chain, ahead of CORS and everything else, because a request
	// from an unapproved network should consume as little of this process as
	// possible and should never reach a handler. It covers the brokered proxy
	// hosts too: they are served by this same engine through NoRoute, so one
	// mount protects the API and every proxied application behind it.
	//
	// This is the last line, not the only one. The firewall or security group
	// in front of the instance is what stops traffic ever arriving, and it is
	// the layer that also covers the database and the object store. Keep both.
	networkAllowlist, err := middleware.NetworkAllowlist(
		middleware.NetworkAllowlistConfig{
			Enabled:         cfg.Network.AllowlistEnabled,
			AllowedCIDRs:    cfg.Network.AllowedCIDRList(),
			BreakGlassCIDRs: cfg.Network.BreakGlassCIDRList(),
			ExemptPaths:     cfg.Network.ExemptPathList(),
		},
		func(sourceIP, path, userAgent string, breakGlass bool) {
			action := models.AuditNetworkDenied
			outcome := models.AuditOutcomeDenied
			severity := models.AuditSeverityWarn
			if breakGlass {
				// An admission through the emergency range is the one event
				// here that means somebody got in.
				action = models.AuditNetworkBreakGlass
				outcome = models.AuditOutcomeSuccess
				severity = models.AuditSeverityCritical
			}
			auditService.Write(services.AuditEntry{
				ActorType: "SYSTEM",
				Action:    action,
				Outcome:   outcome,
				Severity:  severity,
				SourceIP:  sourceIP,
				UserAgent: userAgent,
				Resource:  path,
				Details: map[string]interface{}{
					"control":     "network_allowlist",
					"enforcement": "server_side_prevented",
					"path":        path,
				},
			})
		},
		logger,
	)
	if err != nil {
		logger.Fatal("network.allowlist.config_invalid", zap.Error(err))
	}
	r.Use(networkAllowlist)

	// CORS — API hosts only. Extracted to internal/middleware/cors.go so it
	// can be tested: it used to be an anonymous closure here, which is why the
	// Idempotency-Key allow-list bug shipped with nothing to catch it.
	r.Use(middleware.CORS(cfg.Server.AllowedOrigins, func(host string) bool {
		_, isProxy := webProxyGateway.IsProxyHost(host)
		return isProxy
	}))

	// Brokered web-application gateway. Registered as NoRoute (rather than a
	// route group) because a proxied application owns its ENTIRE path space
	// — "/", "/api/v1/...", "/static/..." — which cannot be expressed as a
	// prefix without colliding with PAM's own API routes. Host-based
	// dispatch keeps the two apart: requests to the API host fall through to
	// the normal 404, requests to "<slug>.<base_domain>" are proxied.
	r.NoRoute(func(c *gin.Context) {
		if _, isProxy := webProxyGateway.IsProxyHost(c.Request.Host); isProxy {
			webProxyGateway.ServeHTTP(c)
			return
		}
		c.JSON(http.StatusNotFound, gin.H{"success": false, "error": "Not found"})
	})

	// ── Public health (no auth) ──
	r.GET("/api/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "service": "PAM", "version": "2.0.0-admin-center"})
	})

	// ═════════════════════════════════════════════════════════════
	// DEV-ONLY: Test login endpoint. Issues a fresh JWT for any user.
	// REMOVE THIS BLOCK BEFORE GOING TO PRODUCTION.
	// ═════════════════════════════════════════════════════════════
	//
	// BOTH SWITCHES, OR NOTHING. This used to be gated on the environment
	// alone, and the environment used to default to development, so an
	// install that never set PAM_SERVER_ENV served an unauthenticated route
	// that mints a root session for any account id. It now also needs
	// PAM_SERVER_ENABLE_DEV_TEST_LOGIN=true, named for exactly what it does,
	// so no single unset variable can publish it.
	if !cfg.IsProduction() && cfg.Server.EnableDevTestLogin {
		r.POST("/test/login-as", func(c *gin.Context) {
			var body struct {
				UserID    string   `json:"user_id"`
				Username  string   `json:"username"`
				Email     string   `json:"email"`
				AccountID string   `json:"account_id"`
				Roles     []string `json:"roles"`
			}
			_ = c.ShouldBindJSON(&body)
			if body.UserID == "" {
				body.UserID = "d66e0687-15ad-4a41-8738-2918acdbf20f"
			}
			if body.Username == "" {
				body.Username = "das.admin"
			}
			if body.Email == "" {
				body.Email = "das.admin@das.in"
			}
			if len(body.Roles) == 0 {
				body.Roles = []string{"admin"}
			}
			sessionID := fmt.Sprintf("test-session-%d", time.Now().UnixNano())
			accessToken, _, expiresAt, err := jwtIssuer.IssueAccessToken(
				body.UserID, body.Username, body.Email, body.AccountID, true, body.Roles, sessionID,
				false, // dev-only test token: never enrolment-restricted
			)
			if err != nil {
				c.JSON(500, gin.H{"success": false, "error": err.Error()})
				return
			}
			c.JSON(200, gin.H{
				"success": true,
				"message": "test token issued (DEV-ONLY). Roles are whatever you pass, not resolved from the database",
				"data": gin.H{
					"access_token": accessToken,
					"session_id":   sessionID,
					"token_type":   "Bearer",
					"expires_at":   expiresAt,
				},
			})
		})
		logger.Warn("dev_only.test_login_endpoint_enabled",
			zap.String("route", "POST /test/login-as"),
			zap.String("danger", "this route issues a session for any account with no password and no second factor"),
			zap.String("disable_with", "unset PAM_SERVER_ENABLE_DEV_TEST_LOGIN"))
	}

	// ═════════════════════════════════════════════════════════════
	//  AUTH ROUTES — PAM owns its own auth entirely, for every user
	//  including root/admin. There is no separate "admin login" route:
	//  the SAME /api/v1/auth/login is used by everyone. What differs is
	//  what the response's `roles` say the account can do — the frontend
	//  routes an admin/root account into the Admin Center and everyone
	//  else into the normal console based on that, exactly the way a
	//  server would never trust a client-supplied "I am root" flag.
	// ═════════════════════════════════════════════════════════════

	// Public (no token required)
	pub := r.Group("/api/v1/auth")
	{
		pub.POST("/login", authHandler.Login)
		pub.POST("/mfa/verify", authHandler.MFAVerify)
		// Public because the access token is expired by definition whenever
		// this is called. The refresh token is the credential: single-use,
		// hashed at rest, rotated on redemption, and killed for the whole
		// session if a spent one comes back. See services/auth_refresh.go.
		pub.POST("/refresh", authHandler.Refresh)
		pub.POST("/mfa/recover", authHandler.MFARecover)
	}

	// Roles are read from the database rather than trusted from the token. See
	// middleware/live_roles.go for why: a JWT's role claim is a snapshot of
	// sign-in, so without this a delegation never reaches a session already
	// open and, worse, a revocation never reaches one either.
	liveRoles := middleware.LiveRoles(identityService.RoleNamesForUser, logger)

	// Account status is resolved live for the same reason roles are: deleting
	// or disabling an account must end its open sessions now, not when the
	// token expires or the holder happens to sign out.
	liveStatus := middleware.LiveAccountStatus(identityService.AccountStatusForUser, logger)

	// The enrolment gate is recomputed live for the same reason. Attaching an
	// MFA policy to a role has to reach the people already holding that role,
	// not just the next person to sign in.
	liveEnrolment := middleware.LiveMFAEnrolment(func(userID string, roles []string) (bool, error) {
		var mfa models.PAMMFA
		enrolled := db.Where("user_id = ?", userID).First(&mfa).Error == nil && mfa.Status == "ACTIVE"
		decision, err := mfaPolicyService.Evaluate(userID, roles, enrolled, time.Now().UTC())
		if err != nil {
			return false, err
		}
		return decision.Block, nil
	}, logger)

	// Protected (require PAM JWT)
	authed := r.Group("/api/v1/auth")
	authed.Use(middleware.PAMAuth(jwtIssuer, logger))
	authed.Use(liveRoles, liveStatus)
	authed.Use(liveEnrolment)
	authed.Use(middleware.AuditMiddleware(auditService, logger))
	// Role-gated MFA: a session issued to an account that must hold a second
	// factor and does not is restricted to enrolment. Mounted on EVERY
	// authenticated group, because the restriction is worthless if one group
	// forgets it — the point is that a caller bypassing the console still
	// cannot act.
	authed.Use(middleware.EnrolmentOnlyGate())
	{
		authed.GET("/me", authHandler.Me)
		authed.POST("/logout", authHandler.Logout)
		authed.GET("/api/health", authHandler.Health)

		// MFA setup (requires login first, then enroll TOTP)
		authed.POST("/mfa/setup/initiate", authHandler.MFASetupInitiate)
		authed.POST("/mfa/setup/verify", authHandler.MFASetupVerify)
		// Fresh backup codes for an already-enrolled device. MFA-gated: issuing
		// new recovery codes from a session that never proved the factor would
		// make the factor optional.
		authed.POST("/mfa/backup-codes/regenerate", middleware.RequireMFA(),
			authHandler.MFABackupCodesRegenerate)
	}

	// ═════════════════════════════════════════════════════════════
	//  STANDARD USER ROUTES
	//  Every route: PAMAuth → AuditMiddleware → RequirePermission (RBAC/PBAC
	//  via the embedded policy engine) → handler.
	//
	//  Scope, by design (see ADMIN_CENTER.md for the full rationale):
	//    - Resources: read/browse the catalog + connect to what you hold an
	//      active JIT grant for. Registering/deleting resources and
	//      managing their stored credentials is Admin Center only.
	//    - Sessions: your own only (start/end/mine). Org-wide visibility
	//      and the ability to kill someone else's session is Admin Center
	//      only.
	//    - Vault: full self-service (safes/credentials you have access to).
	//    - JIT: request/cancel/view your own requests and grants. Approving,
	//      denying, and revoking anyone's grant is Admin Center only.
	//    - Audit: your own self-service views (by request/user/resource,
	//      search, report generation). The full org-wide log, chain
	//      verification, and break-glass reporting are Admin Center only.
	// ═════════════════════════════════════════════════════════════
	res := r.Group("/api/v1/pam")
	res.Use(middleware.PAMAuth(jwtIssuer, logger))
	res.Use(liveRoles, liveStatus)
	res.Use(liveEnrolment)
	res.Use(middleware.AuditMiddleware(auditService, logger))
	// Role-gated MFA: a session issued to an account that must hold a second
	// factor and does not is restricted to enrolment. Mounted on EVERY
	// authenticated group, because the restriction is worthless if one group
	// forgets it — the point is that a caller bypassing the console still
	// cannot act.
	res.Use(middleware.EnrolmentOnlyGate())
	{
		// ── Resources (read + connect only) ──
		// Deliberately NO RequirePermission wrapper on these two: "list" is a
		// three-tier, per-resource model (List < Read < Connect — see
		// opa/policies/default_bundle.json's comment on
		// "resource-access-default-deny"), so there is no single coarse
		// action/pattern left that would correctly gate "can this user call
		// this endpoint at all" — a user with zero granted resources is still
		// allowed to call it, they just get an empty list back. The real
		// authorization is the per-resource pam:resource:List/Read/Connect
		// filtering ResourceHandler.ListGroups/List does internally.
		res.GET("/resources/groups", resourceHandler.ListGroups)
		res.GET("/resources", resourceHandler.List)

		res.GET("/resources/:id",
			middleware.RequirePermission(policyEngine, "pam:resource:Read",
				func(c *gin.Context) string { return fmt.Sprintf("pam:resource/%s", c.Param("id")) }, logger),
			resourceHandler.Get)

		// ── Connection ──
		// Two enforcement layers: RBAC/PBAC decides whether the principal
		// may ever connect; RequireActiveGrant decides whether they may
		// connect RIGHT NOW. The second is a no-op for resources with
		// requires_jit=false.
		res.GET("/resources/:id/connect-info",
			middleware.RequirePermission(policyEngine, "pam:resource:Connect",
				func(c *gin.Context) string { return fmt.Sprintf("pam:resource/%s", c.Param("id")) }, logger),
			middleware.RequireActiveGrant(jitService, resourceService,
				func(c *gin.Context) string { return c.Param("id") }, logger),
			resourceHandler.ConnectInfo)

		// Native launch: issues a one-time token the browser hands to the
		// OS via a pam-agent:// URL, which the locally-installed agent
		// redeems directly against the agent-facing endpoints below. Gated
		// by the exact same pam:resource:Connect permission AND the same
		// RequireActiveGrant check as the browser gateway above — a user
		// who can open the in-browser terminal is exactly who can pop open
		// a native client, no broader and no narrower.
		res.POST("/resources/:id/launch",
			middleware.RequirePermission(policyEngine, "pam:resource:Connect",
				func(c *gin.Context) string { return fmt.Sprintf("pam:resource/%s", c.Param("id")) }, logger),
			middleware.RequireActiveGrant(jitService, resourceService,
				func(c *gin.Context) string { return c.Param("id") }, logger),
			agentHandler.CreateLaunch)

		// Brokered web-app session ("open in browser, already logged in").
		// Same two enforcement layers as every other connect method — the
		// only thing that differs is the transport, never the authorization.
		res.POST("/resources/:id/web-session",
			middleware.RequirePermission(policyEngine, "pam:resource:Connect",
				func(c *gin.Context) string { return fmt.Sprintf("pam:resource/%s", c.Param("id")) }, logger),
			middleware.RequireActiveGrant(jitService, resourceService,
				func(c *gin.Context) string { return c.Param("id") }, logger),
			webProxyHandler.Open)

		// Open a tracked session. The session is bound to the grant that
		// authorised it, which is what makes cascading auto-revoke possible.
		res.POST("/resources/:id/sessions",
			middleware.RequireMFA(),
			middleware.RequirePermission(policyEngine, "pam:session:Start",
				func(c *gin.Context) string { return fmt.Sprintf("pam:resource/%s", c.Param("id")) }, logger),
			middleware.RequireActiveGrant(jitService, resourceService,
				func(c *gin.Context) string { return c.Param("id") }, logger),
			sessionHandler.Start)

		// In-browser terminal (WebSocket upgrade). This is the DAM capture
		// path: whatever the resource/grant's recording obligation says (see
		// StartTrackedSession) gets captured here — screen replay via
		// internal/recorder.Cast and a structured command log via
		// AppendRecordingCommand — with NO separate "enable recording" step
		// for the user to forget. Same two enforcement layers as connect-info
		// and /sessions above: RBAC/PBAC decides whether the principal may
		// ever connect, RequireActiveGrant decides whether they may connect
		// RIGHT NOW.
		res.GET("/resources/:id/connect",
			middleware.RequirePermission(policyEngine, "pam:resource:Connect",
				func(c *gin.Context) string { return fmt.Sprintf("pam:resource/%s", c.Param("id")) }, logger),
			middleware.RequireActiveGrant(jitService, resourceService,
				func(c *gin.Context) string { return c.Param("id") }, logger),
			gatewayHandler.Connect)

		// ── Sessions (self-service only — org-wide view + kill are Admin Center) ──
		res.GET("/sessions/mine", sessionHandler.Mine)
		res.POST("/sessions/:id/end", sessionHandler.End)

		// ── Brokered web sessions (self-service — org-wide view + force-end
		//      are Admin Center, same split as tracked sessions above) ──
		res.GET("/web-sessions/mine", webProxyHandler.Mine)
		res.POST("/web-sessions/:id/end", webProxyHandler.EndMine)

		// ── Hardened vault (envelope-encrypted Safes/Folders/Credentials) ──
		res.GET("/credential-types",
			middleware.RequirePermission(policyEngine, "pam:vault:List",
				func(c *gin.Context) string { return "pam:*" }, logger),
			vaultHandler.ListCredentialTypes)

		res.GET("/safes",
			middleware.RequirePermission(policyEngine, "pam:vault:List",
				func(c *gin.Context) string { return "pam:*" }, logger),
			vaultHandler.ListSafes)

		res.POST("/safes",
			middleware.RequirePermission(policyEngine, "pam:vault:Create",
				func(c *gin.Context) string { return "pam:*" }, logger),
			vaultHandler.CreateSafe)

		res.GET("/safes/:safe_id",
			middleware.RequirePermission(policyEngine, "pam:vault:Read",
				func(c *gin.Context) string { return fmt.Sprintf("pam:vault/%s", c.Param("safe_id")) }, logger),
			vaultHandler.GetSafe)

		res.GET("/safes/:safe_id/folders",
			middleware.RequirePermission(policyEngine, "pam:vault:List",
				func(c *gin.Context) string { return fmt.Sprintf("pam:vault/%s", c.Param("safe_id")) }, logger),
			vaultHandler.ListFolders)

		res.POST("/safes/:safe_id/folders",
			middleware.RequirePermission(policyEngine, "pam:vault:Create",
				func(c *gin.Context) string { return fmt.Sprintf("pam:vault/%s", c.Param("safe_id")) }, logger),
			vaultHandler.CreateFolder)

		res.GET("/safes/:safe_id/credentials",
			middleware.RequirePermission(policyEngine, "pam:vault:List",
				func(c *gin.Context) string { return fmt.Sprintf("pam:vault/%s", c.Param("safe_id")) }, logger),
			vaultHandler.ListCredentials)

		res.POST("/safes/:safe_id/credentials",
			middleware.RequirePermission(policyEngine, "pam:vault:Create",
				func(c *gin.Context) string { return fmt.Sprintf("pam:vault/%s", c.Param("safe_id")) }, logger),
			vaultHandler.CreateCredential)

		res.GET("/credentials/:credential_id",
			middleware.RequirePermission(policyEngine, "pam:vault:Read",
				func(c *gin.Context) string { return fmt.Sprintf("pam:vault/%s", c.Param("credential_id")) }, logger),
			vaultHandler.GetCredential)

		res.POST("/credentials/:credential_id/reveal",
			middleware.RequireMFA(),
			middleware.RequirePermission(policyEngine, "pam:vault:Reveal",
				func(c *gin.Context) string { return fmt.Sprintf("pam:vault/%s", c.Param("credential_id")) }, logger),
			vaultHandler.RevealCredential)

		res.POST("/credentials/:credential_id/versions",
			middleware.RequirePermission(policyEngine, "pam:vault:Store",
				func(c *gin.Context) string { return fmt.Sprintf("pam:vault/%s", c.Param("credential_id")) }, logger),
			vaultHandler.CreateVersion)

		res.POST("/credentials/:credential_id/password-change",
			middleware.RequirePermission(policyEngine, "pam:vault:Store",
				func(c *gin.Context) string { return fmt.Sprintf("pam:vault/%s", c.Param("credential_id")) }, logger),
			vaultHandler.PasswordChange)

		res.POST("/credentials/:credential_id/rotate",
			middleware.RequirePermission(policyEngine, "pam:vault:Rotate",
				func(c *gin.Context) string { return fmt.Sprintf("pam:vault/%s", c.Param("credential_id")) }, logger),
			vaultHandler.RequestRotation)

		// ── Audit + Reporting — self-service (Features 105/106/107) ──
		// Your own activity as counts. Same aggregates the admin endpoint
		// returns, scoped to the caller, so "All events" is not capped here
		// either.
		// ── Notification centre ──
		//
		// Every route is scoped to the caller from the token; there is no user
		// parameter, because a notification list is a record of what ONE person
		// has and has not seen.
		res.GET("/notifications", notificationHandler.List)
		res.GET("/notifications/unread-count", notificationHandler.UnreadCount)
		res.POST("/notifications/:id/read", notificationHandler.MarkRead)
		res.POST("/notifications/read-all", notificationHandler.MarkAllRead)

		res.GET("/audit/stats", auditHandler.MyStats)
		res.GET("/audit",
			middleware.RequirePermission(policyEngine, "pam:audit:Read",
				func(c *gin.Context) string { return "pam:audit" }, logger),
			auditHandler.Search)

		res.GET("/audit/request/:request_id",
			middleware.RequirePermission(policyEngine, "pam:audit:Read",
				func(c *gin.Context) string { return "pam:audit" }, logger),
			auditHandler.ByRequest)

		res.GET("/audit/user/:user_id",
			middleware.RequirePermission(policyEngine, "pam:audit:Read",
				func(c *gin.Context) string {
					return "pam:audit/user/" + c.Param("user_id")
				}, logger),
			auditHandler.ByUser)

		res.GET("/audit/resource/*resource",
			middleware.RequirePermission(policyEngine, "pam:audit:Read",
				func(c *gin.Context) string {
					return "pam:audit/resource" + c.Param("resource")
				}, logger),
			auditHandler.ByResource)

		res.POST("/audit/report",
			middleware.RequirePermission(policyEngine, "pam:report:Generate",
				func(c *gin.Context) string { return "pam:audit/report" }, logger),
			middleware.RequireMFA(),
			auditHandler.Generate)

		// ══════════════════════════════════════════════════════════
		//  JIT ACCESS REQUEST WORKFLOW — self-service only.
		//  Approve/Deny/Revoke live exclusively in the Admin Center below.
		// ══════════════════════════════════════════════════════════
		res.POST("/jit/requests",
			middleware.RequirePermission(policyEngine, "pam:jit:Request",
				func(c *gin.Context) string { return "pam:*" }, logger),
			jitHandler.Create)

		res.GET("/jit/requests", jitHandler.List)
		res.GET("/jit/requests/:id", jitHandler.Get)
		res.POST("/jit/requests/:id/cancel", jitHandler.Cancel)

		// ══════════════════════════════════════════════════════════
		//  BREAK-GLASS / EMERGENCY ACCESS
		//  MFA is mandatory: emergency access must never be reachable
		//  with a stolen password alone.
		// ══════════════════════════════════════════════════════════
		res.POST("/jit/breakglass",
			middleware.RequireMFA(),
			middleware.RequirePermission(policyEngine, "pam:breakglass:Use",
				func(c *gin.Context) string { return "pam:*" }, logger),
			jitHandler.Breakglass)

		// ── Grants — read-only "my grants" (revoke is Admin Center only) ──
		res.GET("/jit/grants", jitHandler.ListGrants)

		// ══════════════════════════════════════════════════════════
		//  LOCAL AGENT — browser-facing endpoints (authenticated PAM user).
		//  Pairing a device requires MFA, same reasoning as break-glass and
		//  credential reveal: this is the step that establishes a durable
		//  trust relationship (a device that can request launch tokens
		//  indefinitely until revoked), so it deserves the same bar as any
		//  other high-consequence action gated behind RequireMFA().
		// ══════════════════════════════════════════════════════════
		res.POST("/agent/pair/init", middleware.RequireMFA(), agentHandler.PairInit)

		// One-click enrolment. Targets is a plain read (the console needs it
		// to decide what to offer); Bootstrap mints an enrolment credential
		// and is MFA-gated for the same reason pair/init is.
		res.GET("/agent/install/targets", agentInstallHandler.Targets)
		res.POST("/agent/install/bootstrap", middleware.RequireMFA(), agentInstallHandler.Bootstrap)
		res.GET("/agent/devices", agentHandler.ListDevices)
		res.DELETE("/agent/devices/:id", agentHandler.RevokeDevice)
	}

	// ══════════════════════════════════════════════════════════════
	//  LOCAL AGENT — agent-facing endpoints (agent side).
	//  Deliberately NOT behind middleware.PAMAuth: the agent is a
	//  short-lived CLI process with no PAM browser session/JWT at these
	//  points. It authenticates itself differently — a one-time pairing
	//  code for pair/complete, and an Ed25519 signature from its enrolled
	//  keypair for the two launch endpoints. See the doc comment on
	//  handlers.AgentHandler before changing this.
	// ══════════════════════════════════════════════════════════════
	r.POST("/api/v1/pam/agent/pair/complete", agentHandler.PairComplete)

	// Fetched by `curl … | sh` and by the installer itself, neither of which
	// can carry a Bearer token — the single-use pairing code in the query
	// string is the credential. Validated without being consumed, so the
	// agent can still redeem it moments later. See agent_install_handler.go
	// for why that exposure is bounded and deliberate.
	r.GET("/api/v1/pam/agent/install/script", agentInstallHandler.Script)
	r.GET("/api/v1/pam/agent/install/binary/:os/:arch", agentInstallHandler.Binary)
	r.POST("/api/v1/pam/agent/launch/resolve", agentHandler.ResolveLaunch)
	r.POST("/api/v1/pam/agent/launch/:session_id/end", agentHandler.EndLaunch)
	r.POST("/api/v1/pam/agent/launch/:session_id/recording", agentHandler.UploadLaunchRecording)

	// ═════════════════════════════════════════════════════════════
	//  MACHINE DATA PLANE, applications reading their own secrets.
	//
	//  Its own group, carrying ONLY ServiceAuth. It never sees PAMAuth, and
	//  the human groups never see ServiceAuth: these are two alternative
	//  authentication schemes for two different kinds of caller, not two
	//  layers of one. Mounting the service check on a human group would make
	//  every console request demand a JWT and a service token at once.
	//
	//  Read-only by construction. Minting a token and widening a grant live
	//  under /admin behind a human session and a second factor, so a leaked
	//  service token cannot escalate itself, only spend what it already has.
	//
	//  A secret is addressed by its canonical path (safe/folder/name) rather
	//  than by id, so a deployment config can name its secrets without
	//  hardcoding UUIDs, and every read is audited under the resolved path
	//  with the caller's stated purpose.
	// ═════════════════════════════════════════════════════════════
	svc := r.Group("/api/v1/pam/svc")
	svc.Use(middleware.ServiceAuth(serviceIdentitySvc, logger))
	{
		svc.GET("/secrets/*path", secretAccessHandler.GetSecret)
		svc.GET("/resources/:resource_id/secrets", secretAccessHandler.GetResourceSecrets)
	}

	// ═════════════════════════════════════════════════════════════
	//  ADMIN CENTER — root/admin only (middleware.RequireAdmin reads the
	//  "root"/"admin" role straight off the caller's own PAM JWT). This is
	//  PAM's central control plane: Identity (RBAC/PBAC), resource
	//  management, JIT approval, org-wide sessions, and the full audit
	//  trail — everything that used to be a separate IAM console reached
	//  by a shared service token now lives here, reached by a real admin
	//  who logged into PAM itself.
	// ═════════════════════════════════════════════════════════════
	admin := r.Group("/api/v1/pam/admin")
	admin.Use(middleware.PAMAuth(jwtIssuer, logger))
	admin.Use(liveRoles, liveStatus)
	admin.Use(liveEnrolment)
	admin.Use(middleware.AuditMiddleware(auditService, logger))
	// Role-gated MFA: a session issued to an account that must hold a second
	// factor and does not is restricted to enrolment. Mounted on EVERY
	// authenticated group, because the restriction is worthless if one group
	// forgets it — the point is that a caller bypassing the console still
	// cannot act.
	admin.Use(middleware.EnrolmentOnlyGate())
	admin.Use(middleware.RequireAdmin())
	// Layer 3. Reads the caller's delegated resource scope once per request
	// and parks it in the context, so a route addressed at one resource can
	// refuse it and a listing can filter itself. A pass-through for root, for
	// seeded admins, and for any delegation created without a scope, which is
	// every account until somebody uses scope_resource_ids.
	admin.Use(middleware.ResolveDelegationScope(identityService.DelegationScopeFor, logger))
	{
		// ── 1. IDENTITY MANAGEMENT ──
		identity := admin.Group("/identity")
		{
			identity.GET("/users", identityHandler.List)
			identity.GET("/users/:id", identityHandler.Get)
			identity.POST("/users", identityHandler.Create)
			identity.PATCH("/users/:id", identityHandler.Update)
			identity.DELETE("/users/:id", identityHandler.Delete)
			identity.POST("/users/:id/status", identityHandler.SetStatus)
			// Setting somebody's password is taking their account, so this is
			// a credential-reset action and carries the same weight as
			// clearing their second factor below: MFA-gated on the way in, and
			// refused outright by the service when the actor may not act on
			// that target (see services.CanResetPassword, which stops an
			// administrator resetting a root's or another admin's password).
			identity.POST("/users/:id/reset-password",
				middleware.RequireMFA(), identityHandler.ResetPassword)
			identity.POST("/users/:id/roles", identityHandler.AssignRole)
			identity.DELETE("/users/:id/roles/:role_name", identityHandler.RemoveRole)
			identity.POST("/users/:id/policies", identityHandler.AttachPolicy)
			identity.DELETE("/users/:id/policies/:policy_id", identityHandler.DetachPolicy)

			// ── Admin delegation (time-boxed, scoped admin rights) ──
			//
			// Granting someone admin is itself a privilege escalation, so it is
			// MFA-gated on the way in exactly like JIT approval and agent pairing
			// are. Revoke deliberately is NOT: taking privilege away is the
			// fail-safe direction and must never be blocked by a lost
			// authenticator.
			identity.POST("/users/:id/delegate-admin",
				middleware.RequireMFA(), identityHandler.DelegateAdmin)
			identity.DELETE("/users/:id/delegate-admin", identityHandler.RevokeAdminDelegation)
			identity.GET("/users/:id/delegation", identityHandler.GetDelegation)

			// Clearing someone's MFA lets them re-enrol a new authenticator, so
			// it is a credential-reset action: MFA-gated, and refused outright by
			// the service when the actor may not act on that target (see
			// services.CanResetMFA — an admin cannot reset a root's MFA).
			identity.POST("/users/:id/reset-mfa",
				middleware.RequireMFA(), mfaPolicyHandler.ResetUserMFA)

			// The identity graph for one user: which paths their roles and grants
			// open up. Read-only, and mounted here rather than under
			// privilege-paths so the user-detail screen can fetch it by user id.
			identity.GET("/users/:id/graph", privPathHandler.MemberGraph)
		}

		// ── 2 & 3. RBAC (Roles) + PBAC (Policies) ──
		rbac := admin.Group("/rbac")
		{
			rbac.GET("/roles", roleHandler.List)
			rbac.GET("/roles/:id", roleHandler.Get)
			rbac.POST("/roles", roleHandler.Create)
			rbac.PATCH("/roles/:id", roleHandler.Update)
			rbac.DELETE("/roles/:id", roleHandler.Delete)
			rbac.POST("/roles/:id/policies", roleHandler.AttachPolicy)
			rbac.DELETE("/roles/:id/policies/:policy_id", roleHandler.DetachPolicy)

			// ── Role criticality ──
			// Mounted in the existing RBAC group so it inherits PAMAuth, the
			// audit middleware and RequireAdmin without restating any of it.
			// Reading is open to any admin; setting a reviewer override is a
			// judgement that changes what the privilege graph reports as
			// dangerous, so it is audited by the service itself.
			rbac.GET("/criticality", roleCriticalityHandler.Summary)
			rbac.GET("/roles/:id/criticality", roleCriticalityHandler.Get)
			rbac.PUT("/roles/:id/criticality", roleCriticalityHandler.SetOverride)
			rbac.DELETE("/roles/:id/criticality", roleCriticalityHandler.ClearOverride)

			rbac.GET("/policies", policyHandler.List)
			rbac.GET("/policies/:id", policyHandler.Get)
			rbac.POST("/policies", policyHandler.Create)
			rbac.PATCH("/policies/:id", policyHandler.Update)
			rbac.DELETE("/policies/:id", policyHandler.Delete)
		}

		// ── 4. RESOURCE MANAGEMENT (registration + the legacy
		//      single-credential-per-resource path) — admin-only. Normal
		//      users still browse/connect via the /api/v1/pam group above;
		//      creating, deleting, and (re)credentialing a resource is an
		//      administrative action.
		resources := admin.Group("/resources")
		{
			// Create is not guarded by scope: there is no resource id yet to
			// be in or out of it. Everything addressed at an existing resource
			// is, so a delegate scoped to three databases cannot rotate the
			// credential on a fourth.
			resources.POST("", resourceHandler.Create)

			inScope := middleware.RequireResourceInScope(
				func(c *gin.Context) string { return c.Param("id") }, logger)

			resources.PATCH("/:id", inScope, resourceHandler.Update)
			resources.DELETE("/:id", inScope, resourceHandler.Delete)
			resources.POST("/:id/credential", inScope, resourceHandler.StoreCredential)
			resources.POST("/:id/rotate", inScope, resourceHandler.RotateCredential)
		}

		// ── Machine identities: provisioning the data plane ──────────────
		//
		// This is where a machine principal is created, given a token and
		// granted a path scope. It sits inside the admin group, so it already
		// carries live role resolution, the enrolment gate and the audit
		// middleware; what is added per route is the extra weight the
		// individual action deserves.
		//
		// MFA on exactly the two operations that WIDEN access. Minting a token
		// hands out a new credential and granting a scope hands out new reach,
		// so both re-check the second factor, the same rule JIT approval and
		// agent pairing follow. Listing, disabling and revoking do not: taking
		// access away is the fail-safe direction and must never be blocked by
		// a lost authenticator during an incident.
		svcAdmin := admin.Group("/services")
		{
			svcAdmin.POST("", serviceIdentityHandler.CreateIdentity)
			svcAdmin.GET("", serviceIdentityHandler.ListIdentities)
			svcAdmin.POST("/:service/tokens", middleware.RequireMFA(), serviceIdentityHandler.IssueToken)
			svcAdmin.GET("/:service/tokens", serviceIdentityHandler.ListTokens)
			svcAdmin.POST("/:service/grants", middleware.RequireMFA(), serviceIdentityHandler.GrantScope)
			svcAdmin.GET("/:service/grants", serviceIdentityHandler.ListGrants)
			svcAdmin.POST("/:service/disable", serviceIdentityHandler.DisableIdentity)
		}
		// Revocation is addressed flat rather than as /services/tokens/:id,
		// which would sit a static segment as a sibling of the :service
		// parameter. Gin resolves that, but the flat form needs no reasoning
		// about router internals to verify.
		admin.DELETE("/service-tokens/:token_id", serviceIdentityHandler.RevokeToken)
		admin.DELETE("/service-grants/:grant_id", serviceIdentityHandler.RevokeGrant)

		// ── Whole-vault backup & restore ──
		//
		// ROOT, WITH A VERIFIED SECOND FACTOR, AND A WRITTEN REASON. These
		// two used to sit behind RequireAdmin alone, which made them the
		// least guarded things in the product and the most consequential:
		// backup exports every secret, restore overwrites the live vault from
		// a caller-supplied object key, and a delegated admin's resource
		// scope cannot narrow either of them because neither addresses a
		// resource. Revealing a single credential, by contrast, wanted a
		// verified factor, a reason and a per-credential permission check.
		// The gates are now the right way round. The reason is enforced in
		// the handler and lands in the audit row.
		admin.POST("/vault/backup",
			middleware.RequireRoot("Exporting the vault"),
			middleware.RequireMFA(),
			vaultHandler.CreateBackup)
		admin.POST("/vault/restore",
			middleware.RequireRoot("Restoring the vault"),
			middleware.RequireMFA(),
			vaultHandler.RestoreBackup)

		// ── 5. JIT — READ-ONLY (org-wide) ──
		admin.GET("/jit-requests", adminHandler.ListJITRequests)
		admin.GET("/jit-requests/:id", adminHandler.GetJITRequest)
		admin.GET("/grants", adminHandler.ListGrants)
		admin.GET("/breakglass", adminHandler.ListBreakglass)
		admin.GET("/breakglass/:grant_id/report", adminHandler.BreakglassReport)

		// ── 6. Sessions & audit — org-wide, read-only ──
		// Brokered web sessions: live list, per-request activity trail (the
		// web-app counterpart to a terminal session's recorded command log),
		// and force-terminate.
		admin.GET("/web-sessions", webProxyHandler.ListActive)
		admin.GET("/web-sessions/:id/activity", webProxyHandler.Activity)
		admin.POST("/web-sessions/:id/end", webProxyHandler.End)

		admin.GET("/sessions", adminHandler.ListSessions)
		admin.GET("/recordings", adminHandler.ListRecordings)
		admin.GET("/recordings/:id/cast", adminHandler.GetRecordingCast)
		admin.GET("/recordings/:id/commands", adminHandler.GetRecordingCommands)
		admin.GET("/recordings/:id/transcript", adminHandler.GetRecordingTranscript)
		admin.GET("/audit", adminHandler.ListAudit)
		// Counts rather than rows, so the dashboard charts describe every event
		// in range instead of the last few thousand the browser could carry.
		admin.GET("/audit/stats", adminHandler.AuditStats)
		admin.GET("/audit/verify", adminHandler.VerifyAudit)
		admin.GET("/stats", adminHandler.Stats)

		// ══════════════════════════════════════════════════════════
		//  ROLE-GATED MFA POLICY
		//  Which roles must hold MFA before they may log in at all.
		//  The console renders this; POST /auth/login enforces it —
		//  see services/mfa_policy.go for why enforcement cannot
		//  live anywhere else.
		// ══════════════════════════════════════════════════════════
		admin.GET("/mfa-policy", mfaPolicyHandler.GetPolicy)
		admin.GET("/mfa-policy/compliance", mfaPolicyHandler.Compliance)
		// Editing the rule that decides who is forced into MFA is a
		// change to an authentication control, so it is MFA-gated:
		// an attacker on a stolen session must not be able to switch
		// the requirement off for the role they just took over.
		admin.PUT("/mfa-policy/rules/:role_name",
			middleware.RequireMFA(), mfaPolicyHandler.UpsertRule)
		admin.DELETE("/mfa-policy/rules/:role_name",
			middleware.RequireMFA(), mfaPolicyHandler.DeleteRule)

		// ══════════════════════════════════════════════════════════
		//  PRIVILEGE-PATH ANALYSIS  (identity graph)
		//
		//  Read this before adding to it: these endpoints are a MAP
		//  OF HOW TO ATTACK THIS SYSTEM. They enumerate, cheapest
		//  first, the route from any principal to superuser. That is
		//  exactly what a defender needs and exactly what an attacker
		//  wants, which is why every one of them sits behind
		//  RequireAdmin and is itself audited. Never widen this group.
		//
		//  Everything here is read-only except Rebuild, which only
		//  refreshes the snapshot — the analyzer never writes to the
		//  identity tables and is never consulted for an authorization
		//  decision.
		// ══════════════════════════════════════════════════════════
		admin.GET("/privilege-paths", privPathHandler.Summary)
		admin.GET("/privilege-paths/targets", privPathHandler.Targets)
		admin.GET("/privilege-paths/to", privPathHandler.PathsTo)
		admin.GET("/privilege-paths/user/:id", privPathHandler.ForUser)
		admin.GET("/privilege-paths/chokepoints", privPathHandler.Chokepoints)
		admin.GET("/privilege-paths/status", privPathHandler.Status)
		// "What would happen if I gave this person that role" — answered
		// without actually granting it. Read-only despite being a POST:
		// the body carries the hypothetical, nothing is persisted.
		admin.POST("/privilege-paths/simulate", privPathHandler.Simulate)
		// Forces a fresh snapshot ahead of the background job's schedule.
		admin.POST("/privilege-paths/rebuild", privPathHandler.Rebuild)

		// ── ACTIONS (attributable writes — every action here is performed
		//      by the logged-in admin/root themselves; see
		//      middleware.AdminIdentityFromContext, which now simply reads
		//      the authenticated PAM JWT's own user_id/username). ──
		actions := admin.Group("/actions")
		{
			// JIT approval — the whole reason this ask exists: approval
			// lives in the Admin Center only. MFA is required to approve,
			// same as before.
			actions.POST("/jit-requests/:id/approve", middleware.RequireMFA(), jitHandler.Approve)
			actions.POST("/jit-requests/:id/deny", jitHandler.Deny)
			actions.POST("/grants/:id/revoke", jitHandler.RevokeGrant)
			actions.POST("/sessions/:id/kill", adminHandler.KillSession)
		}
	}

	// ── Server ──
	srv := &http.Server{
		Addr:         ":" + cfg.Server.Port,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	go func() {
		logger.Info("server.start", zap.String("port", cfg.Server.Port))
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatal("server.fail", zap.Error(err))
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)
	<-quit
	logger.Info("server.shutdown")

	// Stop the sweeper first so no new revocation work starts while the
	// HTTP server drains; give it a bounded window to finish its pass.
	if cfg.JIT.SweeperEnabled {
		sweeper.Stop(10 * time.Second)
	}

	ctx, cancel := context.WithTimeout(context.Background(),
		time.Duration(cfg.Server.ShutdownTimeout)*time.Second)
	defer cancel()
	if err := srv.Shutdown(ctx); err != nil {
		logger.Error("server.shutdown.fail", zap.Error(err))
	}
	logger.Info("server.stopped")
}
