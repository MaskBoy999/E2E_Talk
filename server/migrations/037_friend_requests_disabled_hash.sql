-- Migration 037: Add friend_requests_disabled_hash column
-- The client sends HMAC(hmac_key, user_id + ":fr_disabled:" + "1"/"0") when toggling.
-- The server stores the hash and derives the boolean by computing both HMAC variants.
-- Never stores the raw boolean sent over the wire as plaintext.

ALTER TABLE users ADD COLUMN friend_requests_disabled_hash TEXT;
