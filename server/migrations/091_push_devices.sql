-- Push notification device registrations (Web Push for browsers/PWA + FCM for
-- the Android box). The server only ever forwards the small metadata payload
-- built at send time (title/body/tag/url); message content stays end-to-end
-- encrypted and never reaches this table or the push services.
CREATE TABLE IF NOT EXISTS push_devices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    platform TEXT NOT NULL,             -- 'web' | 'android'
    token TEXT NOT NULL UNIQUE,         -- Web Push endpoint URL, or FCM registration token
    p256dh TEXT,                        -- Web Push: client public key (web only)
    auth TEXT,                          -- Web Push: auth secret (web only)
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_push_devices_user ON push_devices(user_id);
