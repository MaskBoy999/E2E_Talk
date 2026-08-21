-- F14: User custom CSS — 2 encrypted slots per user.
-- Each slot stores opaque ciphertext; the client encrypts with its identity key.
-- active_slot: 0 = use app default, 1 or 2 = use that slot.

CREATE TABLE IF NOT EXISTS user_css_slots (
    user_id     TEXT NOT NULL,
    slot        INTEGER NOT NULL CHECK (slot IN (1, 2)),
    encrypted_css TEXT NOT NULL DEFAULT '',
    nonce       TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, slot)
);

CREATE TABLE IF NOT EXISTS user_css_prefs (
    user_id      TEXT PRIMARY KEY,
    active_slot  INTEGER NOT NULL DEFAULT 0 CHECK (active_slot IN (0, 1, 2))
);
