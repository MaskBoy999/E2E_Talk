use std::collections::HashMap;
use std::sync::{Arc, LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::{
    extract::{Json, Path, Query, State},
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

static JOIN_SERVER_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

static FRIEND_REQUEST_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
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
    pub password: String,  // Client-computed hash: HMAC-SHA256(hash_key, raw_password)
    pub identity_public_key: Option<String>,
    pub friend_code_hash: Option<String>,
    pub encrypted_friend_code: Option<String>,
    pub friend_code_salt: Option<String>,
    pub friend_code_nonce: Option<String>,
    // Identity key escrow (password-wrapped via Argon2id)
    pub encrypted_identity_priv: Option<String>,
    pub escrow_salt: Option<String>,
    pub escrow_nonce: Option<String>,
    // Client-side password hash_key escrow (Argon2id-encrypted, server never sees raw password)
    pub encrypted_hash_key: Option<String>,
    pub hash_key_salt: Option<String>,
    pub hash_key_nonce: Option<String>,
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

    if req.password.len() < 64 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Password hash required (client-side hashing)"})),
        )
            .into_response();
    }

    // Password is already client-computed hash. Store it as-is.
    let password_hash = &req.password;

    let identity_key_bytes = req.identity_public_key.as_ref().and_then(|k| {
        base64::engine::general_purpose::STANDARD.decode(k).ok()
    });

    let user = match state.db.create_user(&req.username, &password_hash, identity_key_bytes.as_deref(), req.friend_code_hash.as_deref(), req.encrypted_friend_code.as_deref(), req.friend_code_salt.as_deref(), req.friend_code_nonce.as_deref(), req.encrypted_hash_key.as_deref(), req.hash_key_salt.as_deref(), req.hash_key_nonce.as_deref()) {
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
    if identity_key_bytes.is_some() {
        // Identity key was provided during registration
        // (device registration not needed in streamlined flow)
    }

    // Store escrowed identity key if provided
    if let (Some(enc_priv), Some(esc_salt), Some(esc_nonce)) = (
        &req.encrypted_identity_priv,
        &req.escrow_salt,
        &req.escrow_nonce,
    ) {
        if let (Ok(enc_key), Ok(salt), Ok(nonce)) = (
            base64::engine::general_purpose::STANDARD.decode(enc_priv),
            base64::engine::general_purpose::STANDARD.decode(esc_salt),
            base64::engine::general_purpose::STANDARD.decode(esc_nonce),
        ) {
            let _ = state.db.save_escrowed_key(&user.id, &enc_key, &salt, &nonce);
        }
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

    // Fetch profile picture only (display_name and other profile fields are now encrypted-only)
    let profile_pic = match state.db.get_user_profile(&user.id) {
        Ok((_, _, pp, _fk, _, _)) => pp,
        Err(_) => None,
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

    // Client-computed hash (HMAC-SHA256) — direct comparison
    let valid = req.password == password_hash;

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

    // Fetch profile picture only (display_name and other profile fields are now encrypted-only)
    let profile_pic = match state.db.get_user_profile(&user.id) {
        Ok((_, _, pp, _fk, _, _)) => pp,
        Err(_) => None,
    };

    (StatusCode::OK, headers, Json(serde_json::json!({
        "token": token,
        "user": {
            "id": user.id,
            "username": user.username,
            "profile_picture_file_id": profile_pic
        }
    }))).into_response()
}

// --- Auth-Params (pre-login hash_key fetch) ---

/// GET /api/auth-params/:username — returns encrypted_hash_key + salt + nonce
/// so the client can decrypt the hash_key with the raw password, derive the
/// pre-hashed password, and submit it to /api/login.
/// No authentication required (these are already encrypted with the user's password).
pub async fn get_auth_params(
    Path(username): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    match state.db.get_auth_params(&username) {
        Ok((encrypted_hash_key, hash_key_salt, hash_key_nonce)) => {
            (StatusCode::OK, Json(serde_json::json!({
                "encrypted_hash_key": encrypted_hash_key,
                "hash_key_salt": hash_key_salt,
                "hash_key_nonce": hash_key_nonce,
            }))).into_response()
        }
        Err(_) => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "User not found"}))).into_response()
        }
    }
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

    // Client-computed hash (HMAC-SHA256) — direct comparison
    let valid = req.password == password_hash;

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

    // Fetch profile picture only (display_name and other profile fields are now encrypted-only)
    let profile_pic = match state.db.get_user_profile(&user.id) {
        Ok((_, _, pp, _fk, _, _)) => pp,
        Err(_) => None,
    };

    (StatusCode::OK, headers, Json(serde_json::json!({
        "token": token,
        "user": {
            "id": user.id,
            "username": user.username,
            "profile_picture_file_id": profile_pic
        }
    }))).into_response()
}

// --- Key Escrow ---

#[derive(Deserialize)]
#[allow(dead_code)]
pub struct UploadEscrowRequest {
    pub encrypted_private_key: String,
    pub salt: String,
    pub nonce: String,
    pub device_id: Option<String>,
}

#[allow(dead_code)]
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

#[allow(dead_code)]
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

// --- User Key Blob (password-encrypted key bundle for full key recovery) ---

#[derive(Deserialize)]
pub struct SaveKeyBlobRequest {
    pub encrypted_blob: String,
    pub salt: String,
    pub nonce: String,
}

