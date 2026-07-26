-- Migration 032: Add server picture support
-- Encrypted server picture (avatar) stored as a file, with file key encrypted using the server key

ALTER TABLE servers ADD COLUMN server_picture_file_id TEXT;
ALTER TABLE servers ADD COLUMN encrypted_server_picture_key BLOB;
ALTER TABLE servers ADD COLUMN server_picture_key_nonce BLOB;
