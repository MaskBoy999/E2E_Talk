import sys

# Read handlers.rs
with open('server/src/handlers.rs', 'rb') as f:
    content = f.read()
text = content.replace(b'\r\n', b'\n').decode('utf-8')

# === Fix 2a: Update SendFriendRequest struct ===
old_struct = '#[derive(Deserialize)]\npub struct SendFriendRequest {\n    pub friend_code: String,\n}'
new_struct = '#[derive(Deserialize)]\npub struct SendFriendRequest {\n    pub friend_code: Option<String>,\n    pub friend_code_hash: Option<String>,\n}'

if old_struct in text:
    text = text.replace(old_struct, new_struct, 1)
    print('OK: SendFriendRequest struct updated')
else:
    print('FAIL: SendFriendRequest struct not found')

# === Fix 2b: Update send_friend_request handler ===
old_handler = '''    let code = req.friend_code.trim().to_uppercase();
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
    };'''

new_handler = '''    // Use pre-hashed friend_code_hash if provided, otherwise hash plaintext friend_code server-side
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
    let friend_request_result = match state.db.create_friend_request(&user_id, &code_hash) {'''

if old_handler in text:
    text = text.replace(old_handler, new_handler, 1)
    print('OK: send_friend_request handler updated')
else:
    print('FAIL: send_friend_request handler not found')
    idx = text.find('hmac_code_hash')
    if idx >= 0:
        print('Context:', repr(text[idx-50:idx+100]))

# === Fix 4: Remove sender_display_name/color/border from message list API ===

# Remove from list_messages JSON response - we need to find and remove 3 lines
old_list_fields = '''                \"sender_display_name\": m.sender_display_name,
                \"sender_profile_pic\": m.sender_profile_pic,
                \"sender_username_color\": m.sender_username_color,
                \"sender_username_border_color\": m.sender_username_border_color,'''
new_list_fields = '''                \"sender_profile_pic\": m.sender_profile_pic,''' 

# This appears TWICE in the file (once in list_messages, once in list_messages_around)
count = text.count(old_list_fields)
if count == 2:
    text = text.replace(old_list_fields, new_list_fields)
    print(f'OK: Removed sender display fields from message list API ({count} occurrences)')
else:
    print(f'FAIL: Expected 2 occurrences of list message fields, found {count}')
    if count > 0:
        text = text.replace(old_list_fields, new_list_fields)
        print(f'Replaced {count} occurrences anyway')
    else:
        idx = text.find('sender_display_name')
        if idx >= 0:
            print('Context:', repr(text[idx:idx+120]))

# Write back handlers.rs with CRLF
with open('server/src/handlers.rs', 'wb') as f:
    f.write(text.replace('\n', '\r\n').encode('utf-8'))
print('OK: handlers.rs written')


# === Read ws.rs ===
with open('server/src/ws.rs', 'rb') as f:
    ws_content = f.read()
ws_text = ws_content.replace(b'\r\n', b'\n').decode('utf-8')

# === Fix 3: Clean up WS broadcasts ===
# In each broadcast location, stop querying get_user_profile for display_name/color/border
# Only keep profile_pic

# Pattern 1: message_new handler
old_ws1 = '''            // Fetch sender's profile data for display name, profile pic, username color, and border color
            let (sender_display_name, sender_profile_pic, sender_color, sender_border_color) = match state.db.get_user_profile(user_id) {
                Ok((_, _, dn, pp, _fk, uc, bc, _, _)) => (dn, pp, uc, bc),
                Err(_) => (None, None, None, None),
            };'''

new_ws1 = '''            // Fetch sender's profile pic only (display name/colors come from encrypted snapshot/conversation_profile)
            let sender_profile_pic = match state.db.get_user_profile(user_id) {
                Ok((_, _, _, pp, _fk, _, _, _, _)) => pp,
                Err(_) => None,
            };
            let sender_display_name: Option<String> = None;
            let sender_color: Option<String> = None;
            let sender_border_color: Option<String> = None;'''

# This pattern appears 4 times - check
count_ws = ws_text.count(old_ws1)
print(f'Found {count_ws} occurrences of WS profile fetch pattern')

if count_ws >= 1:
    ws_text = ws_text.replace(old_ws1, new_ws1)
    print(f'OK: WS broadcasts cleaned ({count_ws} occurrences)')
else:
    print('FAIL: WS pattern not found')
    idx = ws_text.find('Fetch sender')
    if idx >= 0:
        print('Context:', repr(ws_text[idx:idx+300]))

# Write back ws.rs with CRLF
with open('server/src/ws.rs', 'wb') as f:
    f.write(ws_text.replace('\n', '\r\n').encode('utf-8'))
print('OK: ws.rs written')
