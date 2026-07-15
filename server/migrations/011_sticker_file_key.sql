-- Add file_key to server_stickers (safe to run multiple times)
ALTER TABLE server_stickers ADD COLUMN file_key TEXT;
