use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::{
    extract::{Json, Path, State},
    http::{HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
};
use serde::Deserialize;

use base64::Engine;
use crate::auth;
use crate::AppState;

static ADMIN_TOKENS: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

fn get_admin_tokens() -> std::sync::MutexGuard<'static, Option<HashMap<String, Instant>>> {
    ADMIN_TOKENS.lock().unwrap()
}

fn store_admin_token(token: String) {
    let mut guard = get_admin_tokens();
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(token, Instant::now() + Duration::from_secs(24 * 3600));
}

fn extract_user(headers: &HeaderMap, state: &AppState) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
    // Check HttpOnly cookie first
    let token = headers
        .get("cookie")
        .and_then(|v| v.to_str().ok())
        .and_then(|cookie_str| {
            cookie_str.split(';')
                .find_map(|part| {
                    let trimmed = part.trim();
                    trimmed.strip_prefix("token=").map(|v| v.to_string())
                })
        })
        .or_else(|| {
            // Fall back to Authorization: Bearer header
            headers
                .get("authorization")
                .and_then(|v| v.to_str().ok())
                .and_then(|v| v.strip_prefix("Bearer ").map(|s| s.to_string()))
        })
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "Missing authorization"})),
            )
        })?;

    let claims = auth::validate_token(&token, &state.config.jwt_secret).map_err(|_| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Invalid token"})),
        )
    })?;

    Ok(claims.sub)
}

fn extract_admin_token(headers: &HeaderMap) -> Result<(), (StatusCode, Json<serde_json::Value>)> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").map(|s| s.to_string()))
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "Missing admin authorization"})),
            )
        })?;

    let guard = get_admin_tokens();
    let map = guard.as_ref().ok_or_else(|| {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Invalid admin token"})),
        )
    })?;

    match map.get(&token) {
        Some(expiry) if *expiry > Instant::now() => Ok(()),
        _ => Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Invalid or expired admin token"})),
        )),
    }
}

// --- Auth ---

#[derive(Deserialize)]
pub struct RegisterRequest {
    pub username: String,
    pub password: String,
    pub identity_public_key: Option<String>,
    pub friend_code_hash: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

#[derive(Deserialize)]
pub struct AdminLoginRequest {
    pub password: String,
}

pub async fn register(
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterRequest>,
) -> impl IntoResponse {
    if req.username.is_empty() || req.password.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Username and password are required"})),
        );
    }

    if req.password.len() < 6 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Password must be at least 6 characters"})),
        );
    }

    let password_hash = match auth::hash_password(&req.password) {
        Ok(h) => h,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            );
        }
    };

    let identity_key_bytes = req.identity_public_key.as_ref().and_then(|k| {
        base64::engine::general_purpose::STANDARD.decode(k).ok()
    });

    let user = match state.db.create_user(&req.username, &password_hash, identity_key_bytes.as_deref(), req.friend_code_hash.as_deref()) {
        Ok(u) => u,
        Err(e) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error": e})),
            );
        }
    };

    // Also store in user_public_keys for multi-device support
    if let Some(ref key_bytes) = identity_key_bytes {
        let _ = state.db.add_user_public_key(&user.id, key_bytes);
    }

    let token = match auth::create_token(&user.id, &user.username, &state.config.jwt_secret) {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            );
        }
    };

    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "token": token,
            "user": { "id": user.id, "username": user.username }
        })),
    )
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> impl IntoResponse {
    let password_hash = match state.db.get_password_hash(&req.username) {
        Ok(h) => h,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "Wrong username or password"})),
            )
                .into_response();
        }
    };

    let valid = match auth::verify_password(&req.password, &password_hash) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "Wrong username or password"})),
            )
                .into_response();
        }
    };

    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Wrong username or password"})),
        )
            .into_response();
    }

    let user = match state.db.get_user_by_username(&req.username) {
        Ok(u) => u,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let token = match auth::create_token(&user.id, &user.username, &state.config.jwt_secret) {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let mut headers = HeaderMap::new();
    headers.insert(
        "set-cookie",
        HeaderValue::from_str(
            &format!("token={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=86400", token)
        ).unwrap(),
    );

    (StatusCode::OK, headers, Json(serde_json::json!({
        "token": token,
        "user": { "id": user.id, "username": user.username }
    }))).into_response()
}

// --- Servers ---

#[derive(Deserialize)]
pub struct CreateServerRequest {
    pub name: String,
    pub invite_code_hash: String,
}

pub async fn create_server(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateServerRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if req.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Server name is required"})),
        )
            .into_response();
    }

    let server = match state.db.create_server(req.name.trim(), &user_id, &req.invite_code_hash) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": server.id,
            "name": server.name,
        })),
    )
        .into_response()
}

