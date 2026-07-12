-- Phase 6: Hash invite codes and friend codes
-- Server only stores SHA-256 hashes; plaintext codes stay client-side.

-- Add invite_code_hash column to servers (backfilled imperatively in db.rs)
-- Add friend_code_hash column to users (backfilled imperatively in db.rs)

-- These columns are added imperatively via ALTER TABLE in run_migrations()
-- because the backfill requires computing SHA-256 which SQLite can't do natively.
-- The SQL migration file serves as documentation only.