pub async fn save_user_key_blob(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SaveKeyBlobRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.save_user_key_blob(&user_id, &req.encrypted_blob, &req.salt, &req.nonce) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

// --- Profile Data Key (server-side backup) ---

#[derive(Deserialize)]
pub struct SaveProfileDataKeyRequest {
    pub encrypted_key: String,
    pub nonce: String,
}

// --- Shared Profile Data Keys (pre-encrypted for friends/server-mates) ---

#[derive(Deserialize)]
pub struct SaveSharedProfileDataKeyRequest {
    pub target_type: String,  // 'dm_channel' or 'server'
    pub target_id: String,
    pub encrypted_key: String,
    pub nonce: String,
}

/// PUT /api/profile/data-key/shared
/// Uploads a profile_data_key pre-encrypted with a DM channel or server key.
/// Only the owner can upload their own key.
pub async fn save_shared_profile_data_key(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SaveSharedProfileDataKeyRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Validate target_type
    if req.target_type != "dm_channel" && req.target_type != "server" {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid target_type, must be 'dm_channel' or 'server'"})),
        )
            .into_response();
    }

    match state.db.save_shared_profile_data_key(
        &user_id,
        &req.target_type,
        &req.target_id,
        &req.encrypted_key,
        &req.nonce,
    ) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

/// GET /api/profile/data-key/shared/{target_type}/{target_id}
/// Fetches all shared profile_data_keys for a given DM channel or server.
/// The caller must be a member of the target DM/server.
pub async fn get_shared_profile_data_keys(
    Path((target_type, target_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let caller_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Validate target_type
    if target_type != "dm_channel" && target_type != "server" {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid target_type, must be 'dm_channel' or 'server'"})),
        )
            .into_response();
    }

    // Verify caller is a member of the target DM/server
    let is_member = if target_type == "dm_channel" {
        state.db.is_dm_member(&target_id, &caller_id).unwrap_or(false)
    } else {
        state.db.is_member_of_server(&caller_id, &target_id).unwrap_or(false)
    };

    if !is_member {
        return (
            StatusCode::FORBIDDEN,
            Json(serde_json::json!({"error": "Not a member of this DM channel or server"})),
        )
            .into_response();
    }

    match state.db.get_shared_profile_data_keys(&target_type, &target_id) {
        Ok(keys) => {
            // Return as an array of objects
            let result: Vec<serde_json::Value> = keys
                .into_iter()
                .map(|(owner_user_id, encrypted_key, nonce)| {
                    serde_json::json!({
                        "owner_user_id": owner_user_id,
                        "encrypted_key": encrypted_key,
                        "nonce": nonce,
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

// --- Batch Shared Profile Data Keys ---

#[derive(Deserialize)]
pub struct BatchSharedKeysRequest {
    pub targets: Vec<BatchTarget>,
}

#[derive(Deserialize)]
pub struct BatchTarget {
    pub target_type: String,
    pub target_id: String,
}

/// POST /api/profile/data-key/shared/batch
/// Accepts multiple (target_type, target_id) pairs and returns all shared keys
/// grouped by a composite key "{target_type}:{target_id}".
/// The caller must be a member of each target DM/server.
pub async fn get_shared_profile_data_keys_batch(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<BatchSharedKeysRequest>,
) -> impl IntoResponse {
    let caller_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    if req.targets.is_empty() {
        return (StatusCode::OK, Json(serde_json::json!([]))).into_response();
    }

    // Validate and check membership for all targets in parallel
    let mut valid_targets: Vec<(String, String)> = Vec::new();
    for target in &req.targets {
        if target.target_type != "dm_channel" && target.target_type != "server" {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": format!("Invalid target_type '{}', must be 'dm_channel' or 'server'", target.target_type)})),
            )
                .into_response();
        }
        let is_member = if target.target_type == "dm_channel" {
            state.db.is_dm_member(&target.target_id, &caller_id).unwrap_or(false)
        } else {
            state.db.is_member_of_server(&caller_id, &target.target_id).unwrap_or(false)
        };
        if !is_member {
            return (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": format!("Not a member of {} {}", target.target_type, target.target_id)})),
            )
                .into_response();
        }
        valid_targets.push((target.target_type.clone(), target.target_id.clone()));
    }

    match state.db.get_shared_profile_data_keys_batch(&valid_targets) {
        Ok(results) => {
            // Return as a map: { "{target_type}:{target_id}": [{ owner_user_id, encrypted_key, nonce }, ...] }
            let mut map = serde_json::Map::new();
            for (composite, keys) in results {
                let entries: Vec<serde_json::Value> = keys
                    .into_iter()
                    .map(|(owner_user_id, encrypted_key, nonce)| {
                        serde_json::json!({
                            "owner_user_id": owner_user_id,
                            "encrypted_key": encrypted_key,
                            "nonce": nonce,
                        })
                    })
                    .collect();
                map.insert(composite, serde_json::Value::Array(entries));
            }
            (StatusCode::OK, Json(serde_json::Value::Object(map))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

/// DELETE /api/profile/data-key/shared/{target_type}/{target_id}
/// Removes the caller's shared profile_data_key for the given target.
/// Used when leaving a server or unfriending someone to clean up stale keys.
pub async fn delete_shared_profile_data_key(
    Path((target_type, target_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Validate target_type
    if target_type != "dm_channel" && target_type != "server" {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid target_type, must be 'dm_channel' or 'server'"})),
        )
            .into_response();
    }

    match state.db.delete_shared_profile_data_key(&user_id, &target_type, &target_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub async fn save_profile_data_key(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SaveProfileDataKeyRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.save_profile_data_key(&user_id, &req.encrypted_key, &req.nonce) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub async fn get_profile_data_key(
    Path(requested_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let caller_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Self: always authorized (can decrypt with own identity key).
    // Friends / server-mates: also authorized to fetch but cannot decrypt the result
    // (the key is encrypted with the owner's identity key). This is still useful
    // because the client can re-encrypt it with a shared channel key.
    if caller_id != requested_id {
        // Check if they're friends or share a server
        let is_friend = state.db.are_friends(&caller_id, &requested_id).unwrap_or(false);
        let share_server = state.db.share_server(&caller_id, &requested_id).unwrap_or(false);
        if !is_friend && !share_server {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not authorized"}))).into_response();
        }
    }

    match state.db.get_profile_data_key(&requested_id) {
        Ok(Some((encrypted_key, nonce))) => {
            (StatusCode::OK, Json(serde_json::json!({
                "encrypted_key": encrypted_key,
                "nonce": nonce,
            }))).into_response()
        }
        Ok(None) => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "No profile data key found"}))).into_response()
        }
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub async fn get_user_key_blob(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.get_user_key_blob(&user_id) {
        Ok(Some((encrypted_blob, salt, nonce, needs_rebuild))) => {
            (StatusCode::OK, Json(serde_json::json!({
                "encrypted_blob": encrypted_blob,
                "salt": salt,
                "nonce": nonce,
                "needs_rebuild": needs_rebuild,
            }))).into_response()
        }
        Ok(None) => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "No key blob found"}))).into_response()
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
    pub invite_code_hash: String,
    pub encrypted_name: Option<String>,
    pub name_nonce: Option<String>,
    pub channel_encrypted_name: Option<String>,
    pub channel_name_nonce: Option<String>,
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

    let encrypted_name_bytes = req.encrypted_name.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let name_nonce_bytes = req.name_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let ch_enc_name_bytes = req.channel_encrypted_name.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let ch_name_nonce_bytes = req.channel_name_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

    let server = match state.db.create_server(&user_id, &req.invite_code_hash, encrypted_name_bytes.as_deref(), name_nonce_bytes.as_deref(), ch_enc_name_bytes.as_deref(), ch_name_nonce_bytes.as_deref()) {
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
            "encrypted_name": server.encrypted_name.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
            "name_nonce": server.name_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
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
                "encrypted_name": s.encrypted_name.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "name_nonce": s.name_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "is_owner": is_owner,
                "joins_disabled": s.joins_disabled,
                "server_picture_file_id": s.server_picture_file_id,
                "encrypted_server_picture_key": s.encrypted_server_picture_key.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "server_picture_key_nonce": s.server_picture_key_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
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
                "encrypted_name": c.encrypted_name.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "name_nonce": c.name_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(channel_infos))).into_response()
}

#[derive(Deserialize)]
pub struct CreateChannelRequest {
    pub encrypted_name: Option<String>,
    pub name_nonce: Option<String>,
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

    let encrypted_name_bytes = req.encrypted_name.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let name_nonce_bytes = req.name_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

    let channel = match state.db.create_channel(&server_id, encrypted_name_bytes.as_deref(), name_nonce_bytes.as_deref()) {
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
            "encrypted_name": channel.encrypted_name.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
            "name_nonce": channel.name_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
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

    // Rate limit: 10 attempts per 10 minutes
    let rate_key = format!("join_server:{}", user_id);
    if !JOIN_SERVER_RATE_LIMITER.check_and_increment(&rate_key, 10, Duration::from_secs(600)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many server join attempts. Try again in 10 minutes."})),
        )
            .into_response();
    }

    if req.code.trim().is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invite code is required"})),
        )
            .into_response();
    }

    let code = req.code.trim();

    // The client may send a pre-hashed invite code (HMAC-SHA256) for the streamlined flow,
    // or a plaintext invite code (legacy flow). Try the code as-is as a hash first,
    // then try HMAC-hashing it, then fall back to legacy SHA-256.
    // Client already hashed the code, use it directly
    let server = state.db.join_server_by_invite(code, &user_id);
    let server = match server {
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

        // Save pending key_needed events for offline members so the new member gets
        // the server key when someone reconnects (handles the case where all members
        // are offline at join time)
        let new_user_id = user_id.clone();
        let sid = server.id.clone();
        for mid in &members {
            if *mid != new_user_id && !state.ws_manager.is_user_connected(mid).await {
                let _ = state.db.save_pending_event(mid, &sid, "key_needed", &new_user_id);
            }
        }
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "id": server.id,
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
            // If owner is offline, save a pending event so they rotate the key on reconnect
            if !state.ws_manager.is_user_connected(&caller_id).await {
                let _ = state.db.save_pending_event(&caller_id, &server_id, "member_kicked", &req.user_id);
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
    // Find the owner ID before leave_server potentially deletes the server
    let owner_id = state.db.get_server_owner_id(&server_id).ok();

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
                    // Also broadcast to the leaving user so their UI updates in all tabs
                    let mut broadcast_users = members.clone();
                    broadcast_users.push(user_id.clone());
                    let _ = state.ws_manager.broadcast_to_users(&broadcast_users, &leave_msg.to_string()).await;
                }
                // If owner is offline, save a pending event so they rotate the key on reconnect
                if let Some(ref oid) = owner_id {
                    if oid != &user_id && !state.ws_manager.is_user_connected(oid).await {
                        let _ = state.db.save_pending_event(oid, &server_id, "member_left", &user_id);
                    }
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
            // If owner is offline, save a pending event so they rotate the key on reconnect
            if !state.ws_manager.is_user_connected(&caller_id).await {
                let _ = state.db.save_pending_event(&caller_id, &server_id, "member_banned", &req.user_id);
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
        .map(|(id, username, role, _display_name, _profile_pic)| {
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
    Query(params): Query<std::collections::HashMap<String, String>>,
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

    let limit: i64 = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50);
    let before = params.get("before").map(|s| s.as_str());

    let messages = if let Some(ts) = before {
        match state.db.list_messages_before(&channel_id, ts, limit) {
            Ok(m) => m,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": e})),
                ).into_response();
            }
        }
    } else {
        match state.db.list_messages(&channel_id, limit) {
            Ok(m) => m,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": e})),
                ).into_response();
            }
        }
    };

    // Collect unique sender IDs and fetch their conversation profiles for this server
    let mut sender_ids: Vec<&str> = messages.iter().map(|m| m.sender_id.as_str()).collect();
    sender_ids.dedup();
    let conv_profiles = state.db.get_conversation_profiles_batch("channel", &server_id, &sender_ids).unwrap_or_default();

    let message_infos: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "sender_id": m.sender_id,
                "sender_id_hash": m.sender_id_hash,
                "encrypted_sender_username": m.encrypted_sender_username,
                "sender_username_nonce": m.sender_username_nonce,

                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                "timestamp": m.timestamp,
                "message_nonce": m.message_nonce,
                "edited_at": m.edited_at,
                "encrypted_profile_key": m.encrypted_profile_key,
                "profile_key_nonce": m.profile_key_nonce,
                "encrypted_banner_key": m.encrypted_banner_key,
                "banner_key_nonce": m.banner_key_nonce,
                "key_version": m.key_version,
                "encrypted_profile_snapshot": m.encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "profile_snapshot_nonce": m.profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "encrypted_file_key": m.encrypted_file_key.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "file_key_nonce": m.file_key_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "conversation_profile": conv_profiles.get(&m.sender_id).map(|(data, nonce)| serde_json::json!({
                    "encrypted_profile_data": data,
                    "nonce": nonce,
                })),
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

    let mut sender_ids2: Vec<&str> = messages.iter().map(|m| m.sender_id.as_str()).collect();
    sender_ids2.dedup();
    let conv_profiles2 = state.db.get_conversation_profiles_batch("channel", &server_id, &sender_ids2).unwrap_or_default();

    let message_infos: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "sender_id": m.sender_id,
                "sender_id_hash": m.sender_id_hash,
                "encrypted_sender_username": m.encrypted_sender_username,
                "sender_username_nonce": m.sender_username_nonce,

                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                "timestamp": m.timestamp,
                "message_nonce": m.message_nonce,
                "edited_at": m.edited_at,
                "encrypted_profile_key": m.encrypted_profile_key,
                "profile_key_nonce": m.profile_key_nonce,
                "encrypted_banner_key": m.encrypted_banner_key,
                "banner_key_nonce": m.banner_key_nonce,
                "key_version": m.key_version,
                "encrypted_profile_snapshot": m.encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "profile_snapshot_nonce": m.profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "encrypted_file_key": m.encrypted_file_key.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "file_key_nonce": m.file_key_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "conversation_profile": conv_profiles2.get(&m.sender_id).map(|(data, nonce)| serde_json::json!({
                    "encrypted_profile_data": data,
                    "nonce": nonce,
                })),
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(message_infos))).into_response()
}

// --- Keys ---


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
}// --- Per-Device Key Escrow ---



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
    Query(params): Query<HashMap<String, String>>,
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

    // Check if the client requests to skip the key_needed broadcast
    // (used when the user has disabled the refresh heartbeat)
    let skip_key_needed = params.get("skip_key_needed").map(|v| v == "1").unwrap_or(false);

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

            // If this user has no key entries but other users do, broadcast key_needed
            // so any online member can upload the key for this user.
            // Skip if the client requested opt-out (heartbeat disabled).
            let user_has_keys = keys.iter().any(|(uid, _, _, _, _)| uid == &user_id);
            if !skip_key_needed && !user_has_keys && !keys.is_empty() {
                if let Ok(members) = state.db.get_server_members(&server_id) {
                    let need_msg = serde_json::json!({
                        "type": "key_needed",
                        "server_id": server_id,
                        "user_id": user_id,
                    });
                    let _ = state.ws_manager.broadcast_to_users(&members, &need_msg.to_string()).await;

                    // Also save pending key_needed for offline members as a safety net
                    // (the join_server handler also saves these, but this covers edge cases
                    // where the user fetches keys before any member has reconnected)
                    let need_uid = user_id.clone();
                    let need_sid = server_id.clone();
                    for mid in &members {
                        if !state.ws_manager.is_user_connected(mid).await {
                            let _ = state.db.save_pending_event(mid, &need_sid, "key_needed", &need_uid);
                        }
                    }
                }
            }

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

    // Save new keys (old keys are preserved so new members can decrypt old messages)
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

#[derive(Deserialize)]
pub struct UpdateEncryptedNameRequest {
    pub encrypted_name: String,
    pub name_nonce: String,
}

#[derive(Deserialize)]
pub struct UpdateServerPictureRequest {
    pub server_picture_file_id: String,
    pub encrypted_server_picture_key: String,
    pub server_picture_key_nonce: String,
    #[serde(default)]
    pub remove: Option<bool>,
}

pub async fn update_server_name(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpdateEncryptedNameRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if !state.db.is_server_owner(&user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Only the server owner can update server name"}))).into_response();
    }
    let enc_name = match base64::engine::general_purpose::STANDARD.decode(&req.encrypted_name) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid encrypted_name"}))).into_response(),
    };
    let nonce = match base64::engine::general_purpose::STANDARD.decode(&req.name_nonce) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid name_nonce"}))).into_response(),
    };
    if let Err(e) = state.db.update_server_name(&server_id, &enc_name, &nonce) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
    }
    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

pub async fn update_server_picture(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpdateServerPictureRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if !state.db.is_server_owner(&user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Only the server owner can update the server picture"}))).into_response();
    }
    let encrypted_key = match base64::engine::general_purpose::STANDARD.decode(&req.encrypted_server_picture_key) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid encrypted_server_picture_key"}))).into_response(),
    };
    let key_nonce = match base64::engine::general_purpose::STANDARD.decode(&req.server_picture_key_nonce) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid server_picture_key_nonce"}))).into_response(),
    };
    if req.remove == Some(true) {
        if let Err(e) = state.db.remove_server_picture(&server_id) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    } else {
        if let Err(e) = state.db.update_server_picture(&server_id, &req.server_picture_file_id, &encrypted_key, &key_nonce) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    }

    // Broadcast the picture change to all server members so their UI updates in real-time
    let picture_msg = serde_json::json!({
        "type": "server_picture_updated",
        "server_id": server_id,
        "server_picture_file_id": req.server_picture_file_id,
        "encrypted_server_picture_key": req.encrypted_server_picture_key,
        "server_picture_key_nonce": req.server_picture_key_nonce,
        "removed": req.remove.unwrap_or(false),
    });
    if let Ok(members) = state.db.get_server_members(&server_id) {
        let _ = state.ws_manager.broadcast_to_users(&members, &picture_msg.to_string()).await;
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

pub async fn update_channel_name(
    Path((server_id, channel_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpdateEncryptedNameRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if !state.db.is_server_owner(&user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Only the server owner can update channel name"}))).into_response();
    }
    let enc_name = match base64::engine::general_purpose::STANDARD.decode(&req.encrypted_name) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid encrypted_name"}))).into_response(),
    };
    let nonce = match base64::engine::general_purpose::STANDARD.decode(&req.name_nonce) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid name_nonce"}))).into_response(),
    };
    if let Err(e) = state.db.update_channel_name(&channel_id, &enc_name, &nonce) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
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
        .map(|(id, username, _pw_hash, created_at, display_name, identity_public_key, profile_picture_file_id, profile_picture_file_key, username_color, username_border_color, friend_requests_disabled, encrypted_friend_code, friend_code_salt, friend_code_nonce, encrypted_profile_data, encrypted_profile_salt, encrypted_profile_nonce, profile_banner_file_id, profile_banner_file_key, _description, _nickname, profile_background_color, friend_code_hash)| {
            serde_json::json!({
                "id": id,
                "username": username,
                "created_at": created_at,
                "identity_public_key": if identity_public_key.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(identity_public_key.clone()) },
                "profile_picture_file_id": profile_picture_file_id,
                "profile_picture_file_key": profile_picture_file_key,
                "friend_requests_disabled": *friend_requests_disabled != 0,
                "encrypted_friend_code": encrypted_friend_code,
                "friend_code_salt": friend_code_salt,
                "friend_code_nonce": friend_code_nonce,
                "encrypted_profile_data": encrypted_profile_data,
                "encrypted_profile_salt": encrypted_profile_salt,
                "encrypted_profile_nonce": encrypted_profile_nonce,
                "profile_banner_file_id": profile_banner_file_id,
                "profile_banner_file_key": profile_banner_file_key,
                // display_name, username_color, username_border_color, profile_background_color removed — all now in encrypted_profile_data
                "friend_code_hash": friend_code_hash,
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
                "owner_id": s.owner_id,
                "invite_code_hash": s.invite_code_hash,
                "joins_disabled": s.joins_disabled,
                "created_at": s.created_at,
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
                "type": c.channel_type,
                "position": c.position,
                "created_at": c.created_at,
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
                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                "timestamp": m.timestamp,
                "edited_at": m.edited_at,
                "message_nonce": m.message_nonce,
                "encrypted_profile_key": m.encrypted_profile_key,
                "profile_key_nonce": m.profile_key_nonce,
                "encrypted_banner_key": m.encrypted_banner_key,
                "banner_key_nonce": m.banner_key_nonce,
                "sender_id_hash": m.sender_id_hash,
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
        .map(|(sid, sname, uid, ek, spk, nonce, ver, did, ts)| {
            serde_json::json!({
                "server_id": sid,
                "server_name": sname,
                "user_id": uid,
                "encrypted_key": base64::engine::general_purpose::STANDARD.encode(ek),
                "sender_public_key": base64::engine::general_purpose::STANDARD.encode(spk),
                "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
                "version": ver,
                "device_id": did,
                "created_at": ts,
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
        .map(|(uid, uname, sid, sname, role, joined_at)| {
            serde_json::json!({
                "user_id": uid,
                "username": uname,
                "server_id": sid,
                "server_name": sname,
                "role": role,
                "joined_at": joined_at,
            })
        })
        .collect();
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, dm_id, sid, _sname, enc, nonce, ts, _kv, _snap, _snap_nonce, _file_key, _file_key_nonce, _sender_id_hash)| {
        serde_json::json!({
            "id": id, "dm_channel_id": dm_id,
            "sender_id": sid,
            "encrypted_content": base64::engine::general_purpose::STANDARD.encode(enc),
            "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
            "timestamp": ts,
            "sender_id_hash": _sender_id_hash,
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(dm_id, uid, uname, ek, spk, nonce, device_id, created_at)| {
        serde_json::json!({
            "dm_channel_id": dm_id, "user_id": uid, "username": uname,
            "encrypted_key": base64::engine::general_purpose::STANDARD.encode(ek),
            "sender_public_key": base64::engine::general_purpose::STANDARD.encode(spk),
            "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
            "device_id": device_id,
            "created_at": created_at,
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, fid, _fname, tid, _tname, status, ts, responded_at)| {
        serde_json::json!({
            "id": id, "from_user_id": fid,
            "to_user_id": tid, "status": status, "created_at": ts,
            "responded_at": responded_at,
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


pub async fn admin_list_files(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_files_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, uid, uname, name, mime, size, sid, cid, ts, chunk_count, upload_complete)| {
        serde_json::json!({
            "id": id, "uploader_id": uid, "uploader_username": uname,
            "original_name": name, "mime_type": mime, "file_size": size,
            "server_id": sid, "channel_id": cid, "created_at": ts,
            "chunk_count": chunk_count, "upload_complete": *upload_complete != 0,
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, uid, uname, fid, sname, fkey, mime, ekey, eknonce, created_at)| {
        serde_json::json!({
            "id": id, "user_id": uid, "username": uname,
            "file_id": fid, "sticker_name": sname,
            "file_key": if fkey.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(fkey.clone()) },
            "mime_type": mime,
            "created_at": created_at,
            "encrypted_file_key": ekey.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
            "file_key_nonce": eknonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, sid, sname, fid, uby, stname, fkey, ekey, eknonce, created_at)| {
        serde_json::json!({
            "id": id, "server_id": sid, "server_name": sname,
            "file_id": fid, "uploaded_by": uby, "sticker_name": stname,
            "file_key": if fkey.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(fkey.clone()) },
            "created_at": created_at,
            "encrypted_file_key": ekey.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
            "file_key_nonce": eknonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(uid, uname, fname, enc, nonce, spk, created, updated)| {
        serde_json::json!({
            "user_id": uid, "username": uname, "file_name": fname,
            "encrypted_sound": base64::engine::general_purpose::STANDARD.encode(enc),
            "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
            "sender_public_key": base64::engine::general_purpose::STANDARD.encode(spk),
            "created_at": created,
            "updated_at": updated,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_admin_config(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_config_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(key, value)| {
        serde_json::json!({
            "key": key, "value": value,
        })
    }).collect();
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(user_id, identity_key_public, signed_prekey_public, signed_prekey_signature, one_time_prekey_public, one_time_prekey_id, created_at)| {
        serde_json::json!({
            "user_id": user_id, "identity_key_public": identity_key_public,
            "signed_prekey_public": signed_prekey_public, "signed_prekey_signature": signed_prekey_signature,
            "one_time_prekey_public": one_time_prekey_public, "one_time_prekey_id": one_time_prekey_id,
            "created_at": created_at,
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(our_username, our_user_id, their_username, their_user_id, session_data, ratchet_counter, created_at)| {
        serde_json::json!({
            "our_username": our_username, "our_user_id": our_user_id,
            "their_username": their_username, "their_user_id": their_user_id,
            "session_data": session_data, "ratchet_counter": ratchet_counter,
            "created_at": created_at,
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(username, user_id, device_id, device_name, identity_key, signed_prekey, signed_prekey_signature, last_active_at, created_at)| {
        serde_json::json!({
            "username": username, "user_id": user_id,
            "device_id": device_id, "device_name": device_name,
            "identity_key": identity_key, "signed_prekey": signed_prekey,
            "signed_prekey_signature": signed_prekey_signature,
            "last_active_at": last_active_at, "created_at": created_at,
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(username, user_id, encrypted_private_key, salt, nonce, created_at, updated_at)| {
        serde_json::json!({
            "username": username, "user_id": user_id,
            "encrypted_private_key": encrypted_private_key, "salt": salt, "nonce": nonce,
            "created_at": created_at, "updated_at": updated_at,
            "has_key": !encrypted_private_key.is_empty(),
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_user_device_escrow(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_user_device_escrow_admin() {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(username, user_id, device_id, encrypted_private_key, salt, nonce, created_at, updated_at)| {
        serde_json::json!({
            "username": username, "user_id": user_id, "device_id": device_id,
            "encrypted_private_key": encrypted_private_key, "salt": salt, "nonce": nonce,
            "created_at": created_at, "updated_at": updated_at,
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

    match state.db.clear_all("uploads") {
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
    pub encrypted_file_key: Option<String>,
    pub file_key_nonce: Option<String>,
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
                .map(|(id, file_id, name, mime, uploaded_by, file_key, ekey, eknounce)| {
                    serde_json::json!({
                        "id": id,
                        "file_id": file_id,
                        "sticker_name": name,
                        "mime_type": mime,
                        "uploaded_by": uploaded_by,
                        "file_key": file_key,
                        "encrypted_file_key": ekey.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                        "file_key_nonce": eknounce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
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
    // Decode encrypted_file_key and file_key_nonce if provided
    let encrypted_key_bytes = body.encrypted_file_key.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let key_nonce_bytes = body.file_key_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

    match state.db.add_server_sticker(&server_id, &body.file_id, &user_id, &body.sticker_name, body.file_key.as_deref().unwrap_or(""), encrypted_key_bytes.as_deref(), key_nonce_bytes.as_deref()) {
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
    pub encrypted_file_key: Option<String>,
    pub file_key_nonce: Option<String>,
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
                .map(|(id, file_id, name, mime, file_key, ekey, eknounce)| {
                    serde_json::json!({
                        "id": id,
                        "file_id": file_id,
                        "sticker_name": name,
                        "mime_type": mime,
                        "file_key": file_key,
                        "encrypted_file_key": ekey.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                        "file_key_nonce": eknounce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
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
    // Decode encrypted_file_key and file_key_nonce if provided
    let encrypted_key_bytes = body.encrypted_file_key.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let key_nonce_bytes = body.file_key_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

    match state.db.add_user_sticker(&user_id, &body.file_id, &body.sticker_name, body.file_key.as_deref().unwrap_or(""), &body.mime_type, encrypted_key_bytes.as_deref(), key_nonce_bytes.as_deref()) {
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
    pub remove_picture: Option<bool>,  // true = remove profile picture
    pub profile_picture_file_id: Option<String>,  // Some("file_id") = set picture
    pub profile_picture_file_key: Option<String>,  // file encryption key (base64)
    // Profile v2 fields
    pub profile_banner_file_id: Option<String>,
    pub profile_banner_file_key: Option<String>,
    // Encrypted profile — all profile fields (display_name, colors, description, etc.)
    // are inside this encrypted blob. No plaintext profile data accepted.
    pub encrypted_profile_data: Option<String>,
    pub encrypted_profile_salt: Option<String>,
    pub encrypted_profile_nonce: Option<String>,
    pub encrypted_profile_data_key: Option<String>,
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
        Ok((id, username, profile_picture_file_id, file_key, banner_id, banner_key)) => {
            let encrypted = state.db.get_encrypted_profile(&requested_id).ok().flatten();
            (StatusCode::OK, Json(serde_json::json!({
                "id": id,
                "username": username,
                // display_name, username_color, username_border_color, profile_background_color
                // are no longer returned as plaintext — all profile data is inside encrypted_profile_data.
                "profile_picture_file_id": profile_picture_file_id,
                // Only return file decryption keys to authorized users (friends / server-mates / self)
                "profile_picture_file_key": if authorized_for_keys { file_key } else { None },
                "profile_banner_file_id": banner_id,
                "profile_banner_file_key": if authorized_for_keys { banner_key } else { None },
                // description, nickname, display_name, and colors removed from plaintext API.
                // All profile data is inside encrypted_profile_data.
                "encrypted_profile_data": encrypted.as_ref().map(|e| e.0.as_str()),
                "encrypted_profile_salt": encrypted.as_ref().map(|e| e.1.as_str()),
                "encrypted_profile_nonce": encrypted.as_ref().map(|e| e.2.as_str()),
                "encrypted_profile_data_key": encrypted.as_ref().and_then(|e| if e.3.is_empty() { None } else { Some(e.3.as_str()) }),
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

    // Display name, username_color, username_border_color, profile_background_color
    // are NO LONGER accepted as plaintext fields. All profile data (including these)
    // must be sent inside encrypted_profile_data and encrypted with the profile data key.

    // Before changing profile picture, delete the old one's file from DB and disk
    let delete_current_pic = || -> Result<(), String> {
        let (_, _, old_file_id, _, _, _) = state.db.get_user_profile(&user_id)?;
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

    // Description, nickname, display_name, username_color, username_border_color,
    // and profile_background_color are NO LONGER accepted as plaintext fields.
    // All profile data must be inside encrypted_profile_data.

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

    // Save encrypted profile data + key if provided
    if let Some(data) = &req.encrypted_profile_data {
        let salt = req.encrypted_profile_salt.as_deref().unwrap_or("");
        let nonce = req.encrypted_profile_nonce.as_deref().unwrap_or("");
        let data_key = req.encrypted_profile_data_key.as_deref();
        let _ = state.db.save_encrypted_profile(&user_id, data, salt, nonce, data_key);
    }

    // Broadcast profile update to the user, friends, and all server members
    if let Ok(profile) = state.db.get_user_profile(&user_id) {
        let (_id, username, profile_picture_file_id, profile_picture_file_key, banner_id, banner_file_key) = profile;
        let encrypted = state.db.get_encrypted_profile(&user_id).ok().flatten();
        let profile_updated_at = state.db.get_profile_updated_at(&user_id).ok();
        let profile_msg = serde_json::json!({
            "type": "profile_updated",
            "user_id": user_id,
            "username": username,
    // display_name, username_color, username_border_color are
    // no longer sent as plaintext — they're inside encrypted_profile_data.
    "profile_picture_file_id": profile_picture_file_id,
    "profile_picture_file_key": profile_picture_file_key,
    "profile_banner_file_id": banner_id,
    "profile_banner_file_key": banner_file_key,
    "encrypted_profile_data": encrypted.as_ref().map(|e| e.0.as_str()),
    "encrypted_profile_data_key": encrypted.as_ref().and_then(|e| if e.3.is_empty() { None } else { Some(e.3.as_str()) }),
            "profile_updated_at": profile_updated_at,
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

// --- Conversation Profile Data (per-conversation encrypted profile) ---

#[derive(Deserialize)]
pub struct UpsertConversationProfileRequest {
    pub conversation_type: String,  // "dm" or "channel"
    pub conversation_id: String,
    pub encrypted_profile_data: String,
    pub nonce: String,
}

pub async fn upsert_conversation_profile(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpsertConversationProfileRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Verify the caller is a member of the conversation
    let is_member = match req.conversation_type.as_str() {
        "dm" => state.db.is_member_of_dm(&user_id, &req.conversation_id).unwrap_or(false),
        "channel" => {
            // conversation_id may be a server ID (used by uploadConversationProfiles
            // and queried by list_messages) or a channel ID (legacy). Try both.
            if state.db.is_member_of_server(&user_id, &req.conversation_id).unwrap_or(false) {
                true
            } else {
                let server_id = state.db.get_server_id_for_channel(&req.conversation_id).ok();
                match server_id {
                    Some(sid) => state.db.is_member_of_server(&user_id, &sid).unwrap_or(false),
                    None => false,
                }
            }
        }
        _ => false,
    };

    if !is_member {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not a member of this conversation"}))).into_response();
    }

    match state.db.upsert_conversation_profile(&user_id, &req.conversation_type, &req.conversation_id, &req.encrypted_profile_data, &req.nonce) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn get_conversation_profile(
    Path((target_user_id, conv_type, conv_id)): Path<(String, String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Verify the caller is a member of the conversation
    let is_member = match conv_type.as_str() {
        "dm" => state.db.is_member_of_dm(&user_id, &conv_id).unwrap_or(false),
        "channel" => {
            // conv_id may be a server ID or a channel ID — try both
            if state.db.is_member_of_server(&user_id, &conv_id).unwrap_or(false) {
                true
            } else {
                let server_id = state.db.get_server_id_for_channel(&conv_id).ok();
                match server_id {
                    Some(sid) => state.db.is_member_of_server(&user_id, &sid).unwrap_or(false),
                    None => false,
                }
            }
        }
        _ => false,
    };

    if !is_member {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not a member of this conversation"}))).into_response();
    }

    match state.db.get_conversation_profile(&target_user_id, &conv_type, &conv_id) {
        Ok(Some((data, nonce))) => (StatusCode::OK, Json(serde_json::json!({
            "encrypted_profile_data": data,
            "nonce": nonce,
        }))).into_response(),
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "No profile data for this conversation"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

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
pub async fn get_hmac_key(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // PUBLIC endpoint — no auth required.
    // The HMAC key is used by clients to hash friend codes and invite codes
    // during registration (before the user has a token).
    (StatusCode::OK, Json(serde_json::json!({
        "hmac_key": state.config.hmac_key,
    }))).into_response()
}

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

    let hash = hmac_sha256_hex(state.config.hmac_key.as_bytes(), &req.friend_code.trim().to_uppercase());

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

    let hash = hmac_sha256_hex(state.config.hmac_key.as_bytes(), &code);
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

    // Verify password against stored hash (direct string comparison — matches login/reauth)
    let stored_password_hash = match state.db.get_password_hash_by_id(&user_id) {
        Ok(h) => h,
        Err(_) => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "User not found"}))).into_response(),
    };

    if req.password != stored_password_hash {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Wrong password"}))).into_response();
    }

    // Validate the new friend code
    let code = req.friend_code.trim().to_uppercase();
    if code.len() < 8 || code.len() > 16 || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid friend code format"}))).into_response();
    }

    let hash = hmac_sha256_hex(state.config.hmac_key.as_bytes(), &code);

    match state.db.update_encrypted_friend_code(&user_id, &hash, &req.encrypted_friend_code, &req.salt, &req.nonce) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

fn hmac_sha256_hex(key: &[u8], data: &str) -> String {
    use sha2::{Digest, Sha256};
    const BLOCK_SIZE: usize = 64;
    // Normalize key to 32 bytes: if key is not exactly 32 bytes, hash it.
    // This matches the client behavior in crypto.js where libsodium's one-shot
    // crypto_auth_hmacsha256 requires a 32-byte key.
    let normalized_key = if key.len() != 32 {
        let hash = Sha256::digest(key);
        hash.to_vec()
    } else {
        key.to_vec()
    };
    let mut k = vec![0u8; BLOCK_SIZE];
    k[..normalized_key.len()].copy_from_slice(&normalized_key);
    let mut ipad = vec![0u8; BLOCK_SIZE];
    let mut opad = vec![0u8; BLOCK_SIZE];
    for i in 0..BLOCK_SIZE {
        ipad[i] = k[i] ^ 0x36;
        opad[i] = k[i] ^ 0x5c;
    }
    let inner_hash = {
        let mut hasher = Sha256::new();
        hasher.update(&ipad);
        hasher.update(data.as_bytes());
        hasher.finalize()
    };
    let result = {
        let mut hasher = Sha256::new();
        hasher.update(&opad);
        hasher.update(&inner_hash);
        hasher.finalize()
    };
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
pub struct FriendRequestsDisabledRequest {
    pub disabled: bool,
}

pub async fn get_friend_requests_disabled(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.get_friend_requests_disabled(&user_id) {
        Ok(disabled) => (
            StatusCode::OK,
            Json(serde_json::json!({"friend_requests_disabled": disabled})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

pub async fn set_friend_requests_disabled(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<FriendRequestsDisabledRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.set_friend_requests_disabled(&user_id, req.disabled) {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({"ok": true, "friend_requests_disabled": req.disabled})),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response(),
    }
}

#[derive(Deserialize)]
pub struct SendFriendRequest {
    pub friend_code_hash: String,
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

    // Rate limit: 10 friend request attempts per 10 minutes
    let rate_key = format!("friend_request:{}", user_id);
    if !FRIEND_REQUEST_RATE_LIMITER.check_and_increment(&rate_key, 10, Duration::from_secs(600)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many friend request attempts. Try again in 10 minutes."})),
        )
            .into_response();
    }

    let code_hash = &req.friend_code_hash;
    let friend_request_result = state.db.create_friend_request(&user_id, &code_hash);
    match friend_request_result {
        Ok(target) => {
            // Notify the recipient in real time (best-effort). No username included — client resolves from user_id.
            let notify = serde_json::json!({
                "type": "friend_request_received",
                "from_user_id": user_id,
            });
            let _ = state
                .ws_manager
                .broadcast_to_users(&[target.id.clone()], &notify.to_string())
                .await;
            // Save for offline recipient
            if !state.ws_manager.is_user_connected(&target.id).await {
                let _ = state.db.save_pending_notification(&target.id, "friend_request_received", &notify.to_string());
            }
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

            // Notify both users that they are now friends.
            let notify = serde_json::json!({
                "type": "friend_request_accepted",
                "by_user_id": user_id,
                "from_user_id": from_id,
            });
            let _ = state
                .ws_manager
                .broadcast_to_users(&[from_id.clone(), user_id.clone()], &notify.to_string())
                .await;
            // Save for offline users
            if !state.ws_manager.is_user_connected(&from_id).await {
                let _ = state.db.save_pending_notification(&from_id, "friend_request_accepted", &notify.to_string());
            }
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
            // Notify both users that the friendship was removed
            // Include both the caller and the other user for multi-tab consistency
            let notify = serde_json::json!({
                "type": "friend_removed",
                "by_user_id": user_id,
            });
            let _ = state
                .ws_manager
                .broadcast_to_users(&[req.user_id.clone(), user_id.clone()], &notify.to_string())
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
            for (dm_id, other_id, other_username, other_display_name, _other_profile_pic) in channels {
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
                        "timestamp": m.timestamp,
                        "message_nonce": m.message_nonce,
                    }),
                    None => serde_json::Value::Null,
                };
                result.push(serde_json::json!({
                    "dm_channel_id": dm_id,
                    "other_user_id": other_id,
                    "other_username": other_username,
                    // other_display_name removed — now in encrypted profile data
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
    Query(params): Query<std::collections::HashMap<String, String>>,
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
    let limit: i64 = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50);
    let before = params.get("before").map(|s| s.as_str());

    let msgs = if let Some(ts) = before {
        match state.db.list_dm_messages_before(&dm_channel_id, ts, limit) {
            Ok(m) => m,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": e})),
                ).into_response();
            }
        }
    } else {
        match state.db.list_dm_messages(&dm_channel_id, limit) {
            Ok(m) => m,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": e})),
                ).into_response();
            }
        }
    };

    let mut dm_sender_ids: Vec<&str> = msgs.iter().map(|m| m.sender_id.as_str()).collect();
            dm_sender_ids.dedup();
            let dm_conv_profiles = state.db.get_conversation_profiles_batch("dm", &dm_channel_id, &dm_sender_ids).unwrap_or_default();

            let result: Vec<serde_json::Value> = msgs
                .iter()
                .map(|m| {
                    serde_json::json!({
                        "id": m.id,
                        "dm_channel_id": m.dm_channel_id,
                        "sender_id": m.sender_id,
                        "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                        "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                        "timestamp": m.timestamp,
                        "message_nonce": m.message_nonce,
                        "edited_at": m.edited_at,
                        "encrypted_profile_key": m.encrypted_profile_key,
                        "profile_key_nonce": m.profile_key_nonce,
                        "encrypted_banner_key": m.encrypted_banner_key,
                        "banner_key_nonce": m.banner_key_nonce,
                        "key_version": m.key_version,
                        "encrypted_profile_snapshot": base64::engine::general_purpose::STANDARD.encode(m.encrypted_profile_snapshot.as_deref().unwrap_or(&[])),
                        "profile_snapshot_nonce": m.profile_snapshot_nonce,
                        "encrypted_file_key": m.encrypted_file_key,
                        "file_key_nonce": m.file_key_nonce,
                        "sender_id_hash": m.sender_id_hash,
                        "encrypted_sender_username": m.encrypted_sender_username,
                        "sender_username_nonce": m.sender_username_nonce,
                        "conversation_profile": dm_conv_profiles.get(&m.sender_id).map(|(data, nonce)| serde_json::json!({
                            "encrypted_profile_data": data,
                            "nonce": nonce,
                        })),
                    })
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
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

pub async fn list_online_users(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let online = state.ws_manager.get_online_user_ids().await;
    (StatusCode::OK, Json(serde_json::json!(online))).into_response()
}
