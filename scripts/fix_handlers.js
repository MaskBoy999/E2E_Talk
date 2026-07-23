const fs = require('fs');

// Fix 2: handlers.rs - update SendFriendRequest struct and send_friend_request handler
let content = fs.readFileSync('server/src/handlers.rs', 'utf8');

// Update SendFriendRequest struct
content = content.replace(
  '#[derive(Deserialize)]\npub struct SendFriendRequest {\n    pub friend_code: String,\n}',
  '#[derive(Deserialize)]\npub struct SendFriendRequest {\n    pub friend_code: Option<String>,\n    pub friend_code_hash: Option<String>,\n}'
);

// Update send_friend_request handler - replace the code extraction + HMAC hashing
const oldHandler = `    let code = req.friend_code.trim().to_uppercase();
    if code.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({\"error\": \"Friend code is required\"})),
        )
            .into_response();
    }

    // Compute HMAC hash; fall back to legacy SHA-256 if HMAC lookup fails
    let hmac_code_hash = hmac_sha256_hex(state.config.hmac_key.as_bytes(), &code);
    let friend_request_result = match state.db.create_friend_request(&user_id, &hmac_code_hash) {
        Ok(target) => Ok(target),
        Err(_) => {
            // Fall back to legacy SHA-256 hash for old friend codes
            state.db.create_friend_request(&user_id, &sha256_hex(&code))
        }
    };`;

const newHandler = `    // Use pre-hashed friend_code_hash if provided, otherwise hash plaintext friend_code server-side
    let code_hash = match req.friend_code_hash {
        Some(ref hash) => hash.clone(),
        None => {
            let code = match req.friend_code {
                Some(ref c) => c.trim().to_uppercase(),
                None => {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({\"error\": \"Friend code or friend_code_hash is required\"})),
                    )
                        .into_response();
                }
            };
            if code.is_empty() {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({\"error\": \"Friend code is required\"})),
                )
                    .into_response();
            }
            // Legacy fallback: hash the plaintext code server-side
            hmac_sha256_hex(state.config.hmac_key.as_bytes(), &code)
        }
    };
    let friend_request_result = match state.db.create_friend_request(&user_id, &code_hash) {`;

if (content.includes(oldHandler)) {
  content = content.replace(oldHandler, newHandler);
  console.log('✅ handlers.rs: send_friend_request handler updated');
} else {
  console.log('❌ handlers.rs: send_friend_request handler pattern not found');
  const idx = content.indexOf('hmac_code_hash');
  if (idx >= 0) {
    console.log(content.substring(Math.max(0, idx - 100), idx + 200));
  }
}

fs.writeFileSync('server/src/handlers.rs', content, 'utf8');
