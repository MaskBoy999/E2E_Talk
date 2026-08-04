-- Migration 051: Persistent DM-call waiting state
-- When a DM call rings for 30s unanswered (or one side leaves an active call),
-- the waiting side stays visible across page refreshes: the record below lets
-- both participants see "X is waiting for you to join the call" in the DM chat
-- and lets a callback connect the two users automatically.
CREATE TABLE IF NOT EXISTS dm_call_waiting (
    dm_channel_id TEXT PRIMARY KEY,
    waiting_user_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_dm_call_waiting_user ON dm_call_waiting(waiting_user_id);
