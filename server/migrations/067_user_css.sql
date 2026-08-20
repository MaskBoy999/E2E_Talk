-- F14: Custom CSS — user-editable styles stored encrypted on the server
-- The CSS is encrypted with the user's identity key before storage.
-- Other users on the same server can fetch it to render the author's style.
CREATE TABLE IF NOT EXISTS user_css (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    encrypted_css BLOB NOT NULL,
    css_nonce BLOB NOT NULL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
