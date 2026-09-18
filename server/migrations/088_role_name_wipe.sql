-- Roles whose name is already stored encrypted no longer need the plaintext mirror.
-- Rows with encrypted_name IS NULL are deliberately left alone: the client still needs
-- their plaintext to produce the encrypted form (see SECURITY_FIX_PLAN.md §3.1).
UPDATE server_roles SET name = '' WHERE encrypted_name IS NOT NULL AND name <> '';
