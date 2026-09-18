-- @everyone briefly inherited INVITE_MEMBERS (1 << 20) because
-- PERM_DEFAULT_EVERYONE included it, so servers created since the roles feature
-- shipped have permissions = 1335359 (286783 | INVITE_MEMBERS) while the backfill
-- in 086 stores 286783.
--
-- Inviting is now grant-only: the owner holds it implicitly (PERM_ALL) and can
-- hand it to specific members with a custom role, but it is no longer a default.
-- 286783 = VIEW_CHANNEL | SEND_MESSAGES | ADD_REACTIONS | REPLY_IN_THREADS |
--          ATTACH_FILES | CREATE_POLLS | CONNECT_VOICE | SPEAK | USE_SOUNDBOARD
-- (keep in sync with PERM_DEFAULT_EVERYONE in server/src/db.rs).
--
-- Only the exact old default is rewritten, so an @everyone whose permissions
-- were edited by hand (including one that intentionally re-added INVITE_MEMBERS)
-- is left untouched.
UPDATE server_roles
SET permissions = 286783
WHERE is_everyone = 1 AND permissions = 1335359;
