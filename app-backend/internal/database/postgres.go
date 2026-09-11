package database

import (
	"fmt"
	"time"

	"github.com/yourorg/pam/internal/config"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
)

var DB *gorm.DB

// Connect establishes the PostgreSQL connection pool and returns the GORM DB.
func Connect(cfg config.DatabaseConfig) (*gorm.DB, error) {
	// gormLogLevel := logger.Info
	// if cfg.SSLMode == "require" {
	// 	gormLogLevel = logger.Warn // quieter in prod-like
	// }

	db, err := gorm.Open(postgres.Open(cfg.DSN()), &gorm.Config{
		// Logger:      logger.Default.LogMode(gormLogLevel),
		PrepareStmt: true,
	})
	if err != nil {
		return nil, fmt.Errorf("failed to connect to PostgreSQL: %w", err)
	}

	sqlDB, err := db.DB()
	if err != nil {
		return nil, fmt.Errorf("failed to get underlying *sql.DB: %w", err)
	}

	sqlDB.SetMaxOpenConns(20)
	sqlDB.SetMaxIdleConns(5)
	sqlDB.SetConnMaxLifetime(time.Hour)

	// Ensure configured schema exists.
	if err := db.Exec(fmt.Sprintf(
		"CREATE SCHEMA IF NOT EXISTS %s",
		cfg.Schema,
	)).Error; err != nil {
		return nil, fmt.Errorf(
			"failed to create schema %s: %w",
			cfg.Schema,
			err,
		)
	}

	// Set PostgreSQL search path from .env
	if err := db.Exec(fmt.Sprintf(
		"SET search_path TO %s, public",
		cfg.Schema,
	)).Error; err != nil {
		return nil, fmt.Errorf(
			"failed to set search_path: %w",
			err,
		)
	}

	DB = db
	return db, nil
}

// AssertSchemaPresent checks that the PAM tables already exist, for the boots
// that will not create them.
//
// pam_audit_log is the probe because every other startup step assumes it:
// EnsureAuditSearchVector alters it, and the audit verification job reads it
// within seconds of the server coming up. If it is absent the whole schema
// is, and failing here with a sentence an operator can act on beats failing
// on the next statement with SQLSTATE 42P01.
func AssertSchemaPresent(db *gorm.DB, schema string) error {
	var exists bool
	err := db.Raw(`
		SELECT EXISTS (
			SELECT 1 FROM information_schema.tables
			WHERE table_schema = ? AND table_name = 'pam_audit_log'
		)`, schema).Scan(&exists).Error
	if err != nil {
		return fmt.Errorf("schema check failed: %w", err)
	}
	if !exists {
		return fmt.Errorf(
			"table %s.pam_audit_log does not exist: this database has no PAM schema and this process is not configured to create one",
			schema,
		)
	}
	return nil
}

// EnsureAuditSearchVector adds the generated tsvector column and GIN index
// that services/audit_query_service.go's Search() (Feature 107 — searchable
// audit logs) queries against via raw SQL ("search_vector @@
// plainto_tsquery(...)").
//
// This has to be a hand-written migration, not part of AutoMigrate: GORM's
// AutoMigrate has no concept of PostgreSQL generated columns, so a model
// struct field alone can never create one. Without this, Search() compiles
// fine (it's raw SQL) but fails at request time with
// "column \"search_vector\" does not exist" the first time anyone hits
// GET /api/v1/pam/audit?q=..., because nothing else in this codebase
// creates the column.
//
// Safe to run every startup: every statement is IF NOT EXISTS / idempotent.
// AutoMigrate for models.AuditLog must run before this, since it creates
// the table itself.
func EnsureAuditSearchVector(db *gorm.DB, schema string) error {
	table := schema + ".pam_audit_log"

	// ALTER TABLE ... ADD COLUMN IF NOT EXISTS does not support GENERATED
	// ALWAYS AS in one step consistently across PG versions when the column
	// may already exist from a prior run with a different expression, so
	// check for existence explicitly instead of relying on IF NOT EXISTS
	// alone to short-circuit a mismatched re-definition attempt.
	var exists bool
	checkSQL := `
		SELECT EXISTS (
			SELECT 1 FROM information_schema.columns
			WHERE table_schema = ? AND table_name = 'pam_audit_log' AND column_name = 'search_vector'
		)`
	if err := db.Raw(checkSQL, schema).Scan(&exists).Error; err != nil {
		return fmt.Errorf("audit_search_vector: check column: %w", err)
	}
	if !exists {
		addColSQL := fmt.Sprintf(`
			ALTER TABLE %s ADD COLUMN search_vector tsvector
			GENERATED ALWAYS AS (
				to_tsvector('simple',
					coalesce(action, '') || ' ' ||
					coalesce(resource, '') || ' ' ||
					coalesce(resource_name, '') || ' ' ||
					coalesce(username, '') || ' ' ||
					coalesce(details, '') || ' ' ||
					coalesce(justification, '')
				)
			) STORED`, table)
		if err := db.Exec(addColSQL).Error; err != nil {
			return fmt.Errorf("audit_search_vector: add column: %w", err)
		}
	}

	indexSQL := fmt.Sprintf(
		"CREATE INDEX IF NOT EXISTS idx_pam_audit_log_search_vector ON %s USING GIN (search_vector)",
		table,
	)
	if err := db.Exec(indexSQL).Error; err != nil {
		return fmt.Errorf("audit_search_vector: create index: %w", err)
	}
	return nil
}
