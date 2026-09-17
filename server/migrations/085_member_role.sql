-- One role per member. NULL means "no role" — the @everyone role then applies.
-- Deliberately not a FK: role deletion unassigns members explicitly (db.rs
-- delete_role) and membership deletion (kick/ban/leave/account delete) removes
-- the whole server_members row, which resets the member's permissions.
ALTER TABLE server_members ADD COLUMN role_id TEXT;
