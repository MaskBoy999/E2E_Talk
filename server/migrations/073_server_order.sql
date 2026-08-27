-- Per-user server ordering: add position to server_members
ALTER TABLE server_members ADD COLUMN position INTEGER DEFAULT 0;
