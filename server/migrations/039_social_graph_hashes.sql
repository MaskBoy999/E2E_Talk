-- Fix 5: Encrypt notification sound file_name
ALTER TABLE notification_sounds ADD COLUMN encrypted_file_name BLOB;
ALTER TABLE notification_sounds ADD COLUMN file_name_nonce BLOB;

-- Fix 6: Hash request_id for friend accept/decline
ALTER TABLE friend_requests ADD COLUMN request_id_hash TEXT;
