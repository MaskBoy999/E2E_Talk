-- Admin panel 2FA (separate from user 2FA — no FK to users table)
CREATE TABLE IF NOT EXISTS admin_2fa (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    secret_encrypted TEXT NOT NULL,
    nonce TEXT NOT NULL,
    salt TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS admin_recovery_codes (
    code_hash TEXT PRIMARY KEY,
    used INTEGER NOT NULL DEFAULT 0,
    used_at TEXT
);
