-- Discord-style server roles + per-channel/category permission overwrites.
--
-- One role per member (server_members.role_id, migration 085). Every server has
-- exactly one is_everyone=1 role at position 0 which applies to all members and
-- is used as the fallback for members without an explicit role. The server owner
-- is NOT a role row: owners implicitly hold every permission (see db.rs
-- PERM_ALL) and can never be restricted, kicked or banned.
--
-- permissions / allow / deny are bit fields (see the PERM_* constants in
-- server/src/db.rs and the matching table in static/roles.js).
CREATE TABLE IF NOT EXISTS server_roles (
    id TEXT PRIMARY KEY,
    server_id TEXT NOT NULL REFERENCES servers(id) ON DELETE CASCADE,
    name TEXT NOT NULL DEFAULT 'new role',
    color TEXT,
    position INTEGER NOT NULL DEFAULT 1,
    is_everyone INTEGER NOT NULL DEFAULT 0,
    permissions INTEGER NOT NULL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- allow/deny overwrite for one role on one channel OR one category. A channel
-- that belongs to a category inherits the category overwrite first.
CREATE TABLE IF NOT EXISTS role_overwrites (
    role_id TEXT NOT NULL REFERENCES server_roles(id) ON DELETE CASCADE,
    target_type TEXT NOT NULL CHECK(target_type IN ('channel', 'category')),
    target_id TEXT NOT NULL,
    allow INTEGER NOT NULL DEFAULT 0,
    deny INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (role_id, target_type, target_id)
);

CREATE INDEX IF NOT EXISTS idx_server_roles_server ON server_roles(server_id);
CREATE INDEX IF NOT EXISTS idx_role_overwrites_role ON role_overwrites(role_id);
