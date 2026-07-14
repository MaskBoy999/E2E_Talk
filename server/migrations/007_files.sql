-- Phase 5: File Sharing
-- Stores metadata for encrypted files uploaded by users.
-- Actual file data is stored on disk in uploads/ directory.
-- Filenames and content are encrypted client-side; server only sees ciphertext.

CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    uploader_id TEXT NOT NULL REFERENCES users(id),
    original_size INTEGER NOT NULL,
    mime_type TEXT NOT NULL DEFAULT 'application/octet-stream',
    chunk_count INTEGER NOT NULL DEFAULT 0,
    upload_complete BOOLEAN DEFAULT FALSE,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Index for looking up files by channel (in message references)
CREATE INDEX IF NOT EXISTS idx_files_uploader ON files(uploader_id);