pub async fn list_servers(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let servers = match state.db.list_user_servers(&user_id) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let result: Vec<serde_json::Value> = servers
        .iter()
        .map(|s| {
            let is_owner = s.owner_id == user_id;
            serde_json::json!({
                "id": s.id,
                "name": s.name,
                "is_owner": is_owner,
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

// --- Channels ---

pub async fn list_channels(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if !state.db.is_member_of_server(&user_id, &server_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not a member of this server"})),
        )
            .into_response();
    }

    let channels = match state.db.list_server_channels(&server_id) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let channel_infos: Vec<serde_json::Value> = channels
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "name": c.name,
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(channel_infos))).into_response()
}

#[derive(Deserialize)]
pub struct CreateChannelRequest {
    pub name: String,
}

pub async fn create_channel(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateChannelRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if !state.db.is_server_owner(&user_id, &server_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Only the server owner can create channels"})),
        )
            .into_response();
    }

    if req.name.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Channel name is required"})),
        )
            .into_response();
    }

    let channel = match state.db.create_channel(&server_id, req.name.trim()) {
        Ok(c) => c,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    // Broadcast channel_created to all server members
    let channel_msg = serde_json::json!({
        "type": "channel_created",
        "server_id": server_id,
    });
    if let Ok(members) = state.db.get_server_members(&server_id) {
        let _ = state.ws_manager.broadcast_to_users(&members, &channel_msg.to_string()).await;
    }

    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "id": channel.id,
            "name": channel.name,
        })),
    )
        .into_response()
}

// --- Invites ---

pub async fn get_invite(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if !state.db.is_server_owner(&user_id, &server_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Only the server owner can view the invite code"})),
        )
            .into_response();
    }

    let servers = match state.db.list_user_servers(&user_id) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let server = match servers.iter().find(|s| s.id == server_id) {
        Some(s) => s,
        None => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "Server not found"})),
            )
                .into_response();
        }
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "server_id": server.id,
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct RegenerateInviteRequest {
    pub invite_code_hash: String,
}

pub async fn regenerate_invite(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegenerateInviteRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.regenerate_invite(&server_id, &user_id, &req.invite_code_hash) {
        Ok(()) => {
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "server_id": server_id,
                })),
            )
                .into_response()
        }
        Err(e) => {
            (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": e})),
            )
                .into_response()
        }
    }
}

#[derive(Deserialize)]
pub struct JoinServerRequest {
    pub code: String,
}

