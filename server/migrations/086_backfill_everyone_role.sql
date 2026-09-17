-- Backfill the @everyone role for servers that predate roles.
-- 286783 = VIEW_CHANNEL | SEND_MESSAGES | ADD_REACTIONS | REPLY_IN_THREADS |
--          ATTACH_FILES | CREATE_POLLS | CONNECT_VOICE | SPEAK | USE_SOUNDBOARD
-- (keep in sync with PERM_DEFAULT_EVERYONE in server/src/db.rs).
INSERT INTO server_roles (id, server_id, name, color, position, is_everyone, permissions)
SELECT lower(hex(randomblob(16))), s.id, '@everyone', '#99aab5', 0, 1, 286783
FROM servers s
WHERE NOT EXISTS (
    SELECT 1 FROM server_roles r WHERE r.server_id = s.id AND r.is_everyone = 1
);
