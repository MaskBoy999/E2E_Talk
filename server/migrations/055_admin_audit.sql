-- Migration 055: Append-only admin audit log (G4).
-- Records who (admin) did what, when, to which target, from which IP.
-- Tokens/passwords are NEVER logged.
CREATE TABLE IF NOT EXISTS admin_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    target TEXT,
    ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_admin_audit_timestamp ON admin_audit(timestamp DESC);