pub async fn join_server(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<JoinServerRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if req.code.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invite code is required"})),
        )
            .into_response();
    }

    let server = match state.db.join_server_by_invite(req.code.trim(), &user_id) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    // Broadcast member_joined to all server members
    let join_msg = serde_json::json!({
        "type": "member_joined",
        "server_id": server.id,
        "user_id": user_id,
    });
    if let Ok(members) = state.db.get_server_members(&server.id) {
        let _ = state.ws_manager.broadcast_to_users(&members, &join_msg.to_string()).await;
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "id": server.id,
            "name": server.name,
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct KickMemberRequest {
    pub user_id: String,
}

pub async fn kick_member(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<KickMemberRequest>,
) -> impl IntoResponse {
    let caller_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if !state.db.is_server_owner(&caller_id, &server_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Only the server owner can kick members"})),
        )
            .into_response();
    }

    if req.user_id == caller_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Cannot kick yourself"})),
        )
            .into_response();
    }

    match state.db.kick_member(&server_id, &req.user_id) {
        Ok(()) => {
            let kick_msg = serde_json::json!({
                "type": "member_kicked",
                "server_id": server_id,
                "user_id": req.user_id,
            });
            if let Ok(members) = state.db.get_server_members(&server_id) {
                let _ = state.ws_manager.broadcast_to_users(&members, &kick_msg.to_string()).await;
            }
            (
                StatusCode::OK,
                Json(serde_json::json!({"ok": true})),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub async fn leave_server(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.leave_server(&server_id, &user_id) {
        Ok(server_deleted) => {
            if server_deleted {
                // Owner left: broadcast server deletion to all members
                let del_msg = serde_json::json!({
                    "type": "server_deleted",
                    "server_id": server_id,
                });
                if let Ok(members) = state.db.get_server_members(&server_id) {
                    let _ = state.ws_manager.broadcast_to_users(&members, &del_msg.to_string()).await;
                }
            } else {
                // Member left: broadcast member_left
                let leave_msg = serde_json::json!({
                    "type": "member_left",
                    "server_id": server_id,
                    "user_id": user_id,
                });
                if let Ok(members) = state.db.get_server_members(&server_id) {
                    let _ = state.ws_manager.broadcast_to_users(&members, &leave_msg.to_string()).await;
                }
            }
            (
                StatusCode::OK,
                Json(serde_json::json!({"ok": true, "server_deleted": server_deleted})),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct BanMemberRequest {
    pub user_id: String,
}

pub async fn ban_member(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<BanMemberRequest>,
) -> impl IntoResponse {
    let caller_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if !state.db.is_server_owner(&caller_id, &server_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Only the server owner can ban members"})),
        )
            .into_response();
    }

    if req.user_id == caller_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Cannot ban yourself"})),
        )
            .into_response();
    }

    match state.db.ban_member(&server_id, &req.user_id) {
        Ok(()) => {
            let ban_msg = serde_json::json!({
                "type": "member_banned",
                "server_id": server_id,
                "user_id": req.user_id,
            });
            if let Ok(members) = state.db.get_server_members(&server_id) {
                let _ = state.ws_manager.broadcast_to_users(&members, &ban_msg.to_string()).await;
            }
            (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn unban_member(
    Path((server_id, user_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let caller_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if !state.db.is_server_owner(&caller_id, &server_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Only the server owner can unban members"})),
        )
            .into_response();
    }

    match state.db.unban_member(&server_id, &user_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn list_server_bans(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let caller_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if !state.db.is_server_owner(&caller_id, &server_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Only the server owner can view bans"})),
        )
            .into_response();
    }

    match state.db.list_server_bans(&server_id) {
        Ok(bans) => {
            let result: Vec<serde_json::Value> = bans
                .iter()
                .map(|(id, username)| {
                    serde_json::json!({ "id": id, "username": username })
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn delete_channel(
    Path(channel_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Get server_id before deletion for the broadcast
    let server_id = state.db.get_server_id_for_channel(&channel_id);

    match state.db.delete_channel_by_owner(&channel_id, &user_id) {
        Ok(()) => {
            if let Ok(sid) = server_id {
                let channel_msg = serde_json::json!({
                    "type": "channel_deleted",
                    "server_id": sid,
                });
                if let Ok(members) = state.db.get_server_members(&sid) {
                    let _ = state.ws_manager.broadcast_to_users(&members, &channel_msg.to_string()).await;
                }
            }
            (
                StatusCode::OK,
                Json(serde_json::json!({"ok": true})),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

// --- Members ---

pub async fn list_server_members(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if !state.db.is_member_of_server(&user_id, &server_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not a member of this server"})),
        )
            .into_response();
    }

    let members = match state.db.get_server_members_with_names(&server_id) {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let result: Vec<serde_json::Value> = members
        .iter()
        .map(|(id, username, role)| {
            serde_json::json!({
                "id": id,
                "username": username,
                "role": role,
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

// --- Messages ---

pub async fn list_messages(
    Path(channel_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let server_id = match state.db.get_server_id_for_channel(&channel_id) {
        Ok(id) => id,
        Err(e) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    if !state.db.is_member_of_server(&user_id, &server_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not a member of this server"})),
        )
            .into_response();
    }

    let messages = match state.db.list_messages(&channel_id, 100) {
        Ok(m) => m,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let message_infos: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "sender_username": m.sender_username,
                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                "timestamp": m.timestamp
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(message_infos))).into_response()
}

// --- Keys ---

pub async fn get_key_bundle(
    Path(user_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    match state.db.get_prekey_bundle(&user_id) {
        Ok(bundle) => (
            StatusCode::OK,
            Json(serde_json::json!({
                "user_id": bundle.user_id,
                "identity_key_public": base64::engine::general_purpose::STANDARD.encode(&bundle.identity_key_public),
                "signed_prekey_public": base64::engine::general_purpose::STANDARD.encode(&bundle.signed_prekey_public),
                "signed_prekey_signature": base64::engine::general_purpose::STANDARD.encode(&bundle.signed_prekey_signature),
                "one_time_prekey_public": bundle.one_time_prekey_public.as_ref().map(|k| base64::engine::general_purpose::STANDARD.encode(k)),
                "one_time_prekey_id": bundle.one_time_prekey_id,
            })),
        ),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": e})),
        ),
    }
}

pub async fn get_user_id(
    Path(username): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    match state.db.get_user_by_username(&username) {
        Ok(user) => (
            StatusCode::OK,
            Json(serde_json::json!({"id": user.id, "username": user.username})),
        ),
        Err(e) => (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": e})),
        ),
    }
}

// --- Server Keys (E2EE) ---

pub async fn get_identity_key(
    Path(user_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let mut all_keys: Vec<String> = Vec::new();

    // Primary key from users table
    if let Ok(key) = state.db.get_identity_public_key(&user_id) {
        all_keys.push(base64::engine::general_purpose::STANDARD.encode(&key));
    }

    // Additional keys from user_public_keys table
    if let Ok(extra_keys) = state.db.get_all_user_public_keys(&user_id) {
        for k in extra_keys {
            all_keys.push(base64::engine::general_purpose::STANDARD.encode(&k));
        }
    }

    if all_keys.is_empty() {
        return (
            StatusCode::NOT_FOUND,
            Json(serde_json::json!({"error": "User not found or no public key"})),
        )
            .into_response();
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "user_id": user_id,
            "identity_public_key": all_keys[0],
            "identity_public_keys": all_keys,
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct UploadIdentityKeyRequest {
    pub identity_public_key: String,
}

pub async fn upload_identity_key(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UploadIdentityKeyRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let key_bytes = match base64::engine::general_purpose::STANDARD.decode(&req.identity_public_key) {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "Invalid identity_public_key"})),
            )
                .into_response();
        }
    };

    // Update primary key
    if let Err(e) = state.db.update_identity_public_key(&user_id, &key_bytes) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }

    // Also add to multi-device keys table
    let _ = state.db.add_user_public_key(&user_id, &key_bytes);

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

#[derive(Deserialize)]
pub struct UploadServerKeyRequest {
    pub user_id: String,
    pub encrypted_key: String,
    pub sender_public_key: String,
    pub nonce: String,
}

pub async fn upload_server_key(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UploadServerKeyRequest>,
) -> impl IntoResponse {
    let caller_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Only the server owner can upload keys for others
    if !state.db.is_server_owner(&caller_id, &server_id).unwrap_or(false) {
        // Allow users to upload their own key too
        if caller_id != req.user_id {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": "Only the server owner can upload keys for others"})),
            )
                .into_response();
        }
    }

    if !state.db.is_member_of_server(&req.user_id, &server_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "User is not a member of this server"})),
        )
            .into_response();
    }

    let encrypted_key = match base64::engine::general_purpose::STANDARD.decode(&req.encrypted_key) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid encrypted_key"}))).into_response(),
    };
    let sender_pub = match base64::engine::general_purpose::STANDARD.decode(&req.sender_public_key) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid sender_public_key"}))).into_response(),
    };
    let nonce = match base64::engine::general_purpose::STANDARD.decode(&req.nonce) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid nonce"}))).into_response(),
    };

    match state.db.save_server_key(&server_id, &req.user_id, &encrypted_key, &sender_pub, &nonce) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn get_server_keys(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if !state.db.is_member_of_server(&user_id, &server_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not a member of this server"})),
        )
            .into_response();
    }

    match state.db.get_all_server_keys(&server_id) {
        Ok(keys) => {
            let result: Vec<serde_json::Value> = keys
                .iter()
                .map(|(uid, ek, spk, nonce, ver)| {
                    serde_json::json!({
                        "user_id": uid,
                        "encrypted_key": base64::engine::general_purpose::STANDARD.encode(ek),
                        "sender_public_key": base64::engine::general_purpose::STANDARD.encode(spk),
                        "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
                        "version": ver,
                    })
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct RotateKeyRequest {
    pub encrypted_keys: Vec<RotatedKeyEntry>,
}

#[derive(Deserialize)]
pub struct RotatedKeyEntry {
    pub user_id: String,
    pub encrypted_key: String,
    pub sender_public_key: String,
    pub nonce: String,
}

pub async fn rotate_server_keys(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<RotateKeyRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if !state.db.is_server_owner(&user_id, &server_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Only the server owner can rotate keys"})),
        )
            .into_response();
    }

    // Delete old keys
    if let Err(e) = state.db.delete_server_keys(&server_id) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
    }

    // Save new keys
    for entry in &req.encrypted_keys {
        let encrypted_key = match base64::engine::general_purpose::STANDARD.decode(&entry.encrypted_key) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let sender_pub = match base64::engine::general_purpose::STANDARD.decode(&entry.sender_public_key) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let nonce = match base64::engine::general_purpose::STANDARD.decode(&entry.nonce) {
            Ok(b) => b,
            Err(_) => continue,
        };
        let _ = state.db.save_server_key(&server_id, &entry.user_id, &encrypted_key, &sender_pub, &nonce);
    }

    // Broadcast key rotation to all server members
    if let Ok(members) = state.db.get_server_members(&server_id) {
        let rotation_msg = serde_json::json!({
            "type": "server_key_rotated",
            "server_id": server_id,
        });
        state.ws_manager.broadcast_to_users(&members, &rotation_msg.to_string()).await;
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

// --- Admin ---

pub async fn admin_login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AdminLoginRequest>,
) -> impl IntoResponse {
    let is_set = state.db.is_admin_password_set().unwrap_or(false);

    if !is_set {
        if req.password.is_empty() {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "Password cannot be empty", "setup_required": true})),
            )
                .into_response();
        }
        let hash_str = match auth::hash_password(&req.password) {
            Ok(h) => h,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": e})),
                )
                    .into_response();
            }
        };
        if let Err(e) = state.db.set_admin_password_hash(&hash_str) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
        let admin_token = uuid::Uuid::new_v4().to_string();
        store_admin_token(admin_token.clone());
        return (StatusCode::OK, Json(serde_json::json!({"ok": true, "setup_complete": true, "token": admin_token}))).into_response();
    }

    let stored_hash = match state.db.get_admin_password_hash() {
        Ok(Some(h)) => h,
        _ => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "Admin password not configured"})),
            )
                .into_response()
        }
    };

    let valid = match auth::verify_password(&req.password, &stored_hash) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "Wrong admin password"})),
            )
                .into_response();
        }
    };

    if valid {
        let admin_token = uuid::Uuid::new_v4().to_string();
        store_admin_token(admin_token.clone());
        (StatusCode::OK, Json(serde_json::json!({"ok": true, "token": admin_token})))
            .into_response()
    } else {
        (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Wrong admin password"})),
        )
            .into_response()
    }
}

pub async fn admin_list_users(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    let users = match state.db.list_all_users() {
        Ok(u) => u,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            ).into_response();
        }
    };

    let user_infos: Vec<serde_json::Value> = users
        .iter()
        .map(|u| {
            serde_json::json!({
                "id": u.id,
                "username": u.username,
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(user_infos))).into_response()
}

pub async fn admin_delete_user(
    headers: HeaderMap,
    Path(user_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    if user_id == "system" {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Cannot delete system user"})),
        ).into_response();
    }

    match state.db.delete_user(&user_id) {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({"ok": true})),
        ),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        ),
    }.into_response()
}

