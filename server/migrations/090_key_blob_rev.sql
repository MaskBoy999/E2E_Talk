-- Revision counter for the password-wrapped key blob (multi-device sync).
-- Every successful PUT bumps it; a PUT that states a stale base revision is
-- rejected so two devices saving at the same moment cannot silently drop one
-- another's keys (the loser merges the winner's blob and retries).
ALTER TABLE user_key_blobs ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
