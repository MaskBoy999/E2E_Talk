-- Migration 031: Pending events for offline owners
-- Stores key rotation events that need to be replayed when
-- the server owner reconnects via WebSocket.
CREATE TABLE IF NOT EXISTS pending_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    server_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    affected_user_id TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pending_events_user_id ON pending_events(user_id);
