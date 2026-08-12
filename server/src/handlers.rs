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

static HMAC_KEY_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

static LOGIN_IP_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

static FRIEND_REQUEST_IP_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

static REAUTH_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

static REAUTH_IP_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

static AUTH_PARAMS_IP_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

static ADMIN_LOGIN_IP_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

static CREATE_SERVER_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

static ADMIN_TOKENS: Mutex<Option<HashMap<String, Instant>>> = Mutex::new(None);

/// Per-user + per-IP limiter for authenticated state-changing API calls (G2).
/// Env-overridable for test suites (same pattern as LOGIN_IP_MAX/LOGIN_USER_MAX):
/// MUTATION_USER_MAX (default 120 req/10s per user) and MUTATION_IP_MAX
/// (default 1000 req/10s per IP). File-chunk uploads are excluded (a large
/// file legitimately needs thousands of chunk requests) and instead bounded by
/// the per-user storage quota.
static MUTATION_USER_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

static MUTATION_IP_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

/// Check the per-user + per-IP budget for an authenticated mutation.
/// Returns the HTTP status to return on a hit (429), or None if allowed.
pub(crate) fn check_mutation_rate_limit(
    headers: &HeaderMap,
    state: &AppState,
) -> Option<(StatusCode, Json<serde_json::Value>)> {
    let user_id = match extract_user(headers, state) {
        Ok(id) => id,
        // Unauthenticated requests fall through to the handler, which will 401.
        Err(_) => return None,
    };

    let user_max: u32 = std::env::var("MUTATION_USER_MAX")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(120);
    let key = format!("mut_user:{}", user_id);
    if user_max > 0
        && !MUTATION_USER_RATE_LIMITER.check_and_increment(&key, user_max, Duration::from_secs(10))
    {
        return Some((
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many requests. Slow down."})),
        ));
    }

    let ip = get_client_ip(headers);
    let ip_max: u32 = std::env::var("MUTATION_IP_MAX")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1000);
    let ip_key = format!("mut_ip:{}", ip);
    if ip_max > 0
        && !MUTATION_IP_RATE_LIMITER.check_and_increment(&ip_key, ip_max, Duration::from_secs(10))
    {
        return Some((
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many requests. Slow down."})),
        ));
    }

    None
}

fn get_admin_tokens() -> std::sync::MutexGuard<'static, Option<HashMap<String, Instant>>> {
    ADMIN_TOKENS.lock().unwrap()
}

fn store_admin_token(token: String) {
    let mut guard = get_admin_tokens();
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(token, Instant::now() + Duration::from_secs(24 * 3600));
}

pub(crate) fn extract_user(headers: &HeaderMap, state: &AppState) -> Result<String, (StatusCode, Json<serde_json::Value>)> {
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

    // Server-side session check: a force-kicked (revoked) session is rejected
    // on the very next authenticated request, even though its JWT is still
    // cryptographically valid. Tokens without a sid (pre-migration) are also
    // rejected so the user re-logs in through the new flow exactly once.
    if claims.sid.is_empty()
        || state
            .db
            .auth_session_valid(&claims.sid)
            .map_err(|_| {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "Session check failed"})),
                )
            })?
            != true
    {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Session revoked — please sign in again"})),
        ));
    }

    Ok(claims.sub)
}

pub async fn logout(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // Validate the token if present (optional)
    let _ = extract_user(&headers, &state);

    // Revoke this device's server-side session so a stolen token can't be
    // replayed after sign-out (and the Devices panel stops listing it).
    let auth_token: Option<String> = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").map(|s| s.to_string()));
    if let Some(token) = auth_token {
        if let Ok(claims) = auth::validate_token(&token, &state.config.jwt_secret) {
            if !claims.sid.is_empty() {
                let _ = state.db.revoke_auth_session(&claims.sid, &claims.sub);
            }
        }
    }

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

// --- Session/device management (Settings → Security → Devices) ---

/// GET /api/auth/sessions — every signed-in device of the current user.
/// Only the device name and a short device-id suffix are returned (the full
/// device id is a client key, not a secret, but there's no reason to show it
/// in full). The session id IS returned so the client can kick by id.
pub async fn list_auth_sessions(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let (user_id, current_sid) = match extract_claims(&headers, &state) {
        Ok(c) => (c.sub, c.sid),
        Err(r) => return r.into_response(),
    };

    let rows = match state.db.list_auth_sessions(&user_id) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let sessions: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, device_id, device_name, created_at, last_active_at, expires_at, revoked)| {
            let short_id = if device_id.len() > 8 {
                format!("…{}", &device_id[device_id.len() - 8..])
            } else {
                device_id.clone()
            };
            serde_json::json!({
                "id": id,
                "device_name": device_name,
                "device_id": short_id,
                "created_at": created_at,
                "last_active_at": last_active_at,
                "expires_at": expires_at,
                "revoked": revoked != 0,
                "is_current": id == current_sid,
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!({"sessions": sessions}))).into_response()
}

#[derive(Deserialize)]
pub struct KickSessionRequest {
    pub session_id: String,
}

/// POST /api/auth/sessions/kick — revoke one session. If that device is
/// currently connected over WebSocket it is told immediately (session_revoked)
/// and dropped from any voice room it occupies; otherwise the next time its
/// token is validated (API call or WS auth) it is rejected.
pub async fn kick_auth_session(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<KickSessionRequest>,
) -> impl IntoResponse {
    let (user_id, _current_sid) = match extract_claims(&headers, &state) {
        Ok(c) => (c.sub, c.sid),
        Err(r) => return r.into_response(),
    };

    let revoked = match state.db.revoke_auth_session(&req.session_id, &user_id) {
        Ok(r) => r,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };
    if !revoked {
        // Already revoked or not yours — idempotent success either way.
        return (StatusCode::OK, Json(serde_json::json!({"ok": true, "revoked": false}))).into_response();
    }

    // Live-kick: if that session's device has an open WS, tell it and drop it
    // from any voice room it occupies (it can no longer hold a call slot).
    if let Ok(Some((sid_user, device_id))) = state.db.get_auth_session_device(&req.session_id) {
        if !device_id.is_empty() {
            let kick_msg = serde_json::json!({
                "type": "session_revoked",
                "reason": "kicked",
            });
            state.ws_manager.broadcast_to_device(&sid_user, &device_id, &kick_msg.to_string()).await;
            crate::ws::voice_remove_user_all_for_device(&state, &sid_user, &device_id).await;
        }
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true, "revoked": true}))).into_response()
}

