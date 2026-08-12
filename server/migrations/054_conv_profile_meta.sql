-- Migration 054: Conversation-profile field-presence metadata.
--
-- The server cannot decrypt conversation profiles (E2EE), so it cannot tell
-- whether a re-upload would silently DROP fields (e.g. a stale device
-- re-uploading a bare profile and wiping the banner/PFP keys everyone else
-- uses). The client therefore sends the (already server-visible, non-secret)
-- profile_picture_file_id / profile_banner_file_id it is uploading; the server
-- stores them here and rejects non-authoritative uploads that would remove a
-- field the user currently has (per the users table or a previous upload).
ALTER TABLE conversation_profile_data ADD COLUMN profile_picture_file_id TEXT;
ALTER TABLE conversation_profile_data ADD COLUMN profile_banner_file_id TEXT;
