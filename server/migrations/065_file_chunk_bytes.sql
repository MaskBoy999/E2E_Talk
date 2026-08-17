-- H1: track the actual cumulative chunk bytes written per file so uploads are
-- bounded by the declared size (the init-time quota / max-file checks) instead
-- of allowing unbounded chunk writes that bypass both. `chunk_bytes` is the
-- sum of the DISTINCT chunk files on disk (overwrites adjust, not add).
ALTER TABLE files ADD COLUMN chunk_bytes INTEGER NOT NULL DEFAULT 0;
