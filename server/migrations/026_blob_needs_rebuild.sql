-- Migration 026: Add needs_rebuild flag to user_key_blobs
-- Existing blobs created before this migration don't have profile_key_cache
-- in their bundle. Setting needs_rebuild=1 triggers the client to rebuild
-- the blob on next login (which includes profile_key_cache via Fix 6).

ALTER TABLE user_key_blobs ADD COLUMN needs_rebuild INTEGER NOT NULL DEFAULT 0;

-- Mark all existing blobs as needing rebuild
UPDATE user_key_blobs SET needs_rebuild = 1;
