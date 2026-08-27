-- Server groups: folders that hold multiple servers
CREATE TABLE IF NOT EXISTS server_groups (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'Group',
    position INTEGER NOT NULL DEFAULT 0,
    collapsed INTEGER NOT NULL DEFAULT 0,
    parent_group_id TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (parent_group_id) REFERENCES server_groups(id) ON DELETE SET NULL
);

-- Add group_id to servers table
ALTER TABLE servers ADD COLUMN group_id TEXT REFERENCES server_groups(id) ON DELETE SET NULL;

-- Index for fast lookup
CREATE INDEX IF NOT EXISTS idx_server_groups_user ON server_groups(user_id);
CREATE INDEX IF NOT EXISTS idx_servers_group ON servers(group_id);
