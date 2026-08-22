-- Vault files larger than ~900 MB can't fit in a SQLite BLOB (SQLITE_MAX_LENGTH
-- is capped at 1 GB by the bundled compile-time default).  Add storage_path so
-- large (and eventually all) vault blobs can live on disk.
ALTER TABLE user_vault_files ADD COLUMN storage_path TEXT;
