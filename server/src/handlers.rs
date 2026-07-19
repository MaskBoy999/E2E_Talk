use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
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

// --- Rate Limiting ---
struct RateLimiter {
    attempts: Mutex<HashMap<String, (u32, Instant)>>,
}

impl RateLimiter {
    fn check_and_increment(&self, key: &str, max_attempts: u32, window: Duration) -> bool {
        let mut map = self.attempts.lock().unwrap();
        let now = Instant::now();
        if let Some(&(count, first_attempt)) = map.get(key) {
            if now.duration_since(first_attempt) > window {
                map.insert(key.to_string(), (1, now));
                return true;
            }
            if count >= max_attempts {
                return false;
            }
            map.insert(key.to_string(), (count + 1, first_attempt));
        } else {
            map.insert(key.to_string(), (1, now));
        }
        true
    }
}

static LOGIN_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

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
    // Prefer the Authorization: Bearer header over the HttpOnly cookie.
    // A stale/expired HttpOnly cookie from a previous login session can
    // persist even after logout (JS can't clear HttpOnly cookies). By
    // preferring the Bearer header (which is bound to the current user
    // session), we avoid accidentally authenticating as the old user.
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").map(|s| s.to_string()))
        .or_else(|| {
            // Fall back to HttpOnly cookie (legacy support)
            headers
                .get("cookie")
                .and_then(|v| v.to_str().ok())
                .and_then(|cookie_str| {
                    cookie_str.split(';')
                        .find_map(|part| {
                            let trimmed = part.trim();
                            trimmed.strip_prefix("token=").map(|v| v.to_string())
                        })
                })
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

pub async fn logout(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // Validate the token if present (optional)
    let _ = extract_user(&headers, &state);

    // Clear all known cookies by overwriting with blank expired values
    let mut resp_headers = HeaderMap::new();
    for cookie_name in &["token", "session", "connect.sid", "xsrf-token"] {
        resp_headers.append(
            "set-cookie",
            HeaderValue::from_str(
                &format!("{}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0", cookie_name)
            ).unwrap(),
        );
    }

    (StatusCode::OK, resp_headers, Json(serde_json::json!({"ok": true})))
}

/// GET /api/logout — clears all cookies and redirects to login.html
pub async fn logout_get(
    State(_state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let mut resp_headers = HeaderMap::new();
    for cookie_name in &["token", "session", "connect.sid", "xsrf-token"] {
        resp_headers.append(
            "set-cookie",
            HeaderValue::from_str(
                &format!("{}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0", cookie_name)
            ).unwrap(),
        );
    }
    resp_headers.insert(
        "location",
        HeaderValue::from_str("/login.html").unwrap(),
    );
    (StatusCode::FOUND, resp_headers, ())
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
    pub encrypted_friend_code: Option<String>,
    pub friend_code_salt: Option<String>,
    pub friend_code_nonce: Option<String>,
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
    let rate_key = format!("reg:{}", req.username);
    if !LOGIN_RATE_LIMITER.check_and_increment(&rate_key, 10, Duration::from_secs(300)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many registration attempts. Try again in 5 minutes."})),
        )
            .into_response();
    }

    if req.username.is_empty() || req.password.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Username and password are required"})),
        )
            .into_response();
    }

    if req.password.len() < 6 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Password must be at least 6 characters"})),
        )
            .into_response();
    }

    let password_hash = match auth::hash_password(&req.password) {
        Ok(h) => h,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let identity_key_bytes = req.identity_public_key.as_ref().and_then(|k| {
        base64::engine::general_purpose::STANDARD.decode(k).ok()
    });

    let user = match state.db.create_user(&req.username, &password_hash, identity_key_bytes.as_deref(), req.friend_code_hash.as_deref(), req.encrypted_friend_code.as_deref(), req.friend_code_salt.as_deref(), req.friend_code_nonce.as_deref()) {
        Ok(u) => u,
        Err(e) => {
            return (
                StatusCode::CONFLICT,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    // Register initial device with the identity key
    if let Some(ref key_bytes) = identity_key_bytes {
        let device_id = uuid::Uuid::new_v4().to_string();
        let _ = state.db.register_device(&user.id, &device_id, "primary", key_bytes, None, None, None, None);
    }

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

    // Fetch profile data
    let (display_name, profile_pic) = match state.db.get_user_profile(&user.id) {
        Ok((_, _, dn, pp, _fk, _uc, _bc, _, _, _, _)) => (dn, pp),
        Err(_) => (None, None),
    };

    // First user registration means setup is complete
    state.setup_complete.store(true, std::sync::atomic::Ordering::Relaxed);

    (
        StatusCode::CREATED,
        Json(serde_json::json!({
            "token": token,
            "user": {
                "id": user.id,
                "username": user.username,
                "display_name": display_name,
                "profile_picture_file_id": profile_pic
            }
        })),
    )
        .into_response()
}

pub async fn login(
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> impl IntoResponse {
    let rate_key = format!("login:{}", req.username);
    if !LOGIN_RATE_LIMITER.check_and_increment(&rate_key, 10, Duration::from_secs(300)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many login attempts. Try again in 5 minutes."})),
        )
            .into_response();
    }

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
            &format!("token={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000", token)
        ).unwrap(),
    );

    // Fetch profile data
    let (display_name, profile_pic) = match state.db.get_user_profile(&user.id) {
        Ok((_, _, dn, pp, _fk, _uc, _bc, _, _, _, _)) => (dn, pp),
        Err(_) => (None, None),
    };

    (StatusCode::OK, headers, Json(serde_json::json!({
        "token": token,
        "user": {
            "id": user.id,
            "username": user.username,
            "display_name": display_name,
            "profile_picture_file_id": profile_pic
        }
    }))).into_response()
}

// --- Re-authenticate ---

#[derive(Deserialize)]
pub struct ReauthRequest {
    pub password: String,
}

#[derive(Deserialize)]
pub struct UploadNotificationSoundRequest {
    pub encrypted_sound: String,
    pub nonce: String,
    pub sender_public_key: String,
    pub file_name: String,
}

pub async fn upload_notification_sound(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UploadNotificationSoundRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let encrypted_sound = match base64::engine::general_purpose::STANDARD.decode(&req.encrypted_sound) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid encrypted_sound"}))).into_response(),
    };
    let nonce = match base64::engine::general_purpose::STANDARD.decode(&req.nonce) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid nonce"}))).into_response(),
    };
    let sender_public_key = match base64::engine::general_purpose::STANDARD.decode(&req.sender_public_key) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid sender_public_key"}))).into_response(),
    };

    match state.db.save_notification_sound(&user_id, &encrypted_sound, &nonce, &sender_public_key, &req.file_name) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn get_notification_sound(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.get_notification_sound(&user_id) {
        Ok(Some((encrypted_sound, nonce, sender_public_key, file_name))) => {
            (StatusCode::OK, Json(serde_json::json!({
                "encrypted_sound": base64::engine::general_purpose::STANDARD.encode(&encrypted_sound),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&nonce),
                "sender_public_key": base64::engine::general_purpose::STANDARD.encode(&sender_public_key),
                "file_name": file_name,
            }))).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "No notification sound"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn delete_notification_sound(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.delete_notification_sound(&user_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn reauth(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<ReauthRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let user = match state.db.get_user_by_id(&user_id) {
        Ok(u) => u,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let password_hash = match state.db.get_password_hash_by_id(&user_id) {
        Ok(h) => h,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let valid = match auth::verify_password(&req.password, &password_hash) {
        Ok(v) => v,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "Wrong password"})),
            )
                .into_response();
        }
    };

    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Wrong password"})),
        )
            .into_response();
    }

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
            &format!("token={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=2592000", token)
        ).unwrap(),
    );

    // Fetch profile data
    let (display_name, profile_pic) = match state.db.get_user_profile(&user.id) {
        Ok((_, _, dn, pp, _fk, _uc, _bc, _, _, _, _)) => (dn, pp),
        Err(_) => (None, None),
    };

    (StatusCode::OK, headers, Json(serde_json::json!({
        "token": token,
        "user": {
            "id": user.id,
            "username": user.username,
            "display_name": display_name,
            "profile_picture_file_id": profile_pic
        }
    }))).into_response()
}

