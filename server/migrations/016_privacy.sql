-- Phase 16: Privacy - encrypted display names
-- Server stores encrypted display names so it cannot read them.

-- Add encrypted display name columns (XChaCha20-Poly1305 encrypted + nonce)
ALTER TABLE users ADD COLUMN encrypted_display_name TEXT;
ALTER TABLE users ADD COLUMN display_name_nonce TEXT;
