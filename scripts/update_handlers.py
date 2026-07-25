with open('server/src/handlers.rs', 'r') as f:
    content = f.read()

# Update list_messages handler signature and logic
old = '''pub async fn list_messages(
    Path(channel_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {'''

new = '''pub async fn list_messages(
    Path(channel_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {'''

content = content.replace(old, new)

# Update the list_messages body to use query params
old_body = '''    let messages = match state.db.list_messages(&channel_id, 100) {'''

new_body = '''    let limit: i64 = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50);
    let before = params.get("before").map(|s| s.as_str());

    let messages = match before {
        Some(ts) => state.db.list_messages_before(&channel_id, ts, limit),
        None => state.db.list_messages(&channel_id, limit),
    } {'''

content = content.replace(old_body, new_body)

# Update list_dm_messages handler
old2 = '''pub async fn list_dm_messages(
    Path(dm_channel_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {'''

new2 = '''pub async fn list_dm_messages(
    Path(dm_channel_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {'''

content = content.replace(old2, new2)

# Update list_dm_messages body
old_body2 = '''    match state.db.list_dm_messages(&dm_channel_id, 100) {'''

new_body2 = '''    let limit: i64 = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50);
    let before = params.get("before").map(|s| s.as_str());

    match match before {
        Some(ts) => state.db.list_dm_messages_before(&dm_channel_id, ts, limit),
        None => state.db.list_dm_messages(&dm_channel_id, limit),
    } {'''

content = content.replace(old_body2, new_body2)

with open('server/src/handlers.rs', 'w') as f:
    f.write(content)

print('Done: updated handlers.rs')
