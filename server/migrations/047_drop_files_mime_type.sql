-- Migration 047: Drop plaintext mime_type from files
-- The client encrypts the file's mime type with the file key and stores it in
-- encrypted_mime_type + mime_nonce (migration 038 columns). The plaintext column
-- is always written as '' by create_file_record, and download serves
-- application/octet-stream regardless, so a DB dump reveals nothing about the
-- file type. Dropping the column matches migration 046 (user_stickers).

ALTER TABLE files DROP COLUMN mime_type;