pub async fn admin_list_servers(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    let servers = match state.db.list_all_servers_admin() {
        Ok(s) => s,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response()
        }
    };
    let result: Vec<serde_json::Value> = servers
        .iter()
        .map(|s| {
            serde_json::json!({
                "id": s.id,
                "name": s.name,
                "owner_id": s.owner_id,
            })
        })
        .collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_channels(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    let channels = match state.db.list_all_channels_admin() {
        Ok(c) => c,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response()
        }
    };
    let result: Vec<serde_json::Value> = channels
        .iter()
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "server_id": c.server_id,
                "name": c.name,
                "type": c.channel_type,
            })
        })
        .collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_messages(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    let messages = match state.db.list_all_messages_admin() {
        Ok(m) => m,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response()
        }
    };
    let result: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "channel_id": m.channel_id,
                "sender_id": m.sender_id,
                "sender_username": m.sender_username,
                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                "timestamp": m.timestamp,
            })
        })
        .collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_server_keys(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    let keys = match state.db.list_all_server_keys_admin() {
        Ok(k) => k,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response()
        }
    };
    let result: Vec<serde_json::Value> = keys
        .iter()
        .map(|(sid, sname, uid, ek, spk, nonce, ver)| {
            serde_json::json!({
                "server_id": sid,
                "server_name": sname,
                "user_id": uid,
                "encrypted_key": base64::engine::general_purpose::STANDARD.encode(ek),
                "sender_public_key": base64::engine::general_purpose::STANDARD.encode(spk),
                "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
                "version": ver,
            })
        })
        .collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_server_members(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    let members = match state.db.list_all_server_members_admin() {
        Ok(m) => m,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response()
        }
    };
    let result: Vec<serde_json::Value> = members
        .iter()
        .map(|(uid, uname, sid, sname)| {
            serde_json::json!({
                "user_id": uid,
                "username": uname,
                "server_id": sid,
                "server_name": sname,
            })
        })
        .collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_user_cascade_stats(
    headers: HeaderMap,
    Path(user_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    match state.db.get_user_cascade_stats(&user_id) {
        Ok(stats) => (StatusCode::OK, Json(stats)).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn admin_delete_server(
    headers: HeaderMap,
    Path(server_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    match state.db.delete_server_admin(&server_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn admin_delete_channel(
    headers: HeaderMap,
    Path(channel_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    match state.db.delete_channel_admin(&channel_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn admin_clear_all(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    match state.db.clear_all() {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

// ===== Phase 5: File Sharing =====

const MAX_FILE_SIZE: i64 = 1024 * 1024 * 1024; // 1 GB
const UPLOAD_DIR: &str = "uploads";

#[derive(Deserialize)]
pub struct InitFileUploadRequest {
    pub size: i64,
    pub mime: String,
}

pub async fn init_file_upload(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<InitFileUploadRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if req.size <= 0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "File size must be positive"})),
        )
            .into_response();
    }

    if req.size > MAX_FILE_SIZE {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({"error": "File too large (max 1 GB)"})),
        )
            .into_response();
    }

    match state.db.create_file_record(&user_id, req.size, &req.mime) {
        Ok(file_id) => {
            let dir = format!("{}/{}", UPLOAD_DIR, file_id);
            let _ = tokio::fs::create_dir_all(&dir).await;
            (
                StatusCode::OK,
                Json(serde_json::json!({"file_id": file_id})),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub async fn upload_file_chunk(
    Path((file_id, index)): Path<(String, usize)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let file_info = match state.db.get_file_info(&file_id) {
        Ok(f) => f,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "File not found"})),
            )
                .into_response()
        }
    };

    if file_info.uploader_id != user_id {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not your file"})),
        )
            .into_response();
    }

    if file_info.upload_complete {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Upload already complete"})),
        )
            .into_response();
    }

    let chunk_path = format!("{}/{}/{}.enc", UPLOAD_DIR, file_id, index);
    if let Err(e) = tokio::fs::write(&chunk_path, &body).await {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e.to_string()})),
        )
            .into_response();
    }

    let _ = state
        .db
        .update_file_chunks(&file_id, (index + 1) as i32);

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

