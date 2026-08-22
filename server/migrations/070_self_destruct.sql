-- F3-14: Self-Destructing Accounts (per-user setting)
-- Off by default. User can enable in Settings → Security.
-- When enabled, the account is auto-deleted after N days of inactivity.

-- Add self-destruct columns to users table
ALTER TABLE users ADD COLUMN self_destruct_days INTEGER DEFAULT 0;
ALTER TABLE users ADD COLUMN last_active_at TEXT DEFAULT NULL;
