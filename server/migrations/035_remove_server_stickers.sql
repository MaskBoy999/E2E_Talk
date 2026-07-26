-- Migration 035: Remove server_stickers table
-- The chat client never used server stickers. They only existed in the
-- admin panel and database. The file_key leak was already fixed in
-- migration 034 (backfill). Now removing the table entirely.
DROP TABLE IF EXISTS server_stickers;
