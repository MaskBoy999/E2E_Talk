-- Soundboard per-account: clips belong to a user, not a server.
-- Encrypted with user's identity key so they are portable across servers.
-- server_id stays for backward compat but is ignored for access control.
ALTER TABLE soundboard_clips ADD COLUMN encrypted_key TEXT DEFAULT '';
ALTER TABLE soundboard_clips ADD COLUMN key_nonce TEXT DEFAULT '';

-- New endpoint: list all clips for the current user (across all servers)
-- The existing list_soundboard_clips queries by server_id; we add a user-only query.
