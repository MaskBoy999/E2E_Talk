-- Track compression algorithm used for vault files
ALTER TABLE user_vault_files ADD COLUMN compression TEXT NOT NULL DEFAULT 'none';
