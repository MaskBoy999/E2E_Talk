-- Phase 19: Friend request privacy setting
-- Users can block incoming friend requests
ALTER TABLE users ADD COLUMN friend_requests_disabled INTEGER NOT NULL DEFAULT 0;
