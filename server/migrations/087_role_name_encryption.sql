-- Add encrypted name columns to server_roles for E2E encryption of role names.
-- The plaintext `name` column is kept for backward compatibility during migration;
-- new writes use encrypted_name/name_nonce and the name column mirrors the
-- decrypted value for search/sort only.
ALTER TABLE server_roles ADD COLUMN encrypted_name BLOB;
ALTER TABLE server_roles ADD COLUMN name_nonce BLOB;
