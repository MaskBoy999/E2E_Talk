with open('server/src/handlers.rs', 'r') as f:
    content = f.read()

# Fix the broken list_messages body - replace the broken match+unwrap_or_else with clean if/else
old = '''    let messages = match before {
        Some(ts) => state.db.list_messages_before(&channel_id, ts, limit),
        None => state.db.list_messages(&channel_id, limit),
    }.unwrap_or_else(|e| {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({\"error\": e})),
        ).into_response();
        vec![] // unreachable, needed for type inference
    });
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({\"error\": e})),
            )
                .into_response();
        }
    };

    // Collect unique sender IDs'''

new = '''    let messages = if let Some(ts) = before {
        match state.db.list_messages_before(&channel_id, ts, limit) {
            Ok(m) => m,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({\"error\": e})),
                ).into_response();
            }
        }
    } else {
        match state.db.list_messages(&channel_id, limit) {
            Ok(m) => m,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({\"error\": e})),
                ).into_response();
            }
        }
    };

    // Collect unique sender IDs'''

content = content.replace(old, new)

# Fix the broken list_dm_messages body
old2 = '''    match match before {
        Some(ts) => state.db.list_dm_messages_before(&dm_channel_id, ts, limit),
        None => state.db.list_dm_messages(&dm_channel_id, limit),
    } {'''

new2 = '''    let msgs = if let Some(ts) = before {
        match state.db.list_dm_messages_before(&dm_channel_id, ts, limit) {
            Ok(m) => m,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({\"error\": e})),
                ).into_response();
            }
        }
    } else {
        match state.db.list_dm_messages(&dm_channel_id, limit) {
            Ok(m) => m,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({\"error\": e})),
                ).into_response();
            }
        }
    };'''

content = content.replace(old2, new2)

with open('server/src/handlers.rs', 'w') as f:
    f.write(content)

print('Fixed handlers.rs')
