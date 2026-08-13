-- Migration 057: F4 legacy cleanup
-- Drops the 0-row X3DH-era tables that survived the old migration 023
-- (which was never registered because its step 3 would have dropped
-- user_key_escrow, still in use). These three tables have no code
-- references left: the admin endpoints that once listed them were removed
-- alongside this migration.
DROP TABLE IF EXISTS sessions;
DROP TABLE IF EXISTS user_devices;
DROP TABLE IF EXISTS prekey_bundles;
