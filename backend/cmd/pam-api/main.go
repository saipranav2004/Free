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
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gin-gonic/gin"
	"github.com/joho/godotenv"
	"github.com/yourorg/pam/internal/api/handlers"
	"github.com/yourorg/pam/internal/config"
	"github.com/yourorg/pam/internal/database"
	"github.com/yourorg/pam/internal/middleware"
	"github.com/yourorg/pam/internal/models"
	"github.com/yourorg/pam/internal/services"
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

	// AutoMigrate PAM-specific tables. Dev-only by design (see
	// APIs_Docunment_PAM.md's deployment matrix): production schema changes
	// go through reviewed SQL migrations instead of GORM's automigration,
	// since automigration can silently widen a column or add a nullable one
	// in a way nobody reviewed.
	if !cfg.IsProduction() {
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
			&models.PAMUserSession{},

			// ── Resources & connection sessions ──
			&models.PAMResource{},
			&models.ConnectionSession{},

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

			// ── Tamper-evident audit chain + session recording metadata ──
			&models.AuditLog{},
			&models.SessionRecording{},

			// ── Local agent (native desktop/CLI launch) ──
			&models.AgentDevice{},
			&models.AgentPairingCode{},
			&models.LaunchToken{},
		); err != nil {
			// A failed migration leaves the schema in an unknown state — refuse
			// to serve rather than fail later on the first privileged request.
			logger.Fatal("db.migrate.fail", zap.Error(err))
		}
		logger.Info("db.migrated.pam_tables")
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
	resourceService := services.NewResourceService(db, cfg.Vault.EncryptionKey, logger)

	// Hardened vault (envelope) — uses PAM_VAULT_ENCRYPTION_KEY via local-dev KMS.
	vaultService, err := services.NewVaultService(db, logger)
	if err != nil {
		logger.Fatal("vault.init.fail", zap.Error(err))
	}
	rotationService := services.NewRotationService(db, vaultService, logger)

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
	agentService := services.NewAgentService(db, resourceService, logger)

	// ── Identity / RBAC / PBAC services (Admin Center) ──
	identityService := services.NewIdentityService(db, logger)
	roleService := services.NewRoleService(db, logger)
	policyService := services.NewPolicyService(db, logger)
	// Role criticality classification. Derives a banded risk score for each
	// role from what it can actually reach, and stores reviewer overrides.
	// See internal/services/role_criticality_service.go for the model.
	roleCriticalityService := services.NewRoleCriticalityService(db, auditService, logger)
	if !cfg.IsProduction() {
		if err := roleCriticalityService.Migrate(); err != nil {
			logger.Fatal("migrate.role_criticality.fail", zap.Error(err))
		}
	}

	// ── Handlers ──
	authHandler := handlers.NewAuthHandler(authService, logger)
	resourceHandler := handlers.NewResourceHandler(resourceService, logger)
	vaultHandler := handlers.NewVaultHandler(vaultService, rotationService, logger)
	auditHandler := handlers.NewAuditHandler(auditQuery, reportSvc, auditService, logger)
	jitHandler := handlers.NewJITHandler(jitService, logger)
	sessionHandler := handlers.NewSessionHandler(resourceService, auditService, logger)
	adminHandler := handlers.NewAdminHandler(jitService, resourceService, auditService, logger)
	identityHandler := handlers.NewIdentityHandler(identityService, logger)
	roleHandler := handlers.NewRoleHandler(roleService, logger)
	policyHandler := handlers.NewPolicyHandler(policyService, logger)
	roleCriticalityHandler := handlers.NewRoleCriticalityHandler(roleCriticalityService, logger)
	agentHandler := handlers.NewAgentHandler(agentService, cfg.Server.PublicURL, logger)

	// ── Auto-revocation worker (expiry, break-glass activation) ──
	sweeperCtx, stopSweeper := context.WithCancel(context.Background())
	defer stopSweeper()
	sweeper := services.NewSweeper(jitService,
		time.Duration(cfg.JIT.SweepIntervalSec)*time.Second, logger)
	if cfg.JIT.SweeperEnabled {
		sweeper.Start(sweeperCtx)
	} else {
		logger.Warn("sweeper.disabled",
			zap.String("impact", "grants will not auto-expire and break-glass will never activate"))
	}

	// ── Gin Engine ──
	r := gin.New()
	r.Use(gin.Recovery())

	// CORS
	r.Use(func(c *gin.Context) {
		c.Header("Access-Control-Allow-Origin", cfg.Server.AllowedOrigins)
		c.Header("Access-Control-Allow-Methods", "GET, POST, PUT, PATCH, DELETE, OPTIONS")
		c.Header("Access-Control-Allow-Headers", "*")
		if c.Request.Method == "OPTIONS" {
			c.AbortWithStatus(204)
			return
		}
		c.Next()
	})

	// ── Public health (no auth) ──
	r.GET("/api/health", func(c *gin.Context) {
		c.JSON(200, gin.H{"status": "ok", "service": "PAM", "version": "2.0.0-admin-center"})
	})

	// ═════════════════════════════════════════════════════════════
	// DEV-ONLY: Test login endpoint. Issues a fresh JWT for any user.
	// REMOVE THIS BLOCK BEFORE GOING TO PRODUCTION.
	// ═════════════════════════════════════════════════════════════
	if !cfg.IsProduction() {
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
			)
			if err != nil {
				c.JSON(500, gin.H{"success": false, "error": err.Error()})
				return
			}
			c.JSON(200, gin.H{
				"success": true,
				"message": "test token issued (DEV-ONLY) — roles are whatever you pass, not resolved from the database",
				"data": gin.H{
					"access_token": accessToken,
					"session_id":   sessionID,
					"token_type":   "Bearer",
					"expires_at":   expiresAt,
				},
			})
		})
		logger.Warn("dev_only.test_login_endpoint_enabled",
			zap.String("route", "POST /test/login-as"))
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
	}

	// Protected (require PAM JWT)
	authed := r.Group("/api/v1/auth")
	authed.Use(middleware.PAMAuth(jwtIssuer, logger))
	authed.Use(middleware.AuditMiddleware(auditService, logger))
	{
		authed.GET("/me", authHandler.Me)
		authed.POST("/logout", authHandler.Logout)
		authed.GET("/api/health", authHandler.Health)

		// MFA setup (requires login first, then enroll TOTP)
		authed.POST("/mfa/setup/initiate", authHandler.MFASetupInitiate)
		authed.POST("/mfa/setup/verify", authHandler.MFASetupVerify)
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
	res.Use(middleware.AuditMiddleware(auditService, logger))
	{
		// ── Resources (read + connect only) ──
		res.GET("/resources/groups",
			middleware.RequirePermission(policyEngine, "pam:resource:List",
				func(c *gin.Context) string { return "pam:*" }, logger),
			resourceHandler.ListGroups)

		res.GET("/resources",
			middleware.RequirePermission(policyEngine, "pam:resource:List",
				func(c *gin.Context) string { return "pam:*" }, logger),
			resourceHandler.List)

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

		// Open a tracked session. The session is bound to the grant that
		// authorised it, which is what makes cascading auto-revoke possible.
		res.POST("/resources/:id/sessions",
			middleware.RequireMFA(),
			middleware.RequirePermission(policyEngine, "pam:session:Start",
				func(c *gin.Context) string { return fmt.Sprintf("pam:resource/%s", c.Param("id")) }, logger),
			middleware.RequireActiveGrant(jitService, resourceService,
				func(c *gin.Context) string { return c.Param("id") }, logger),
			sessionHandler.Start)

		// ── Sessions (self-service only — org-wide view + kill are Admin Center) ──
		res.GET("/sessions/mine", sessionHandler.Mine)
		res.POST("/sessions/:id/end", sessionHandler.End)

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
	r.POST("/api/v1/pam/agent/launch/resolve", agentHandler.ResolveLaunch)
	r.POST("/api/v1/pam/agent/launch/:session_id/end", agentHandler.EndLaunch)

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
	admin.Use(middleware.AuditMiddleware(auditService, logger))
	admin.Use(middleware.RequireAdmin())
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
			identity.POST("/users/:id/reset-password", identityHandler.ResetPassword)
			identity.POST("/users/:id/roles", identityHandler.AssignRole)
			identity.DELETE("/users/:id/roles/:role_name", identityHandler.RemoveRole)
			identity.POST("/users/:id/policies", identityHandler.AttachPolicy)
			identity.DELETE("/users/:id/policies/:policy_id", identityHandler.DetachPolicy)

			// Admin delegation (subadmin) — root-only enforced in the service
			// layer (IdentityService.DelegateAdmin / RevokeAdminDelegation).
			// Handlers live in identity_delegation_handler.go (additive).
			identity.POST("/users/:id/delegate-admin", identityHandler.DelegateAdmin)
			identity.DELETE("/users/:id/delegate-admin", identityHandler.RevokeAdminDelegation)
			identity.GET("/users/:id/delegation", identityHandler.GetDelegation)
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

			// Role criticality classification. The estate-wide roll-up backs
			// the Roles table's criticality column in one call; the per-role
			// route carries the scored evidence behind that band.
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
			resources.POST("", resourceHandler.Create)
			resources.DELETE("/:id", resourceHandler.Delete)
			resources.POST("/:id/credential", resourceHandler.StoreCredential)
			resources.POST("/:id/rotate", resourceHandler.RotateCredential)
		}

		// ── Whole-vault backup & restore — infra-level, admin-only ──
		admin.POST("/vault/backup", vaultHandler.CreateBackup)
		admin.POST("/vault/restore", vaultHandler.RestoreBackup)

		// ── 5. JIT — READ-ONLY (org-wide) ──
		admin.GET("/jit-requests", adminHandler.ListJITRequests)
		admin.GET("/jit-requests/:id", adminHandler.GetJITRequest)
		admin.GET("/grants", adminHandler.ListGrants)
		admin.GET("/breakglass", adminHandler.ListBreakglass)
		admin.GET("/breakglass/:grant_id/report", adminHandler.BreakglassReport)

		// ── 6. Sessions & audit — org-wide, read-only ──
		admin.GET("/sessions", adminHandler.ListSessions)
		admin.GET("/recordings", adminHandler.ListRecordings)
		admin.GET("/audit", adminHandler.ListAudit)
		admin.GET("/audit/verify", adminHandler.VerifyAudit)
		admin.GET("/stats", adminHandler.Stats)

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
