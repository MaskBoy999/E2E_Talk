-- Per-user DM conversation ordering
ALTER TABLE dm_channels ADD COLUMN position INTEGER DEFAULT 0;
