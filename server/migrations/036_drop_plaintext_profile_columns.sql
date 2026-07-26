-- Migration 036: Drop plaintext profile style columns
-- username_color, username_border_color, profile_background_color
-- are now exclusively stored in encrypted_profile_data (AES-GCM with identity key).
-- These columns were readable by any SQL query on the users table.

ALTER TABLE users DROP COLUMN username_color;
ALTER TABLE users DROP COLUMN username_border_color;
ALTER TABLE users DROP COLUMN profile_background_color;
