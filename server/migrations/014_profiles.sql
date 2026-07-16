-- Migration 014: Profile pictures and display names

-- Add display_name column (shown in chat instead of login username)
ALTER TABLE users ADD COLUMN display_name TEXT;

-- Add profile_picture_file_id column (references encrypted file upload)
ALTER TABLE users ADD COLUMN profile_picture_file_id TEXT REFERENCES files(id) ON DELETE SET NULL;