/// POST /api/auth/sessions/kick-all — revoke every session except the current
/// one ("log out everywhere else" button).
pub async fn kick_all_auth_sessions(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let (user_id, current_sid) = match extract_claims(&headers, &state) {
        Ok(c) => (c.sub, c.sid),
        Err(r) => return r.into_response(),
    };

    let n = match state.db.revoke_auth_sessions_except(&user_id, &current_sid) {
        Ok(n) => n,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    // Live-kick every revoked session's device.
    if let Ok(rows) = state.db.list_auth_sessions(&user_id) {
        let kick_msg = serde_json::json!({
            "type": "session_revoked",
            "reason": "kicked",
        });
        for (sid, device_id, _, _, _, _, revoked) in rows {
            if sid == current_sid || revoked == 0 {
                continue;
            }
            if !device_id.is_empty() {
                state.ws_manager.broadcast_to_device(&user_id, &device_id, &kick_msg.to_string()).await;
                crate::ws::voice_remove_user_all_for_device(&state, &user_id, &device_id).await;
            }
        }
    }

    (StatusCode::OK, Json(serde_json::json!({"ok": true, "revoked": n}))).into_response()
}

/// Validate the Bearer token and return its claims (sid included). Reuses the
/// same session-revocation enforcement as extract_user.
fn extract_claims(
    headers: &HeaderMap,
    state: &AppState,
) -> Result<auth::Claims, (StatusCode, Json<serde_json::Value>)> {
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").map(|s| s.to_string()))
        .or_else(|| {
            headers
                .get("cookie")
                .and_then(|v| v.to_str().ok())
                .and_then(|cookie_str| {
                    cookie_str.split(';').find_map(|part| {
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

    if claims.sid.is_empty()
        || state
            .db
            .auth_session_valid(&claims.sid)
            .map_err(|_| {
                (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "Session check failed"})),
                )
            })?
            != true
    {
        return Err((
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Session revoked — please sign in again"})),
        ));
    }

    Ok(claims)
}

fn get_client_ip(headers: &HeaderMap) -> String {
    headers
        .get("x-forwarded-for")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.split(',').next().map(|s| s.trim().to_string()))
        .or_else(|| {
            headers
                .get("x-real-ip")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string())
        })
        .unwrap_or_else(|| "unknown".to_string())
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
    pub friend_code: Option<String>,
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
    // Optional custom session lifetime in seconds (Settings → Security, max 30 days).
    #[serde(default)]
    pub duration_seconds: Option<u64>,
    // Device identity for the session/device list (Settings → Security → Devices).
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
}

#[derive(Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
    // Optional custom session lifetime in seconds (Settings → Security, max 30 days).
    #[serde(default)]
    pub duration_seconds: Option<u64>,
    // Device identity for the session/device list (Settings → Security → Devices).
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
}

// Session lifetime clamp shared by register/login/reauth. Clients may request a
// custom duration; the server floors it at 1 minute and caps it at 30 days so a
// malformed request can never mint an over-long token.
const MAX_SESSION_SECS: u64 = 30 * 24 * 60 * 60; // 30 days
const MIN_SESSION_SECS: u64 = 60; // 1 minute
fn session_duration_secs(dur: Option<u64>) -> u64 {
    dur.unwrap_or(MAX_SESSION_SECS).clamp(MIN_SESSION_SECS, MAX_SESSION_SECS)
}

/// Mint a session row + JWT for a (user, device) sign-in. Every login,
/// registration, and re-auth goes through here so the Devices panel sees
/// exactly what is signed in and any of it can be force-kicked later.
fn mint_session_token(
    state: &AppState,
    user_id: &str,
    username: &str,
    device_id: Option<&str>,
    device_name: Option<&str>,
    session_secs: u64,
) -> Result<String, String> {
    let sid = uuid::Uuid::new_v4().to_string();
    let expires_at = chrono::Utc::now()
        .checked_add_signed(chrono::Duration::seconds(session_secs as i64))
        .unwrap()
        .to_rfc3339();
    state.db.upsert_auth_session(
        &sid,
        user_id,
        device_id.unwrap_or(""),
        device_name.unwrap_or(""),
        &expires_at,
    )?;
    auth::create_token_with_duration(
        user_id,
        username,
        &sid,
        &state.config.jwt_secret,
        chrono::Duration::seconds(session_secs as i64),
    )
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

    // Compute salted friend code hash if raw friend code provided
    let (friend_code_hash, friend_code_hash_salt) = if let Some(fc) = &req.friend_code {
        use rand::Rng;
        let salt: String = rand::thread_rng().gen::<[u8; 16]>().iter().map(|b| format!("{:02x}", b)).collect();
        let code_upper = fc.trim().to_uppercase();
        let hash = crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &format!("{}{}", salt, code_upper));
        (Some(hash), Some(salt))
    } else {
        (None, None)
    };

    let user = match state.db.create_user(&req.username, &password_hash, identity_key_bytes.as_deref(), friend_code_hash.as_deref(), friend_code_hash_salt.as_deref(), req.encrypted_friend_code.as_deref(), req.friend_code_salt.as_deref(), req.friend_code_nonce.as_deref(), req.encrypted_hash_key.as_deref(), req.hash_key_salt.as_deref(), req.hash_key_nonce.as_deref()) {
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

    let session_secs = session_duration_secs(req.duration_seconds);
    let token = match mint_session_token(
        &state,
        &user.id,
        &user.username,
        req.device_id.as_deref(),
        req.device_name.as_deref(),
        session_secs,
    ) {
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
        Ok((_, _, pp, pph, _, bh, _, _, _, _)) => (pp, pph, bh),
        Err(_) => (None, None, None),
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
                "profile_picture_file_id": profile_pic.0,
                "profile_picture_file_id_hash": profile_pic.1,
                "profile_banner_file_id_hash": profile_pic.2
            }
        })),
    )
        .into_response()
}