pub async fn complete_file_upload(
    Path(file_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let file_info = match state.db.get_file_info(&file_id) {
        Ok(f) => f,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "File not found"})),
            )
                .into_response()
        }
    };

    if file_info.uploader_id != user_id {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not your file"})),
        )
            .into_response();
    }

    if file_info.chunk_count == 0 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "No chunks uploaded"})),
        )
            .into_response();
    }

    match state.db.mark_file_complete(&file_id) {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({"ok": true})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub async fn download_file(
    Path(file_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let file_info = match state.db.get_file_info(&file_id) {
        Ok(f) => f,
        Err(_) => {
            return (
                StatusCode::NOT_FOUND,
                Json(serde_json::json!({"error": "File not found"})),
            )
                .into_response()
        }
    };

    if !file_info.upload_complete {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Upload not complete"})),
        )
            .into_response();
    }

    // Authorization: user must be the uploader, or a member of at least one server
    // (files are shared within server channels or DMs)
    let is_uploader = file_info.uploader_id == user_id;
    if !is_uploader {
        let is_member = state.db.list_user_servers(&user_id)
            .map(|s| !s.is_empty())
            .unwrap_or(false);
        if !is_member {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": "Not authorized to access this file"})),
            )
                .into_response();
        }
    }

    // Read all encrypted chunks and concatenate
    let mut data = Vec::new();
    for i in 0..file_info.chunk_count {
        let chunk_path = format!("{}/{}/{}.enc", UPLOAD_DIR, file_id, i);
        match std::fs::read(&chunk_path) {
            Ok(chunk) => data.extend_from_slice(&chunk),
            Err(_) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": "Missing chunk"})),
                )
                    .into_response()
            }
        }
    }

    (
        StatusCode::OK,
        [
            ("content-type", "application/octet-stream"),
            (
                "content-disposition",
                &format!("attachment; filename=\"{}.bin\"", file_id),
            ),
        ],
        data,
    )
        .into_response()
}

