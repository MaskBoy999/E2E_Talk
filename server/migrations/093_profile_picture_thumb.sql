-- Profile-picture thumbnails.
--
-- A profile picture is rendered at 32-64px almost everywhere (message avatars,
-- DM sidebar, member list, mentions, search) and at full size in exactly one
-- place (the profile view). Uploading and sharing the original for every one of
-- those avatars costs bandwidth and forces the browser to decode a multi-
-- megapixel image to fill a 36px circle.
--
-- The client therefore uploads a second, 360x360 file that is encrypted with
-- its own random file key, exactly like the original. These columns hold that
-- thumb's id, its blind SHA-256 index, and the thumb key encrypted with the
-- owner's identity key (the server can decrypt none of it).
--
-- All four stay NULL for accounts that never re-upload a picture; clients fall
-- back to the full-resolution file in that case.
ALTER TABLE users ADD COLUMN profile_picture_thumb_file_id TEXT;
ALTER TABLE users ADD COLUMN profile_picture_thumb_file_id_hash TEXT;
ALTER TABLE users ADD COLUMN encrypted_pic_thumb_key BLOB;
ALTER TABLE users ADD COLUMN pic_thumb_key_nonce BLOB;
