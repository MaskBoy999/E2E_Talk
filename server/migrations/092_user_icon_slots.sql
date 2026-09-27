-- F15: Custom UI icons — 2 encrypted slots per user.
--
-- Every icon in the app is a `<symbol id="icon-…">` in the page's sprite, drawn
-- through the `icon(name)` helper. A slot holds a JSON map of
-- icon-name -> SVG markup that overrides those symbols; ids a pack does not
-- define keep the built-in art. The client encrypts the map with its identity
-- key, so the server stores opaque ciphertext and can never see the artwork.
--
-- active_slot: 0 = built-in icons, 1 or 2 = that slot.
CREATE TABLE IF NOT EXISTS user_icon_slots (
    user_id       TEXT NOT NULL,
    slot          INTEGER NOT NULL CHECK (slot IN (1, 2)),
    encrypted_icons TEXT NOT NULL DEFAULT '',
    nonce         TEXT NOT NULL DEFAULT '',
    PRIMARY KEY (user_id, slot)
);

CREATE TABLE IF NOT EXISTS user_icon_prefs (
    user_id      TEXT PRIMARY KEY,
    active_slot  INTEGER NOT NULL DEFAULT 0 CHECK (active_slot IN (0, 1, 2))
);