// ===== Phase 4: Friends + Direct Messages =====

// --- Current user / friend code ---

pub async fn get_me(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let user = match state.db.get_user_by_id(&user_id) {
        Ok(u) => u,
        Err(e) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": e}))).into_response(),
    };
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "id": user.id,
            "username": user.username,
        })),
    )
        .into_response()
}

pub async fn delete_me(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.delete_user(&user_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

// --- Friends ---

#[derive(Deserialize)]
pub struct SendFriendRequest {
    pub friend_code: String,
}

pub async fn send_friend_request(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SendFriendRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let code = req.friend_code.trim().to_uppercase();
    if code.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Friend code is required"})),
        )
            .into_response();
    }

    match state.db.create_friend_request(&user_id, &code) {
        Ok(target) => {
            // Notify the recipient in real time (best-effort).
            let notify = serde_json::json!({
                "type": "friend_request_received",
                "from_user_id": user_id,
            });
            let _ = state
                .ws_manager
                .broadcast_to_users(&[target.id.clone()], &notify.to_string())
                .await;
            (
                StatusCode::OK,
                Json(serde_json::json!({
                    "ok": true,
                    "to": { "id": target.id, "username": target.username },
                })),
            )
                .into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct RespondFriendRequest {
    pub request_id: String,
}

pub async fn accept_friend_request(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<RespondFriendRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.accept_friend_request(&req.request_id, &user_id) {
        Ok((from_id, _to_id)) => {
            // Auto-create a DM channel between the two new friends
            let _ = state.db.find_or_create_dm_channel(&from_id, &user_id);

            // Notify the original sender that they are now friends.
            let notify = serde_json::json!({
                "type": "friend_request_accepted",
                "by_user_id": user_id,
            });
            let _ = state
                .ws_manager
                .broadcast_to_users(&[from_id], &notify.to_string())
                .await;
            (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
        }
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub async fn decline_friend_request(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<RespondFriendRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.decline_friend_request(&req.request_id, &user_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn list_incoming_friend_requests(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.list_incoming_friend_requests(&user_id) {
        Ok(reqs) => {
            let result: Vec<serde_json::Value> = reqs
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "id": r.id,
                        "from_user_id": r.from_user_id,
                        "from_username": r.from_username,
                        "status": r.status,
                        "created_at": r.created_at,
                    })
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub async fn list_outgoing_friend_requests(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.list_outgoing_friend_requests(&user_id) {
        Ok(reqs) => {
            let result: Vec<serde_json::Value> = reqs
                .iter()
                .map(|r| {
                    serde_json::json!({
                        "id": r.id,
                        "to_user_id": r.to_user_id,
                        "to_username": r.to_username,
                        "status": r.status,
                        "created_at": r.created_at,
                    })
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub async fn list_friends(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.list_friends(&user_id) {
        Ok(friends) => {
            let result: Vec<serde_json::Value> = friends
                .iter()
                .map(|f| serde_json::json!({ "id": f.user_id, "username": f.username }))
                .collect();
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct RemoveFriendRequest {
    pub user_id: String,
}

pub async fn remove_friend(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<RemoveFriendRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.remove_friend(&user_id, &req.user_id) {
        Ok(()) => {
            // Notify the other user that they've been unfriended
            let notify = serde_json::json!({
                "type": "friend_removed",
                "by_user_id": user_id,
            });
            let _ = state
                .ws_manager
                .broadcast_to_users(&[req.user_id.clone()], &notify.to_string())
                .await;
            (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
        }
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

// --- DM Channels ---

/// Get or create a DM channel with a friend. Returns the dm_channel_id.
/// Friendship is required; the endpoint refuses otherwise.
pub async fn get_or_create_dm(
    Path(friend_user_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if user_id == friend_user_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Cannot DM yourself"})),
        )
            .into_response();
    }
    if !state.db.are_friends(&user_id, &friend_user_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "You can only DM friends. Send a friend request first."})),
        )
            .into_response();
    }

    let dm_channel_id = match state.db.find_dm_channel(&user_id, &friend_user_id) {
        Ok(Some(id)) => id,
        Ok(None) => match state.db.create_dm_channel(&user_id, &friend_user_id) {
            Ok(id) => id,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": e})),
                )
                    .into_response();
            }
        },
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({ "id": dm_channel_id })),
    )
        .into_response()
}

pub async fn list_dm_conversations(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.list_dm_channels_for_user(&user_id) {
        Ok(channels) => {
            let mut result: Vec<serde_json::Value> = Vec::new();
            for (dm_id, other_id, other_username) in channels {
                let identity_pub = state
                    .db
                    .get_identity_public_key(&other_id)
                    .map(|k| base64::engine::general_purpose::STANDARD.encode(k))
                    .unwrap_or_default();
                let last = state.db.get_dm_last_message(&dm_id).ok().flatten();
                let last_json = match last {
                    Some(m) => serde_json::json!({
                        "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                        "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                        "sender_id": m.sender_id,
                        "timestamp": m.timestamp,
                    }),
                    None => serde_json::Value::Null,
                };
                result.push(serde_json::json!({
                    "dm_channel_id": dm_id,
                    "other_user_id": other_id,
                    "other_username": other_username,
                    "other_public_key": identity_pub,
                    "last_message": last_json,
                }));
            }
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub async fn list_dm_messages(
    Path(dm_channel_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if !state.db.is_dm_member(&dm_channel_id, &user_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not a member of this DM"})),
        )
            .into_response();
    }
    match state.db.list_dm_messages(&dm_channel_id, 100) {
        Ok(msgs) => {
            let result: Vec<serde_json::Value> = msgs
                .iter()
                .map(|m| {
                    serde_json::json!({
                        "id": m.id,
                        "dm_channel_id": m.dm_channel_id,
                        "sender_id": m.sender_id,
                        "sender_username": m.sender_username,
                        "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                        "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                        "timestamp": m.timestamp,
                    })
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

// --- DM Keys (envelope-encrypted distribution, same pattern as server keys) ---

#[derive(Deserialize)]
pub struct UploadDmKeyRequest {
    pub user_id: String,
    pub encrypted_key: String,
    pub sender_public_key: String,
    pub nonce: String,
}

pub async fn upload_dm_key(
    Path(dm_channel_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UploadDmKeyRequest>,
) -> impl IntoResponse {
    let caller_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    // Must be a member of the DM to upload a key (for self or for the other member).
    if !state.db.is_dm_member(&dm_channel_id, &caller_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not a member of this DM"})),
        )
            .into_response();
    }
    if !state.db.is_dm_member(&dm_channel_id, &req.user_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Recipient is not a member of this DM"})),
        )
            .into_response();
    }

    let encrypted_key = match base64::engine::general_purpose::STANDARD.decode(&req.encrypted_key) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid encrypted_key"}))).into_response(),
    };
    let sender_pub = match base64::engine::general_purpose::STANDARD.decode(&req.sender_public_key) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid sender_public_key"}))).into_response(),
    };
    let nonce = match base64::engine::general_purpose::STANDARD.decode(&req.nonce) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid nonce"}))).into_response(),
    };

    match state.db.save_dm_key(&dm_channel_id, &req.user_id, &encrypted_key, &sender_pub, &nonce) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn get_dm_keys(
    Path(dm_channel_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if !state.db.is_dm_member(&dm_channel_id, &user_id).unwrap_or(false) {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not a member of this DM"})),
        )
            .into_response();
    }
    match state.db.get_dm_keys_for_user(&dm_channel_id, &user_id) {
        Ok(keys) => {
            let result: Vec<serde_json::Value> = keys
                .iter()
                .map(|(ek, spk, nonce)| {
                    serde_json::json!({
                        "encrypted_key": base64::engine::general_purpose::STANDARD.encode(ek),
                        "sender_public_key": base64::engine::general_purpose::STANDARD.encode(spk),
                        "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
                    })
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}