// --- Key Escrow ---

#[derive(Deserialize)]
pub struct UploadEscrowRequest {
    pub encrypted_private_key: String,
    pub salt: String,
    pub nonce: String,
    pub device_id: Option<String>,
}

pub async fn upload_escrowed_key(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UploadEscrowRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let encrypted_key = match base64::engine::general_purpose::STANDARD.decode(&req.encrypted_private_key) {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "Invalid encrypted_private_key"})),
            )
                .into_response();
        }
    };

    let salt = match base64::engine::general_purpose::STANDARD.decode(&req.salt) {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "Invalid salt"})),
            )
                .into_response();
        }
    };

    let nonce = match base64::engine::general_purpose::STANDARD.decode(&req.nonce) {
        Ok(b) => b,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "Invalid nonce"})),
            )
                .into_response();
        }
    };

    match state.db.save_escrowed_key(&user_id, &encrypted_key, &salt, &nonce) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub async fn get_escrowed_key(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.get_escrowed_key(&user_id) {
        Ok(Some((encrypted_key, salt, nonce))) => {
            (StatusCode::OK, Json(serde_json::json!({
                "encrypted_private_key": base64::engine::general_purpose::STANDARD.encode(&encrypted_key),
                "salt": base64::engine::general_purpose::STANDARD.encode(&salt),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&nonce),
            }))).into_response()
        }
        Ok(None) => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "No escrowed key found"}))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
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
                "joins_disabled": s.joins_disabled,
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
                // Also broadcast to the kicked user so their UI updates without refresh
                let mut broadcast_users = members.clone();
                broadcast_users.push(req.user_id.clone());
                let _ = state.ws_manager.broadcast_to_users(&broadcast_users, &kick_msg.to_string()).await;
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

    // Collect members BEFORE leaving (owner case deletes the server from DB, making get_server_members fail)
    let server_members = state.db.get_server_members(&server_id).ok();

    match state.db.leave_server(&server_id, &user_id) {
        Ok(server_deleted) => {
            if server_deleted {
                // Owner left: broadcast server deletion to all members
                let del_msg = serde_json::json!({
                    "type": "server_deleted",
                    "server_id": server_id,
                });
                if let Some(members) = server_members {
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
                // Also broadcast to the banned user so their UI updates without refresh
                let mut broadcast_users = members.clone();
                broadcast_users.push(req.user_id.clone());
                let _ = state.ws_manager.broadcast_to_users(&broadcast_users, &ban_msg.to_string()).await;
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

#[derive(Deserialize)]
pub struct SetJoinsDisabledRequest {
    pub disabled: bool,
}

pub async fn set_joins_disabled(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SetJoinsDisabledRequest>,
) -> impl IntoResponse {
    let caller_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.set_joins_disabled(&server_id, &caller_id, req.disabled) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "joins_disabled": req.disabled}))).into_response(),
        Err(e) => (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": e}))).into_response(),
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
        .map(|(id, username, role, display_name, profile_pic)| {
            serde_json::json!({
                "id": id,
                "username": username,
                "role": role,
                "display_name": display_name,
                "profile_picture_file_id": profile_pic,
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
                "sender_id": m.sender_id,
                "sender_username": m.sender_username,
                "sender_display_name": m.sender_display_name,
                "sender_profile_pic": m.sender_profile_pic,
                "sender_username_color": m.sender_username_color,
                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                "timestamp": m.timestamp,
                "message_nonce": m.message_nonce,
                "edited_at": m.edited_at
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(message_infos))).into_response()
}

pub async fn list_messages_around(
    Path((channel_id, message_id)): Path<(String, String)>,
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

    let messages = match state.db.list_messages_around(&channel_id, &message_id, 100) {
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
                "sender_id": m.sender_id,
                "sender_username": m.sender_username,
                "sender_display_name": m.sender_display_name,
                "sender_profile_pic": m.sender_profile_pic,
                "sender_username_color": m.sender_username_color,
                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                "timestamp": m.timestamp,
                "message_nonce": m.message_nonce,
                "edited_at": m.edited_at
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

    // Additional keys from user_devices table
    if let Ok(extra_keys) = state.db.get_all_user_identity_keys(&user_id) {
        for (_device_id, key_bytes) in extra_keys {
            all_keys.push(base64::engine::general_purpose::STANDARD.encode(&key_bytes));
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

    // Also register as device
    let device_id = uuid::Uuid::new_v4().to_string();
    let _ = state.db.register_device(&user_id, &device_id, "primary", &key_bytes, None, None, None, None);

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

#[derive(Deserialize)]
pub struct AddDeviceKeyRequest {
    pub identity_public_key: String,
}

pub async fn add_device_key(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<AddDeviceKeyRequest>,
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

    if key_bytes.len() != 32 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Key must be 32 bytes"})),
        )
            .into_response();
    }

    // Check for duplicate
    if let Ok(existing) = state.db.get_all_user_identity_keys(&user_id) {
        for (_did, k) in &existing {
            if k == &key_bytes {
                return (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response();
            }
        }
    }

    let device_id = uuid::Uuid::new_v4().to_string();
    match state.db.register_device(&user_id, &device_id, "additional", &key_bytes, None, None, None, None) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

// --- Device Management ---

#[derive(Deserialize)]
pub struct RegisterDeviceRequest {
    pub device_id: String,
    pub device_name: Option<String>,
    pub identity_key: String,
    pub signed_prekey: Option<String>,
    pub signed_prekey_signature: Option<String>,
    pub one_time_prekey: Option<String>,
    pub one_time_prekey_id: Option<i32>,
}

pub async fn register_device(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegisterDeviceRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let key_bytes = match base64::engine::general_purpose::STANDARD.decode(&req.identity_key) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid identity_key"}))).into_response(),
    };

    let spk = req.signed_prekey.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let spk_sig = req.signed_prekey_signature.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let otpk = req.one_time_prekey.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

    match state.db.register_device(
        &user_id,
        &req.device_id,
        req.device_name.as_deref().unwrap_or("Unnamed device"),
        &key_bytes,
        spk.as_deref(),
        spk_sig.as_deref(),
        otpk.as_deref(),
        req.one_time_prekey_id,
    ) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "device_id": req.device_id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn list_devices(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.get_user_devices(&user_id) {
        Ok(devices) => {
            let result: Vec<serde_json::Value> = devices.iter().map(|(did, dname, ik, spk, last_active)| {
                serde_json::json!({
                    "device_id": did,
                    "device_name": dname,
                    "identity_key": base64::engine::general_purpose::STANDARD.encode(ik),
                    "signed_prekey": spk.as_ref().map(|k| base64::engine::general_purpose::STANDARD.encode(k)),
                    "last_active_at": last_active,
                })
            }).collect();
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn remove_device(
    Path(device_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.remove_device(&user_id, &device_id) {
        Ok(true) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Ok(false) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Device not found"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

// --- Per-Device Key Escrow ---

pub async fn upload_device_escrowed_key(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UploadEscrowRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Get device_id from request body or first device
    let device_id = req.device_id.clone().unwrap_or_default();
    if device_id.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "device_id required"}))).into_response();
    }

    let encrypted_key = match base64::engine::general_purpose::STANDARD.decode(&req.encrypted_private_key) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid encrypted_private_key"}))).into_response(),
    };
    let salt = match base64::engine::general_purpose::STANDARD.decode(&req.salt) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid salt"}))).into_response(),
    };
    let nonce = match base64::engine::general_purpose::STANDARD.decode(&req.nonce) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid nonce"}))).into_response(),
    };

    match state.db.save_device_escrowed_key(&user_id, &device_id, &encrypted_key, &salt, &nonce) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn get_device_escrowed_key(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Get device_id from query parameter or header
    let device_id = headers.get("x-device-id")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    if device_id.is_empty() {
        // Fall back to user-level key escrow
        return match state.db.get_escrowed_key(&user_id) {
            Ok(Some((encrypted_key, salt, nonce))) => {
                (StatusCode::OK, Json(serde_json::json!({
                    "encrypted_private_key": base64::engine::general_purpose::STANDARD.encode(&encrypted_key),
                    "salt": base64::engine::general_purpose::STANDARD.encode(&salt),
                    "nonce": base64::engine::general_purpose::STANDARD.encode(&nonce),
                }))).into_response()
            }
            Ok(None) => {
                (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "No escrowed key found"}))).into_response()
            }
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response(),
        };
    }

    match state.db.get_device_escrowed_key(&user_id, device_id) {
        Ok(Some((encrypted_key, salt, nonce))) => {
            (StatusCode::OK, Json(serde_json::json!({
                "encrypted_private_key": base64::engine::general_purpose::STANDARD.encode(&encrypted_key),
                "salt": base64::engine::general_purpose::STANDARD.encode(&salt),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&nonce),
                "device_id": device_id,
            }))).into_response()
        }
        Ok(None) => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "No escrowed key found for device"}))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
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

    match state.db.save_server_key(&server_id, &req.user_id, &encrypted_key, &sender_pub, &nonce, None) {
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
        let _ = state.db.save_server_key(&server_id, &entry.user_id, &encrypted_key, &sender_pub, &nonce, None);
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
        // Mark setup as complete — this disables the startup redirect
        state.setup_complete.store(true, std::sync::atomic::Ordering::Relaxed);
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

pub async fn admin_list_prekey_bundles(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_prekey_bundles_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(uid, ik, spk, sig, otpk, otpk_id)| {
        serde_json::json!({
            "user_id": uid,
            "identity_key_public": base64::engine::general_purpose::STANDARD.encode(ik),
            "signed_prekey_public": base64::engine::general_purpose::STANDARD.encode(spk),
            "signed_prekey_signature": base64::engine::general_purpose::STANDARD.encode(sig),
            "one_time_prekey_public": otpk.as_ref().map(|k| base64::engine::general_purpose::STANDARD.encode(k)),
            "one_time_prekey_id": otpk_id,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_sessions(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_sessions_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(our_id, our_name, their_id, their_name, data, rc)| {
        serde_json::json!({
            "our_user_id": our_id, "our_username": our_name,
            "their_user_id": their_id, "their_username": their_name,
            "session_data": base64::engine::general_purpose::STANDARD.encode(data),
            "ratchet_counter": rc,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_server_bans(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_server_bans_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(sid, sname, uid, uname, reason, ts)| {
        serde_json::json!({
            "server_id": sid, "server_name": sname, "user_id": uid, "username": uname, "reason": reason, "created_at": ts,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_dm_channels(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_dm_channels_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, ts)| {
        serde_json::json!({ "id": id, "created_at": ts })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_dm_members(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_dm_members_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(dm_id, uid, uname, created)| {
        serde_json::json!({ "dm_channel_id": dm_id, "user_id": uid, "username": uname, "created_at": created })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_dm_messages(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_dm_messages_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, dm_id, sid, sname, enc, nonce, ts)| {
        serde_json::json!({
            "id": id, "dm_channel_id": dm_id, "sender_id": sid, "sender_username": sname,
            "encrypted_content": base64::engine::general_purpose::STANDARD.encode(enc),
            "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
            "timestamp": ts,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_dm_keys(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_dm_keys_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(dm_id, uid, uname, ek, spk, nonce)| {
        serde_json::json!({
            "dm_channel_id": dm_id, "user_id": uid, "username": uname,
            "encrypted_key": base64::engine::general_purpose::STANDARD.encode(ek),
            "sender_public_key": base64::engine::general_purpose::STANDARD.encode(spk),
            "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_friend_requests(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_friend_requests_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, fid, fname, tid, tname, status, ts)| {
        serde_json::json!({
            "id": id, "from_user_id": fid, "from_username": fname,
            "to_user_id": tid, "to_username": tname, "status": status, "created_at": ts,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_friendships(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_friendships_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(u1id, u1name, u2id, u2name, ts)| {
        serde_json::json!({
            "user_id_1": u1id, "username_1": u1name,
            "user_id_2": u2id, "username_2": u2name, "created_at": ts,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_user_public_keys(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_user_devices_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(uid, uname, did, dname, ik, spk, last_active)| {
        serde_json::json!({
            "user_id": uid, "username": uname, "device_id": did, "device_name": dname,
            "identity_key": base64::engine::general_purpose::STANDARD.encode(ik),
            "signed_prekey": spk.as_ref().map(|k| base64::engine::general_purpose::STANDARD.encode(k)),
            "last_active_at": last_active,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_files(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_files_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, uid, uname, name, mime, size, sid, cid, ts)| {
        serde_json::json!({
            "id": id, "uploader_id": uid, "uploader_username": uname,
            "original_name": name, "mime_type": mime, "file_size": size,
            "server_id": sid, "channel_id": cid, "created_at": ts,
        })
    }).collect();
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

pub async fn admin_list_user_stickers(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_user_stickers_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, uid, uname, fid, sname, fkey, mime, _ekey, _eknonce)| {
        serde_json::json!({
            "id": id, "user_id": uid, "username": uname,
            "file_id": fid, "sticker_name": sname,
            "file_key": if fkey.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(fkey.clone()) },
            "mime_type": mime,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_server_stickers(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_server_stickers_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, sid, sname, fid, uby, stname, fkey, _ekey, _eknonce)| {
        serde_json::json!({
            "id": id, "server_id": sid, "server_name": sname,
            "file_id": fid, "uploaded_by": uby, "sticker_name": stname,
            "file_key": if fkey.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(fkey.clone()) },
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_user_key_escrow(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_user_key_escrow_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(uid, uname, created, updated, has_key)| {
        serde_json::json!({
            "user_id": uid, "username": uname,
            "created_at": created, "updated_at": updated,
            "has_key": *has_key != 0,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_notification_sounds(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_notification_sounds_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(uid, uname, fname, enc, nonce, spk, created)| {
        serde_json::json!({
            "user_id": uid, "username": uname, "file_name": fname,
            "encrypted_sound": base64::engine::general_purpose::STANDARD.encode(enc),
            "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
            "sender_public_key": base64::engine::general_purpose::STANDARD.encode(spk),
            "created_at": created,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_clear_all(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    match state.db.clear_all() {
        Ok(()) => {
            // Invalidate all in-memory admin tokens so the admin must re-login
            // after the database is wiped.
            let mut guard = ADMIN_TOKENS.lock().unwrap();
            *guard = None;
            // Reset the setup_complete flag so the next visitor is redirected
            // to the admin setup page again (factory-fresh state).
            state.setup_complete.store(false, std::sync::atomic::Ordering::Relaxed);
            (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
        }
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

    // Authorization: user must be the uploader, a member of a shared server, or a friend
    let is_uploader = file_info.uploader_id == user_id;
    if !is_uploader {
        let authorized = state.db.are_friends(&user_id, &file_info.uploader_id)
            .unwrap_or(false)
            || state.db.share_server(&user_id, &file_info.uploader_id)
                .unwrap_or(false);
        if !authorized {
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

// ===== Server Stickers =====

#[derive(Deserialize)]
pub struct AddStickerRequest {
    pub file_id: String,
    pub sticker_name: String,
    pub file_key: Option<String>,
}

pub async fn list_server_stickers(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if !state.db.is_member_of_server(&user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not a member"}))).into_response();
    }
    match state.db.list_server_stickers(&server_id) {
        Ok(stickers) => {
            let result: Vec<serde_json::Value> = stickers
                .iter()
                .map(|(id, file_id, name, mime, uploaded_by, file_key, _ekey, _eknonce)| {
                    serde_json::json!({
                        "id": id,
                        "file_id": file_id,
                        "sticker_name": name,
                        "mime_type": mime,
                        "uploaded_by": uploaded_by,
                        "file_key": file_key,
                    })
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn add_server_sticker(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<AddStickerRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if !state.db.is_member_of_server(&user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not a member"}))).into_response();
    }
    // Verify file exists and is uploaded
    match state.db.get_file_info(&body.file_id) {
        Ok(f) => {
            if !f.upload_complete {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Upload not complete"}))).into_response();
            }
        }
        Err(_) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "File not found"}))).into_response(),
    }
    match state.db.add_server_sticker(&server_id, &body.file_id, &user_id, &body.sticker_name, body.file_key.as_deref().unwrap_or(""), None, None) {
        Ok(id) => (StatusCode::OK, Json(serde_json::json!({"id": id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn remove_server_sticker(
    Path((server_id, sticker_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    // Only server owner or sticker uploader can remove
    let is_owner = state.db.is_server_owner(&user_id, &server_id).unwrap_or(false);
    if !is_owner {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Only server owner can remove stickers"}))).into_response();
    }
    match state.db.remove_server_sticker(&sticker_id, &server_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

// ===== User Stickers/GIFs =====

#[derive(Deserialize)]
pub struct AddUserStickerRequest {
    pub file_id: String,
    pub sticker_name: String,
    pub file_key: Option<String>,
    pub mime_type: String,
}

pub async fn list_user_stickers(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.list_user_stickers(&user_id) {
        Ok(stickers) => {
            let result: Vec<serde_json::Value> = stickers
                .iter()
                .map(|(id, file_id, name, mime, file_key, _ekey, _eknonce)| {
                    serde_json::json!({
                        "id": id,
                        "file_id": file_id,
                        "sticker_name": name,
                        "mime_type": mime,
                        "file_key": file_key,
                    })
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn add_user_sticker(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<AddUserStickerRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    // Verify file exists and is uploaded
    match state.db.get_file_info(&body.file_id) {
        Ok(f) => {
            if !f.upload_complete {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Upload not complete"}))).into_response();
            }
        }
        Err(_) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "File not found"}))).into_response(),
    }
    match state.db.add_user_sticker(&user_id, &body.file_id, &body.sticker_name, body.file_key.as_deref().unwrap_or(""), &body.mime_type, None, None) {
        Ok(id) => (StatusCode::OK, Json(serde_json::json!({"id": id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn remove_user_sticker(
    Path(sticker_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.remove_user_sticker(&sticker_id, &user_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

// ===== Phase 4: Friends + Direct Messages =====

// --- Profile (display name + profile picture) ---

#[derive(Deserialize)]
pub struct UpdateProfileRequest {
    pub display_name: Option<String>,  // None = no change, Some("") = clear, Some("value") = set
    pub remove_picture: Option<bool>,  // true = remove profile picture
    pub profile_picture_file_id: Option<String>,  // Some("file_id") = set picture
    pub profile_picture_file_key: Option<String>,  // file encryption key (base64)
    pub username_color: Option<String>,  // hex color for username
    pub username_border_color: Option<String>,  // hex color for display name glow/border
    // Profile v2 fields
    pub profile_banner_file_id: Option<String>,
    pub profile_banner_file_key: Option<String>,
    pub description: Option<String>,
    pub nickname: Option<String>,
    pub profile_background_color: Option<String>,
    // Encrypted profile (password-based)
    pub encrypted_profile_data: Option<String>,
    pub encrypted_profile_salt: Option<String>,
    pub encrypted_profile_nonce: Option<String>,
}

pub async fn get_profile(
    Path(requested_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // Extract the requesting user; require authentication
    let caller_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Determine if the caller is authorized to see file decryption keys:
    // - Own profile: always authorized
    // - Friends or share a server: authorized
    let is_own_profile = caller_id == requested_id;
    let authorized_for_keys = is_own_profile
        || state.db.are_friends(&caller_id, &requested_id).unwrap_or(false)
        || state.db.share_server(&caller_id, &requested_id).unwrap_or(false);

    match state.db.get_user_profile(&requested_id) {
        Ok((id, username, display_name, profile_picture_file_id, file_key, username_color, username_border_color, banner_id, banner_key, description, nickname)) => {
            let encrypted = state.db.get_encrypted_profile(&requested_id).ok().flatten();
            // Fetch background color separately (dynamic column)
            let bg_color = state.db.get_profile_background_color(&requested_id).ok();
            (StatusCode::OK, Json(serde_json::json!({
                "id": id,
                "username": username,
                "display_name": display_name,
                "profile_picture_file_id": profile_picture_file_id,
                // Only return file decryption keys to authorized users (friends / server-mates / self)
                "profile_picture_file_key": if authorized_for_keys { file_key } else { None },
                "username_color": username_color.unwrap_or("#4fc3f7".to_string()),
                "username_border_color": username_border_color,
                "profile_banner_file_id": banner_id,
                "profile_banner_file_key": if authorized_for_keys { banner_key } else { None },
                "description": description.unwrap_or_default(),
                "nickname": nickname.unwrap_or_default(),
                "profile_background_color": bg_color.unwrap_or("#16213e".to_string()),
                "encrypted_profile_data": encrypted.as_ref().map(|e| e.0.as_str()),
                "encrypted_profile_salt": encrypted.as_ref().map(|e| e.1.as_str()),
                "encrypted_profile_nonce": encrypted.as_ref().map(|e| e.2.as_str()),
            }))).into_response()
        }
        Err(e) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn update_profile(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpdateProfileRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Update display name if provided
    if let Some(ref display_name) = req.display_name {
        let trimmed = display_name.trim();
        if trimmed.len() > 50 {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Display name too long (max 50 chars)"}))).into_response();
        }
        // Empty string means clear the display name
        if trimmed.is_empty() {
            if let Err(e) = state.db.update_display_name(&user_id, "") {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
            }
        } else {
            if let Err(e) = state.db.update_display_name(&user_id, trimmed) {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
            }
        }
    }

    // Before changing profile picture, delete the old one's file from DB and disk
    let delete_current_pic = || -> Result<(), String> {
        let (_, _, _, old_file_id, _, _, _, _, _, _, _) = state.db.get_user_profile(&user_id)?;
        if let Some(old_id) = old_file_id {
            // Delete from DB (checks ownership)
            if let Ok(old_info) = state.db.delete_file_record(&old_id) {
                // Delete chunk files from disk
                for i in 0..old_info.chunk_count {
                    let chunk_path = format!("{}/{}/{}.enc", UPLOAD_DIR, old_id, i);
                    let _ = std::fs::remove_file(&chunk_path);
                }
                // Remove the directory
                let dir = format!("{}/{}", UPLOAD_DIR, old_id);
                let _ = std::fs::remove_dir(&dir);
            }
        }
        Ok(())
    };

    // Handle profile picture removal
    if req.remove_picture.unwrap_or(false) {
        let _ = delete_current_pic();
        if let Err(e) = state.db.update_profile_picture(&user_id, None, None) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    }

    // Handle profile picture set
    if let Some(ref file_id) = req.profile_picture_file_id {
        // Verify the file exists and is complete
        let file_info = match state.db.get_file_info(file_id) {
            Ok(f) => f,
            Err(_) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "File not found"}))).into_response(),
        };
        if !file_info.upload_complete {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Upload not complete"}))).into_response();
        }
        // Only allow image files
        if !file_info.mime_type.starts_with("image/") {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Only image files allowed for profile picture"}))).into_response();
        }
        // Verify ownership
        if file_info.uploader_id != user_id {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not your file"}))).into_response();
        }
        // Delete old profile pic before setting new one
        let _ = delete_current_pic();
        let file_key = req.profile_picture_file_key.as_deref();
        if let Err(e) = state.db.update_profile_picture(&user_id, Some(file_id), file_key) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    }

    // Handle username border color update
    if let Some(ref border_color) = req.username_border_color {
        let trimmed = border_color.trim();
        let is_valid_hex = trimmed.starts_with("#") && (trimmed.len() == 7 || trimmed.len() == 4);
        let is_valid_rgba = trimmed.starts_with("rgba(") && trimmed.ends_with(")");
        if !is_valid_hex && !is_valid_rgba {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid border color format. Use hex e.g. #000000 or rgba e.g. rgba(0,0,0,0.8)"}))).into_response();
        }
        if let Err(e) = state.db.update_username_border_color(&user_id, trimmed) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    }

    // Handle username color update
    if let Some(ref color) = req.username_color {
        let trimmed = color.trim();
        if !trimmed.starts_with("#") || (trimmed.len() != 7 && trimmed.len() != 4) {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid color format. Use hex e.g. #4fc3f7"}))).into_response();
        }
        if let Err(e) = state.db.update_username_color(&user_id, trimmed) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    }

    // Handle profile background color update
    if let Some(ref bg_color) = req.profile_background_color {
        let trimmed = bg_color.trim();
        if !trimmed.starts_with("#") || (trimmed.len() != 7 && trimmed.len() != 4) {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid background color format. Use hex e.g. #16213e"}))).into_response();
        }
        if let Err(e) = state.db.update_profile_background_color(&user_id, trimmed) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    }

    // Handle description update with 300-word hard cap
    if let Some(ref description) = req.description {
        let word_count = description.trim().split_whitespace().count();
        if word_count > 300 {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Description too long (max 300 words)"}))).into_response();
        }
        if let Err(e) = state.db.update_description(&user_id, description) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    }

    // Handle nickname update
    if let Some(ref nickname) = req.nickname {
        if let Err(e) = state.db.update_nickname(&user_id, nickname) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    }

    // Handle profile banner
    if let Some(ref banner_file_id) = req.profile_banner_file_id {
        // Verify the file exists and is complete
        let file_info = match state.db.get_file_info(banner_file_id) {
            Ok(f) => f,
            Err(_) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Banner file not found"}))).into_response(),
        };
        if !file_info.upload_complete {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Banner upload not complete"}))).into_response();
        }
        if !file_info.mime_type.starts_with("image/") {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Only image files allowed for banner"}))).into_response();
        }
        if file_info.uploader_id != user_id {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not your file"}))).into_response();
        }
        let banner_key = req.profile_banner_file_key.as_deref();
        if let Err(e) = state.db.update_profile_banner(&user_id, Some(banner_file_id), banner_key) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    }

    // Save encrypted profile data if provided (password-based encryption)
    if let (Some(data), Some(salt), Some(nonce)) = (&req.encrypted_profile_data, &req.encrypted_profile_salt, &req.encrypted_profile_nonce) {
        let _ = state.db.save_encrypted_profile(&user_id, data, salt, nonce);
    }

    // Broadcast profile update to the user, friends, and all server members
    if let Ok(profile) = state.db.get_user_profile(&user_id) {
        let (_id, username, display_name, profile_picture_file_id, _fk, username_color, username_border_color, banner_id, _, description, nickname) = profile;
        let profile_msg = serde_json::json!({
            "type": "profile_updated",
            "user_id": user_id,
            "username": username,
            "display_name": display_name,
            "profile_picture_file_id": profile_picture_file_id,
            "profile_banner_file_id": banner_id,
            "description": description,
            "nickname": nickname,
            "username_color": username_color.unwrap_or("#4fc3f7".to_string()),
            "username_border_color": username_border_color,
        });

        let mut recipients: std::collections::HashSet<String> = std::collections::HashSet::new();
        recipients.insert(user_id.clone());

        // Add friends
        if let Ok(friends) = state.db.list_friends(&user_id) {
            for f in friends {
                recipients.insert(f.user_id);
            }
        }

        // Add members of all servers the user is in
        if let Ok(servers) = state.db.list_user_servers(&user_id) {
            for s in servers {
                if let Ok(members) = state.db.get_server_members(&s.id) {
                    for m in members {
                        recipients.insert(m);
                    }
                }
            }
        }

        let recipient_list: Vec<String> = recipients.into_iter().collect();
        let _ = state.ws_manager.broadcast_to_users(&recipient_list, &profile_msg.to_string()).await;
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

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

    // Collect affected users BEFORE deletion so we can broadcast "user_deleted"
    let mut affected_users: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Add all server members from servers the user is in
    if let Ok(servers) = state.db.list_user_servers(&user_id) {
        for s in &servers {
            if let Ok(members) = state.db.get_server_members(&s.id) {
                for m in members {
                    affected_users.insert(m);
                }
            }
        }
    }
    // Add all DM conversation partners
    if let Ok(dm_channels) = state.db.list_dm_channels_for_user(&user_id) {
        for (_dm_id, other_id, _username, _dn, _pp) in dm_channels {
            affected_users.insert(other_id);
        }
    }
    // Add friends
    if let Ok(friends) = state.db.list_friends(&user_id) {
        for f in friends {
            affected_users.insert(f.user_id);
        }
    }
    // Remove self from broadcast list
    affected_users.remove(&user_id);

    match state.db.delete_user(&user_id) {
        Ok(()) => {
            // Broadcast "user_deleted" to all affected users so they can clean up UI
            let user_deleted_msg = serde_json::json!({
                "type": "user_deleted",
                "user_id": user_id,
            });
            let affected: Vec<String> = affected_users.into_iter().collect();
            if !affected.is_empty() {
                state.ws_manager.broadcast_to_users(&affected, &user_deleted_msg.to_string()).await;
            }

            // Clear all cookies so the user is fully logged out
            let mut resp_headers = HeaderMap::new();
            for cookie_name in &["token", "session", "connect.sid", "xsrf-token"] {
                resp_headers.append(
                    "set-cookie",
                    HeaderValue::from_str(
                        &format!("{}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0", cookie_name)
                    ).unwrap(),
                );
            }
            (StatusCode::OK, resp_headers, Json(serde_json::json!({"ok": true}))).into_response()
        },
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

// --- Friend Code ---

/// GET /api/friend-code — returns the encrypted friend code + salt + nonce for password-based recovery
pub async fn get_my_friend_code(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.get_encrypted_friend_code(&user_id) {
        Ok((encrypted, salt, nonce)) => (StatusCode::OK, Json(serde_json::json!({
            "encrypted_friend_code": encrypted,
            "salt": salt,
            "nonce": nonce,
        }))).into_response(),
        Err(_) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "No encrypted friend code set"}))).into_response(),
    }
}

/// POST /api/friend-code/store-encrypted — store encrypted friend code + salt + nonce (no password verification)
pub async fn store_encrypted_friend_code(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<StoreEncryptedFriendCodeRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if req.encrypted_friend_code.is_empty() || req.salt.is_empty() || req.nonce.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Missing encrypted friend code data"}))).into_response();
    }

    let hash = sha256_hex(&req.friend_code.trim().to_uppercase());

    match state.db.update_encrypted_friend_code(&user_id, &hash, &req.encrypted_friend_code, &req.salt, &req.nonce) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// POST /api/friend-code/regenerate — server generates a new code (stores hash only, no encrypted backup)
pub async fn server_regenerate_friend_code(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    use rand::Rng;
    const ALPHABET: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let mut rng = rand::thread_rng();
    let code: String = (0..8)
        .map(|_| {
            let idx = rng.gen_range(0..ALPHABET.len());
            ALPHABET[idx] as char
        })
        .collect();

    let hash = sha256_hex(&code);
    match state.db.update_friend_code_hash(&user_id, &hash) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "friend_code": code}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// POST /api/friend-code/regen-with-password — verify password, then regen + store encrypted friend code
pub async fn regen_friend_code_with_password(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<RegenWithPasswordRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Verify password against stored hash
    let stored_password_hash = match state.db.get_password_hash_by_id(&user_id) {
        Ok(h) => h,
        Err(_) => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "User not found"}))).into_response(),
    };

    match auth::verify_password(&req.password, &stored_password_hash) {
        Ok(true) => {}
        Ok(false) => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Wrong password"}))).into_response(),
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }

    // Validate the new friend code
    let code = req.friend_code.trim().to_uppercase();
    if code.len() != 8 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid friend code format"}))).into_response();
    }

    let hash = sha256_hex(&code);

    match state.db.update_encrypted_friend_code(&user_id, &hash, &req.encrypted_friend_code, &req.salt, &req.nonce) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

fn sha256_hex(data: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data.as_bytes());
    let result = hasher.finalize();
    result.iter().map(|b| format!("{:02x}", b)).collect()
}

#[derive(Deserialize)]
pub struct StoreEncryptedFriendCodeRequest {
    pub friend_code: String,
    pub encrypted_friend_code: String,
    pub salt: String,
    pub nonce: String,
}

#[derive(Deserialize)]
pub struct RegenWithPasswordRequest {
    pub password: String,
    pub friend_code: String,
    pub encrypted_friend_code: String,
    pub salt: String,
    pub nonce: String,
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
            // Notify the recipient in real time (best-effort). Include sender username.
            let sender_username = state.db.get_user_by_id(&user_id).ok().map(|u| u.username).unwrap_or_default();
            let notify = serde_json::json!({
                "type": "friend_request_received",
                "from_user_id": user_id,
                "from_username": sender_username,
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
            for (dm_id, other_id, other_username, other_display_name, other_profile_pic) in channels {
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
                        "message_nonce": m.message_nonce,
                    }),
                    None => serde_json::Value::Null,
                };
                result.push(serde_json::json!({
                    "dm_channel_id": dm_id,
                    "other_user_id": other_id,
                    "other_username": other_username,
                    "other_display_name": other_display_name,
                    "other_profile_picture_file_id": other_profile_pic,
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
                        "sender_display_name": m.sender_display_name,
                        "sender_profile_pic": m.sender_profile_pic,
                        "sender_username_color": m.sender_username_color,
                        "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                        "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                        "timestamp": m.timestamp,
                        "message_nonce": m.message_nonce,
                        "edited_at": m.edited_at,
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

    match state.db.save_dm_key(&dm_channel_id, &req.user_id, &encrypted_key, &sender_pub, &nonce, None) {
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