pub async fn login(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<LoginRequest>,
) -> impl IntoResponse {
    // Per-IP rate limiting: 10 attempts per 5 minutes.
    // Env-overridable so automated test suites (which log in dozens of users
    // from one IP) can raise/disable the budget: set LOGIN_IP_MAX=0 to
    // disable, or a number to raise it (same pattern as FRIEND_REQUEST_IP_MAX).
    let ip = get_client_ip(&headers);
    let ip_rate_key = format!("login_ip:{}", ip);
    let ip_max: u32 = std::env::var("LOGIN_IP_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
    if ip_max > 0 && !LOGIN_IP_RATE_LIMITER.check_and_increment(&ip_rate_key, ip_max, Duration::from_secs(300)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many login attempts. Try again in 5 minutes."})),
        )
            .into_response();
    }

    // Per-username rate limiting (already existed). Env-overridable for tests.
    let rate_key = format!("login:{}", req.username);
    let user_max: u32 = std::env::var("LOGIN_USER_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
    if user_max > 0 && !LOGIN_RATE_LIMITER.check_and_increment(&rate_key, user_max, Duration::from_secs(300)) {
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

    // Client-computed hash (HMAC-SHA256) — constant-time comparison to prevent timing attacks
    use subtle::ConstantTimeEq;
    let valid: bool = req.password.as_bytes().ct_eq(password_hash.as_bytes()).into();

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

    let session_secs = session_duration_secs(req.duration_seconds);
    let token = match mint_session_token(
        &state,
        &user.id,
        &user.username,
        req.device_id.as_deref(),
        req.device_name.as_deref(),
        session_secs,
    ) {
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
            &format!("token={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={}", token, session_secs)
        ).unwrap(),
    );

    // Fetch profile picture only (display_name and other profile fields are now encrypted-only)
    let profile_pic = match state.db.get_user_profile(&user.id) {
        Ok((_, _, pp, pph, _, bh, _, _, _, _)) => (pp, pph, bh),
        Err(_) => (None, None, None),
    };

    (StatusCode::OK, headers, Json(serde_json::json!({
        "token": token,
        "user": {
            "id": user.id,
            "username": user.username,
            "profile_picture_file_id": profile_pic.0,
            "profile_picture_file_id_hash": profile_pic.1,
            "profile_banner_file_id_hash": profile_pic.2
        }
    }))).into_response()
}

// --- Auth-Params (pre-login hash_key fetch) ---

/// GET /api/auth-params/:username — returns encrypted_hash_key + salt + nonce
/// so the client can decrypt the hash_key with the raw password, derive the
/// pre-hashed password, and submit it to /api/login.
/// No authentication required (these are already encrypted with the user's password).
pub async fn get_auth_params(
    headers: HeaderMap,
    Path(username): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // Per-IP rate limiting: 10 requests per minute.
    // Env-overridable for test suites (same pattern as LOGIN_IP_MAX): set
    // AUTH_PARAMS_IP_MAX=0 to disable, or a number to raise it.
    let ip = get_client_ip(&headers);
    let ip_rate_key = format!("auth_params_ip:{}", ip);
    let ip_max: u32 = std::env::var("AUTH_PARAMS_IP_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
    if ip_max > 0 && !AUTH_PARAMS_IP_RATE_LIMITER.check_and_increment(&ip_rate_key, ip_max, Duration::from_secs(60)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many requests. Try again in 1 minute."})),
        )
            .into_response();
    }

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
    /// Optional custom session lifetime in seconds (clamped server-side to
    /// [60s, 30 days]). Missing/None keeps the legacy 30-day default.
    #[serde(default)]
    pub duration_seconds: Option<u64>,
    // Device identity (Settings → Security → Devices).
    #[serde(default)]
    pub device_id: Option<String>,
    #[serde(default)]
    pub device_name: Option<String>,
}

#[derive(Deserialize)]
pub struct UploadNotificationSoundRequest {
    pub encrypted_sound: String,
    pub nonce: String,
    pub sender_public_key: String,
    pub file_name: Option<String>,          // legacy placeholder (migration 045 dropped the plaintext column) — display name lives in encrypted_file_name
    pub encrypted_file_name: Option<String>,  // AES-GCM encrypted with identity key
    pub file_name_nonce: Option<String>,      // AES-GCM nonce
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

    // Decrypt and re-encrypt file_name if encrypted_file_name is provided
    let encrypted_file_name_bytes = req.encrypted_file_name.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let file_name_nonce_bytes = req.file_name_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

    match state.db.save_notification_sound(&user_id, &encrypted_sound, &nonce, &sender_public_key, encrypted_file_name_bytes, file_name_nonce_bytes) {
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
        Ok(Some((encrypted_sound, nonce, sender_public_key, file_name, encrypted_file_name, file_name_nonce))) => {
            (StatusCode::OK, Json(serde_json::json!({
                "encrypted_sound": base64::engine::general_purpose::STANDARD.encode(&encrypted_sound),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&nonce),
                "sender_public_key": base64::engine::general_purpose::STANDARD.encode(&sender_public_key),
                "file_name": file_name,
                "encrypted_file_name": encrypted_file_name.map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "file_name_nonce": file_name_nonce.map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
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

// --- Ringtone Sync (encrypted ringtone for DM call ring) ---

#[derive(Deserialize)]
pub struct UploadRingtoneRequest {
    pub encrypted_sound: String,
    pub nonce: String,
    pub sender_public_key: String,
    pub encrypted_file_name: Option<String>,  // AES-GCM encrypted with identity key
    pub file_name_nonce: Option<String>,      // AES-GCM nonce
}

pub async fn upload_ringtone(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UploadRingtoneRequest>,
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

    let encrypted_file_name_bytes = req.encrypted_file_name.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let file_name_nonce_bytes = req.file_name_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

    match state.db.save_ringtone(&user_id, &encrypted_sound, &nonce, &sender_public_key, encrypted_file_name_bytes, file_name_nonce_bytes) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn get_ringtone(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.get_ringtone(&user_id) {
        Ok(Some((encrypted_sound, nonce, sender_public_key, encrypted_file_name, file_name_nonce))) => {
            (StatusCode::OK, Json(serde_json::json!({
                "encrypted_sound": base64::engine::general_purpose::STANDARD.encode(&encrypted_sound),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&nonce),
                "sender_public_key": base64::engine::general_purpose::STANDARD.encode(&sender_public_key),
                "encrypted_file_name": encrypted_file_name.map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "file_name_nonce": file_name_nonce.map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
            }))).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "No ringtone"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn delete_ringtone(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.delete_ringtone(&user_id) {
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

    // Per-IP rate limiting: 10 attempts per 5 minutes.
    // Env-overridable so automated test suites (which re-auth dozens of users
    // from one IP) can raise/disable the budget: REAUTH_IP_MAX=0 disables,
    // or a number raises it (same pattern as LOGIN_IP_MAX/LOGIN_USER_MAX).
    let ip = get_client_ip(&headers);
    let ip_rate_key = format!("reauth_ip:{}", ip);
    let ip_max: u32 = std::env::var("REAUTH_IP_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
    if ip_max > 0 && !REAUTH_IP_RATE_LIMITER.check_and_increment(&ip_rate_key, ip_max, Duration::from_secs(300)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many reauth attempts. Try again in 5 minutes."})),
        )
            .into_response();
    }

    // Per-user rate limiting: 10 attempts per 5 minutes (env-overridable).
    let rate_key = format!("reauth:{}", user_id);
    let user_max: u32 = std::env::var("REAUTH_USER_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
    if user_max > 0 && !REAUTH_RATE_LIMITER.check_and_increment(&rate_key, user_max, Duration::from_secs(300)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many reauth attempts. Try again in 5 minutes."})),
        )
            .into_response();
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

    // Client-computed hash (HMAC-SHA256) — constant-time comparison
    use subtle::ConstantTimeEq;
    let valid: bool = req.password.as_bytes().ct_eq(password_hash.as_bytes()).into();

    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Wrong password"})),
        )
            .into_response();
    }

    // Custom session duration chosen by the user in settings (clamped to
    // [1 minute, 30 days]). Missing/invalid falls back to 30 days.
    let duration_secs = session_duration_secs(req.duration_seconds);

    let token = match mint_session_token(
        &state,
        &user.id,
        &user.username,
        req.device_id.as_deref(),
        req.device_name.as_deref(),
        duration_secs,
    ) {
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
            &format!("token={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={}", token, duration_secs)
        ).unwrap(),
    );

    // Fetch profile picture only (display_name and other profile fields are now encrypted-only)
    let profile_pic = match state.db.get_user_profile(&user.id) {
        Ok((_, _, pp, pph, _, bh, _, _, _, _)) => (pp, pph, bh),
        Err(_) => (None, None, None),
    };

    (StatusCode::OK, headers, Json(serde_json::json!({
        "token": token,
        "user": {
            "id": user.id,
            "username": user.username,
            "profile_picture_file_id": profile_pic.0,
            "profile_picture_file_id_hash": profile_pic.1,
            "profile_banner_file_id_hash": profile_pic.2
        }
    }))).into_response()
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
    pub invite_code: String,
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

    let rate_key = format!("create_server:{}", user_id);
    if !CREATE_SERVER_RATE_LIMITER.check_and_increment(&rate_key, 5, Duration::from_secs(3600)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many servers created. Try again in 1 hour."})),
        )
            .into_response();
    }

    // Generate random salt and compute salted invite code hash
    use rand::Rng;
    let salt: String = rand::thread_rng().gen::<[u8; 16]>().iter().map(|b| format!("{:02x}", b)).collect();
    let code_upper = req.invite_code.trim().to_uppercase();
    let invite_code_hash = crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &format!("{}{}", salt, code_upper));

    let encrypted_name_bytes = req.encrypted_name.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let name_nonce_bytes = req.name_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let ch_enc_name_bytes = req.channel_encrypted_name.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let ch_name_nonce_bytes = req.channel_name_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

    let server = match state.db.create_server(&user_id, &invite_code_hash, &salt, encrypted_name_bytes.as_deref(), name_nonce_bytes.as_deref(), ch_enc_name_bytes.as_deref(), ch_name_nonce_bytes.as_deref()) {
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
                "owner_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &s.owner_id),
                "is_owner": is_owner,
                "joins_disabled": s.joins_disabled,
                "server_picture_file_id": s.server_picture_file_id,
                "server_picture_file_id_hash": s.server_picture_file_id_hash,
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
                "channel_type": c.channel_type,
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(channel_infos))).into_response()
}

#[derive(Deserialize)]
pub struct CreateChannelRequest {
    pub encrypted_name: Option<String>,
    pub name_nonce: Option<String>,
    #[serde(default)]
    pub channel_type: Option<String>,
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

    let ctype = req.channel_type.as_deref().unwrap_or("text");
    let channel = match state.db.create_channel(&server_id, encrypted_name_bytes.as_deref(), name_nonce_bytes.as_deref(), ctype) {
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
            "channel_type": channel.channel_type,
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
    pub invite_code: String,
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

    use rand::Rng;
    let salt: String = rand::thread_rng().gen::<[u8; 16]>().iter().map(|b| format!("{:02x}", b)).collect();
    let code_upper = req.invite_code.trim().to_uppercase();
    let invite_code_hash = crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &format!("{}{}", salt, code_upper));

    match state.db.regenerate_invite(&server_id, &user_id, &invite_code_hash, &salt) {
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

    let server = state.db.join_server_by_invite(code, &user_id, state.config.hmac_key.as_bytes());
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
        "user_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &user_id),
        "raw_user_id": user_id,
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
                "user_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &req.user_id),
                "raw_user_id": req.user_id,
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
                "user_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &user_id),
                "raw_user_id": user_id,
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
                "user_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &req.user_id),
                "raw_user_id": req.user_id,
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
    let before_id = params.get("before_id").map(|s| s.as_str());

    let messages = if let Some(ts) = before {
        match state.db.list_messages_before(&channel_id, ts, before_id, limit) {
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

    // Pinned message ids for this channel (metadata only — content stays encrypted)
    let pinned_ids = state.db.get_pinned_message_ids(&channel_id).unwrap_or_default();

    let message_infos: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "sender_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &m.sender_id),
                "sender_user_id": m.sender_id,
                "sender_id_hash": m.sender_id_hash,
                "encrypted_sender_username": m.encrypted_sender_username,
                "sender_username_nonce": m.sender_username_nonce,

                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                "timestamp": m.timestamp,
                "edited_at": m.edited_at,
                "key_version": m.key_version,
                "encrypted_profile_snapshot": m.encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "profile_snapshot_nonce": m.profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),

                "pinned": pinned_ids.iter().any(|pid| pid == &m.id),

                "conversation_profile": conv_profiles.get(&m.sender_id).map(|(data, nonce)| serde_json::json!({
                    "encrypted_profile_data": data,
                    "nonce": nonce,
                })),
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(message_infos))).into_response()
}

/// List pinned messages for a server channel. Returns the full encrypted message
/// rows (same shape as list_messages) so the client can decrypt + render them;
/// the server only ever stores/returns pin metadata + ciphertext.
pub async fn list_channel_pins(
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
        Err(e) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": e}))).into_response(),
    };
    if !state.db.is_member_of_server(&user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not a member of this server"}))).into_response();
    }
    let messages = match state.db.get_pinned_messages(&channel_id) {
        Ok(m) => m,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let mut sender_ids: Vec<&str> = messages.iter().map(|m| m.sender_id.as_str()).collect();
    sender_ids.dedup();
    let conv_profiles = state.db.get_conversation_profiles_batch("channel", &server_id, &sender_ids).unwrap_or_default();
    let message_infos: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "sender_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &m.sender_id),
                "sender_user_id": m.sender_id,
                "sender_id_hash": m.sender_id_hash,
                "encrypted_sender_username": m.encrypted_sender_username,
                "sender_username_nonce": m.sender_username_nonce,
                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                "timestamp": m.timestamp,
                "edited_at": m.edited_at,
                "key_version": m.key_version,
                "encrypted_profile_snapshot": m.encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "profile_snapshot_nonce": m.profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "pinned": true,
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

    // Pinned ids so a jump-to-pin (which loads messages around a target) still
    // renders the 📌 badge on the pinned message.
    let pinned_ids2 = state.db.get_pinned_message_ids(&channel_id).unwrap_or_default();

    let message_infos: Vec<serde_json::Value> = messages
        .iter()
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "sender_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &m.sender_id),
                "sender_user_id": m.sender_id,
                "sender_id_hash": m.sender_id_hash,
                "encrypted_sender_username": m.encrypted_sender_username,
                "sender_username_nonce": m.sender_username_nonce,

                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                "timestamp": m.timestamp,
                "edited_at": m.edited_at,
                "key_version": m.key_version,
                "encrypted_profile_snapshot": m.encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "profile_snapshot_nonce": m.profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),

                "pinned": pinned_ids2.iter().any(|pid| pid == &m.id),

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

// --- Voice: TURN server config (WebRTC calls behind strict NAT) ---

/// Authenticated endpoint serving the configured TURN servers to logged-in
/// clients so WebRTC calls can traverse strict NATs (STUN-only fails there).
/// Returns `{ "urls": [...], "username": ..., "credential": ... }` — or
/// `{ "urls": [] }` when no TURN is configured (client stays STUN-only).
pub async fn get_turn_config(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let _user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let mut body = serde_json::json!({
        "urls": state.config.turn_urls,
    });
    if let Some(u) = &state.config.turn_username {
        body["username"] = serde_json::Value::String(u.clone());
    }
    if let Some(p) = &state.config.turn_password {
        body["credential"] = serde_json::Value::String(p.clone());
    }
    (StatusCode::OK, Json(body)).into_response()
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

    match state.db.save_server_key(&server_id, &req.user_id, &encrypted_key, &sender_pub, &nonce) {
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
        "server_picture_file_id_hash": crate::db::sha256_hex(&req.server_picture_file_id),
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

pub async fn admin_logout(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // Extract the admin token from the Authorization header
    let token = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer ").map(|s| s.to_string()));

    if let Some(t) = token {
        let mut guard = get_admin_tokens();
        if let Some(map) = guard.as_mut() {
            map.remove(&t);
        }
    }

    log_admin_action(&state, "admin_logout", None, &headers);

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

pub async fn admin_login(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<AdminLoginRequest>,
) -> impl IntoResponse {
    // Per-IP rate limiting: 10 attempts per 5 minutes
    let ip = get_client_ip(&headers);
    let ip_rate_key = format!("admin_login_ip:{}", ip);
    if !ADMIN_LOGIN_IP_RATE_LIMITER.check_and_increment(&ip_rate_key, 10, Duration::from_secs(300)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many admin login attempts. Try again in 5 minutes."})),
        )
            .into_response();
    }

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
        log_admin_action(&state, "admin_setup", None, &headers);
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
        log_admin_action(&state, "admin_login", None, &headers);
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
        .map(|(id, username, _pw_hash, created_at, _display_name, identity_public_key, profile_picture_file_id, friend_requests_disabled, encrypted_friend_code, friend_code_salt, friend_code_nonce, encrypted_profile_data, encrypted_profile_salt, encrypted_profile_nonce, profile_banner_file_id, _description, _nickname, friend_code_hash, encrypted_hash_key, hash_key_salt, hash_key_nonce)| {
            serde_json::json!({
                "id": id,
                "username": username,
                "created_at": created_at,
                "identity_public_key": if identity_public_key.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(identity_public_key.clone()) },
                "profile_picture_file_id": profile_picture_file_id,
                "friend_requests_disabled": *friend_requests_disabled != 0,
                "encrypted_friend_code": encrypted_friend_code,
                "friend_code_salt": friend_code_salt,
                "friend_code_nonce": friend_code_nonce,
                "encrypted_profile_data": encrypted_profile_data,
                "encrypted_profile_salt": encrypted_profile_salt,
                "encrypted_profile_nonce": encrypted_profile_nonce,
                "profile_banner_file_id": profile_banner_file_id,
                "friend_code_hash": friend_code_hash,
                "encrypted_hash_key": encrypted_hash_key,
                "hash_key_salt": hash_key_salt,
                "hash_key_nonce": hash_key_nonce,
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
        Ok(()) => {
            log_admin_action(&state, "admin_delete_user", Some(&user_id), &headers);
            (
                StatusCode::OK,
                Json(serde_json::json!({"ok": true})),
            )
        }
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
                "encrypted_name": s.encrypted_name.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                "name_nonce": s.name_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                "server_picture_file_id": s.server_picture_file_id,
                "server_picture_file_id_hash": s.server_picture_file_id_hash,
                "encrypted_server_picture_key": s.encrypted_server_picture_key.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                "server_picture_key_nonce": s.server_picture_key_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
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
                "encrypted_name": c.encrypted_name.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                "name_nonce": c.name_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
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
                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                "timestamp": m.timestamp,
                "edited_at": m.edited_at,
                "key_version": m.key_version,
                "sender_id_hash": m.sender_id_hash,
                "encrypted_profile_snapshot": m.encrypted_profile_snapshot.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                "profile_snapshot_nonce": m.profile_snapshot_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
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
        .map(|(sid, sname, uid, ek, spk, nonce, ver, ts)| {
            serde_json::json!({
                "server_id": sid,
                "server_name": sname,
                "user_id": uid,
                "encrypted_key": base64::engine::general_purpose::STANDARD.encode(ek),
                "sender_public_key": base64::engine::general_purpose::STANDARD.encode(spk),
                "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
                "version": ver,
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, dm_id, sid, sname, enc, nonce, ts, kv, snap, snap_nonce, sender_id_hash)| {
        serde_json::json!({
            "id": id, "dm_channel_id": dm_id,
            "sender_id": sid, "sender_username": sname,
            "encrypted_content": base64::engine::general_purpose::STANDARD.encode(enc),
            "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
            "timestamp": ts,
            "key_version": kv,
            "sender_id_hash": sender_id_hash,
            "encrypted_profile_snapshot": snap.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
            "profile_snapshot_nonce": snap_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(dm_id, uid, uname, ek, spk, nonce, created_at)| {
        serde_json::json!({
            "dm_channel_id": dm_id, "user_id": uid, "username": uname,
            "encrypted_key": base64::engine::general_purpose::STANDARD.encode(ek),
            "sender_public_key": base64::engine::general_purpose::STANDARD.encode(spk),
            "nonce": base64::engine::general_purpose::STANDARD.encode(nonce),
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, uid, uname, name, mime, size, file_id_hash, ts, chunk_count, upload_complete, enc_mime, mime_nonce)| {
        serde_json::json!({
            "id": id, "uploader_id": uid, "uploader_username": uname,
            "original_name": name, "mime_type": mime, "file_size": size,
            "file_id_hash": file_id_hash, "created_at": ts,
            "chunk_count": chunk_count, "upload_complete": *upload_complete != 0,
            "encrypted_mime_type": enc_mime.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
            "mime_nonce": mime_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
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
        Ok(()) => {
            log_admin_action(&state, "admin_delete_server", Some(&server_id), &headers);
            (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
        }
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
        Ok(()) => {
            log_admin_action(&state, "admin_delete_channel", Some(&channel_id), &headers);
            (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
        }
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
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, uid, uname, fid, mime, ekey, eknonce, created_at, enc_name, name_nonce)| {
        serde_json::json!({
            "id": id, "user_id": uid, "username": uname,
            "file_id": fid,
            "mime_type": mime,
            "created_at": created_at,
            "encrypted_file_key": ekey.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
            "file_key_nonce": eknonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
            "encrypted_sticker_name": enc_name.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
            "sticker_name_nonce": name_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
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


/// GET /api/admin/audit-log — append-only record of admin actions (G4).
/// Never contains tokens or passwords. Newest first.
pub async fn admin_audit_log(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }
    let rows = match state.db.list_admin_audit(1000) {
        Ok(r) => r,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    };
    let result: Vec<serde_json::Value> = rows
        .into_iter()
        .map(|(id, ts, actor, action, target, ip)| {
            serde_json::json!({
                "id": id,
                "timestamp": ts,
                "actor": actor,
                "action": action,
                "target": target,
                "ip": ip,
            })
        })
        .collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

/// Append an admin action to the audit log. Best-effort: an audit-log failure
/// never fails the admin request itself.
fn log_admin_action(state: &AppState, action: &str, target: Option<&str>, headers: &HeaderMap) {
    let ip = get_client_ip(headers);
    if let Err(e) = state.db.log_admin_action("admin", action, target, &ip) {
        tracing::warn!("Failed to write admin audit entry ({}): {}", action, e);
    }
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
            log_admin_action(&state, "admin_clear_all", None, &headers);
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

pub async fn admin_list_pending_events(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }
    let rows = match state.db.list_all_pending_events_admin() {
        Ok(r) => r,
        Err(e) => { return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(); }
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, user_id, server_id, event_type, affected_user_id)| {
        serde_json::json!({"id": id, "user_id": user_id, "server_id": server_id, "event_type": event_type, "affected_user_id": affected_user_id})
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_pending_notifications(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }
    let rows = match state.db.list_all_pending_notifications_admin() {
        Ok(r) => r,
        Err(e) => { return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(); }
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, user_id, notification_type, payload)| {
        serde_json::json!({"id": id, "user_id": user_id, "notification_type": notification_type, "payload": payload})
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_voice_sessions(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_voice_sessions_admin() {
        Ok(r) => r, Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, channel_id, started_at, ended_at)| {
        serde_json::json!({"id": id, "channel_id": channel_id, "started_at": started_at, "ended_at": ended_at})
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_voice_participants(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_voice_participants_admin() {
        Ok(r) => r, Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(vsid, uid, joined, left, muted, deaf, cam, sharing)| {
        serde_json::json!({"voice_session_id": vsid, "user_id": uid, "joined_at": joined, "left_at": left, "is_muted": *muted != 0, "is_deafened": *deaf != 0, "is_camera_on": *cam != 0, "is_screen_sharing": *sharing != 0})
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_user_media(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_user_media_admin() {
        Ok(r) => r, Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, uname, fid, ekey, eph, nonce, mtype, created)| {
        serde_json::json!({"id": id, "username": uname, "file_id": fid, "encrypted_file_key": ekey.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)), "eph_pub": eph.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)), "nonce": nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)), "media_type": mtype, "created_at": created})
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_user_key_blobs(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_user_key_blobs_admin() {
        Ok(r) => r, Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(uname, uid, blob, salt, nonce)| {
        serde_json::json!({"username": uname, "user_id": uid, "encrypted_blob": blob, "salt": salt, "nonce": nonce})
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_profile_data_keys(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_profile_data_keys_admin() {
        Ok(r) => r, Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(uname, uid, ekey, nonce)| {
        serde_json::json!({"username": uname, "user_id": uid, "encrypted_key": ekey, "nonce": nonce})
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

pub async fn admin_list_shared_profile_data_keys(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) { return e.into_response(); }
    let rows = match state.db.list_all_shared_profile_data_keys_admin() {
        Ok(r) => r, Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let result: Vec<serde_json::Value> = rows.iter().map(|(id, uname, oid, ttype, tid, ekey)| {
        serde_json::json!({"id": id, "username": uname, "owner_user_id": oid, "target_type": ttype, "target_id": tid, "encrypted_key": ekey})
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

/// GET /api/admin/export-db — downloads the entire SQLite database file
pub async fn admin_export_db(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }
    let db_path = &state.config.database_url;
    // Checkpoint WAL before reading to ensure all pending writes are flushed
    // to the main database file, so the export includes all data.
    if let Err(e) = state.db.wal_checkpoint() {
        tracing::warn!("WAL checkpoint before export failed (non-fatal): {}", e);
    }
    match tokio::fs::read(db_path).await {
        Ok(data) => {
            log_admin_action(&state, "admin_export_db", None, &headers);
            let mut resp_headers = HeaderMap::new();
            resp_headers.insert("content-type", HeaderValue::from_static("application/x-sqlite3"));
            resp_headers.insert("content-disposition", HeaderValue::from_str("attachment; filename=\"e2e_chat.db\"").unwrap());
            (StatusCode::OK, resp_headers, axum::body::Body::from(data)).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Failed to read database: {}", e)}))).into_response(),
    }
}

/// POST /api/admin/import-db — upload a SQLite database file to replace the current one
pub async fn admin_import_db(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }
    if body.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Empty database file"}))).into_response();
    }
    if body.len() < 16 || &body[..16] != b"SQLite format 3\x00" {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "File does not appear to be a valid SQLite database"}))).into_response();
    }
    let db_path = state.config.database_url.clone();

    // Step 1: Checkpoint the old WAL so all pending writes flush to the main DB file.
    // This prevents stale WAL entries from corrupting the imported database.
    if let Err(e) = state.db.wal_checkpoint() {
        tracing::warn!("WAL checkpoint before import failed (non-fatal): {}", e);
    }

    // Step 2: Write the new database file
    match tokio::fs::write(&db_path, &body).await {
        Ok(()) => {
            // Step 3: Delete stale WAL and SHM files that belonged to the OLD database.
            // If we don't delete them, SQLite's WAL replay on the new connection
            // will roll forward stale data into the freshly imported database.
            if let Err(e) = tokio::fs::remove_file(format!("{}-wal", db_path)).await {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!("Failed to remove stale -wal file: {}", e);
                }
            }
            if let Err(e) = tokio::fs::remove_file(format!("{}-shm", db_path)).await {
                if e.kind() != std::io::ErrorKind::NotFound {
                    tracing::warn!("Failed to remove stale -shm file: {}", e);
                }
            }

            // Step 4: Reconnect to the new database
            match state.db.reconnect(&db_path) {
                Ok(()) => {
                    log_admin_action(&state, "admin_import_db", None, &headers);
                    state.setup_complete.store(true, std::sync::atomic::Ordering::Relaxed);
                    let mut guard = get_admin_tokens();
                    *guard = None;
                    (StatusCode::OK, Json(serde_json::json!({"ok": true, "message": "Database imported. Please re-login."}))).into_response()
                }
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Written but reconnect failed: {}", e)}))).into_response(),
            }
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Failed: {}", e)}))).into_response(),
    }
}

// ===== Phase 5: File Sharing =====

const MAX_FILE_SIZE: i64 = 10 * 1024 * 1024 * 1024; // 10 GB
const UPLOAD_DIR: &str = "uploads";

#[derive(Deserialize)]
pub struct InitFileUploadRequest {
    pub size: i64,
    pub encrypted_mime: Option<String>,  // AES-GCM encrypted mime_type, base64 encoded
    pub mime_nonce: Option<String>,      // AES-GCM nonce, base64 encoded
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
            Json(serde_json::json!({"error": "File too large"})),
        )
            .into_response();
    }

    // G2 storage quota: reject the init if the user would exceed their cap.
    // Env-overridable for tests: FILE_STORAGE_QUOTA_BYTES (0 disables).
    let quota: i64 = std::env::var("FILE_STORAGE_QUOTA_BYTES")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(1024 * 1024 * 1024); // 1 GiB default
    if quota > 0 {
        let used = state.db.get_user_storage_usage(&user_id).unwrap_or(0);
        if used + req.size > quota {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({"error": "Storage quota exceeded"})),
            )
                .into_response();
        }
    }

    // G5: the encrypted mime blob + nonce are small ciphertexts; cap their
    // decoded size so a garbage payload can't bloat the files table.
    if let Some(s) = &req.encrypted_mime {
        if let Ok(b) = base64::engine::general_purpose::STANDARD.decode(s) {
            if b.len() > 1024 {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "encrypted_mime too large"}))).into_response();
            }
        } else {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid encrypted_mime"}))).into_response();
        }
    }
    if let Some(s) = &req.mime_nonce {
        if let Ok(b) = base64::engine::general_purpose::STANDARD.decode(s) {
            if b.len() > 64 {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "mime_nonce too large"}))).into_response();
            }
        } else {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid mime_nonce"}))).into_response();
        }
    }

    // Decode optional encrypted mime type
    let encrypted_mime_bytes = req.encrypted_mime.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let mime_nonce_bytes = req.mime_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

    match state.db.create_file_record(&user_id, req.size, encrypted_mime_bytes.as_deref(), mime_nonce_bytes.as_deref()) {
        Ok((file_id, _file_hash)) => {
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

/// Download a file by its SHA-256 hash (instead of raw file_id UUID).
/// This prevents the host from learning which file_id corresponds to which user's
/// profile picture or banner — only the hashed version is exposed via API responses.
pub async fn download_file_by_hash(
    Path(hash): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Look up the file_id by hash from the users table (profile pics/banners),
    // then fall back to the files table (message attachments, stickers, etc.)
    let file_id = match state.db.get_file_id_by_hash(&hash) {
        Ok(fid) => fid,
        Err(_) => match state.db.get_file_id_by_hash_from_files(&hash) {
            Ok(fid) => fid,
            Err(_) => {
                return (
                    StatusCode::NOT_FOUND,
                    Json(serde_json::json!({"error": "File not found by hash"})),
                )
                    .into_response()
            }
        }
    };

    // Now serve the file using the resolved file_id (same logic as download_file)
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

// ===== User Stickers/GIFs =====

#[derive(Deserialize)]
pub struct AddUserStickerRequest {
    pub file_id: String,
    pub encrypted_mime_type: Option<String>, // AES-GCM encrypted with the sticker's file key
    pub mime_nonce: Option<String>,          // AES-GCM nonce for encrypted_mime_type
    pub encrypted_file_key: Option<String>,
    pub file_key_nonce: Option<String>,
    pub encrypted_sticker_name: Option<String>,
    pub sticker_name_nonce: Option<String>,
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
                .map(|(id, file_id, _file_id_hash, mime, enc_mime, mime_nonce, ekey, eknounce, enc_name, name_nonce)| {
                    serde_json::json!({
                        "id": id,
                        "file_id": file_id,
                        "mime_type": mime,
                        "encrypted_mime_type": enc_mime.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                        "mime_nonce": mime_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                        "encrypted_file_key": ekey.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                        "file_key_nonce": eknounce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                        "encrypted_sticker_name": enc_name.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                        "sticker_name_nonce": name_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
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
    // Decode encrypted_mime_type and mime_nonce if provided (mime is never stored plaintext)
    let enc_mime_bytes = body.encrypted_mime_type.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let mime_nonce_bytes = body.mime_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    // Decode encrypted_file_key and file_key_nonce if provided
    let encrypted_key_bytes = body.encrypted_file_key.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let key_nonce_bytes = body.file_key_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    // Decode encrypted_sticker_name if provided
    let enc_name_bytes = body.encrypted_sticker_name.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let name_nonce_bytes = body.sticker_name_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

    match state.db.add_user_sticker(&user_id, &body.file_id, enc_mime_bytes.as_deref(), mime_nonce_bytes.as_deref(), encrypted_key_bytes.as_deref(), key_nonce_bytes.as_deref(), enc_name_bytes.as_deref(), name_nonce_bytes.as_deref()) {
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
    pub remove_picture: Option<bool>,
    pub remove_banner: Option<bool>,
    pub profile_picture_file_id: Option<String>,
    // Encrypted file keys (AES-GCM with identity key) — no plaintext keys accepted
    pub encrypted_pic_key: Option<String>,
    pub pic_key_nonce: Option<String>,
    pub profile_banner_file_id: Option<String>,
    pub encrypted_banner_key: Option<String>,
    pub banner_key_nonce: Option<String>,
    // Encrypted profile — all profile fields inside this encrypted blob
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
    let _authorized_for_keys = is_own_profile
        || state.db.are_friends(&caller_id, &requested_id).unwrap_or(false)
        || state.db.share_server(&caller_id, &requested_id).unwrap_or(false);

    match state.db.get_user_profile(&requested_id) {
        Ok((id, username, profile_picture_file_id, _pph, banner_id, _banner_hash, enc_pic_key, pic_key_nonce, enc_banner_key, banner_key_nonce)) => {
            let encrypted = state.db.get_encrypted_profile(&requested_id).ok().flatten();
            (StatusCode::OK, Json(serde_json::json!({
                "id": id,
                "username": username,
                "profile_picture_file_id": profile_picture_file_id,
                // Return encrypted file keys (AES-GCM with user's identity key)
                "encrypted_pic_key": enc_pic_key.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                "pic_key_nonce": pic_key_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                "profile_banner_file_id": banner_id,
                "encrypted_banner_key": enc_banner_key.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                "banner_key_nonce": banner_key_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
                // All profile metadata inside encrypted_profile_data
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

    // Before changing profile picture, delete the old one's file from DB and disk.
    // IMPORTANT: the client re-sends the unchanged picture/banner id on every save
    // (the crop globals persist across saves in the same session). Deleting the file
    // record for a file_id that is ABOUT to be re-assigned breaks the FK constraint
    // (profile_picture_file_id REFERENCES files(id)) and fails the whole PATCH — which
    // is exactly how a banner update silently failed. Only delete when the new file
    // id actually differs from the current one.
    let delete_current_pic = |keep_id: Option<&str>| -> Result<(), String> {
        let (_, _, old_file_id, _, _, _, _, _, _, _) = state.db.get_user_profile(&user_id)?;
        if let Some(old_id) = old_file_id {
            if let Some(k) = keep_id {
                if k == old_id {
                    // Same file id re-sent — do NOT delete the file record we're about to re-set.
                    return Ok(());
                }
            }
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
        let _ = delete_current_pic(None);
        if let Err(e) = state.db.update_profile_picture(&user_id, None, None, None) {
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
        // MIME type check skipped — mime_type is encrypted, so the server cannot validate it.
    // The client is expected to only send image files for profile pictures.
        
        // Verify ownership
        if file_info.uploader_id != user_id {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not your file"}))).into_response();
        }
        // Delete old profile pic before setting new one — but only when it's a
        // DIFFERENT file than the one being set (re-sent unchanged ids must not
        // delete the file record we're about to re-assign → FK violation).
        let _ = delete_current_pic(Some(file_id));
        let enc_key = req.encrypted_pic_key.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
        let key_nonce = req.pic_key_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
        if let Err(e) = state.db.update_profile_picture(&user_id, Some(file_id), enc_key.as_deref(), key_nonce.as_deref()) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    }

    // Description, nickname, display_name, username_color, username_border_color,
    // and profile_background_color are NO LONGER accepted as plaintext fields.
    // All profile data must be inside encrypted_profile_data.

    // Handle profile banner removal
    if req.remove_banner.unwrap_or(false) {
        if let Err(e) = state.db.update_profile_banner(&user_id, None, None, None) {
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
        // MIME type check skipped — mime_type is encrypted, so the server cannot validate it.
        // The client is expected to only send image files for banners.
        
        if file_info.uploader_id != user_id {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not your file"}))).into_response();
        }
        let enc_banner_key = req.encrypted_banner_key.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
        let banner_key_nonce = req.banner_key_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
        if let Err(e) = state.db.update_profile_banner(&user_id, Some(banner_file_id), enc_banner_key.as_deref(), banner_key_nonce.as_deref()) {
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
        let (_id, username, profile_picture_file_id, _pph, banner_id, _banner_hash, enc_pic_key, pic_key_nonce, enc_banner_key, banner_key_nonce) = profile;
        let encrypted = state.db.get_encrypted_profile(&user_id).ok().flatten();
        let profile_updated_at = state.db.get_profile_updated_at(&user_id).ok();
        let profile_msg = serde_json::json!({
            "type": "profile_updated",
            "user_id": user_id,
            "username": username,
            "profile_picture_file_id": profile_picture_file_id,
            "profile_picture_file_id_hash": _pph,
            "encrypted_pic_key": enc_pic_key.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
            "pic_key_nonce": pic_key_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
            "profile_banner_file_id": banner_id,
            "profile_banner_file_id_hash": _banner_hash,
            "encrypted_banner_key": enc_banner_key.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
            "banner_key_nonce": banner_key_nonce.as_ref().map(|b| base64::engine::general_purpose::STANDARD.encode(b)),
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
    // E2EE-safe field-presence metadata. The server cannot see inside the
    // ciphertext, so the client reports which banner/PFP file ids it is
    // uploading (file ids are already server-visible in the users table, so
    // nothing new leaks). authoritative=true means the user explicitly saved
    // their profile (removals included); everything else is a background
    // re-upload and must never DROP fields a previous upload or the users
    // table still has — that is how a stale device silently erased another
    // user's banner for everyone else.
    #[serde(default)]
    pub authoritative: Option<bool>,
    #[serde(default)]
    pub profile_picture_file_id: Option<String>,
    #[serde(default)]
    pub profile_banner_file_id: Option<String>,
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

    // Normalize empty-string claims to None (the client sends null or a real id).
    let claim_pfp = req.profile_picture_file_id.as_deref().filter(|s| !s.is_empty()).map(|s| s.to_string());
    let claim_banner = req.profile_banner_file_id.as_deref().filter(|s| !s.is_empty()).map(|s| s.to_string());
    let is_authoritative = req.authoritative.unwrap_or(false);

    if !is_authoritative {
        // Authoritative banner/PFP per the users table (only updated by
        // PATCH /api/profile — the one place removals can be expressed).
        let (_, _, auth_pfp, _, auth_banner, _, _, _, _, _) = match state.db.get_user_profile(&user_id) {
            Ok(p) => p,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
        };
        // What the previous upload of THIS conversation profile carried (if any).
        let stored = state.db.get_conversation_profile_meta(&user_id, &req.conversation_type, &req.conversation_id).unwrap_or(None);
        let stored_pfp = stored.as_ref().and_then(|(p, _)| p.clone());
        let stored_banner = stored.as_ref().and_then(|(_, b)| b.clone());

        // Drop guard: a background re-upload must never remove a field the
        // user currently has (users table) or that this conversation profile
        // previously carried.
        let drops_pfp = claim_pfp.is_none() && (auth_pfp.is_some() || stored_pfp.is_some());
        let drops_banner = claim_banner.is_none() && (auth_banner.is_some() || stored_banner.is_some());
        // Re-add guard: a background re-upload must never resurrect a field
        // the user no longer has anywhere (users table AND previous upload).
        let readds_pfp = claim_pfp.is_some() && auth_pfp.is_none() && stored_pfp.is_none();
        let readds_banner = claim_banner.is_some() && auth_banner.is_none() && stored_banner.is_none();

        if drops_pfp || drops_banner || readds_pfp || readds_banner {
            return (StatusCode::CONFLICT, Json(serde_json::json!({
                "error": "conversation profile upload would change pic/banner field presence outside an explicit profile save; rejected"
            }))).into_response();
        }
    }

    match state.db.upsert_conversation_profile(&user_id, &req.conversation_type, &req.conversation_id, &req.encrypted_profile_data, &req.nonce, claim_pfp.as_deref(), claim_banner.as_deref()) {
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
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // PUBLIC endpoint — no auth required.
    // The HMAC key is used by clients to hash friend codes and invite codes
    // during registration (before the user has a token).
    // Rate limited per-IP to prevent offline brute-force of friend codes.
    // Env-overridable for test suites (same pattern as LOGIN_IP_MAX): set
    // HMAC_KEY_IP_MAX=0 to disable, or a number to raise it.
    let ip = get_client_ip(&headers);
    let rate_key = format!("hmac_key:{}", ip);
    let ip_max: u32 = std::env::var("HMAC_KEY_IP_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(6);
    if ip_max > 0 && !HMAC_KEY_RATE_LIMITER.check_and_increment(&rate_key, ip_max, Duration::from_secs(60)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many requests. Try again later."})),
        )
            .into_response();
    }
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

    use rand::Rng;
    let hash_salt: String = rand::thread_rng().gen::<[u8; 16]>().iter().map(|b| format!("{:02x}", b)).collect();
    let code_upper = req.friend_code.trim().to_uppercase();
    let hash = crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &format!("{}{}", hash_salt, code_upper));

    match state.db.update_encrypted_friend_code(&user_id, &hash, &hash_salt, &req.encrypted_friend_code, &req.salt, &req.nonce) {
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

    let salt: String = rand::thread_rng().gen::<[u8; 16]>().iter().map(|b| format!("{:02x}", b)).collect();
    let hash = crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &format!("{}{}", salt, code));
    match state.db.update_friend_code_hash(&user_id, &hash, &salt) {
        Ok(()) => {
            // The server cannot re-encrypt the code without the user's password,
            // so clear the stale encrypted backup. Otherwise a later login would
            // restore the OLD code (which no longer matches this hash) and the
            // displayed code would silently not resolve to the user.
            let _ = state.db.clear_encrypted_friend_code(&user_id);
            (StatusCode::OK, Json(serde_json::json!({"ok": true, "friend_code": code}))).into_response()
        }
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

    use rand::Rng;
    let hash_salt: String = rand::thread_rng().gen::<[u8; 16]>().iter().map(|b| format!("{:02x}", b)).collect();
    let hash = crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &format!("{}{}", hash_salt, code));

    match state.db.update_encrypted_friend_code(&user_id, &hash, &hash_salt, &req.encrypted_friend_code, &req.salt, &req.nonce) {
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
    pub disabled_hash: String,
}

pub async fn get_friend_requests_disabled(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Fetch the hash and derive the boolean from it
    match state.db.get_friend_requests_disabled_hash(&user_id) {
        Ok(Some(h)) if !h.is_empty() => {
            let disabled_variant = hmac_sha256_hex(state.config.hmac_key.as_bytes(), &format!("{}:fr_disabled:1", user_id));
            let disabled = h == disabled_variant;
            (StatusCode::OK, Json(serde_json::json!({"friend_requests_disabled": disabled}))).into_response()
        }
        _ => {
            // Legacy fallback to plaintext column
            match state.db.get_friend_requests_disabled(&user_id) {
                Ok(disabled) => (StatusCode::OK, Json(serde_json::json!({"friend_requests_disabled": disabled}))).into_response(),
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
            }
        }
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

    // Derive the boolean from the hash by computing both HMAC variants
    let disabled_variant = hmac_sha256_hex(state.config.hmac_key.as_bytes(), &format!("{}:fr_disabled:1", user_id));
    let is_disabled = req.disabled_hash == disabled_variant;

    match state.db.set_friend_requests_disabled(&user_id, &req.disabled_hash, is_disabled) {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({"ok": true, "friend_requests_disabled": is_disabled})),
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

    // Per-IP rate limiting: 10 friend request attempts per 10 minutes.
    // Env-overridable so automated test suites (which hit localhost from one
    // IP for dozens of users) can raise/disable the budget: set
    // FRIEND_REQUEST_IP_MAX=0 to disable, or a number to raise it.
    let ip_max: u32 = std::env::var("FRIEND_REQUEST_IP_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
    let ip = get_client_ip(&headers);
    let ip_rate_key = format!("friend_request_ip:{}", ip);
    if ip_max > 0 && !FRIEND_REQUEST_IP_RATE_LIMITER.check_and_increment(&ip_rate_key, ip_max, Duration::from_secs(600)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many friend request attempts. Try again in 10 minutes."})),
        )
            .into_response();
    }

    // Per-user rate limiting (already existed). Env-overridable for tests.
    let user_max: u32 = std::env::var("FRIEND_REQUEST_USER_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
    let rate_key = format!("friend_request:{}", user_id);
    if user_max > 0 && !FRIEND_REQUEST_RATE_LIMITER.check_and_increment(&rate_key, user_max, Duration::from_secs(600)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many friend request attempts. Try again in 10 minutes."})),
        )
            .into_response();
    }

    // Look up target user by raw friend code
    let target_user = match state.db.get_user_by_friend_code(&req.friend_code, state.config.hmac_key.as_bytes()) {
        Ok(u) => u,
        Err(e) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };
    let recipient_disabled = match state.db.get_friend_requests_disabled_hash(&target_user.id) {
        Ok(Some(h)) if !h.is_empty() => {
            let disabled_variant = hmac_sha256_hex(state.config.hmac_key.as_bytes(), &format!("{}:fr_disabled:1", target_user.id));
            h == disabled_variant
        }
        _ => false,
    };
    let friend_request_result = state.db.create_friend_request(&user_id, &target_user.id, &target_user.username, recipient_disabled);
    match friend_request_result {
        Ok(target) => {
            // Notify the recipient in real time (best-effort). No username included — client resolves from user_id.
            let notify = serde_json::json!({
                "type": "friend_request_received",
                "from_user_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &user_id),
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
                    "to": { "id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &target.id), "username": target.username },
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
                "by_user_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &user_id),
                "from_user_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &from_id),
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
                        "from_user_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &r.from_user_id),
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
                        "to_user_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &r.to_user_id),
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
                .map(|f| serde_json::json!({ "id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &f.user_id), "username": f.username }))
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
    // Unfriending removes the DM channel, so any active DM call or waiting
    // room between the two users must end too — otherwise the room lingers
    // forever with no way back in. find_dm_channel + get_dm_members MUST run
    // BEFORE remove_friend (which deletes the channel and its members).
    let dm_between = state.db.find_dm_channel(&user_id, &req.user_id).ok().flatten();
    let dm_members = match &dm_between {
        Some(id) => state.db.get_dm_members(id).unwrap_or_default(),
        None => Vec::new(),
    };
    match state.db.remove_friend(&user_id, &req.user_id) {
        Ok(()) => {
            if let Some(dm_id) = dm_between {
                crate::ws::end_dm_call_between(&state, &dm_id, &dm_members).await;
            }
            // Notify both users that the friendship was removed
            // Include both the caller and the other user for multi-tab consistency
            let notify = serde_json::json!({
                "type": "friend_removed",
                "by_user_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &user_id),
                "raw_by_user_id": user_id,
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
            for (dm_id, other_id, other_username, _other_display_name, _other_profile_pic) in channels {
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
                    }),
                    None => serde_json::Value::Null,
                };
                // Who is waiting in a DM call for this channel, if anyone — lets
                // the client show a persistent "waiting for you to join" banner
                // in the DM chat that survives page refreshes.
                let waiting_user_id = state.db.get_dm_call_waiting(&dm_id).unwrap_or(None);
                let waiting_username = match &waiting_user_id {
                    Some(uid) => state.db.get_user_by_id(uid).map(|u| u.username).unwrap_or_default(),
                    None => String::new(),
                };
                result.push(serde_json::json!({
                    "dm_channel_id": dm_id,
                    "other_user_id": other_id,
                    "other_username": other_username,
                    // other_display_name removed — now in encrypted profile data
                    "other_public_key": identity_pub,
                    "last_message": last_json,
                    "waiting_user_id": waiting_user_id,
                    "waiting_username": if waiting_user_id.is_some() { waiting_username } else { String::new() },
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
    let before_id = params.get("before_id").map(|s| s.as_str());

    let msgs = if let Some(ts) = before {
        match state.db.list_dm_messages_before(&dm_channel_id, ts, before_id, limit) {
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

            let dm_pinned_ids = state.db.get_pinned_dm_message_ids(&dm_channel_id).unwrap_or_default();

            let result: Vec<serde_json::Value> = msgs
                .iter()
                .map(|m| {
                    serde_json::json!({
                        "id": m.id,
                        "dm_channel_id": m.dm_channel_id,
                        "sender_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &m.sender_id),
                        "sender_user_id": m.sender_id,
                        "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                        "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                        "timestamp": m.timestamp,
                        "edited_at": m.edited_at,
                        "key_version": m.key_version,
                        "encrypted_profile_snapshot": m.encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                        "profile_snapshot_nonce": m.profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                        "sender_id_hash": m.sender_id_hash,
                        "encrypted_sender_username": m.encrypted_sender_username,
                        "sender_username_nonce": m.sender_username_nonce,
                        "pinned": dm_pinned_ids.iter().any(|pid| pid == &m.id),
                        "conversation_profile": dm_conv_profiles.get(&m.sender_id).map(|(data, nonce)| serde_json::json!({
                            "encrypted_profile_data": data,
                            "nonce": nonce,
                        })),
                    })
                })
                .collect();
            (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

/// List pinned messages for a DM channel (encrypted rows — same shape as
/// list_dm_messages) so the client can decrypt + render them.
pub async fn list_dm_pins(
    Path(dm_channel_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if !state.db.is_dm_member(&dm_channel_id, &user_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not a member of this DM"}))).into_response();
    }
    let msgs = match state.db.get_pinned_dm_messages(&dm_channel_id) {
        Ok(m) => m,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
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
                "sender_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &m.sender_id),
                "sender_user_id": m.sender_id,
                "encrypted_content": base64::engine::general_purpose::STANDARD.encode(&m.encrypted_content),
                "nonce": base64::engine::general_purpose::STANDARD.encode(&m.nonce),
                "timestamp": m.timestamp,
                "edited_at": m.edited_at,
                "key_version": m.key_version,
                "encrypted_profile_snapshot": m.encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "profile_snapshot_nonce": m.profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "sender_id_hash": m.sender_id_hash,
                "encrypted_sender_username": m.encrypted_sender_username,
                "sender_username_nonce": m.sender_username_nonce,
                "pinned": true,
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

pub async fn list_online_users(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let online = state.ws_manager.get_online_user_ids().await;
    (StatusCode::OK, Json(serde_json::json!(online))).into_response()
}
