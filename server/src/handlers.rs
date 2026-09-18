use crate::totp;
use std::collections::HashMap;
use std::time::Duration as StdDuration;
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

    /// Check-only: returns true if the key is within budget, without incrementing.
    /// Used to test a budget before performing expensive work (e.g. password
    /// verification) so the counter is only bumped on actual failures.
    fn is_blocked(&self, key: &str, max_attempts: u32, window: Duration) -> bool {
        let mut map = self.attempts.lock().unwrap();
        let now = Instant::now();
        if let Some(&(count, first_attempt)) = map.get(key) {
            if now.duration_since(first_attempt) > window {
                map.remove(key);
                return false;
            }
            return count >= max_attempts;
        }
        false
    }

    /// Increment the counter for a key (called after a confirmed failure).
    /// If the window expired, starts a fresh bucket.
    fn increment(&self, key: &str, window: Duration) {
        let mut map = self.attempts.lock().unwrap();
        let now = Instant::now();
        if let Some(&(count, first_attempt)) = map.get(key) {
            if now.duration_since(first_attempt) > window {
                map.insert(key.to_string(), (1, now));
            } else {
                map.insert(key.to_string(), (count + 1, first_attempt));
            }
        } else {
            map.insert(key.to_string(), (1, now));
        }
    }

    /// Snapshot live buckets: (key, count, seconds_remaining_in_window).
    /// Expired buckets are dropped first so the view only shows active windows.
    fn snapshot(&self, window: Duration) -> Vec<(String, u32, u64)> {
        let mut map = self.attempts.lock().unwrap();
        let now = Instant::now();
        map.retain(|_, &mut (_, first)| now.duration_since(first) <= window);
        let mut out = Vec::with_capacity(map.len());
        for (k, &(count, first)) in map.iter() {
            let elapsed = now.duration_since(first).as_secs();
            out.push((k.clone(), count, window.as_secs().saturating_sub(elapsed)));
        }
        out
    }
}

static LOGIN_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

/// S8 — Per-username failure limiter: caps FAILED password attempts per
/// username regardless of IP.  Unlike LOGIN_RATE_LIMITER (which counts every
/// attempt including successes), this only bumps on a confirmed wrong password
/// so legitimate users are never throttled by their own successful logins.
/// Default: 3 failures / 15 min. Env-overridable: LOGIN_USER_FAIL_MAX=0 to
/// disable, or a number to raise the budget.
static LOGIN_USER_FAIL_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

/// S3 — Per-username login-failure notification limiter. Tracks confirmed
/// wrong-password attempts and fires an encrypted notification when the
/// threshold is reached (default 5 / 10 min). The notification alerts the
/// account owner that someone is trying to brute-force their password.
/// Env-overridable: LOGIN_FAIL_NOTIFY_MAX=0 to disable.
static LOGIN_FAIL_NOTIFY_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

/// F2 — Per-IP registration limiter (account spam). Env-overridable for test
/// suites (same pattern as LOGIN_IP_MAX): set REGISTER_IP_MAX=0 to disable,
/// or a number to raise the budget.
static REGISTER_IP_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
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

/// Kill-switch proof attempts get a dedicated, tighter per-IP budget so an
/// attacker can't brute-force kill-switch passwords through /api/login even
/// if the general login limits are raised. Env-overridable for test suites
/// (same pattern as LOGIN_IP_MAX): set KILL_SWITCH_IP_MAX=0 to disable, or a
/// number to raise the budget.
static KILL_SWITCH_IP_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

/// Per-account companion to KILL_SWITCH_IP_RATE_LIMITER: caps kill-switch
/// proof attempts per target username so one account can't be hammered from
/// many IPs (a distributed brute-force of the kill-switch password). Same
/// 5/5min default and the same byte-identical 429 as the general login
/// limit. Env-overridable for test suites (same pattern as
/// KILL_SWITCH_IP_MAX): set KILL_SWITCH_USER_MAX=0 to disable, or a number
/// to raise the budget.
static KILL_SWITCH_USER_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

/// Per-IP throttle for the public /api/client-config endpoint (the value is
/// public, but the endpoint shouldn't be hammerable). Env-overridable for
/// test suites (same pattern as HMAC_KEY_IP_MAX).
static CLIENT_CONFIG_IP_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

/// Per-IP throttle for the E2E message-search endpoints (both the search query
/// and the client-side token-index backfill). Env-overridable for test suites
/// (same pattern as HMAC_KEY_IP_MAX): set SEARCH_IP_MAX=0 to disable.
static SEARCH_IP_RATE_LIMITER: LazyLock<RateLimiter> = LazyLock::new(|| RateLimiter {
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

/// Bounded log of recent mutation-limit 429s (for the admin usage view).
/// Cap prevents unbounded growth; only the most recent entries are kept.
struct RateLimitHit {
    user_id: Option<String>,
    ip: String,
    ts: i64, // unix seconds
}

static MUTATION_429_HITS: LazyLock<Mutex<std::collections::VecDeque<RateLimitHit>>> =
    LazyLock::new(|| Mutex::new(std::collections::VecDeque::new()));

const MUTATION_429_HITS_CAP: usize = 100;

fn record_mutation_429(user_id: Option<&str>, ip: &str) {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    let mut q = MUTATION_429_HITS.lock().unwrap();
    if q.len() >= MUTATION_429_HITS_CAP {
        q.pop_front();
    }
    q.push_back(RateLimitHit {
        user_id: user_id.map(|s| s.to_string()),
        ip: ip.to_string(),
        ts,
    });
}

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

    // Limits come from the runtime-tunable admin config (DB → env → default),
    // so a host can adjust them live from the admin panel without a restart.
    let (user_max, ip_max) = {
        let tuning = state.runtime_tuning.read().unwrap();
        (tuning.mutation_user_max, tuning.mutation_ip_max)
    };
    let key = format!("mut_user:{}", user_id);
    if user_max > 0
        && !MUTATION_USER_RATE_LIMITER.check_and_increment(&key, user_max, Duration::from_secs(10))
    {
        record_mutation_429(Some(&user_id), &get_client_ip(headers));
        return Some((
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many requests. Slow down."})),
        ));
    }

    let ip = get_client_ip(headers);
    let ip_key = format!("mut_ip:{}", ip);
    if ip_max > 0
        && !MUTATION_IP_RATE_LIMITER.check_and_increment(&ip_key, ip_max, Duration::from_secs(10))
    {
        record_mutation_429(Some(&user_id), &ip);
        return Some((
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many requests. Slow down."})),
        ));
    }

    None
}

/// H3: verify a client-computed credential (HMAC for new accounts, raw
/// password for legacy) against the stored verifier, and self-heal legacy
/// bare-credential rows by replacing them with a server-side Argon2id verifier
/// on the first successful login. The stored value is never a replayable
/// password-equivalent (see auth::verify_user_verifier).
fn verify_user_password_and_upgrade(
    state: &AppState,
    user_id: &str,
    stored: &str,
    credential: &str,
) -> Result<bool, String> {
    let valid = auth::verify_user_verifier(credential, stored)?;
    if valid && auth::verifier_needs_upgrade(stored) {
        let upgraded = auth::hash_user_verifier(credential)?;
        let _ = state.db.update_password_hash(user_id, &upgraded);
    }
    Ok(valid)
}

fn get_admin_tokens() -> std::sync::MutexGuard<'static, Option<HashMap<String, Instant>>> {
    ADMIN_TOKENS.lock().unwrap()
}

fn store_admin_token(token: String) {
    let mut guard = get_admin_tokens();
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(token, Instant::now() + Duration::from_secs(24 * 3600));
}

fn store_admin_pre_token(token: String) {
    let mut guard = get_admin_tokens();
    let map = guard.get_or_insert_with(HashMap::new);
    map.insert(token, Instant::now() + Duration::from_secs(300)); // 5 min TTL
}

fn remove_admin_token(token: &str) {
    let mut guard = get_admin_tokens();
    if let Some(map) = guard.as_mut() {
        map.remove(token);
    }
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

    // Only ACTIVE sessions belong in the "signed in devices" list. Revoked
    // (signed-out) and naturally-expired sessions are dropped so the panel
    // never fills up with stale "Signed out" entries — every listed device is
    // one that can actually still be used.
    let now = chrono::Utc::now();
    let sessions: Vec<serde_json::Value> = rows
        .into_iter()
        .filter(|(_, _, _, _, _, expires_at, revoked)| {
            if *revoked != 0 {
                return false;
            }
            if !expires_at.is_empty() {
                if let Ok(exp) = chrono::DateTime::parse_from_rfc3339(expires_at) {
                    if exp.with_timezone(&chrono::Utc) <= now {
                        return false;
                    }
                }
            }
            true
        })
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
    /// Client-computed hash of the CURRENT password: HMAC-SHA256(hash_key, raw).
    /// Per-device sign-out is password-gated exactly like kick-all, so a stolen
    /// session can't sign out the real user's devices one at a time.
    pub current_password: String,
}

/// POST /api/auth/sessions/kick — revoke one session. If that device is
/// currently connected over WebSocket it is told immediately (session_revoked)
/// and dropped from any voice room it occupies; otherwise the next time its
/// token is validated (API call or WS auth) it is rejected.
/// Password-gated like every other destructive/permanent action.
pub async fn kick_auth_session(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<KickSessionRequest>,
) -> impl IntoResponse {
    let (user_id, _current_sid) = match extract_claims(&headers, &state) {
        Ok(c) => (c.sub, c.sid),
        Err(r) => return r.into_response(),
    };
    let stored_hash = match state.db.get_password_hash_by_id(&user_id) {
        Ok(h) => h,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "User not found"})),
            )
                .into_response();
        }
    };
    let valid = match verify_user_password_and_upgrade(&state, &user_id, &stored_hash, &req.current_password) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Wrong password"})),
        )
            .into_response();
    }

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
/// one ("log out everywhere else" button). Password-gated like every other
/// destructive/permanent action, so a stolen session can't sign out the real
/// user's other devices.
#[derive(Deserialize)]
pub struct KickAllSessionsRequest {
    /// Client-computed hash of the CURRENT password: HMAC-SHA256(hash_key, raw).
    pub current_password: String,
}

pub async fn kick_all_auth_sessions(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<KickAllSessionsRequest>,
) -> impl IntoResponse {
    let (user_id, current_sid) = match extract_claims(&headers, &state) {
        Ok(c) => (c.sub, c.sid),
        Err(r) => return r.into_response(),
    };
    let stored_hash = match state.db.get_password_hash_by_id(&user_id) {
        Ok(h) => h,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "User not found"})),
            )
                .into_response();
        }
    };
    let valid = match verify_user_password_and_upgrade(&state, &user_id, &stored_hash, &req.current_password) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Wrong password"})),
        )
            .into_response();
    }

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

    live_kick_other_devices(&state, &user_id, &current_sid, "kicked").await;

    (StatusCode::OK, Json(serde_json::json!({"ok": true, "revoked": n}))).into_response()
}

/// Send a live `session_revoked` WS message to every session of `user_id`
/// except `keep_sid` that is currently revoked, and drop those devices from
/// any voice room they occupy. Used after force-kicks and password changes so
/// kicked devices are told immediately rather than only at their next request.
async fn live_kick_other_devices(state: &Arc<AppState>, user_id: &str, keep_sid: &str, reason: &str) {
    if let Ok(rows) = state.db.list_auth_sessions(user_id) {
        let kick_msg = serde_json::json!({
            "type": "session_revoked",
            "reason": reason,
        });
        for (sid, device_id, _, _, _, _, revoked) in rows {
            if sid == keep_sid || revoked == 0 {
                continue;
            }
            if !device_id.is_empty() {
                state.ws_manager.broadcast_to_device(user_id, &device_id, &kick_msg.to_string()).await;
                crate::ws::voice_remove_user_all_for_device(state, user_id, &device_id).await;
            }
        }
    }
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
    // Kill Switch: client-decrypted verifier sent INSTEAD of the password when
    // the kill-switch password was entered. Never the raw kill-switch password.
    #[serde(default)]
    pub kill_switch_proof: Option<String>,
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
    headers: HeaderMap,
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

    // F2 — Per-IP account-spam budget (default 5 accounts / 10 min per IP).
    // Automated suites that register many users from one IP can raise or
    // disable it with REGISTER_IP_MAX (same pattern as LOGIN_IP_MAX).
    let reg_ip = get_client_ip(&headers);
    let reg_ip_key = format!("register_ip:{}", reg_ip);
    let reg_ip_max: u32 = std::env::var("REGISTER_IP_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(5);
    if reg_ip_max > 0
        && !REGISTER_IP_RATE_LIMITER.check_and_increment(&reg_ip_key, reg_ip_max, Duration::from_secs(600))
    {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many accounts created from this IP. Try again later."})),
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

    // H3: the client sends a deterministic credential (HMAC of the password);
    // store a server-side Argon2id verifier of it, never the credential itself,
    // so a DB dump is not a replayable password-equivalent.
    let password_hash = match auth::hash_user_verifier(&req.password) {
        Ok(h) => h,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };

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

    // S8 — Per-username failure limiter: caps FAILED password attempts per
    // username regardless of IP (default 3/15min). Unlike LOGIN_RATE_LIMITER
    // which counts every attempt, this only blocks after confirmed wrong
    // passwords so legitimate users are unaffected. Checked before the
    // expensive Argon2 verification; bumped after a confirmed failure.
    let fail_rate_key = format!("login_fail:{}", req.username);
    let user_fail_max: u32 = std::env::var("LOGIN_USER_FAIL_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(3);
    if user_fail_max > 0 && LOGIN_USER_FAIL_RATE_LIMITER.is_blocked(&fail_rate_key, user_fail_max, Duration::from_secs(900)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many failed attempts for this account. Try again in 15 minutes."})),
        )
            .into_response();
    }

    // Kill-switch proof attempts get their own tighter per-IP budget (default
    // 5/5min vs the general 10/5min) so a brute-force of kill-switch passwords
    // is throttled even if LOGIN_IP_MAX is raised. The response is byte-identical
    // to the general login rate-limit (same status + message), so hitting this
    // throttle never reveals whether an account has a kill switch.
    if req.kill_switch_proof.is_some() {
        let ks_ip_key = format!("login_ks_ip:{}", ip);
        let ks_ip_max: u32 = std::env::var("KILL_SWITCH_IP_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(5);
        if ks_ip_max > 0 && !KILL_SWITCH_IP_RATE_LIMITER.check_and_increment(&ks_ip_key, ks_ip_max, Duration::from_secs(300)) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({"error": "Too many login attempts. Try again in 5 minutes."})),
            )
                .into_response();
        }

        // Per-account budget (same default, byte-identical 429): one target
        // can't be hammered from many IPs. Applied to every proof attempt
        // (even for unknown usernames) so it never reveals whether an account
        // has a kill switch — the throttle looks exactly like the general
        // login rate limit.
        let ks_user_key = format!("login_ks_user:{}", req.username);
        let ks_user_max: u32 = std::env::var("KILL_SWITCH_USER_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(5);
        if ks_user_max > 0 && !KILL_SWITCH_USER_RATE_LIMITER.check_and_increment(&ks_user_key, ks_user_max, Duration::from_secs(300)) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({"error": "Too many login attempts. Try again in 5 minutes."})),
            )
                .into_response();
        }
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

    // H3: verify against the server-side verifier (Argon2id of the client
    // credential — the stored value is never a replayable password-equivalent)
    // and self-heal legacy bare rows on the first successful login.
    let user_for_verify = state.db.get_user_by_username(&req.username).ok();
    let valid = match &user_for_verify {
        Some(u) => match verify_user_password_and_upgrade(&state, &u.id, &password_hash, &req.password) {
            Ok(v) => v,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
        },
        None => false,
    };

    // Kill Switch: entering the kill-switch password instead of the real one
    // deletes the account on the spot (shows as a generic server error so the
    // deletion is hidden). The proof is the client-decrypted verifier — bound
    // to the stored check HMAC — and the server holds nothing it can replay,
    // so even the host cannot trigger a deletion from stored data.
    if !valid {
        if let Some(proof) = &req.kill_switch_proof {
            if let Ok(Some(check)) = state.db.get_kill_switch_check(&req.username) {
                let proof_check = crate::db::hmac_sha256_hex(proof.as_bytes(), KILL_SWITCH_CHECK_LABEL);
                use subtle::ConstantTimeEq;
                if proof_check.as_bytes().ct_eq(check.as_bytes()).into() {
                    // Kill switch armed. If the account has 2FA, require the
                    // code too (looks like a normal 2FA login) — the deletion
                    // happens on the verified code step. Otherwise delete now.
                    if let Ok(user) = state.db.get_user_by_username(&req.username) {
                        if state.db.totp_enabled(&user.id).unwrap_or(false) {
                            let session_secs = session_duration_secs(req.duration_seconds);
                            return match auth::create_pending_2fa_token(
                                &user.id,
                                &user.username,
                                &state.config.jwt_secret,
                                chrono::Duration::minutes(5),
                                session_secs,
                                "kill_switch_pending",
                            ) {
                                Ok(pending) => (
                                    StatusCode::OK,
                                    Json(serde_json::json!({
                                        "two_factor_required": true,
                                        "pending_token": pending,
                                    })),
                                )
                                    .into_response(),
                                Err(e) => (
                                    StatusCode::INTERNAL_SERVER_ERROR,
                                    Json(serde_json::json!({"error": e})),
                                )
                                    .into_response(),
                            };
                        }
                        // No 2FA → delete immediately, reply with a generic error.
                        let _ = delete_account_and_cleanup(&state, &user.id).await;
                    }
                    return (
                        StatusCode::INTERNAL_SERVER_ERROR,
                        Json(serde_json::json!({
                            "error": "Internal server error. Please try again later."
                        })),
                    )
                        .into_response();
                }
            }
        }
        // S8: bump the per-username failure counter (only on confirmed wrong
        // password, never on success or kill-switch paths, so legitimate
        // users and kill-switch attempts are unaffected).
        if user_fail_max > 0 {
            LOGIN_USER_FAIL_RATE_LIMITER.increment(&fail_rate_key, Duration::from_secs(900));
        }

        // S3: Login attempt notification — when the per-username failure count
        // hits the threshold, send an encrypted alert to the account owner via
        // WS (or queue for offline delivery). This lets users know someone is
        // trying to brute-force their password.
        let notify_max: u32 = std::env::var("LOGIN_FAIL_NOTIFY_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(5);
        if notify_max > 0 {
            let notify_key = format!("login_notify:{}", req.username);
            LOGIN_FAIL_NOTIFY_RATE_LIMITER.increment(&notify_key, Duration::from_secs(600));
            // Snapshot: check if we just hit the threshold (count == notify_max)
            let snapshot = LOGIN_FAIL_NOTIFY_RATE_LIMITER.snapshot(Duration::from_secs(600));
            if let Some(&(_, count, _)) = snapshot.iter().find(|(k, _, _)| k == &notify_key) {
                if count == notify_max {
                    // Only notify for existing users (password hash lookup succeeded above)
                    let notify_ip = get_client_ip(&headers);
                    if let Ok(user) = state.db.get_user_by_username(&req.username) {
                        let payload = serde_json::json!({
                            "type": "login_attempt_alert",
                            "attempts": count,
                            "ip": notify_ip,
                            "timestamp": chrono::Utc::now().to_rfc3339(),
                        });
                        let state_clone = state.clone();
                        let uid = user.id.clone();
                        let notif_str = payload.to_string();
                        // Fire-and-forget: deliver encrypted notification
                        tokio::spawn(async move {
                            crate::ws::deliver_encrypted_notification(
                                &state_clone,
                                &[uid],
                                "login_attempt_alert",
                                &notif_str,
                            ).await;
                        });
                    }
                }
            }
        }

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

    // 2FA (TOTP): the password stage only earns a short-lived pending token;
    // the real session is minted by /api/login/2fa after a valid code.
    if state.db.totp_enabled(&user.id).unwrap_or(false) {
        let session_secs = session_duration_secs(req.duration_seconds);
        return match auth::create_pending_2fa_token(
            &user.id,
            &user.username,
            &state.config.jwt_secret,
            chrono::Duration::minutes(5),
            session_secs,
            "2fa_pending",
        ) {
            Ok(pending) => (
                StatusCode::OK,
                Json(serde_json::json!({
                    "two_factor_required": true,
                    "pending_token": pending,
                })),
            )
                .into_response(),
            Err(e) => (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response(),
        };
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

// --- Two-factor authentication (TOTP + recovery codes) ---

#[derive(Deserialize)]
pub struct Login2FaRequest {
    pub pending_token: String,
    pub code: String,
}

/// Second step of login for 2FA-enabled accounts. Verifies the short-lived
/// pending token (password step done) + a TOTP code or one-time recovery code,
/// then mints the real session — same success shape as /api/login.
pub async fn login_2fa(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<Login2FaRequest>,
) -> impl IntoResponse {
    // 6-digit codes need brute-force protection: per-IP budget (env-overridable
    // for tests, same pattern as LOGIN_IP_MAX).
    let ip = get_client_ip(&headers);
    let ip_rate_key = format!("login2fa_ip:{}", ip);
    let ip_max: u32 = std::env::var("LOGIN_2FA_IP_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(10);
    if ip_max > 0 && !LOGIN_RATE_LIMITER.check_and_increment(&ip_rate_key, ip_max, Duration::from_secs(300)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many attempts. Try again in 5 minutes."})),
        )
            .into_response();
    }

    let claims = match auth::validate_token(&req.pending_token, &state.config.jwt_secret) {
        Ok(c) => c,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "Session expired. Please log in again."})),
            )
                .into_response();
        }
    };
    let is_kill_switch = claims.purpose.as_deref() == Some("kill_switch_pending");
    if !is_kill_switch && claims.purpose.as_deref() != Some("2fa_pending") {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Invalid session. Please log in again."})),
        )
            .into_response();
    }

    // Kill Switch + 2FA: the code step of a kill-switch deletion is the actual
    // deletion point, so it gets the same per-account budget as the proof step
    // (one target can't be hammered from many IPs). Applied before code
    // verification so every attempt counts — even replays after a deletion —
    // with the same 429 as the general 2FA rate limit so nothing is revealed.
    if is_kill_switch {
        let ks_user_key = format!("login_ks_user2fa:{}", claims.sub);
        let ks_user_max: u32 = std::env::var("KILL_SWITCH_USER_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(5);
        if ks_user_max > 0 && !KILL_SWITCH_USER_RATE_LIMITER.check_and_increment(&ks_user_key, ks_user_max, Duration::from_secs(300)) {
            return (
                StatusCode::TOO_MANY_REQUESTS,
                Json(serde_json::json!({"error": "Too many attempts. Try again in 5 minutes."})),
            )
                .into_response();
        }
    }

    let secret_row = match state.db.get_totp_secret(&claims.sub) {
        Ok(Some(r)) => r,
        _ => {
            // Kill-switch path: a replayed pending token hits this after the
            // account was already deleted by a previous verified code. Answer
            // with the same generic server error so the deletion stays hidden
            // (a normal 2FA login keeps the specific message).
            if is_kill_switch {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({
                        "error": "Internal server error. Please try again later."
                    })),
                )
                    .into_response();
            }
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "2FA is not enabled for this account"})),
            )
                .into_response();
        }
    };
    let secret = match totp::decrypt_secret(&secret_row.0, &secret_row.1, &state.config.jwt_secret) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    // TOTP code, or a (still-unused) one-time recovery code.
    let mut used_recovery: Option<String> = None;
    if !totp::verify_totp(&secret, &req.code, 1) {
        let salt = &secret_row.2;
        let code_hash = totp::hash_recovery_code(salt, &req.code);
        let hashes = match state.db.list_recovery_code_hashes(&claims.sub) {
            Ok(h) => h,
            Err(e) => {
                return (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    Json(serde_json::json!({"error": e})),
                )
                    .into_response();
            }
        };
        match hashes.iter().find(|(h, used)| h == &code_hash && !*used) {
            Some(_) => used_recovery = Some(code_hash),
            None => {
                return (
                    StatusCode::UNAUTHORIZED,
                    Json(serde_json::json!({"error": "Invalid code"})),
                )
                    .into_response();
            }
        }
    }
    if let Some(h) = used_recovery {
        if let Err(e) = state.db.mark_recovery_code_used(&claims.sub, &h) {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    }

    // Kill Switch + 2FA: the code verified, so delete the account now and
    // answer with a generic server error — the deletion stays hidden and the
    // whole flow looked like a failed 2FA login.
    if is_kill_switch {
        let _ = delete_account_and_cleanup(&state, &claims.sub).await;
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({
                "error": "Internal server error. Please try again later."
            })),
        )
            .into_response();
    }

    let user = match state.db.get_user_by_username(&claims.username) {
        Ok(u) => u,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };
    let session_secs = session_duration_secs(claims.duration_secs);
    let token = match mint_session_token(&state, &user.id, &user.username, None, None, session_secs) {
        Ok(t) => t,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };

    let mut headers_out = HeaderMap::new();
    headers_out.insert(
        "set-cookie",
        HeaderValue::from_str(
            &format!("token={}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age={}", token, session_secs)
        )
        .unwrap(),
    );
    let profile_pic = match state.db.get_user_profile(&user.id) {
        Ok((_, _, pp, pph, _, bh, _, _, _, _)) => (pp, pph, bh),
        Err(_) => (None, None, None),
    };

    (StatusCode::OK, headers_out, Json(serde_json::json!({
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

// --- 2FA enrollment / status / disable ---

/// Pending enrollments: user_id → (secret_b32, recovery_salt, recovery_codes, expiry).
/// Kept in memory (single instance); the secret is only persisted once the user
/// proves they scanned the QR by submitting a valid code.
static PENDING_2FA_ENROLL: LazyLock<Mutex<HashMap<String, (String, String, Vec<String>, Instant)>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

const PENDING_2FA_TTL: Duration = Duration::from_secs(600); // 10 minutes

#[derive(Deserialize)]
pub struct Enroll2FaRequest {
    /// Client-computed password hash (same value /api/login accepts).
    pub password: String,
}

pub async fn enroll_2fa(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<Enroll2FaRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if state.db.totp_enabled(&user_id).unwrap_or(false) {
        return (
            StatusCode::CONFLICT,
            Json(serde_json::json!({"error": "2FA is already enabled"})),
        )
            .into_response();
    }
    // Re-verify the password so a stolen session can't silently lock the owner out.
    let stored_hash = match state.db.get_password_hash_by_id(&user_id) {
        Ok(h) => h,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "User not found"})),
            )
                .into_response();
        }
    };
    let valid = match verify_user_password_and_upgrade(&state, &user_id, &stored_hash, &req.password) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Wrong password"})),
        )
            .into_response();
    }

    let secret = totp::generate_secret();
    let salt: String = {
        use rand::Rng;
        rand::thread_rng().gen::<[u8; 16]>().iter().map(|b| format!("{:02x}", b)).collect()
    };
    let codes = totp::generate_recovery_codes(8);
    {
        let mut pending = PENDING_2FA_ENROLL.lock().unwrap();
        if pending.len() > 200 {
            let now = Instant::now();
            pending.retain(|_, v| now.duration_since(v.3) <= PENDING_2FA_TTL);
        }
        pending.insert(user_id.clone(), (secret.clone(), salt, codes.clone(), Instant::now()));
    }
    let username = claims_username_from_user_id(&state, &user_id).unwrap_or_else(|| "user".to_string());
    let otpauth = totp::otpauth_uri("E2E Chat", &username, &secret);
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "secret_base32": secret,
            "otpauth_url": otpauth,
            "recovery_codes": codes,
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct VerifyEnroll2FaRequest {
    pub code: String,
}

pub async fn verify_enroll_2fa(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<VerifyEnroll2FaRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let entry = {
        let mut pending = PENDING_2FA_ENROLL.lock().unwrap();
        match pending.get(&user_id) {
            Some((secret, salt, codes, exp)) => {
                if Instant::now().duration_since(*exp) > PENDING_2FA_TTL {
                    pending.remove(&user_id);
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(serde_json::json!({"error": "Enrollment expired. Please start over."})),
                    )
                        .into_response();
                }
                (secret.clone(), salt.clone(), codes.clone())
            }
            None => {
                return (
                    StatusCode::BAD_REQUEST,
                    Json(serde_json::json!({"error": "No pending enrollment. Please start over."})),
                )
                    .into_response();
            }
        }
    };
    if !totp::verify_totp(&entry.0, &req.code, 1) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Invalid code"})),
        )
            .into_response();
    }
    let (ct, nonce) = match totp::encrypt_secret(&entry.0, &state.config.jwt_secret) {
        Ok(v) => v,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };
    let hashes: Vec<String> = entry
        .2
        .iter()
        .map(|c| totp::hash_recovery_code(&entry.1, c))
        .collect();
    if let Err(e) = state.db.save_totp_secret(&user_id, &ct, &nonce, &entry.1) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }
    if let Err(e) = state.db.save_recovery_code_hashes(&user_id, &hashes) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }
    PENDING_2FA_ENROLL.lock().unwrap().remove(&user_id);
    (
        StatusCode::OK,
        Json(serde_json::json!({"ok": true, "enabled": true})),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct Disable2FaRequest {
    /// Current TOTP code or an unused recovery code.
    pub code: String,
}

pub async fn disable_2fa(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<Disable2FaRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let secret_row = match state.db.get_totp_secret(&user_id) {
        Ok(Some(r)) => r,
        _ => {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "2FA is not enabled"})),
            )
                .into_response();
        }
    };
    let secret = match totp::decrypt_secret(&secret_row.0, &secret_row.1, &state.config.jwt_secret) {
        Ok(s) => s,
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    };
    let mut ok = totp::verify_totp(&secret, &req.code, 1);
    if !ok {
        let code_hash = totp::hash_recovery_code(&secret_row.2, &req.code);
        let hashes = state.db.list_recovery_code_hashes(&user_id).unwrap_or_default();
        ok = hashes.iter().any(|(h, used)| h == &code_hash && !*used);
    }
    if !ok {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Invalid code"})),
        )
            .into_response();
    }
    if let Err(e) = state.db.delete_totp(&user_id) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }
    (StatusCode::OK, Json(serde_json::json!({"ok": true, "enabled": false}))).into_response()
}

pub async fn get_2fa_status(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let enabled = state.db.totp_enabled(&user_id).unwrap_or(false);
    (
        StatusCode::OK,
        Json(serde_json::json!({"enabled": enabled})),
    )
        .into_response()
}

fn claims_username_from_user_id(state: &AppState, user_id: &str) -> Option<String> {
    state.db.get_username_by_id(user_id).ok().flatten()
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
        Ok((encrypted_hash_key, hash_key_salt, hash_key_nonce, ks_ver, ks_wrap_salt, ks_wrap_nonce, ks_salt, ks_check)) => {
            let has_kill_switch = ks_check.is_some();
            (StatusCode::OK, Json(serde_json::json!({
                "encrypted_hash_key": encrypted_hash_key,
                "hash_key_salt": hash_key_salt,
                "hash_key_nonce": hash_key_nonce,
                "has_kill_switch": has_kill_switch,
                "kill_switch_verifier_encrypted": ks_ver,
                "kill_switch_wrap_salt": ks_wrap_salt,
                "kill_switch_wrap_nonce": ks_wrap_nonce,
                "kill_switch_salt": ks_salt,
            }))).into_response()
        }
        Err(_) => {
            (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "User not found"}))).into_response()
        }
    }
}

// --- Password change ---

#[derive(Deserialize)]
pub struct ChangePasswordRequest {
    /// Client-computed hash of the CURRENT password: HMAC-SHA256(hash_key, raw).
    pub old_password: String,
    /// Client-computed hash of the NEW password: HMAC-SHA256(hash_key, raw).
    pub new_password: String,
    // hash_key re-encrypted with the NEW password (required — login depends on it).
    pub encrypted_hash_key: String,
    pub hash_key_salt: String,
    pub hash_key_nonce: String,
    // Identity key escrow re-encrypted with the NEW password (optional).
    #[serde(default)]
    pub encrypted_identity_priv: Option<String>,
    #[serde(default)]
    pub escrow_salt: Option<String>,
    #[serde(default)]
    pub escrow_nonce: Option<String>,
    // Friend code re-encrypted with the NEW password (optional).
    #[serde(default)]
    pub encrypted_friend_code: Option<String>,
    #[serde(default)]
    pub friend_code_salt: Option<String>,
    #[serde(default)]
    pub friend_code_nonce: Option<String>,
    // Key blob (identity + message keys) re-encrypted with the NEW password.
    #[serde(default)]
    pub encrypted_blob: Option<String>,
    #[serde(default)]
    pub blob_salt: Option<String>,
    #[serde(default)]
    pub blob_nonce: Option<String>,
}

/// POST /api/password/change — verifies the current password (client-computed
/// hash, constant-time) and swaps every password-wrapped credential blob to the
/// new password in one go. The identity keys themselves never change, so
/// messages and profile data are unaffected. Every OTHER session is revoked in
/// the same transaction, so all other devices must sign in again with the new
/// password (the current device stays signed in).
pub async fn change_password(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<ChangePasswordRequest>,
) -> impl IntoResponse {
    let (user_id, current_sid) = match extract_claims(&headers, &state) {
        Ok(c) => (c.sub, c.sid),
        Err(r) => return r.into_response(),
    };

    // Mirrors the register rule: the client must send the pre-hashed password
    // (HMAC-SHA256 hex, 64 chars).
    if req.new_password.len() < 64 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "New password hash required (client-side hashing)"})),
        )
            .into_response();
    }

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

    // H3: verify against the server-side verifier (Argon2id of the client
    // credential) and self-heal legacy bare rows on success.
    let valid = match verify_user_password_and_upgrade(&state, &user_id, &password_hash, &req.old_password) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Wrong password"})),
        )
            .into_response();
    }

    // Decode the base64 escrow blobs (same as register). Skip if partial/malformed.
    let escrow = if let (Some(k), Some(s), Some(n)) = (
        &req.encrypted_identity_priv,
        &req.escrow_salt,
        &req.escrow_nonce,
    ) {
        match (
            base64::engine::general_purpose::STANDARD.decode(k),
            base64::engine::general_purpose::STANDARD.decode(s),
            base64::engine::general_purpose::STANDARD.decode(n),
        ) {
            (Ok(k), Ok(s), Ok(n)) => Some((k, s, n)),
            _ => None,
        }
    } else {
        None
    };

    // H3: store a server-side verifier of the new client credential.
    let new_verifier = match auth::hash_user_verifier(&req.new_password) {
        Ok(h) => h,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };

    if let Err(e) = state.db.change_password_credentials(
        &user_id,
        &current_sid,
        &new_verifier,
        &req.encrypted_hash_key,
        &req.hash_key_salt,
        &req.hash_key_nonce,
        escrow.as_ref().map(|x| x.0.as_slice()),
        escrow.as_ref().map(|x| x.1.as_slice()),
        escrow.as_ref().map(|x| x.2.as_slice()),
        req.encrypted_friend_code.as_deref(),
        req.friend_code_salt.as_deref(),
        req.friend_code_nonce.as_deref(),
        req.encrypted_blob.as_deref(),
        req.blob_salt.as_deref(),
        req.blob_nonce.as_deref(),
    ) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }

    // Every other session was revoked in the same transaction — tell those
    // devices now so they sign out immediately instead of at their next call.
    live_kick_other_devices(&state, &user_id, &current_sid, "password_changed").await;

    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
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

    // H3: verify against the server-side verifier (Argon2id of the client
    // credential) and self-heal legacy bare rows on success.
    let valid = match verify_user_password_and_upgrade(&state, &user_id, &password_hash, &req.password) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };

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
        Ok(Some((encrypted_blob, salt, nonce, needs_rebuild, updated_at))) => {
            (StatusCode::OK, Json(serde_json::json!({
                "encrypted_blob": encrypted_blob,
                "salt": salt,
                "nonce": nonce,
                "needs_rebuild": needs_rebuild,
                "updated_at": updated_at,
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
    pub voice_channel_encrypted_name: Option<String>,
    pub voice_channel_name_nonce: Option<String>,
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
    if !CREATE_SERVER_RATE_LIMITER.check_and_increment(&rate_key, 30, Duration::from_secs(3600)) {
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
    let voice_ch_enc_name_bytes = req.voice_channel_encrypted_name.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let voice_ch_name_nonce_bytes = req.voice_channel_name_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

    let server = match state.db.create_server(&user_id, &invite_code_hash, &salt, encrypted_name_bytes.as_deref(), name_nonce_bytes.as_deref(), ch_enc_name_bytes.as_deref(), ch_name_nonce_bytes.as_deref(), voice_ch_enc_name_bytes.as_deref(), voice_ch_name_nonce_bytes.as_deref()) {
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
                "group_id": s.group_id,
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

    // Only channels the caller may see. Role overwrites (channel or category)
    // can hide a channel from a role entirely, which is how "announcements: only
    // mods can see/post" categories are wired.
    let channel_infos: Vec<serde_json::Value> = channels
        .iter()
        .filter(|c| state.db.member_has_permission(&server_id, &user_id, crate::db::PERM_VIEW_CHANNEL, Some(&c.id)))
        .map(|c| {
            serde_json::json!({
                "id": c.id,
                "encrypted_name": c.encrypted_name.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "name_nonce": c.name_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                "channel_type": c.channel_type,
                "category_id": c.category_id,
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
    #[serde(default)]
    pub category_id: Option<String>,
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

    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_CHANNELS, None) {
        return denied;
    }

    let encrypted_name_bytes = req.encrypted_name.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let name_nonce_bytes = req.name_nonce.as_ref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

    let ctype = req.channel_type.as_deref().unwrap_or("text");
    let cat_id = req.category_id.as_deref();
    let channel = match state.db.create_channel(&server_id, encrypted_name_bytes.as_deref(), name_nonce_bytes.as_deref(), ctype, cat_id) {
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

    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_INVITE_MEMBERS, None) {
        return denied;
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

    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_INVITE_MEMBERS, None) {
        return denied;
    }

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

    // Broadcast member_joined to all server members EXCEPT the joiner.
    // The joiner already knows they joined (HTTP response) and calls loadServers()
    // client-side. Broadcasting to the joiner too creates a race between the
    // member_joined-triggered refreshServerListData() and the joinServer()-
    // triggered loadServers(), which can duplicate the server in the sidebar.
    let join_msg = serde_json::json!({
        "type": "member_joined",
        "server_id": server.id,
        "user_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &user_id),
        "raw_user_id": user_id,
    });
    if let Ok(members) = state.db.get_server_members(&server.id) {
        let recipients: Vec<String> = members.into_iter().filter(|m| *m != user_id).collect();
        let _ = state.ws_manager.broadcast_to_users(&recipients, &join_msg.to_string()).await;

        // Save pending key_needed events for offline members so the new member gets
        // the server key when someone reconnects (handles the case where all members
        // are offline at join time)
        let new_user_id = user_id.clone();
        let sid = server.id.clone();
        for mid in &recipients {
            if !state.ws_manager.is_user_connected(mid).await {
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

    if let Some(denied) = perm_denied(&state, &server_id, &caller_id, crate::db::PERM_KICK_MEMBERS, None) {
        return denied;
    }

    if req.user_id == caller_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Cannot kick yourself"})),
        )
            .into_response();
    }

    // Hierarchy: the owner can never be kicked and a member can only kick
    // members ranked strictly below their own role.
    if state.db.is_server_owner(&req.user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "The server owner cannot be kicked"}))).into_response();
    }
    let actor_pos = state.db.member_role_position(&server_id, &caller_id).unwrap_or(0);
    let target_pos = state.db.member_role_position(&server_id, &req.user_id).unwrap_or(0);
    if actor_pos <= target_pos {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot kick a member at or above your own role"}))).into_response();
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

    if let Some(denied) = perm_denied(&state, &server_id, &caller_id, crate::db::PERM_BAN_MEMBERS, None) {
        return denied;
    }

    if req.user_id == caller_id {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Cannot ban yourself"})),
        )
            .into_response();
    }

    // Hierarchy: the owner can never be banned and a member can only ban
    // members ranked strictly below their own role.
    if state.db.is_server_owner(&req.user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "The server owner cannot be banned"}))).into_response();
    }
    let actor_pos = state.db.member_role_position(&server_id, &caller_id).unwrap_or(0);
    let target_pos = state.db.member_role_position(&server_id, &req.user_id).unwrap_or(0);
    if actor_pos <= target_pos {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot ban a member at or above your own role"}))).into_response();
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

    if let Some(denied) = perm_denied(&state, &server_id, &caller_id, crate::db::PERM_BAN_MEMBERS, None) {
        return denied;
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

    if let Some(denied) = perm_denied(&state, &server_id, &caller_id, crate::db::PERM_BAN_MEMBERS, None) {
        return denied;
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

    if let Some(denied) = perm_denied(&state, &server_id, &caller_id, crate::db::PERM_MANAGE_SERVER, None) {
        return denied;
    }

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

    if let Ok(sid) = server_id.as_ref() {
        if let Some(denied) = perm_denied(&state, sid, &user_id, crate::db::PERM_MANAGE_CHANNELS, None) {
            return denied;
        }
    } else {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Channel not found"}))).into_response();
    }

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

    let members = match state.db.get_server_members_with_roles(&server_id) {
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
        .map(|m| {
            serde_json::json!({
                "id": m.id,
                "username": m.username,
                "role": m.role,
                "role_id": m.role_id,
                "role_name": m.role_name,
                "role_color": m.role_color,
                "role_position": m.role_position,
            })
        })
        .collect();

    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

// --- Roles & permissions ---------------------------------------------------
//
// Permissions are granted exclusively through roles. The server owner holds
// every permission implicitly and can never be restricted, kicked or banned
// (db.rs member_permissions / member_role_position). Role management is
// hierarchy-bound: an actor may only touch roles strictly below their own, may
// not rank a new role at or above their own, may not grant a permission they do
// not hold, and may not manage a member whose role is at or above their own.

/// None = the caller holds `perm`; Some(403) = denied.
fn perm_denied(
    state: &Arc<AppState>,
    server_id: &str,
    user_id: &str,
    perm: i64,
    channel_id: Option<&str>,
) -> Option<axum::response::Response> {
    if state.db.member_has_permission(server_id, user_id, perm, channel_id) {
        None
    } else {
        Some(
            (
                StatusCode::FORBIDDEN,
                Json(serde_json::json!({"error": "Missing permission"})),
            )
                .into_response(),
        )
    }
}

fn role_json(role: &crate::db::ServerRole, actor_position: i64, overwrites: &[(String, String, i64, i64)]) -> serde_json::Value {
    let enc_name_b64 = role.encrypted_name.as_ref().map(|e| base64::engine::general_purpose::STANDARD.encode(e));
    let nonce_b64 = role.name_nonce.as_ref().map(|e| base64::engine::general_purpose::STANDARD.encode(e));
    serde_json::json!({
        "id": role.id,
        "name": role.name,
        "color": role.color,
        "position": role.position,
        "is_everyone": role.is_everyone,
        "permissions": role.permissions,
        "encrypted_name": enc_name_b64,
        "name_nonce": nonce_b64,
        // True when the caller's role outranks this one and may therefore edit it.
        "can_manage": actor_position > role.position as i64,
        "overwrites": overwrites.iter().map(|(t, id, allow, deny)| serde_json::json!({
            "target_type": t, "target_id": id, "allow": allow, "deny": deny,
        })).collect::<Vec<_>>(),
    })
}

/// GET /api/servers/{server_id}/roles — any member may read roles (the member
/// list needs the name/color), plus the caller's own computed permissions so
/// the client can hide/disable UI it is not allowed to use.
pub async fn list_server_roles(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if !state.db.is_member_of_server(&user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not a member of this server"}))).into_response();
    }
    let roles = match state.db.list_server_roles(&server_id) {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let is_owner = state.db.is_server_owner(&user_id, &server_id).unwrap_or(false);
    let my_position = state.db.member_role_position(&server_id, &user_id).unwrap_or(0);
    let my_permissions = state.db.member_permissions(&server_id, &user_id, None).unwrap_or(0);
    let my_role_id = state.db.get_member_role_id(&server_id, &user_id).ok().flatten();
    let result: Vec<serde_json::Value> = roles
        .iter()
        .map(|r| {
            let ow = if my_position > r.position as i64 {
                state.db.list_role_overwrites(&r.id).unwrap_or_default()
            } else {
                Vec::new()
            };
            role_json(r, my_position, &ow)
        })
        .collect();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "roles": result,
            "my_permissions": my_permissions,
            "my_role_id": my_role_id,
            "my_position": if is_owner { i32::MAX as i64 } else { my_position },
            "is_owner": is_owner,
        })),
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct ReorderRolesRequest {
    pub ordered_ids: Vec<ReorderEntry>,
}

#[derive(Deserialize)]
pub struct ReorderEntry {
    pub id: String,
    pub position: i32,
}

/// PUT /api/servers/{sid}/roles/reorder — batch reorder role positions.
pub async fn reorder_roles(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<ReorderRolesRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let is_owner = state.db.is_server_owner(&user_id, &server_id).unwrap_or(false);
    if !is_owner {
        if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_ROLES, None) {
            return denied;
        }
    }
    let actor_position = if is_owner { i32::MAX } else { state.db.member_role_position(&server_id, &user_id).unwrap_or(0) as i32 };
    for entry in &req.ordered_ids {
        if let Some(role) = state.db.get_role(&entry.id).ok() {
            if role.server_id != server_id || role.is_everyone {
                continue;
            }
            if !is_owner && entry.position >= actor_position {
                continue;
            }
            let _ = state.db.set_role_position(&entry.id, entry.position);
        }
    }
    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

#[derive(Deserialize)]
pub struct CreateRoleRequest {
    pub name: String,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub permissions: Option<i64>,
    #[serde(default)]
    pub position: Option<i32>,
    #[serde(default)]
    pub encrypted_name: Option<String>,
    #[serde(default)]
    pub name_nonce: Option<String>,
}

pub async fn create_server_role(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<CreateRoleRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    // CREATE_ROLES or MANAGE_ROLES (superset) needed to create.
    if !state.db.member_has_permission(&server_id, &user_id, crate::db::PERM_CREATE_ROLES, None)
        && !state.db.member_has_permission(&server_id, &user_id, crate::db::PERM_MANAGE_ROLES, None) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Missing permission"}))).into_response();
    }
    let actor_position = state.db.member_role_position(&server_id, &user_id).unwrap_or(0);
    let is_owner = state.db.is_server_owner(&user_id, &server_id).unwrap_or(false);
    let position = req.position.unwrap_or(0);
    // Owner is never restricted; non-owners can only create roles below themselves.
    if !is_owner {
        if actor_position <= position as i64 {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot create a role at or above your own role"}))).into_response();
        }
    }
    let permissions = req.permissions.unwrap_or(0);
    let name = req.name.trim();
    if name.is_empty() || name.len() > 64 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid role name"}))).into_response();
    }
    if !is_owner {
        let actor_perms = state.db.member_permissions(&server_id, &user_id, None).unwrap_or(0);
        if permissions & !actor_perms != 0 {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot grant permissions you do not hold"}))).into_response();
        }
    }
    let enc_name = req.encrypted_name.as_deref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let name_nonce = req.name_nonce.as_deref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    match state.db.create_role(&server_id, name, req.color.as_deref(), permissions, position, enc_name.as_deref(), name_nonce.as_deref()) {
        Ok(role) => (StatusCode::OK, Json(role_json(&role, actor_position, &[]))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct UpdateRoleRequest {
    pub name: Option<String>,
    #[serde(default)]
    pub color: Option<String>,
    #[serde(default)]
    pub permissions: Option<i64>,
    #[serde(default)]
    pub position: Option<i32>,
    #[serde(default)]
    pub encrypted_name: Option<String>,
    #[serde(default)]
    pub name_nonce: Option<String>,
}

pub async fn update_server_role(
    Path((server_id, role_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpdateRoleRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    // EDIT_ROLES or MANAGE_ROLES (superset) needed to edit.
    if !state.db.member_has_permission(&server_id, &user_id, crate::db::PERM_EDIT_ROLES, None)
        && !state.db.member_has_permission(&server_id, &user_id, crate::db::PERM_MANAGE_ROLES, None) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Missing permission"}))).into_response();
    }
    let role = match state.db.get_role(&role_id) {
        Ok(r) if r.server_id == server_id => r,
        _ => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Role not found"}))).into_response(),
    };
    let actor_position = state.db.member_role_position(&server_id, &user_id).unwrap_or(0);
    let is_owner = state.db.is_server_owner(&user_id, &server_id).unwrap_or(false);
    // Owner is never restricted; non-owners can only modify roles below themselves.
    if !is_owner {
        if actor_position <= role.position as i64 {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot modify a role at or above your own role"}))).into_response();
        }
        if let Some(perms) = req.permissions {
            let actor_perms = state.db.member_permissions(&server_id, &user_id, None).unwrap_or(0);
            // You can only hand out abilities you actually hold yourself.
            if perms & !actor_perms != 0 {
                return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot grant permissions you do not hold"}))).into_response();
            }
        }
    }
    let name = req.name.unwrap_or_else(|| role.name.clone());
    if name.trim().is_empty() || name.len() > 64 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid role name"}))).into_response();
    }
    let color = if req.color.is_some() { req.color.as_deref() } else { role.color.as_deref() };
    let enc_name = req.encrypted_name.as_deref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let name_nonce = req.name_nonce.as_deref().and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    if let Err(e) = state.db.update_role(&role_id, name.trim(), color, req.permissions, enc_name.as_deref(), name_nonce.as_deref()) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
    }
    if let Some(new_pos) = req.position {
        if new_pos >= 0 && (new_pos as i64) < actor_position {
            let _ = state.db.set_role_position(&role_id, new_pos);
        }
    }
    let updated = match state.db.get_role(&role_id) {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let ow = state.db.list_role_overwrites(&role_id).unwrap_or_default();
    (StatusCode::OK, Json(role_json(&updated, actor_position, &ow))).into_response()
}

pub async fn delete_server_role(
    Path((server_id, role_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    // EDIT_ROLES or MANAGE_ROLES (superset) needed to delete.
    if !state.db.member_has_permission(&server_id, &user_id, crate::db::PERM_EDIT_ROLES, None)
        && !state.db.member_has_permission(&server_id, &user_id, crate::db::PERM_MANAGE_ROLES, None) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Missing permission"}))).into_response();
    }
    let role = match state.db.get_role(&role_id) {
        Ok(r) if r.server_id == server_id => r,
        _ => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Role not found"}))).into_response(),
    };
    let actor_position = state.db.member_role_position(&server_id, &user_id).unwrap_or(0);
    let is_owner = state.db.is_server_owner(&user_id, &server_id).unwrap_or(false);
    if !is_owner && actor_position <= role.position as i64 {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot delete a role at or above your own role"}))).into_response();
    }
    match state.db.delete_role(&role_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct RoleOverwriteRequest {
    pub target_type: String,
    pub target_id: String,
    #[serde(default)]
    pub allow: i64,
    #[serde(default)]
    pub deny: i64,
}

/// PUT /api/servers/{sid}/roles/{rid}/overwrite — set (or clear, with 0/0) a
/// role's allow/deny for one channel or one category.
pub async fn set_role_overwrite(
    Path((server_id, role_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<RoleOverwriteRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_ROLES, None) {
        return denied;
    }
    let role = match state.db.get_role(&role_id) {
        Ok(r) if r.server_id == server_id => r,
        _ => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Role not found"}))).into_response(),
    };
    let actor_position = state.db.member_role_position(&server_id, &user_id).unwrap_or(0);
    let is_owner = state.db.is_server_owner(&user_id, &server_id).unwrap_or(false);
    // Owner is never restricted; non-owners can only overwrite roles below themselves.
    if !is_owner {
        if actor_position <= role.position as i64 {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot modify a role at or above your own role"}))).into_response();
        }
    }
    // The target must belong to this server.
    let ok_target = if req.target_type == "channel" {
        state.db.get_server_id_for_channel(&req.target_id).map(|s| s == server_id).unwrap_or(false)
    } else if req.target_type == "category" {
        state.db.get_category_server_id(&req.target_id).map(|s| s == server_id).unwrap_or(false)
    } else {
        false
    };
    if !ok_target {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid target"}))).into_response();
    }
    if !is_owner {
        let actor_perms = state.db.member_permissions(&server_id, &user_id, None).unwrap_or(0);
        if req.allow & !actor_perms != 0 {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot grant permissions you do not hold"}))).into_response();
        }
    }
    match state.db.set_role_overwrite(&role_id, &req.target_type, &req.target_id, req.allow, req.deny) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct SetMemberRoleRequest {
    #[serde(default)]
    pub role_id: Option<String>,
}

/// PUT /api/servers/{sid}/members/{user_id}/role — assign the member's single
/// role (null clears it, falling back to @everyone).
pub async fn set_member_role(
    Path((server_id, target_user_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SetMemberRoleRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_ROLES, None) {
        return denied;
    }
    if !state.db.is_member_of_server(&target_user_id, &server_id).unwrap_or(false) {
        return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Not a member of this server"}))).into_response();
    }
    if state.db.is_server_owner(&target_user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "The server owner cannot be restricted"}))).into_response();
    }
    let actor_position = state.db.member_role_position(&server_id, &user_id).unwrap_or(0);
    let target_position = state.db.member_role_position(&server_id, &target_user_id).unwrap_or(0);
    if actor_position <= target_position {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot manage a member at or above your own role"}))).into_response();
    }
    if let Some(rid) = req.role_id.as_deref() {
        let role = match state.db.get_role(rid) {
            Ok(r) if r.server_id == server_id => r,
            _ => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Role not found"}))).into_response(),
        };
        if actor_position <= role.position as i64 {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot assign a role at or above your own role"}))).into_response();
        }
    }
    match state.db.set_member_role(&server_id, &target_user_id, req.role_id.as_deref()) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// GET /api/servers/{server_id}/my-permissions — the caller's computed
/// permissions, server-wide plus per visible channel (used by the client to
/// hide/disable what it may not do, e.g. the composer in a read-only channel).
pub async fn get_my_permissions(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if !state.db.is_member_of_server(&user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not a member of this server"}))).into_response();
    }
    let is_owner = state.db.is_server_owner(&user_id, &server_id).unwrap_or(false);
    let server_perms = state.db.member_permissions(&server_id, &user_id, None).unwrap_or(0);
    let mut channels = serde_json::Map::new();
    for c in state.db.list_server_channels(&server_id).unwrap_or_default() {
        let perms = state.db.member_permissions(&server_id, &user_id, Some(&c.id)).unwrap_or(0);
        channels.insert(c.id, serde_json::json!(perms));
    }
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "permissions": server_perms,
            "is_owner": is_owner,
            "channels": channels,
        })),
    )
        .into_response()
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
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_VIEW_CHANNEL, Some(&channel_id)) {
        return denied;
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
    let msg_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
    let reactions = state.db.get_message_reactions(&msg_ids).unwrap_or_default();
    let poll_votes = state.db.get_message_poll_votes(&msg_ids).unwrap_or_default();
    let acks = state.db.get_message_acks(&msg_ids).unwrap_or_default();
    let expiries = state.db.get_message_expiries(&msg_ids).unwrap_or_default();

    let mut message_infos: Vec<serde_json::Value> = messages
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
                "reactions": reactions_json(&state, reactions.get(&m.id)),
                "poll_votes": poll_votes_json(&state, poll_votes.get(&m.id)),
                "acks": acks_json(&state, acks.get(&m.id), &user_id, &m.sender_id),
                "expires_at": expiries.get(&m.id).cloned().flatten(),
                "thread_parent_id": m.thread_parent_id,
                "thread_reply_count": 0, // filled below

                "conversation_profile": conv_profiles.get(&m.sender_id).map(|(data, nonce)| serde_json::json!({
                    "encrypted_profile_data": data,
                    "nonce": nonce,
                })),
            })
        })
        .collect();

    // F3: fill thread reply counts for top-level messages
    let parent_ids: Vec<&str> = message_infos.iter()
        .filter(|m| m.get("thread_parent_id").and_then(|v| v.as_str()).is_none())
        .map(|m| m.get("id").and_then(|v| v.as_str()).unwrap())
        .collect();
    if let Ok(counts) = state.db.get_thread_reply_counts(&parent_ids) {
        for mi in message_infos.iter_mut() {
            if mi.get("thread_parent_id").and_then(|v| v.as_str()).is_none() {
                if let Some(id) = mi.get("id").and_then(|v| v.as_str()) {
                    if let Some(count) = counts.get(id) {
                        mi["thread_reply_count"] = serde_json::json!(count);
                    }
                }
            }
        }
    }

    (StatusCode::OK, Json(serde_json::json!(message_infos))).into_response()
}

/// F3: List thread replies for a parent message.
pub async fn list_thread_messages(
    Path((channel_id, parent_id)): Path<(String, String)>,
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
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not a member"}))).into_response();
    }
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_VIEW_CHANNEL, Some(&channel_id)) {
        return denied;
    }
    let limit: i64 = 100;
    let messages = match state.db.list_thread_messages(&parent_id, limit) {
        Ok(m) => m,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let mut sender_ids: Vec<&str> = messages.iter().map(|m| m.sender_id.as_str()).collect();
    sender_ids.dedup();
    let conv_profiles = state.db.get_conversation_profiles_batch("channel", &server_id, &sender_ids).unwrap_or_default();
    let msg_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
    let reactions = state.db.get_message_reactions(&msg_ids).unwrap_or_default();
    let acks = state.db.get_message_acks(&msg_ids).unwrap_or_default();
    let message_infos: Vec<serde_json::Value> = messages.iter().map(|m| {
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
            "pinned": false,
            "reactions": reactions_json(&state, reactions.get(&m.id)),
            "poll_votes": serde_json::json!({}),
            "acks": acks_json(&state, acks.get(&m.id), &user_id, &m.sender_id),
            "expires_at": serde_json::Value::Null,
            "thread_parent_id": m.thread_parent_id,
            "thread_reply_count": 0,
            "conversation_profile": conv_profiles.get(&m.sender_id).map(|(data, nonce)| serde_json::json!({
                "encrypted_profile_data": data, "nonce": nonce,
            })),
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(message_infos))).into_response()
}

/// F4: List channel categories for a server.
pub async fn list_categories(
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
    let categories = state.db.list_categories(&server_id).unwrap_or_default();
    let result: Vec<serde_json::Value> = categories.iter().map(|c| {
        serde_json::json!({
            "id": c.id,
            "server_id": c.server_id,
            "encrypted_name": c.encrypted_name.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
            "name_nonce": c.name_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
            "position": c.position,
        })
    }).collect();
    (StatusCode::OK, Json(serde_json::json!(result))).into_response()
}

/// F4: Create a channel category (owner only).
pub async fn create_category(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    axum::extract::Json(body): axum::extract::Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_CHANNELS, None) {
        return denied;
    }
    let encrypted_name = body.get("encrypted_name").and_then(|v| v.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let name_nonce = body.get("name_nonce").and_then(|v| v.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
    let position = body.get("position").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    match state.db.create_category(&server_id, encrypted_name.as_deref(), name_nonce.as_deref(), position) {
        Ok(cat) => (StatusCode::OK, Json(serde_json::json!({"id": cat.id, "position": cat.position}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// F4: Delete a channel category (owner only).
pub async fn delete_category(
    Path((server_id, category_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_CHANNELS, None) {
        return denied;
    }
    // Prevent deleting the last category
    let cats = state.db.list_categories(&server_id).unwrap_or_default();
    if cats.len() <= 1 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Cannot delete the last category"}))).into_response();
    }
    match state.db.delete_category(&category_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// F4: Rename a channel category (owner only).
pub async fn rename_category(
    Path((server_id, category_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<UpdateEncryptedNameRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_CHANNELS, None) {
        return denied;
    }
    let enc_name = match base64::engine::general_purpose::STANDARD.decode(&req.encrypted_name) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid encrypted_name"}))).into_response(),
    };
    let nonce = match base64::engine::general_purpose::STANDARD.decode(&req.name_nonce) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid name_nonce"}))).into_response(),
    };
    if let Err(e) = state.db.update_category_name(&category_id, Some(&enc_name), Some(&nonce)) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
    }
    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

/// F4: Move a channel to a category (owner only).
pub async fn move_channel_to_category(
    Path((server_id, channel_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    axum::extract::Json(body): axum::extract::Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_CHANNELS, None) {
        return denied;
    }
    let category_id = body.get("category_id").and_then(|v| v.as_str());
    match state.db.move_channel_to_category(&channel_id, category_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// F4: Reorder categories within a server (owner only).
pub async fn reorder_categories(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_CHANNELS, None) {
        return denied;
    }
    let ids: Vec<&str> = match body.get("ordered_ids").and_then(|v| v.as_array()) {
        Some(arr) => arr.iter().filter_map(|v| v.as_str()).collect(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "ordered_ids required"}))).into_response(),
    };
    let refs: Vec<&str> = ids.iter().map(|s| *s).collect();
    match state.db.reorder_categories(&server_id, &refs) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// F4: Reorder channels within a server (owner only).
pub async fn reorder_channels(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_CHANNELS, None) {
        return denied;
    }
    let ids: Vec<&str> = match body.get("ordered_ids").and_then(|v| v.as_array()) {
        Some(arr) => arr.iter().filter_map(|v| v.as_str()).collect(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "ordered_ids required"}))).into_response(),
    };
    let refs: Vec<&str> = ids.iter().map(|s| *s).collect();
    match state.db.reorder_channels(&server_id, &refs) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// Reorder servers in user's sidebar (any user can reorder their own).
pub async fn reorder_servers(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let ids: Vec<&str> = match body.get("ordered_ids").and_then(|v| v.as_array()) {
        Some(arr) => arr.iter().filter_map(|v| v.as_str()).collect(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "ordered_ids required"}))).into_response(),
    };
    let refs: Vec<&str> = ids.iter().map(|s| *s).collect();
    match state.db.reorder_servers(&user_id, &refs) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
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
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_VIEW_CHANNEL, Some(&channel_id)) {
        return denied;
    }
    let messages = match state.db.get_pinned_messages(&channel_id) {
        Ok(m) => m,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let mut sender_ids: Vec<&str> = messages.iter().map(|m| m.sender_id.as_str()).collect();
    sender_ids.dedup();
    let conv_profiles = state.db.get_conversation_profiles_batch("channel", &server_id, &sender_ids).unwrap_or_default();    let msg_ids: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
    let reactions = state.db.get_message_reactions(&msg_ids).unwrap_or_default();
    let poll_votes = state.db.get_message_poll_votes(&msg_ids).unwrap_or_default();
    let acks = state.db.get_message_acks(&msg_ids).unwrap_or_default();
    let expiries = state.db.get_message_expiries(&msg_ids).unwrap_or_default();

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
                "reactions": reactions_json(&state, reactions.get(&m.id)),
                "poll_votes": poll_votes_json(&state, poll_votes.get(&m.id)),
                "acks": acks_json(&state, acks.get(&m.id), &user_id, &m.sender_id),
                "expires_at": expiries.get(&m.id).cloned().flatten(),
                "conversation_profile": conv_profiles.get(&m.sender_id).map(|(data, nonce)| serde_json::json!({
                    "encrypted_profile_data": data,
                    "nonce": nonce,
                })),
            })
        })
        .collect();
    (StatusCode::OK, Json(serde_json::json!(message_infos))).into_response()
}

/// Reorder DM conversations in user sidebar.

/// Block a user.
pub async fn block_user(
    Path(blocked_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if user_id == blocked_id {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Cannot block yourself"}))).into_response();
    }
    match state.db.block_user(&user_id, &blocked_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// Unblock a user.
pub async fn unblock_user(
    Path(blocked_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.unblock_user(&user_id, &blocked_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// Get blocked user list.
pub async fn get_blocked_users(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.get_blocked_users(&user_id) {
        Ok(ids) => (StatusCode::OK, Json(serde_json::json!({"blocked": ids}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn reorder_dms(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let ids: Vec<&str> = match body.get("ordered_ids").and_then(|v| v.as_array()) {
        Some(arr) => arr.iter().filter_map(|v| v.as_str()).collect(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "ordered_ids required"}))).into_response(),
    };
    let refs: Vec<&str> = ids.iter().map(|s| *s).collect();
    match state.db.reorder_dms(&user_id, &refs) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
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
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_VIEW_CHANNEL, Some(&channel_id)) {
        return denied;
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
    let conv_profiles2 = state.db.get_conversation_profiles_batch("channel", &server_id, &sender_ids2).unwrap_or_default();    // Pinned ids so a jump-to-pin (which loads messages around a target) still
    // renders the 📌 badge on the pinned message.
    let pinned_ids2 = state.db.get_pinned_message_ids(&channel_id).unwrap_or_default();
    let msg_ids2: Vec<String> = messages.iter().map(|m| m.id.clone()).collect();
    let reactions2 = state.db.get_message_reactions(&msg_ids2).unwrap_or_default();
    let poll_votes2 = state.db.get_message_poll_votes(&msg_ids2).unwrap_or_default();
    let acks2 = state.db.get_message_acks(&msg_ids2).unwrap_or_default();
    let expiries2 = state.db.get_message_expiries(&msg_ids2).unwrap_or_default();

    let mut message_infos: Vec<serde_json::Value> = messages
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
                "reactions": reactions_json(&state, reactions2.get(&m.id)),
                "poll_votes": poll_votes_json(&state, poll_votes2.get(&m.id)),
                "acks": acks_json(&state, acks2.get(&m.id), &user_id, &m.sender_id),
                "expires_at": expiries2.get(&m.id).cloned().flatten(),
                "thread_parent_id": m.thread_parent_id,
                "thread_reply_count": 0,
                "conversation_profile": conv_profiles2.get(&m.sender_id).map(|(data, nonce)| serde_json::json!({
                    "encrypted_profile_data": data,
                    "nonce": nonce,
                })),
            })
        })
        .collect();

    // F3: fill thread reply counts
    let parent_ids2: Vec<&str> = message_infos.iter()
        .filter(|m| m.get("thread_parent_id").and_then(|v| v.as_str()).is_none())
        .map(|m| m.get("id").and_then(|v| v.as_str()).unwrap())
        .collect();
    if let Ok(counts) = state.db.get_thread_reply_counts(&parent_ids2) {
        for mi in message_infos.iter_mut() {
            if mi.get("thread_parent_id").and_then(|v| v.as_str()).is_none() {
                if let Some(id) = mi.get("id").and_then(|v| v.as_str()) {
                    if let Some(count) = counts.get(id) {
                        mi["thread_reply_count"] = serde_json::json!(count);
                    }
                }
            }
        }
    }

    (StatusCode::OK, Json(serde_json::json!(message_infos))).into_response()
}

// --- Keys ---


pub async fn get_user_id(
    headers: HeaderMap,
    Path(username): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // H4: username → id resolution is private (user enumeration).
    let _user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e,
    };
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
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_SERVER, None) {
        return denied;
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
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_SERVER, None) {
        return denied;
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
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_CHANNELS, None) {
        return denied;
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
    // Per-IP rate limiting: 10 attempts per 5 minutes. Env-overridable for test
    // suites (ADMIN_LOGIN_IP_MAX / ADMIN_LOGIN_IP_WINDOW_SECS), same pattern as
    // the login/friend-request limiters.
    let ip = get_client_ip(&headers);
    let ip_rate_key = format!("admin_login_ip:{}", ip);
    let admin_ip_max: u32 = std::env::var("ADMIN_LOGIN_IP_MAX")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(10);
    let admin_ip_window: u64 = std::env::var("ADMIN_LOGIN_IP_WINDOW_SECS")
        .ok()
        .and_then(|v| v.parse().ok())
        .unwrap_or(300);
    if !ADMIN_LOGIN_IP_RATE_LIMITER.check_and_increment(&ip_rate_key, admin_ip_max, Duration::from_secs(admin_ip_window)) {
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
        // If 2FA is enabled, return a short-lived pre-token instead of the real admin token.
        // The client must then submit a TOTP code to /api/admin/verify-2fa to get the real token.
        if state.db.admin_2fa_enabled().unwrap_or(false) {
            let pre_token = uuid::Uuid::new_v4().to_string();
            store_admin_pre_token(pre_token.clone());
            log_admin_action(&state, "admin_login_2fa_pending", None, &headers);
            return (StatusCode::OK, Json(serde_json::json!({"ok": true, "requires_2fa": true, "pre_token": pre_token}))).into_response();
        }
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

#[derive(Deserialize)]
pub struct AdminVerify2FaRequest {
    pub code: String,
    pub pre_token: String,
}

pub async fn admin_verify_2fa(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AdminVerify2FaRequest>,
) -> impl IntoResponse {
    // Validate pre-token exists (it was issued during password verification)
    let guard = get_admin_tokens();
    let map = match guard.as_ref() {
        Some(m) => m,
        None => {
            return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Invalid or expired session"}))).into_response();
        }
    };
    match map.get(&req.pre_token) {
        Some(expiry) if *expiry > Instant::now() => {}
        _ => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Invalid or expired session"}))).into_response(),
    }
    drop(guard);

    // Verify TOTP code
    let secret_row = match state.db.get_admin_totp() {
        Ok(Some(r)) => r,
        _ => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "2FA not configured"}))).into_response(),
    };
    let secret = match totp::decrypt_secret(&secret_row.0, &secret_row.1, &state.config.jwt_secret) {
        Ok(s) => s,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let mut code_valid = totp::verify_totp(&secret, &req.code, 1);
    if !code_valid {
        // Try recovery codes
        let code_hash = totp::hash_recovery_code(&secret_row.2, &req.code);
        let codes = state.db.list_admin_recovery_hashes().unwrap_or_default();
        let found = codes.iter().any(|(h, used)| h == &code_hash && !*used);
        if found {
            code_valid = true;
            let _ = state.db.mark_admin_recovery_used(&code_hash);
        }
    }
    if !code_valid {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Invalid code"}))).into_response();
    }

    // Remove the pre-token and issue the real admin token
    remove_admin_token(&req.pre_token);
    let admin_token = uuid::Uuid::new_v4().to_string();
    store_admin_token(admin_token.clone());
    log_admin_action(&state, "admin_login_2fa_complete", None, &HeaderMap::new());
    (StatusCode::OK, Json(serde_json::json!({"ok": true, "token": admin_token}))).into_response()
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

    // Map user_id → 2FA status so the panel can show who has it enabled.
    let twofa: std::collections::HashMap<String, bool> = state
        .db
        .list_users_with_2fa()
        .unwrap_or_default()
        .into_iter()
        .map(|(id, _uname, on)| (id, on))
        .collect();

    let user_infos: Vec<serde_json::Value> = users
        .iter()
        .map(|(id, username, _pw_hash, created_at, _display_name, identity_public_key, profile_picture_file_id, friend_requests_disabled, encrypted_friend_code, friend_code_salt, friend_code_nonce, encrypted_profile_data, encrypted_profile_salt, encrypted_profile_nonce, profile_banner_file_id, _description, _nickname, friend_code_hash, encrypted_hash_key, hash_key_salt, hash_key_nonce)| {
            serde_json::json!({
                "id": id,
                "username": username,
                "created_at": created_at,
                "two_factor_enabled": twofa.get(id).copied().unwrap_or(false),
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

pub async fn admin_disable_user_2fa(
    headers: HeaderMap,
    Path(user_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }
    if !state.db.totp_enabled(&user_id).unwrap_or(false) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "2FA is not enabled for this user"})),
        )
            .into_response();
    }
    if let Err(e) = state.db.delete_totp(&user_id) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": e})),
        )
            .into_response();
    }
    log_admin_action(&state, "admin_disable_2fa", Some(&user_id), &headers);
    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

// --- Admin panel 2FA (protects admin login itself) ---

pub async fn admin_2fa_status(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let enabled = state.db.admin_2fa_enabled().unwrap_or(false);
    (StatusCode::OK, Json(serde_json::json!({"enabled": enabled}))).into_response()
}

#[derive(Deserialize)]
pub struct AdminEnroll2FaRequest {
    pub password: String,
}

pub async fn admin_enroll_2fa(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AdminEnroll2FaRequest>,
) -> impl IntoResponse {
    if state.db.admin_2fa_enabled().unwrap_or(false) {
        return (StatusCode::CONFLICT, Json(serde_json::json!({"error": "2FA is already enabled"}))).into_response();
    }
    // Verify admin password before allowing enrollment
    let stored_hash = match state.db.get_admin_password_hash() {
        Ok(Some(h)) => h,
        _ => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Admin password not configured"}))).into_response(),
    };
    let valid = match auth::verify_password(&req.password, &stored_hash) {
        Ok(v) => v,
        Err(_) => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Wrong password"}))).into_response(),
    };
    if !valid {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Wrong password"}))).into_response();
    }

    let secret = totp::generate_secret();
    let salt: String = {
        use rand::Rng;
        rand::thread_rng().gen::<[u8; 16]>().iter().map(|b| format!("{:02x}", b)).collect()
    };
    let codes = totp::generate_recovery_codes(8);
    {
        let mut pending = PENDING_2FA_ENROLL.lock().unwrap();
        pending.insert("admin".to_string(), (secret.clone(), salt, codes.clone(), Instant::now()));
    }
    let otpauth = totp::otpauth_uri("E2E Chat", "admin", &secret);
    (StatusCode::OK, Json(serde_json::json!({
        "secret_base32": secret,
        "otpauth_url": otpauth,
        "recovery_codes": codes,
    }))).into_response()
}

#[derive(Deserialize)]
pub struct AdminVerifyEnroll2FaRequest {
    pub code: String,
}

pub async fn admin_verify_enroll_2fa(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AdminVerifyEnroll2FaRequest>,
) -> impl IntoResponse {
    let entry = {
        let mut pending = PENDING_2FA_ENROLL.lock().unwrap();
        match pending.get("admin") {
            Some((secret, salt, codes, exp)) => {
                if Instant::now().duration_since(*exp) > PENDING_2FA_TTL {
                    pending.remove("admin");
                    return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Enrollment expired. Please start over."}))).into_response();
                }
                (secret.clone(), salt.clone(), codes.clone())
            }
            None => {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "No pending enrollment. Please start over."}))).into_response();
            }
        }
    };
    if !totp::verify_totp(&entry.0, &req.code, 1) {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Invalid code"}))).into_response();
    }
    let (ct, nonce) = match totp::encrypt_secret(&entry.0, &state.config.jwt_secret) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    if let Err(e) = state.db.save_admin_totp(&ct, &nonce, &entry.1) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
    }
    let hashes: Vec<String> = entry.2.iter()
        .map(|c| totp::hash_recovery_code(&entry.1, c))
        .collect();
    if let Err(e) = state.db.save_admin_recovery_hashes(&hashes) {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
    }
    {
        let mut pending = PENDING_2FA_ENROLL.lock().unwrap();
        pending.remove("admin");
    }
    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

#[derive(Deserialize)]
pub struct AdminDisable2FaRequest {
    pub code: String,
}

pub async fn admin_disable_self_2fa(
    State(state): State<Arc<AppState>>,
    Json(req): Json<AdminDisable2FaRequest>,
) -> impl IntoResponse {
    if !state.db.admin_2fa_enabled().unwrap_or(false) {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "2FA is not enabled"}))).into_response();
    }
    let secret_row = match state.db.get_admin_totp() {
        Ok(Some(r)) => r,
        _ => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "2FA not configured"}))).into_response(),
    };
    let secret = match totp::decrypt_secret(&secret_row.0, &secret_row.1, &state.config.jwt_secret) {
        Ok(s) => s,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    let mut code_valid = totp::verify_totp(&secret, &req.code, 1);
    if !code_valid {
        let code_hash = totp::hash_recovery_code(&secret_row.2, &req.code);
        let codes = state.db.list_admin_recovery_hashes().unwrap_or_default();
        let found = codes.iter().any(|(h, used)| h == &code_hash && !*used);
        if found {
            code_valid = true;
            let _ = state.db.mark_admin_recovery_used(&code_hash);
        }
    }
    if !code_valid {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Invalid code"}))).into_response();
    }
    if let Err(e) = state.db.delete_admin_totp() {
        return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
    }
    (StatusCode::OK, Json(serde_json::json!({"ok": true, "enabled": false}))).into_response()
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

    match delete_account_and_cleanup(&state, &user_id).await {
        Ok(_) => {
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

/// Effective G2 runtime limits + where each value came from ("db"|"env"|"default").
pub async fn admin_get_runtime_config(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }
    let tuning = state.runtime_tuning.read().unwrap();
    // F5 — include the live IP-redaction toggle (env or admin_config).
    let redact = std::env::var("ADMIN_AUDIT_REDACT_IPS")
        .ok()
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
        || state
            .db
            .get_config_value("admin_audit_redact_ips")
            .ok()
            .flatten()
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "mutation_user_max": tuning.mutation_user_max,
            "mutation_ip_max": tuning.mutation_ip_max,
            "file_storage_quota_bytes": tuning.file_storage_quota_bytes,
            "max_file_size_mb": tuning.max_file_size_mb,
            "admin_audit_redact_ips": redact,
            "sources": {
                "mutation_user_max": tuning.sources[0],
                "mutation_ip_max": tuning.sources[1],
                "file_storage_quota_bytes": tuning.sources[2],
                "max_file_size_mb": tuning.sources[3],
            },
        })),
    )
        .into_response()
}

#[derive(serde::Deserialize)]
pub struct AdminSetRuntimeConfigRequest {
    #[serde(default)]
    pub mutation_user_max: Option<u64>,
    #[serde(default)]
    pub mutation_ip_max: Option<u64>,
    #[serde(default)]
    pub file_storage_quota_bytes: Option<i64>,
    /// Max single-file upload size in MB (0 = unlimited, default 1024).
    #[serde(default)]
    pub max_file_size_mb: Option<i64>,
    /// F5 — when true, admin audit entries store a redacted placeholder
    /// instead of the raw client IP (privacy toggle, live-applied).
    #[serde(default)]
    pub admin_audit_redact_ips: Option<bool>,
}

/// Persist new G2 limits in admin_config and apply them live (no restart).
/// Every field is optional; only the provided ones are changed. `0` disables
/// the limit. The mutation budgets are u32; anything larger is rejected.
pub async fn admin_set_runtime_config(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<AdminSetRuntimeConfigRequest>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    if req.mutation_user_max.is_none()
        && req.mutation_ip_max.is_none()
        && req.file_storage_quota_bytes.is_none()
        && req.max_file_size_mb.is_none()
        && req.admin_audit_redact_ips.is_none()
    {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Provide at least one value to update"})),
        )
            .into_response();
    }

    if let Some(v) = req.mutation_user_max {
        if u32::try_from(v).is_err() {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "mutation_user_max must fit in u32 (0 = unlimited)"})),
            )
                .into_response();
        }
    }
    if let Some(v) = req.mutation_ip_max {
        if u32::try_from(v).is_err() {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "mutation_ip_max must fit in u32 (0 = unlimited)"})),
            )
                .into_response();
        }
    }
    if let Some(v) = req.file_storage_quota_bytes {
        if v < 0 {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "file_storage_quota_bytes must be >= 0 (0 = unlimited)"})),
            )
                .into_response();
        }
    }
    if let Some(v) = req.max_file_size_mb {
        if v < 0 {
            return (
                StatusCode::BAD_REQUEST,
                Json(serde_json::json!({"error": "max_file_size_mb must be >= 0 (0 = unlimited)"})),
            )
                .into_response();
        }
    }

    let mut summary = Vec::new();
    {
        let mut tuning = state.runtime_tuning.write().unwrap();
        if let Some(v) = req.mutation_user_max {
            tuning.mutation_user_max = v as u32;
            tuning.sources[0] = "db";
            let _ = state.db.set_config_value("mutation_user_max", &v.to_string());
            summary.push(format!("mutation_user_max={}", v));
        }
        if let Some(v) = req.mutation_ip_max {
            tuning.mutation_ip_max = v as u32;
            tuning.sources[1] = "db";
            let _ = state.db.set_config_value("mutation_ip_max", &v.to_string());
            summary.push(format!("mutation_ip_max={}", v));
        }
        if let Some(v) = req.file_storage_quota_bytes {
            tuning.file_storage_quota_bytes = v;
            tuning.sources[2] = "db";
            let _ = state.db.set_config_value("file_storage_quota_bytes", &v.to_string());
            summary.push(format!("file_storage_quota_bytes={}", v));
        }
        if let Some(v) = req.max_file_size_mb {
            tuning.max_file_size_mb = v;
            tuning.sources[3] = "db";
            let _ = state.db.set_config_value("max_file_size_mb", &v.to_string());
            summary.push(format!("max_file_size_mb={}", v));
        }
        // F5 — IP redaction toggle (live-applied; read on every audit write).
        if let Some(v) = req.admin_audit_redact_ips {
            let _ = state.db.set_config_value("admin_audit_redact_ips", if v { "1" } else { "0" });
            summary.push(format!("admin_audit_redact_ips={}", v));
        }
    }
    log_admin_action(&state, "admin_set_runtime_config", Some(&summary.join(", ")), &headers);

    let tuning = state.runtime_tuning.read().unwrap();
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "ok": true,
            "mutation_user_max": tuning.mutation_user_max,
            "mutation_ip_max": tuning.mutation_ip_max,
            "file_storage_quota_bytes": tuning.file_storage_quota_bytes,
            "max_file_size_mb": tuning.max_file_size_mb,
        })),
    )
        .into_response()
}

/// Live mutation-limit usage for the admin panel: top per-user + per-IP buckets
/// (count, current limit, seconds left in the 10s window) and the most recent
/// 429s, with usernames resolved so hosts can spot abusive accounts at a glance.
pub async fn admin_get_rate_limit_usage(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }

    let window = Duration::from_secs(10);
    let (user_limit, ip_limit) = {
        let tuning = state.runtime_tuning.read().unwrap();
        (tuning.mutation_user_max, tuning.mutation_ip_max)
    };

    let mut users: Vec<(String, u32, u64)> = MUTATION_USER_RATE_LIMITER
        .snapshot(window)
        .into_iter()
        .filter_map(|(k, c, r)| k.strip_prefix("mut_user:").map(|id| (id.to_string(), c, r)))
        .collect();
    users.sort_by(|a, b| b.1.cmp(&a.1));
    users.truncate(10);
    let user_rows: Vec<serde_json::Value> = users
        .into_iter()
        .map(|(id, count, remaining)| {
            let username = state
                .db
                .get_username_by_id(&id)
                .ok()
                .flatten()
                .unwrap_or_else(|| id.clone());
            serde_json::json!({
                "user_id": id, "username": username, "count": count,
                "limit": user_limit, "window_remaining_s": remaining,
            })
        })
        .collect();

    let mut ips: Vec<(String, u32, u64)> = MUTATION_IP_RATE_LIMITER
        .snapshot(window)
        .into_iter()
        .filter_map(|(k, c, r)| k.strip_prefix("mut_ip:").map(|ip| (ip.to_string(), c, r)))
        .collect();
    ips.sort_by(|a, b| b.1.cmp(&a.1));
    ips.truncate(10);
    let ip_rows: Vec<serde_json::Value> = ips
        .into_iter()
        .map(|(ip, count, remaining)| {
            serde_json::json!({
                "ip": ip, "count": count,
                "limit": ip_limit, "window_remaining_s": remaining,
            })
        })
        .collect();

    let hits: Vec<serde_json::Value> = {
        let q = MUTATION_429_HITS.lock().unwrap();
        q.iter().rev().take(50).map(|h| {
            let username = h
                .user_id
                .as_ref()
                .and_then(|id| state.db.get_username_by_id(id).ok().flatten());
            serde_json::json!({
                "user_id": h.user_id.clone().unwrap_or_default(),
                "username": username.unwrap_or_else(|| "—".to_string()),
                "ip": h.ip,
                "ts": h.ts,
            })
        }).collect()
    };

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "window_seconds": 10,
            "users": user_rows,
            "ips": ip_rows,
            "recent_429s": hits,
            "last_updated": std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0),
        })),
    )
        .into_response()
}

// F4 — legacy X3DH admin listers (prekey-bundles / sessions / user-public-keys)
// removed with migration 057; the tables no longer exist.

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
/// F5 — IP redaction toggle: when the admin_config row `admin_audit_redact_ips`
/// is "1" (admin-config tab, live) or the ADMIN_AUDIT_REDACT_IPS env var is
/// set to 1/true, the raw client IP is replaced by a placeholder in the log.
fn log_admin_action(state: &AppState, action: &str, target: Option<&str>, headers: &HeaderMap) {
    let ip = get_client_ip(headers);
    let redact = std::env::var("ADMIN_AUDIT_REDACT_IPS")
        .ok()
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false)
        || state
            .db
            .get_config_value("admin_audit_redact_ips")
            .ok()
            .flatten()
            .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
            .unwrap_or(false);
    let stored_ip = if redact { "*.*.*.*" } else { ip.as_str() };
    if let Err(e) = state.db.log_admin_action("admin", action, target, stored_ip) {
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

    match state.db.clear_all(&state.config.upload_dir) {
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

/// GET /api/admin/tables — every table in the DB with its row count
/// (raw-table browser so the panel always reflects added/removed tables).
pub async fn admin_list_tables(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }
    match state.db.admin_list_tables() {
        Ok(rows) => {
            let list: Vec<serde_json::Value> = rows
                .iter()
                .map(|(name, count)| serde_json::json!({ "name": name, "count": count }))
                .collect();
            (StatusCode::OK, Json(serde_json::json!(list))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// GET /api/admin/table/{name} — columns + rows (latest-first, capped at 1000)
/// for one table.
pub async fn admin_table_rows(
    Path(table): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }
    match state.db.admin_table_rows(&table) {
        Ok((cols, rows)) => (StatusCode::OK, Json(serde_json::json!({"table": table, "columns": cols, "rows": rows}))).into_response(),
        Err(e) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e}))).into_response(),
    }
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

/// POST /api/admin/import-db — upload a SQLite database file to replace the current one.
/// Query param `dry_run=1` validates the file (integrity check + table census) on a
/// temp copy WITHOUT touching the live database.
pub async fn admin_import_db(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
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

    // Dry-run: validate a staged copy and report without replacing anything.
    // An optional `table` param returns a row preview from that table instead
    // of the census (columns + latest rows, read-only from the staged copy).
    if params.get("dry_run").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false) {
        if let Some(table) = params.get("table") {
            if table.trim().is_empty() {
                return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Empty table name"}))).into_response();
            }
            return preview_import_table(&body, table).into_response();
        }
        return validate_import_db(&body).into_response();
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

/// Bundle format shared by the uploads export/import endpoints:
///   [4-byte LE manifest_len][manifest JSON utf8][payload bytes]
/// where manifest = [{file_id, chunks: [byte_len, ...]}, ...] and payload is
/// every chunk's bytes concatenated in manifest order. The client folds this
/// (plus the DB) into one inner payload for the admin backup so an export →
/// wipe → import round-trip restores uploaded images too (a DB-only backup
/// leaves every file row dangling — "the picture name remains, the bytes are
/// gone").
const UPLOADS_BUNDLE_MAGIC_HEADER: u8 = 0xDB;

fn read_u32_le(b: &[u8], off: usize) -> Option<u32> {
    if off + 4 > b.len() { return None; }
    Some(u32::from_le_bytes([b[off], b[off + 1], b[off + 2], b[off + 3]]))
}

fn push_u32_le(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// GET /api/admin/export-uploads — stream every uploaded file chunk as a
/// manifest + payload bundle (same shape the client embeds in the backup).
pub async fn admin_export_uploads(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }
    log_admin_action(&state, "admin_export_uploads", None, &headers);

    let upload_dir = &state.config.upload_dir;
    let mut manifest: Vec<serde_json::Value> = Vec::new();
    let mut payload: Vec<u8> = Vec::new();
    let mut total_chunks = 0usize;

    let entries = match std::fs::read_dir(upload_dir) {
        Ok(e) => e,
        Err(_) => {
            // No uploads dir yet — a valid empty bundle (manifest [], payload []).
            let manifest_bytes = serde_json::to_vec(&manifest).unwrap_or_default();
            let mut out = Vec::with_capacity(4 + manifest_bytes.len());
            push_u32_le(&mut out, manifest_bytes.len() as u32);
            out.extend_from_slice(&manifest_bytes);
            return (StatusCode::OK, [( "content-type", "application/octet-stream")], out).into_response();
        }
    };

    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() { continue; }
        let file_id = match path.file_name().and_then(|n| n.to_str()) {
            Some(n) => n.to_string(),
            None => continue,
        };
        let mut chunk_lens: Vec<u32> = Vec::new();
        let mut i = 0u32;
        loop {
            let chunk_path = format!("{}/{}/{}.enc", upload_dir, file_id, i);
            match std::fs::read(&chunk_path) {
                Ok(bytes) => {
                    chunk_lens.push(bytes.len() as u32);
                    payload.extend_from_slice(&bytes);
                    total_chunks += 1;
                    i += 1;
                }
                Err(_) => break,
            }
        }
        if !chunk_lens.is_empty() {
            manifest.push(serde_json::json!({"file_id": file_id, "chunks": chunk_lens}));
        }
    }

    let manifest_bytes = match serde_json::to_vec(&manifest) {
        Ok(m) => m,
        Err(e) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Failed to encode uploads manifest: {}", e)}))).into_response();
        }
    };
    let mut out = Vec::with_capacity(4 + manifest_bytes.len() + payload.len());
    push_u32_le(&mut out, manifest_bytes.len() as u32);
    out.extend_from_slice(&manifest_bytes);
    out.extend_from_slice(&payload);
    tracing::info!("admin export-uploads: {} files, {} chunks, {} bytes", manifest.len(), total_chunks, payload.len());
    (
        StatusCode::OK,
        [("content-type", "application/octet-stream")],
        out,
    )
        .into_response()
}

/// Parse a uploads bundle (manifest + payload) into (file_id, chunk lens, bytes).
fn parse_uploads_bundle(body: &[u8]) -> Result<Vec<(String, Vec<u32>, Vec<u8>)>, String> {
    if body.len() < 4 {
        return Err("Uploads bundle too small".to_string());
    }
    let manifest_len = read_u32_le(body, 0).unwrap() as usize;
    if 4 + manifest_len > body.len() {
        return Err("Uploads bundle manifest overflows the payload".to_string());
    }
    let manifest: Vec<serde_json::Value> = serde_json::from_slice(&body[4..4 + manifest_len])
        .map_err(|e| format!("Uploads bundle manifest is not valid JSON: {}", e))?;
    let mut cursor = 4 + manifest_len;
    let mut files: Vec<(String, Vec<u32>, Vec<u8>)> = Vec::new();
    for item in &manifest {
        let file_id = item.get("file_id").and_then(|v| v.as_str()).unwrap_or("").to_string();
        // Path-traversal guard: the id must be a single safe path segment.
        if file_id.is_empty()
            || file_id.contains('/')
            || file_id.contains('\\')
            || file_id == "."
            || file_id == ".."
        {
            return Err(format!("Uploads bundle contains an unsafe file id: {:?}", file_id));
        }
        let chunks = item.get("chunks").and_then(|v| v.as_array()).cloned().unwrap_or_default();
        let mut lens: Vec<u32> = Vec::with_capacity(chunks.len());
        let mut bytes: Vec<u8> = Vec::new();
        for c in &chunks {
            let len = c.as_u64().unwrap_or(0);
            if len as usize > body.len() - cursor {
                return Err(format!("Uploads bundle truncated for file {}", file_id));
            }
            bytes.extend_from_slice(&body[cursor..cursor + len as usize]);
            lens.push(len as u32);
            cursor += len as usize;
        }
        if !lens.is_empty() {
            files.push((file_id, lens, bytes));
        }
    }
    if cursor != body.len() {
        return Err("Uploads bundle has trailing bytes after the payload".to_string());
    }
    Ok(files)
}

/// POST /api/admin/import-uploads — restore uploaded file chunks from a bundle.
/// `?dry_run=1` parses + cross-checks against the live DB without writing.
pub async fn admin_import_uploads(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(params): Query<HashMap<String, String>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    if let Err(e) = extract_admin_token(&headers) {
        return e.into_response();
    }
    let dry_run = params.get("dry_run").map(|v| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false);
    let files = match parse_uploads_bundle(&body) {
        Ok(f) => f,
        Err(e) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": e}))).into_response(),
    };

    if dry_run {
        // Cross-check each bundle file against the LIVE files table: a file in
        // the bundle without a DB row would be swept as an orphan by cleanup.
        let mut missing: Vec<String> = Vec::new();
        for (file_id, _, _) in &files {
            if state.db.get_file_info(file_id).is_err() {
                missing.push(file_id.clone());
            }
        }
        return (
            StatusCode::OK,
            Json(serde_json::json!({
                "ok": true,
                "dry_run": true,
                "files": files.len(),
                "chunks": files.iter().map(|(_, l, _)| l.len()).sum::<usize>(),
                "bytes": files.iter().map(|(_, _, b)| b.len()).sum::<usize>(),
                "missing_rows": missing.len(),
                "missing_file_ids": missing.iter().take(50).cloned().collect::<Vec<_>>(),
            })),
        )
            .into_response();
    }

    let upload_dir = &state.config.upload_dir;
    let mut written_files = 0usize;
    let mut written_bytes = 0usize;
    for (file_id, lens, bytes) in &files {
        let dir = format!("{}/{}", upload_dir, file_id);
        if let Err(e) = std::fs::create_dir_all(&dir) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Failed to create upload dir for {}: {}", file_id, e)}))).into_response();
        }
        let mut cursor = 0usize;
        for (i, len) in lens.iter().enumerate() {
            let chunk = &bytes[cursor..cursor + *len as usize];
            cursor += *len as usize;
            let chunk_path = format!("{}/{}.enc", dir, i);
            if let Err(e) = std::fs::write(&chunk_path, chunk) {
                return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": format!("Failed to write {}: {}", chunk_path, e)}))).into_response();
            }
            written_bytes += chunk.len();
        }
        written_files += 1;
    }
    log_admin_action(&state, "admin_import_uploads", None, &headers);
    (
        StatusCode::OK,
        Json(serde_json::json!({"ok": true, "files": written_files, "bytes": written_bytes})),
    )
        .into_response()
}

/// Preview columns + latest rows of one table from a candidate SQLite database
/// on a temp copy (dry-run import with `table`). The live DB is untouched.
fn preview_import_table(body: &[u8], table: &str) -> (StatusCode, Json<serde_json::Value>) {
    // Stage the file in the system temp dir with a unique name.
    let mut tmp_path = std::env::temp_dir();
    let unique = format!(
        "e2e_import_dryrun_{}_{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    tmp_path.push(unique);
    let tmp_str = tmp_path.to_string_lossy().into_owned();

    if let Err(e) = std::fs::write(&tmp_str, body) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Could not stage file for preview: {}", e)})),
        );
    }

    let result = (|| -> Result<serde_json::Value, String> {
        let conn = rusqlite::Connection::open_with_flags(
            &tmp_str,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("Could not open as SQLite: {}", e))?;

        // The table must exist in THIS backup (quoted safely below).
        let exists: bool = conn
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name = ?1)",
                rusqlite::params![table],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            return Err(format!("Table not found in this backup: {}", table));
        }
        let safe_name = table.replace('"', "\"\"");

        let cols: Vec<String> = {
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info(\"{}\")", safe_name))
                .map_err(|e| e.to_string())?;
            let mut out = Vec::new();
            let mut q = stmt.query([]).map_err(|e| e.to_string())?;
            while let Some(row) = q.next().map_err(|e| e.to_string())? {
                out.push(row.get::<_, String>(1).map_err(|e| e.to_string())?);
            }
            out
        };

        // Latest rows first (same ordering the Raw Tables browser uses).
        let sql = format!("SELECT * FROM \"{}\" ORDER BY rowid DESC LIMIT 100", safe_name);
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let mut rows: Vec<Vec<serde_json::Value>> = Vec::new();
        let mut q = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = q.next().map_err(|e| e.to_string())? {
            let mut r = Vec::new();
            for i in 0..cols.len() {
                let v: rusqlite::types::Value = row.get(i).map_err(|e| e.to_string())?;
                let jv = match v {
                    rusqlite::types::Value::Null => serde_json::Value::Null,
                    rusqlite::types::Value::Integer(i) => serde_json::Value::from(i),
                    rusqlite::types::Value::Real(f) => serde_json::Value::from(f),
                    rusqlite::types::Value::Text(t) => serde_json::Value::String(t),
                    rusqlite::types::Value::Blob(b) => {
                        serde_json::Value::String(base64::engine::general_purpose::STANDARD.encode(b))
                    }
                };
                r.push(jv);
            }
            rows.push(r);
        }

        Ok(serde_json::json!({
            "ok": true,
            "dry_run": true,
            "table": table,
            "columns": cols,
            "rows": rows,
            "row_count": rows.len(),
        }))
    })();

    // Always clean up the staged copy AND its WAL/SHM sidecars (opening the
    // temp DB in WAL mode leaves -wal/-shm files behind that would otherwise
    // accumulate in the server directory forever).
    let _ = std::fs::remove_file(&tmp_str);
    let _ = std::fs::remove_file(format!("{}-wal", tmp_str));
    let _ = std::fs::remove_file(format!("{}-shm", tmp_str));

    match result {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": format!("Invalid database: {}", e)})),
        ),
    }
}

/// Validate a candidate SQLite database on a temp copy (dry-run import).
/// Returns integrity status plus a per-table census; the live DB is untouched.
fn validate_import_db(body: &[u8]) -> (StatusCode, Json<serde_json::Value>) {
    // Stage the file in the system temp dir with a unique name.
    let mut tmp_path = std::env::temp_dir();
    let unique = format!(
        "e2e_import_dryrun_{}_{}.db",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    );
    tmp_path.push(unique);
    let tmp_str = tmp_path.to_string_lossy().into_owned();

    if let Err(e) = std::fs::write(&tmp_str, body) {
        return (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({"error": format!("Could not stage file for validation: {}", e)})),
        );
    }

    let result = (|| -> Result<serde_json::Value, String> {
        let conn = rusqlite::Connection::open_with_flags(
            &tmp_str,
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .map_err(|e| format!("Could not open as SQLite: {}", e))?;

        // Integrity check — every row must read "ok".
        let mut stmt = conn
            .prepare("PRAGMA integrity_check")
            .map_err(|e| e.to_string())?;
        let rows: Vec<String> = stmt
            .query_map([], |r| r.get(0))
            .map_err(|e| e.to_string())?
            .collect::<Result<_, _>>()
            .map_err(|e| e.to_string())?;
        let integrity_ok = rows.iter().all(|r| r == "ok");

        // Foreign-key sanity: list violations without failing the run.
        let mut fk_stmt = conn
            .prepare("PRAGMA foreign_key_check")
            .map_err(|e| e.to_string())?;
        let fk_rows = fk_stmt
            .query_map([], |r| {
                Ok(format!(
                    "{}: {} row {} references {}",
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, i64>(3)?
                ))
            })
            .map_err(|e| e.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;

        // Per-table on-disk size in bytes (data + indexes) via the dbstat
        // virtual table; falls back to None when dbstat is unavailable.
        // total_size_bytes comes from the staged file itself (authoritative).
        let total_size_bytes = std::fs::metadata(&tmp_str)
            .map(|m| m.len() as i64)
            .unwrap_or(0);
        let mut per_table_bytes: HashMap<String, i64> = HashMap::new();
        let dbstat_ok = conn
            .prepare(
                "SELECT m.tbl_name, SUM(d.pgsize) FROM \
                 (SELECT name, pgsize FROM dbstat WHERE aggregate = TRUE) d \
                 JOIN sqlite_master m ON m.name = d.name \
                 GROUP BY m.tbl_name",
            )
            .and_then(|mut stmt| {
                let rows = stmt.query_map([], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
                });
                match rows {
                    Ok(iter) => {
                        for row in iter.flatten() {
                            per_table_bytes.insert(row.0, row.1);
                        }
                        Ok(())
                    }
                    Err(e) => Err(e),
                }
            });
        let dbstat_ok = dbstat_ok.is_ok();

        // Table census.
        let mut tables: Vec<serde_json::Value> = Vec::new();
        {
            let mut stmt = conn
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
                .map_err(|e| e.to_string())?;
            let names: Vec<String> = stmt
                .query_map([], |r| r.get(0))
                .map_err(|e| e.to_string())?
                .collect::<Result<_, _>>()
                .map_err(|e| e.to_string())?;
            for name in names {
                let count: i64 = conn
                    .query_row(
                        &format!("SELECT COUNT(*) FROM \"{}\"", name.replace('"', "\"\"")),
                        [],
                        |r| r.get(0),
                    )
                    .map_err(|e| format!("table {}: {}", name, e))?;
                let bytes = if dbstat_ok { per_table_bytes.get(&name).copied() } else { None };
                tables.push(serde_json::json!({"name": name, "count": count, "size_bytes": bytes}));
            }
        }

        Ok(serde_json::json!({
            "ok": true,
            "dry_run": true,
            "integrity_ok": integrity_ok,
            "integrity": rows,
            "foreign_key_violations": fk_rows,
            "tables": tables,
            "table_count": tables.len(),
            "total_size_bytes": total_size_bytes,
        }))
    })();

    // Always clean up the staged copy AND its WAL/SHM sidecars (opening the
    // temp DB in WAL mode leaves -wal/-shm files behind that would otherwise
    // accumulate in the server directory forever).
    let _ = std::fs::remove_file(&tmp_str);
    let _ = std::fs::remove_file(format!("{}-wal", tmp_str));
    let _ = std::fs::remove_file(format!("{}-shm", tmp_str));

    match result {
        Ok(value) => (StatusCode::OK, Json(value)),
        Err(e) => (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": format!("Invalid database: {}", e)})),
        ),
    }
}

// ===== Phase 5: File Sharing =====


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

    // Max single-file size, runtime-tunable from the admin panel (MB; DB →
    // env MAX_FILE_SIZE_MB → 1024 MB default). 0 disables the cap.
    let max_file_bytes = state.runtime_tuning.read().unwrap().max_file_size_mb * 1024 * 1024;
    if max_file_bytes > 0 && req.size > max_file_bytes {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({"error": "File too large"})),
        )
            .into_response();
    }

    // G2 storage quota: reject the init if the user would exceed their cap.
    // Runtime-tunable from the admin panel (DB → env → 1 GiB default). 0 disables.
    let quota: i64 = state.runtime_tuning.read().unwrap().file_storage_quota_bytes;
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
            let dir = format!("{}/{}", state.config.upload_dir, file_id);
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

    // H1: a single chunk must stay small (the client splits plaintext into
    // 64 KB chunks, so an encrypted chunk is ≤ 65624 bytes; 1 MiB is a generous
    // bound that still stops one oversized write).
    if body.len() > 1024 * 1024 {
        return (
            StatusCode::PAYLOAD_TOO_LARGE,
            Json(serde_json::json!({"error": "Chunk too large"})),
        )
            .into_response();
    }

    // H1: cumulative enforcement — the running total of DISTINCT chunk bytes
    // may never exceed the declared size plus the per-chunk AEAD overhead
    // (client: 40 bytes/chunk). This makes the init-time quota / max-file
    // checks actually binding: a client that declares size=1 cannot write
    // unlimited chunks past it.
    let chunk_path = format!("{}/{}/{}.enc", state.config.upload_dir, file_id, index);
    let old_size: i64 = match tokio::fs::metadata(&chunk_path).await {
        Ok(m) => m.len() as i64,
        Err(_) => 0,
    };
    let delta: i64 = body.len() as i64 - old_size;
    let orig: i64 = file_info.original_size.max(0);
    let total_chunks = orig / 65536 + if orig % 65536 == 0 { 0 } else { 1 };
    let allowed = orig + 64 * total_chunks;
    match state.db.charge_file_chunk(&file_id, delta, allowed) {
        Ok(true) => {}
        Ok(false) => {
            return (
                StatusCode::PAYLOAD_TOO_LARGE,
                Json(serde_json::json!({"error": "Upload exceeds declared size"})),
            )
                .into_response();
        }
        Err(e) => {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": e})),
            )
                .into_response();
        }
    }

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

    // H1: the cumulative bytes on disk must match the declared size (within the
    // per-chunk AEAD overhead). This catches a client that declared size=1 but
    // wrote far past it — including across a server restart that lost the
    // incremental meter (the write-time check only sees the running total).
    let chunk_bytes = state.db.get_file_chunk_bytes(&file_id).unwrap_or(0);
    let orig: i64 = file_info.original_size.max(0);
    let total_chunks = orig / 65536 + if orig % 65536 == 0 { 0 } else { 1 };
    let allowed = orig + 64 * total_chunks;
    if chunk_bytes < orig || chunk_bytes > allowed {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Uploaded size does not match declared size"})),
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
        let chunk_path = format!("{}/{}/{}.enc", state.config.upload_dir, file_id, i);
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
        let chunk_path = format!("{}/{}/{}.enc", state.config.upload_dir, file_id, i);
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
                    let chunk_path = format!("{}/{}/{}.enc", state.config.upload_dir, old_id, i);
                    let _ = std::fs::remove_file(&chunk_path);
                }
                // Remove the directory
                let dir = format!("{}/{}", state.config.upload_dir, old_id);
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
    let has_kill_switch = state.db.get_kill_switch_status(&user.id).unwrap_or(false);
    (
        StatusCode::OK,
        Json(serde_json::json!({
            "id": user.id,
            "username": user.username,
            "has_kill_switch": has_kill_switch,
        })),
    )
        .into_response()
}

/// Label used to HMAC-bind the kill-switch proof to the stored check. The
/// client computes check = HMAC-SHA256(verifier, label); the server verifies a
/// presented proof the same way. The verifier itself is Argon2id-wrapped with
/// the kill-switch password, so the server holds nothing it can replay.
const KILL_SWITCH_CHECK_LABEL: &str = "kill-switch-check";

/// Fully delete an account and every trace: wipes all user tables via
/// delete_user (incl. 2FA secrets, key blobs, sessions, notifications, pins,
/// sounds, voice state), removes the on-disk upload chunk dirs, tells
/// friends/DM partners/server members via WS, and force-disconnects the user's
/// own live connections. Returns the removed file ids (best-effort).
async fn delete_account_and_cleanup(
    state: &Arc<AppState>,
    user_id: &str,
) -> Result<Vec<String>, String> {
    // Collect affected users BEFORE deletion so we can broadcast "user_deleted"
    let mut affected_users: std::collections::HashSet<String> = std::collections::HashSet::new();
    // Add all server members from servers the user is in
    if let Ok(servers) = state.db.list_user_servers(user_id) {
        for s in &servers {
            if let Ok(members) = state.db.get_server_members(&s.id) {
                for m in members {
                    affected_users.insert(m);
                }
            }
        }
    }
    // Add all DM conversation partners
    if let Ok(dm_channels) = state.db.list_dm_channels_for_user(user_id) {
        for (_dm_id, other_id, _username, _dn, _pp) in dm_channels {
            affected_users.insert(other_id);
        }
    }
    // Add friends
    if let Ok(friends) = state.db.list_friends(user_id) {
        for f in friends {
            affected_users.insert(f.user_id);
        }
    }
    // Remove self from broadcast list
    affected_users.remove(user_id);

    let file_ids = state.db.delete_user(user_id)?;

    // Remove the on-disk chunk dirs for the user's files (uploads/{file_id}).
    for fid in &file_ids {
        let dir = format!("{}/{}", state.config.upload_dir, fid);
        let _ = std::fs::remove_dir_all(&dir);
    }

    // Broadcast "user_deleted" to all affected users so they can clean up UI.
    let user_deleted_msg = serde_json::json!({
        "type": "user_deleted",
        "user_id": user_id,
    });
    let affected: Vec<String> = affected_users.into_iter().collect();
    if !affected.is_empty() {
        state.ws_manager.broadcast_to_users(&affected, &user_deleted_msg.to_string()).await;
    }

    // Force-disconnect the user's own live connections (their sessions are
    // gone, so any still-open socket must be torn down).
    state.ws_manager.disconnect_user(user_id, &user_deleted_msg.to_string()).await;

    Ok(file_ids)
}

#[derive(Deserialize)]
pub struct DeleteMeRequest {
    /// Client-computed hash of the CURRENT password: HMAC-SHA256(hash_key, raw).
    pub current_password: String,
}

pub async fn delete_me(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<DeleteMeRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let stored_hash = match state.db.get_password_hash_by_id(&user_id) {
        Ok(h) => h,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "User not found"})),
            )
                .into_response();
        }
    };
    // Deleting is permanent — require the password so a stolen session can't
    // nuke the account (same rule as 2FA, password change, and kill switch).
    let valid = match verify_user_password_and_upgrade(&state, &user_id, &stored_hash, &req.current_password) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Wrong password"})),
        )
            .into_response();
    }

    match delete_account_and_cleanup(&state, &user_id).await {
        Ok(_) => {
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

// --- Kill Switch (Settings → Security) ---

#[derive(Deserialize)]
pub struct SetKillSwitchRequest {
    /// Client-computed hash of the CURRENT password: HMAC-SHA256(hash_key, raw).
    pub current_password: String,
    /// Argon2id-wrapped verifier (base64), produced client-side by
    /// E2ECrypto.encryptWithPassword(verifier, kill_switch_password). The
    /// server stores only this blob + the check HMAC below — it can verify a
    /// proof at login but cannot derive one, so it can never trigger the
    /// deletion itself.
    pub verifier_encrypted: String,
    pub wrap_salt: String,
    pub wrap_nonce: String,
    /// Hex salt used for the verifier HMAC.
    pub ks_salt: String,
    /// Hex HMAC-SHA256(verifier, "kill-switch-check") — the login proof check.
    pub check: String,
}

/// POST /api/me/kill-switch — arm (or re-arm) the Kill Switch. Arming is a
/// security event: every OTHER session is force-signed-out (the arming device
/// stays logged in) so the kill-switch password isn't competing with live
/// sessions on other devices.
pub async fn set_kill_switch(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SetKillSwitchRequest>,
) -> impl IntoResponse {
    let (user_id, current_sid) = match extract_claims(&headers, &state) {
        Ok(c) => (c.sub, c.sid),
        Err(r) => return r.into_response(),
    };
    let stored_hash = match state.db.get_password_hash_by_id(&user_id) {
        Ok(h) => h,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "User not found"})),
            )
                .into_response();
        }
    };
    // Re-verify the password so a stolen session can't arm/change the kill switch.
    let valid = match verify_user_password_and_upgrade(&state, &user_id, &stored_hash, &req.current_password) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Wrong password"})),
        )
            .into_response();
    }
    // Validate shapes before storing.
    let is_hex = |s: &str| s.len() % 2 == 0 && s.chars().all(|c| c.is_ascii_hexdigit());
    if !is_hex(&req.check) || req.check.len() != 64 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid kill switch data"})),
        )
            .into_response();
    }
    if !is_hex(&req.ks_salt) || req.ks_salt.len() < 16 {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid kill switch data"})),
        )
            .into_response();
    }
    if req.verifier_encrypted.is_empty() || req.wrap_salt.is_empty() || req.wrap_nonce.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({"error": "Invalid kill switch data"})),
        )
            .into_response();
    }
    match state.db.set_kill_switch(
        &user_id,
        &req.verifier_encrypted,
        &req.wrap_salt,
        &req.wrap_nonce,
        &req.ks_salt,
        &req.check,
    ) {
        Ok(()) => {
            // Force-sign-out every other session (same semantics as the
            // Devices panel's "Sign out all other devices") and live-kick the
            // now-revoked devices so they're told immediately.
            let n = state.db.revoke_auth_sessions_except(&user_id, &current_sid).unwrap_or(0);
            live_kick_other_devices(&state, &user_id, &current_sid, "kill_switch_armed").await;
            (StatusCode::OK, Json(serde_json::json!({"ok": true, "revoked": n}))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

#[derive(Deserialize)]
pub struct ClearKillSwitchRequest {
    /// Client-computed hash of the CURRENT password: HMAC-SHA256(hash_key, raw).
    pub current_password: String,
}

/// DELETE /api/me/kill-switch — disarm the Kill Switch (off by default again).
pub async fn clear_kill_switch(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<ClearKillSwitchRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let stored_hash = match state.db.get_password_hash_by_id(&user_id) {
        Ok(h) => h,
        Err(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"error": "User not found"})),
            )
                .into_response();
        }
    };
    let valid = match verify_user_password_and_upgrade(&state, &user_id, &stored_hash, &req.current_password) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    if !valid {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({"error": "Wrong password"})),
        )
            .into_response();
    }
    match state.db.clear_kill_switch(&user_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
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

/// GET /api/client-config — public, unauthenticated. Tells clients the
/// currently-configured upload limits so their pre-upload checks match the
/// server. Values are runtime-tunable from the admin panel (Runtime Limits).
pub async fn client_config(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let ip = get_client_ip(&headers);
    let rate_key = format!("client_config_ip:{}", ip);
    let ip_max: u32 = std::env::var("CLIENT_CONFIG_IP_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(60);
    if ip_max > 0 && !CLIENT_CONFIG_IP_RATE_LIMITER.check_and_increment(&rate_key, ip_max, Duration::from_secs(60)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many requests. Try again later."})),
        )
            .into_response();
    }
    let tuning = state.runtime_tuning.read().unwrap();
    let max_mb = tuning.max_file_size_mb;
    (StatusCode::OK, Json(serde_json::json!({
        "max_file_size_mb": max_mb,
        "max_file_size_bytes": max_mb * 1024 * 1024,
    }))).into_response()
}

/// Serialize a server-channel search result in the same encrypted shape as
/// list_messages, plus the context the client needs to render + jump
/// (server/channel ids and encrypted names for the context line).
fn channel_search_json(
    state: &Arc<AppState>,
    m: &crate::db::Message,
    server_id: &str,
    ch_enc: Option<&(Vec<u8>, Vec<u8>)>,
    sv_enc: Option<&(Vec<u8>, Vec<u8>)>,
) -> serde_json::Value {
    serde_json::json!({
        "id": m.id,
        "channel_id": m.channel_id,
        "server_id": server_id,
        "dm_channel_id": null,
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
        "channel_encrypted_name": ch_enc.map(|(n, _)| base64::engine::general_purpose::STANDARD.encode(n)),
        "channel_name_nonce": ch_enc.map(|(_, nn)| base64::engine::general_purpose::STANDARD.encode(nn)),
        "server_encrypted_name": sv_enc.map(|(n, _)| base64::engine::general_purpose::STANDARD.encode(n)),
        "server_name_nonce": sv_enc.map(|(_, nn)| base64::engine::general_purpose::STANDARD.encode(nn)),
    })
}

/// Serialize the reaction rows of one message (ciphertext + blind emoji token
/// + reactor ids — same metadata treatment as message sender ids). The client
/// decrypts the emoji payloads and computes counts locally.
fn reactions_json(state: &Arc<AppState>, rows: Option<&Vec<crate::db::ReactionRow>>) -> serde_json::Value {
    match rows {
        Some(rs) => serde_json::json!(rs
            .iter()
            .map(|r| {
                serde_json::json!({
                    "reactor_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &r.reactor_id),
                    "reactor_user_id": r.reactor_id,
                    "emoji_token": r.emoji_token,
                    "encrypted_emoji": r.encrypted_emoji,
                    "emoji_nonce": r.emoji_nonce,
                    "created_at": r.created_at,
                })
            })
            .collect::<Vec<_>>()),
        None => serde_json::json!([]),
    }
}

/// Serialize the poll vote rows of one message (blind option token + voter ids
/// — the same metadata treatment as message sender ids). The client matches
/// tokens to the option ids from the decrypted poll message and computes
/// counts + "my vote" locally; the server never sees which option was chosen.
fn poll_votes_json(state: &Arc<AppState>, rows: Option<&Vec<crate::db::PollVoteRow>>) -> serde_json::Value {
    match rows {
        Some(rs) => serde_json::json!(rs
            .iter()
            .map(|r| {
                serde_json::json!({
                    "voter_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &r.voter_id),
                    "voter_user_id": r.voter_id,
                    "option_token": r.option_token,
                    "created_at": r.created_at,
                })
            })
            .collect::<Vec<_>>()),
        None => serde_json::json!([]),
    }
}

/// Serialize the delivery/read ack rows of one message, showing them ONLY to
/// the message author and to the acker themselves (read state is private to
/// the sender/recipient pair — a third channel member must not learn who read
/// what). The blind ack_token is never returned to clients. The author's
/// client renders ✓ / ✓✓ / read from the returned statuses.
fn acks_json(state: &Arc<AppState>, rows: Option<&Vec<crate::db::AckRow>>, requester_id: &str, sender_id: &str) -> serde_json::Value {
    match rows {
        Some(rs) => serde_json::json!(rs
            .iter()
            .filter(|r| r.acker_id == requester_id || sender_id == requester_id)
            .map(|r| {
                serde_json::json!({
                    "acker_id": crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &r.acker_id),
                    "acker_user_id": r.acker_id,
                    "status": r.status,
                    "created_at": r.created_at,
                })
            })
            .collect::<Vec<_>>()),
        None => serde_json::json!([]),
    }
}

/// GET /api/search — E2E blind-index message search.
/// Query params: `q` (repeatable HMAC token, one per keyword, AND semantics),
/// `sender_id` (filter to one sender), `channel_id` / `dm_channel_id` (scope;
/// omitted = search every channel/DM the user can read), `limit` (cap 100).
/// The server never sees plaintext: tokens are HMACs keyed by the channel/DM
/// key, which only clients hold.
pub async fn search_messages_handler(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Query(params): Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let ip = get_client_ip(&headers);
    let rate_key = format!("search_ip:{}", ip);
    let ip_max: u32 = std::env::var("SEARCH_IP_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
    if ip_max > 0 && !SEARCH_IP_RATE_LIMITER.check_and_increment(&rate_key, ip_max, Duration::from_secs(60)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many requests. Try again later."})),
        )
            .into_response();
    }

    // Tokens arrive comma-joined in one `q` param (each token is hex, so no
    // commas can appear inside). One token per keyword, AND semantics.
    // Dedupe identical tokens (a client with duplicate rotation-history keys
    // could otherwise send the same token twice, breaking the
    // COUNT(DISTINCT token) = #tokens match).
    let mut tokens: Vec<String> = params
        .get("q")
        .map(|q| {
            // Substring tokens are HMAC'd with the conversation key (blind
            // index) and can be as short as 2 chars; the host cannot read
            // them, so the old >= 8 length floor (for full-word tokens) is
            // dropped to allow "ligh" -> "lighthouse" contains-matching.
            q.split(',')
                .filter(|t| t.len() >= 2 && t.len() <= 64)
                .take(8)
                .map(|s| s.to_string())
                .collect()
        })
        .unwrap_or_default();
    tokens.sort();
    tokens.dedup();
    let sender_id = params.get("sender_id").filter(|s| !s.is_empty()).map(|s| s.as_str());
    let limit: i64 = params.get("limit").and_then(|v| v.parse().ok()).unwrap_or(50).min(100);

    if let Some(channel_id) = params.get("channel_id") {
        let server_id = match state.db.get_server_id_for_channel(channel_id) {
            Ok(id) => id,
            Err(_) => return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Channel not found"}))).into_response(),
        };
        if !state.db.is_member_of_server(&user_id, &server_id).unwrap_or(false) {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not a member of this server"}))).into_response();
        }
        let msgs = match state.db.search_messages(channel_id, &tokens, sender_id, limit) {
            Ok(m) => m,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
        };
        let ch_enc = state.db.get_channel_encrypted_name(channel_id).ok();
        let sv_enc = state.db.get_server_encrypted_name(&server_id).ok();
        let results: Vec<serde_json::Value> = msgs.iter().map(|m| channel_search_json(&state, m, &server_id, ch_enc.as_ref(), sv_enc.as_ref())).collect();
        return (StatusCode::OK, Json(serde_json::json!({"results": results, "scope": "channel"}))).into_response();
    }

    if let Some(dm_channel_id) = params.get("dm_channel_id") {
        if !state.db.is_dm_member(dm_channel_id, &user_id).unwrap_or(false) {
            return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Not a member of this DM"}))).into_response();
        }
        let msgs = match state.db.search_dm_messages(dm_channel_id, &tokens, sender_id, limit) {
            Ok(m) => m,
            Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
        };
        let results: Vec<serde_json::Value> = msgs
            .iter()
            .map(|m| {
                serde_json::json!({
                    "id": m.id,
                    "dm_channel_id": m.dm_channel_id,
                    "channel_id": null,
                    "server_id": null,
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
                })
            })
            .collect();
        return (StatusCode::OK, Json(serde_json::json!({"results": results, "scope": "dm"}))).into_response();
    }

    // Global: every server channel + DM the user can read.
    let ch_msgs = state.db.search_messages_global(&user_id, &tokens, sender_id, limit).unwrap_or_default();
    let dm_msgs = state.db.search_dm_messages_global(&user_id, &tokens, sender_id, limit).unwrap_or_default();
    let mut ch_names: std::collections::HashMap<String, Option<(Vec<u8>, Vec<u8>)>> = std::collections::HashMap::new();
    let mut sv_names: std::collections::HashMap<String, Option<(Vec<u8>, Vec<u8>)>> = std::collections::HashMap::new();
    let mut results: Vec<serde_json::Value> = Vec::new();
    for m in &ch_msgs {
        let server_id = state.db.get_server_id_for_channel(&m.channel_id).unwrap_or_default();
        let ch_enc = ch_names.entry(m.channel_id.clone()).or_insert_with(|| state.db.get_channel_encrypted_name(&m.channel_id).ok()).as_ref().cloned();
        let sv_enc = sv_names.entry(server_id.clone()).or_insert_with(|| state.db.get_server_encrypted_name(&server_id).ok()).as_ref().cloned();
        results.push(channel_search_json(&state, m, &server_id, ch_enc.as_ref(), sv_enc.as_ref()));
    }
    for m in &dm_msgs {
        results.push(serde_json::json!({
            "id": m.id,
            "dm_channel_id": m.dm_channel_id,
            "channel_id": null,
            "server_id": null,
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
        }));
    }
    // Merge channel + DM results, newest first.
    results.sort_by(|a, b| b["timestamp"].as_str().unwrap_or("").cmp(a["timestamp"].as_str().unwrap_or("")));
    results.truncate(limit as usize);
    (StatusCode::OK, Json(serde_json::json!({"results": results, "scope": "global"}))).into_response()
}

#[derive(Deserialize)]
pub struct SearchIndexEntry {
    pub message_id: String,
    #[serde(default)]
    pub tokens: Vec<String>,
}

#[derive(Deserialize)]
pub struct SearchIndexRequest {
    #[serde(default)]
    pub channel_id: Option<String>,
    #[serde(default)]
    pub dm_channel_id: Option<String>,
    pub entries: Vec<SearchIndexEntry>,
}

/// POST /api/search/index — client-side backfill of the E2E search blind index.
/// The client computes HMAC tokens for messages it has already decrypted (e.g.
/// while scrolling history) and submits them in batches; the server only
/// INSERT-OR-IGNOREs them (idempotent). Ownership is validated per entry.
pub async fn index_search_tokens(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(req): Json<SearchIndexRequest>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let ip = get_client_ip(&headers);
    let rate_key = format!("search_index_ip:{}", ip);
    let ip_max: u32 = std::env::var("SEARCH_IP_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
    if ip_max > 0 && !SEARCH_IP_RATE_LIMITER.check_and_increment(&rate_key, ip_max, Duration::from_secs(60)) {
        return (
            StatusCode::TOO_MANY_REQUESTS,
            Json(serde_json::json!({"error": "Too many requests. Try again later."})),
        )
            .into_response();
    }

    let mut indexed = 0usize;
    for entry in req.entries.iter().take(300) {
        let toks: Vec<String> = entry.tokens.iter().filter(|t| t.len() >= 2 && t.len() <= 64).take(400).cloned().collect();
        if toks.is_empty() { continue; }
        if let Some(channel_id) = &req.channel_id {
            // Validate: message must live in this channel and the user must be
            // a member of the channel's server.
            if state.db.get_message_channel_id(&entry.message_id).ok().as_deref() != Some(channel_id.as_str()) {
                continue;
            }
            let server_id = match state.db.get_server_id_for_channel(channel_id) {
                Ok(id) => id,
                Err(_) => continue,
            };
            if !state.db.is_member_of_server(&user_id, &server_id).unwrap_or(false) {
                continue;
            }
            if state.db.index_message_tokens(&entry.message_id, &toks).is_ok() {
                indexed += 1;
            }
        } else if let Some(dm_channel_id) = &req.dm_channel_id {
            if state.db.get_dm_message_channel_id(&entry.message_id).ok().as_deref() != Some(dm_channel_id.as_str()) {
                continue;
            }
            if !state.db.is_dm_member(dm_channel_id, &user_id).unwrap_or(false) {
                continue;
            }
            if state.db.index_dm_message_tokens(&entry.message_id, &toks).is_ok() {
                indexed += 1;
            }
        }
    }
    (StatusCode::OK, Json(serde_json::json!({"ok": true, "indexed": indexed}))).into_response()
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

    let valid = match verify_user_password_and_upgrade(&state, &user_id, &stored_password_hash, &req.password) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    if !valid {
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
                let _ = state.db.save_pending_notification(&target.id, "friend_request_received", &notify.to_string(), state.config.hmac_key.as_bytes());
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
                let _ = state.db.save_pending_notification(&from_id, "friend_request_accepted", &notify.to_string(), state.config.hmac_key.as_bytes());
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
            let dm_msg_ids: Vec<String> = msgs.iter().map(|m| m.id.clone()).collect();
            let dm_reactions = state.db.get_dm_message_reactions(&dm_msg_ids).unwrap_or_default();
            let dm_poll_votes = state.db.get_dm_message_poll_votes(&dm_msg_ids).unwrap_or_default();
            let dm_acks = state.db.get_dm_message_acks(&dm_msg_ids).unwrap_or_default();
            let dm_expiries = state.db.get_dm_message_expiries(&dm_msg_ids).unwrap_or_default();

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
                        "reactions": reactions_json(&state, dm_reactions.get(&m.id)),
                        "poll_votes": poll_votes_json(&state, dm_poll_votes.get(&m.id)),
                        "acks": acks_json(&state, dm_acks.get(&m.id), &user_id, &m.sender_id),
                        "expires_at": dm_expiries.get(&m.id).cloned().flatten(),
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
    let dm_msg_ids: Vec<String> = msgs.iter().map(|m| m.id.clone()).collect();
    let dm_reactions = state.db.get_dm_message_reactions(&dm_msg_ids).unwrap_or_default();
    let dm_poll_votes = state.db.get_dm_message_poll_votes(&dm_msg_ids).unwrap_or_default();
    let dm_acks = state.db.get_dm_message_acks(&dm_msg_ids).unwrap_or_default();
    let dm_expiries = state.db.get_dm_message_expiries(&dm_msg_ids).unwrap_or_default();
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
                "reactions": reactions_json(&state, dm_reactions.get(&m.id)),
                "poll_votes": poll_votes_json(&state, dm_poll_votes.get(&m.id)),
                "acks": acks_json(&state, dm_acks.get(&m.id), &user_id, &m.sender_id),
                "expires_at": dm_expiries.get(&m.id).cloned().flatten(),
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
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // H4: presence is private — only authenticated users may see who is online.
    let _user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let online = state.ws_manager.get_online_user_ids().await;
    (StatusCode::OK, Json(serde_json::json!(online))).into_response()
}

// ── F14: User Custom CSS Slots ─────────────────────────────────────────────
// Two encrypted CSS slots per user.  The client encrypts the plaintext CSS
// with the user's identity key; the server only stores opaque blobs.
// active_slot: 0 = use app default, 1 or 2 = use that slot.

/// GET /api/user-css/slots — return both slots and active_slot for the caller.
pub async fn get_css_slots(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.get_css_slots(&user_id) {
        Ok((s1_css, s1_nonce, s2_css, s2_nonce, active)) => {
            (StatusCode::OK, Json(serde_json::json!({
                "slot1": { "encrypted_css": s1_css, "nonce": s1_nonce },
                "slot2": { "encrypted_css": s2_css, "nonce": s2_nonce },
                "active_slot": active,
            }))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// PUT /api/user-css/slot/:slot — save encrypted CSS to slot 1 or 2.
pub async fn save_css_slot(
    Path(slot_num): Path<i64>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if slot_num != 1 && slot_num != 2 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "slot must be 1 or 2"}))).into_response();
    }
    let encrypted_css = body["encrypted_css"].as_str().unwrap_or("").to_string();
    let nonce = body["nonce"].as_str().unwrap_or("").to_string();
    match state.db.save_css_slot(&user_id, slot_num, &encrypted_css, &nonce) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// DELETE /api/user-css/slot/:slot — clear a CSS slot.
pub async fn delete_css_slot(
    Path(slot_num): Path<i64>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.delete_css_slot(&user_id, slot_num) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// PUT /api/user-css/active — set which slot is active (0 = default, 1 or 2).
pub async fn set_css_active_slot(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let active = body["active_slot"].as_i64().unwrap_or(0);
    if active < 0 || active > 2 {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "active_slot must be 0, 1, or 2"}))).into_response();
    }
    match state.db.set_css_active_slot(&user_id, active) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "active_slot": active}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

// --- Link Preview: fetch OG metadata for URLs ---

/// GET /api/link-preview?url=<encoded_url>
/// Fetches a URL and extracts Open Graph / basic metadata for link previews.
/// Rate-limited to prevent abuse. Returns JSON with title, description,
/// image, and site_name fields.
pub async fn link_preview(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let _user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let url = match params.get("url") {
        Some(u) if !u.is_empty() => u.clone(),
        _ => {
            return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "url parameter required"}))).into_response();
        }
    };

    // Validate URL scheme
    if !url.starts_with("http://") && !url.starts_with("https://") {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "only http/https URLs allowed"}))).into_response();
    }

    // Fetch with timeout and size limit
    let client = reqwest::Client::builder()
        .timeout(StdDuration::from_secs(5))
        .user_agent("E2E-Chat/1.0 LinkPreview")
        .danger_accept_invalid_certs(false)
        .build();

    let client = match client {
        Ok(c) => c,
        Err(_) => {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": "failed to create client"}))).into_response();
        }
    };

    let resp = match client.get(&url).send().await {
        Ok(r) => r,
        Err(_) => {
            return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({"error": "failed to fetch URL"}))).into_response();
        }
    };

    // Read first 100KB of HTML only
    let content_type = resp.headers().get("content-type")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("")
        .to_string();

    let body = match resp.bytes().await {
        Ok(b) => {
            let limit = std::cmp::min(b.len(), 100 * 1024);
            b[..limit].to_vec()
        }
        Err(_) => {
            return (StatusCode::BAD_GATEWAY, Json(serde_json::json!({"error": "failed to read response"}))).into_response();
        }
    };

    let html = String::from_utf8_lossy(&body).to_string();

    // Extract OG metadata from HTML
    let title = extract_meta(&html, "og:title")
        .or_else(|| extract_tag_text(&html, "title"))
        .unwrap_or_default();
    let description = extract_meta(&html, "og:description")
        .or_else(|| extract_meta_content(&html, "description"))
        .unwrap_or_default();
    let image = extract_meta(&html, "og:image").unwrap_or_default();
    let site_name = extract_meta(&html, "og:site_name").unwrap_or_default();
    let video = extract_meta(&html, "og:video").unwrap_or_default();

    let parsed_url = url::Url::parse(&url);
    let domain = parsed_url.as_ref().map(|u| u.host_str().unwrap_or("")).unwrap_or("").to_string();

    (StatusCode::OK, Json(serde_json::json!({
        "url": url,
        "title": title,
        "description": description,
        "image": image,
        "video": video,
        "site_name": site_name,
        "domain": domain,
        "content_type": content_type,
    }))).into_response()
}

fn extract_meta(html: &str, property: &str) -> Option<String> {
    // Look for <meta property="og:xxx" content="yyy" />
    let lower = html.to_lowercase();
    let prop_lower = property.to_lowercase();
    if let Some(idx) = lower.find(&format!("property=\"{}\"", prop_lower)) {
        let rest = &html[idx..];
        if let Some(ci) = rest.find("content=\"") {
            let start = ci + 9;
            if let Some(end) = rest[start..].find('"') {
                return Some(html[start + (start - idx - 9 + 9 - 9)..start + end].to_string());
            }
        }
    }
    // Also try name="xxx" (for twitter:card etc)
    if let Some(idx) = lower.find(&format!("name=\"{}\"", prop_lower)) {
        let rest = &html[idx..];
        if let Some(ci) = rest.find("content=\"") {
            let start = ci + 9;
            if let Some(end) = rest[start..].find('"') {
                return Some(rest[start..start + end].to_string());
            }
        }
    }
    None
}

fn extract_meta_content(html: &str, name: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let name_lower = name.to_lowercase();
    if let Some(idx) = lower.find(&format!("name=\"{}\"", name_lower)) {
        let rest = &html[idx..];
        if let Some(ci) = rest.find("content=\"") {
            let start = ci + 9;
            if let Some(end) = rest[start..].find('"') {
                return Some(rest[start..start + end].to_string());
            }
        }
    }
    None
}

fn extract_tag_text(html: &str, tag: &str) -> Option<String> {
    let lower = html.to_lowercase();
    let open = format!("<{}>", tag);
    let close = format!("</{}>", tag);
    if let Some(start) = lower.find(&open) {
        let text_start = start + open.len();
        if let Some(end) = lower[text_start..].find(&close) {
            return Some(html[text_start..text_start + end].trim().to_string());
        }
    }
    None
}

// --- F3-15: Encrypted File Vault ---
/// POST /api/vault/upload — store a file in the user's encrypted vault.
/// The file data is already encrypted + compressed client-side; the server
/// stores the opaque blob. Max vault size is enforced.
pub async fn vault_upload(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    // Metadata comes from headers; encrypted blob is the raw body (no base64)
    let file_id = headers.get("x-vault-file-id")
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    let encrypted_filename = headers.get("x-vault-filename")
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    let filename_nonce = headers.get("x-vault-filename-nonce")
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    let encrypted_mime = headers.get("x-vault-mime")
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    let mime_nonce = headers.get("x-vault-mime-nonce")
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    let original_size: i64 = headers.get("x-vault-original-size")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok()).unwrap_or(0);
    let stored_size: i64 = headers.get("x-vault-stored-size")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok()).unwrap_or(body.len() as i64);
    let enc_file_key = headers.get("x-vault-file-key")
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    let file_key_nonce = headers.get("x-vault-file-key-nonce")
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    let content_hash = headers.get("x-vault-hash")
        .and_then(|v| v.to_str().ok()).unwrap_or("");
    let compression = headers.get("x-vault-compression")
        .and_then(|v| v.to_str().ok()).unwrap_or("none");

    if file_id.is_empty() || body.is_empty() {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "x-vault-file-id header and body required"}))).into_response();
    }

    // Check vault size quota
    let tuning = state.runtime_tuning.read().unwrap();
    let max_bytes = tuning.file_storage_quota_bytes;
    drop(tuning);
    
    let current_size = state.db.vault_total_size(&user_id).unwrap_or(0);
    if max_bytes > 0 && (current_size + stored_size) > max_bytes {
        return (StatusCode::PAYLOAD_TOO_LARGE, Json(serde_json::json!({"error": "Vault size limit reached"}))).into_response();
    }

    match state.db.vault_store_file(
        &user_id, file_id, &body,
        encrypted_filename, filename_nonce,
        encrypted_mime, mime_nonce,
        original_size, stored_size,
        enc_file_key, file_key_nonce, content_hash,
        compression,
    ) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "file_id": file_id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// GET /api/vault/files — list files in the user's vault (metadata only).
pub async fn vault_list(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let tuning = state.runtime_tuning.read().unwrap();
    let max_bytes = tuning.file_storage_quota_bytes;
    drop(tuning);

    let total_size = state.db.vault_total_size(&user_id).unwrap_or(0);
    let files = state.db.vault_list_files(&user_id).unwrap_or_default();

    (StatusCode::OK, Json(serde_json::json!({
        "files": files,
        "total_size": total_size,
        "max_size_bytes": max_bytes,
    }))).into_response()
}

/// GET /api/vault/files/:file_id — download a vault file (encrypted blob).
pub async fn vault_download(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(file_id): Path<String>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.vault_get_file(&user_id, &file_id) {
        Ok(Some((data, mime, nonce))) => {
            // Return raw binary body with metadata in headers (no base64 overhead)
            let mut resp_headers = axum::http::HeaderMap::new();
            resp_headers.insert("x-vault-mime", mime.parse().unwrap_or(axum::http::HeaderValue::from_static("application/octet-stream")));
            resp_headers.insert("x-vault-mime-nonce", nonce.parse().unwrap_or(axum::http::HeaderValue::from_static("")));
            (StatusCode::OK, resp_headers, data).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "file not found"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// DELETE /api/vault/files/:file_id — delete a vault file.
pub async fn vault_delete(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Path(file_id): Path<String>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    match state.db.vault_delete_file(&user_id, &file_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

// --- F4-19: Data Portability ---
/// GET /api/me/export -- export all data for the authenticated user.
pub async fn export_user_data(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };

    let mut export = serde_json::json!({
        "export_version": "1.0",
        "exported_at": chrono::Utc::now().to_rfc3339(),
        "user_id": user_id,
    });

    // User info
    if let Ok(user_row) = state.db.get_user_by_id(&user_id) {
        export["user"] = serde_json::json!({
            "id": user_id,
            "username": user_row.username,
        });
    }

    // Vault files metadata
    if let Ok(vault_files) = state.db.vault_list_files(&user_id) {
        export["vault"] = serde_json::json!({
            "files": vault_files,
            "count": vault_files.len(),
        });
    }

    // Servers
    if let Ok(servers) = state.db.list_user_servers(&user_id) {
        export["servers"] = serde_json::json!(servers.into_iter().map(|s| s.id).collect::<Vec<_>>());
    }

    // DM channels
    if let Ok(dms) = state.db.list_dm_channels_for_user(&user_id) {
        export["dm_conversations"] = serde_json::json!(dms.len());
    }

    // Friends
    if let Ok(friends) = state.db.list_friends(&user_id) {
        export["friends"] = serde_json::json!(friends.len());
    }

    (StatusCode::OK, Json(export)).into_response()
}
// --- F3-14: Self-Destructing Accounts (per-user API) ---

/// GET /api/me/self-destruct — get the user's self-destruct setting.
pub async fn get_self_destruct(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let days = state.db.get_self_destruct_days(&user_id).unwrap_or(0);
    (StatusCode::OK, Json(serde_json::json!({ "self_destruct_days": days }))).into_response()
}

/// PUT /api/me/self-destruct — set the user's self-destruct setting.
pub async fn set_self_destruct(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let current_password = match body.get("current_password").and_then(|v| v.as_str()) {
        Some(p) => p,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Password required"}))).into_response(),
    };
    let stored_hash = match state.db.get_password_hash_by_id(&user_id) {
        Ok(h) => h,
        Err(_) => return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "User not found"}))).into_response(),
    };
    let valid = match verify_user_password_and_upgrade(&state, &user_id, &stored_hash, current_password) {
        Ok(v) => v,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    };
    if !valid {
        return (StatusCode::UNAUTHORIZED, Json(serde_json::json!({"error": "Wrong password"}))).into_response();
    }
    let days = body["self_destruct_days"].as_i64().unwrap_or(0);
    let days = if days < 0 { 0 } else if days > 365 { 365 } else { days };
    match state.db.set_self_destruct_days(&user_id, days) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({ "ok": true, "self_destruct_days": days }))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({ "error": e }))).into_response(),
    }
}
// === Soundboard Handlers ===

/// POST /api/soundboard/temp-play — upload decrypted audio bytes for fast relay.
/// Returns { "token": "..." } that receivers can GET to fetch the audio.
pub async fn upload_sb_temp_play(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let audio_b64 = match body.get("audio").and_then(|v| v.as_str()) {
        Some(b) => b,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error":"missing audio"}))).into_response(),
    };
    let audio_bytes = match base64::engine::general_purpose::STANDARD.decode(audio_b64) {
        Ok(b) => b,
        Err(_) => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error":"invalid base64"}))).into_response(),
    };
    // 60-char random hex token
    let token = rand_hex_token(30);
    state
        .sb_temp_play
        .write()
        .unwrap()
        .insert(token.clone(), (audio_bytes, std::time::Instant::now()));
    // Cleanup entries older than 15 min (backstop — normal cleanup happens
    // when playback stops or the player leaves voice). Entries must survive
    // the whole playback so late joiners can still fetch the audio.
    {
        let mut map = state.sb_temp_play.write().unwrap();
        map.retain(|_, (_, created)| created.elapsed() < std::time::Duration::from_secs(900));
    }
    (StatusCode::OK, Json(serde_json::json!({ "token": token }))).into_response()
}

/// GET /api/soundboard/temp-play/{token} — fetch the temporarily stored audio.
/// NOT one-shot: every room member (and every late joiner within the TTL)
/// must be able to fetch the same token, so the entry is kept until the
/// TTL backstop expires or an explicit stop clears it.
pub async fn get_sb_temp_play(
    Path(token): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let map = state.sb_temp_play.read().unwrap();
    match map.get(&token) {
        Some((bytes, created)) => {
            // Expired entries behave as missing
            if created.elapsed() >= std::time::Duration::from_secs(900) {
                return (StatusCode::NOT_FOUND, Json(serde_json::json!({"error":"expired"}))).into_response();
            }
            (
                StatusCode::OK,
                [(axum::http::header::CONTENT_TYPE, "audio/wav".to_string())],
                bytes.clone(),
            )
                .into_response()
        }
        None => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error":"expired or invalid"}))).into_response(),
    }
}

/// Remove a temp-play token (called when playback stops or the player leaves).
pub fn remove_sb_temp_play(state: &Arc<AppState>, token: &str) {
    if token.is_empty() { return; }
    state.sb_temp_play.write().unwrap().remove(token);
}

/// GET /api/soundboard/temp-play — cleanup old entries (admin/cron).
pub async fn sb_temp_play_cleanup(
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let before = state.sb_temp_play.read().unwrap().len();
    state.sb_temp_play.write().unwrap().retain(|_, (_, created)| created.elapsed() < std::time::Duration::from_secs(900));
    let after = state.sb_temp_play.read().unwrap().len();
    (StatusCode::OK, Json(serde_json::json!({ "cleaned": before - after, "remaining": after }))).into_response()
}

fn rand_hex_token(len: usize) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..len).map(|_| format!("{:02x}", rng.gen::<u8>())).collect()
}

pub async fn upload_soundboard_clip(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let server_id = match body["server_id"].as_str() {
        Some(id) => id,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "server_id required"}))).into_response(),
    };
    let name = match body["name"].as_str() {
        Some(n) => n,
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "name required"}))).into_response(),
    };
    let encrypted_audio = match body["encrypted_audio"].as_str() {
        Some(a) => base64::engine::general_purpose::STANDARD.decode(a).unwrap_or_default(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "encrypted_audio required"}))).into_response(),
    };
    let audio_nonce = match body["audio_nonce"].as_str() {
        Some(n) => base64::engine::general_purpose::STANDARD.decode(n).unwrap_or_default(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "audio_nonce required"}))).into_response(),
    };
    let duration_ms = body["duration_ms"].as_i64().unwrap_or(0);
    let clip_id = uuid::Uuid::new_v4().to_string();
    match state.db.save_soundboard_clip(&clip_id, &user_id, server_id, name, &encrypted_audio, &audio_nonce, duration_ms) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "clip_id": clip_id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn list_soundboard_clips(
    headers: HeaderMap,
    Path(server_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.list_soundboard_clips(&user_id, &server_id) {
        Ok(clips) => {
            let arr: Vec<serde_json::Value> = clips.into_iter().map(|(id, uploader, name, audio, nonce, dur)| {
                serde_json::json!({
                    "id": id,
                    "user_id": uploader,
                    "name": name,
                    "encrypted_audio": base64::engine::general_purpose::STANDARD.encode(&audio),
                    "audio_nonce": base64::engine::general_purpose::STANDARD.encode(&nonce),
                    "duration_ms": dur,
                })
            }).collect();
            (StatusCode::OK, Json(serde_json::json!(arr))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// List all soundboard clips for the current user (per-account, not per-server).
pub async fn list_my_soundboard_clips(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.list_soundboard_clips_for_user(&user_id) {
        Ok(clips) => {
            let arr: Vec<serde_json::Value> = clips.into_iter().map(|(id, uploader, name, audio, nonce, dur)| {
                serde_json::json!({
                    "id": id,
                    "user_id": uploader,
                    "name": name,
                    "encrypted_audio": base64::engine::general_purpose::STANDARD.encode(&audio),
                    "audio_nonce": base64::engine::general_purpose::STANDARD.encode(&nonce),
                    "duration_ms": dur,
                })
            }).collect();
            (StatusCode::OK, Json(serde_json::json!(arr))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn delete_soundboard_clip(
    headers: HeaderMap,
    Path(clip_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.delete_soundboard_clip(&clip_id, &user_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn mute_soundboard(
    headers: HeaderMap,
    Path((server_id, user_id)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let muted_by = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.mute_soundboard_user(&server_id, &user_id, &muted_by) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn unmute_soundboard(
    headers: HeaderMap,
    Path((server_id, user_id)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let muted_by = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.unmute_soundboard_user(&server_id, &user_id, &muted_by) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn list_muted_soundboard(
    headers: HeaderMap,
    Path(server_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let muted_by = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.get_muted_soundboard_users(&server_id, &muted_by) {
        Ok(ids) => (StatusCode::OK, Json(serde_json::json!({"muted": ids}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

// === Soundboard Global Mute (owner kill-switch) ===

pub async fn toggle_soundboard_global_mute(
    headers: HeaderMap,
    Path(server_id): Path<String>,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_SOUNDBOARD, None) {
        return denied;
    }
    let muted = body["muted"].as_bool().unwrap_or(false);
    match state.db.set_soundboard_global_mute(&server_id, muted) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "muted": muted}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn get_soundboard_global_mute(
    Path(server_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    match state.db.is_soundboard_global_muted(&server_id) {
        Ok(muted) => (StatusCode::OK, Json(serde_json::json!({"muted": muted}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn disable_soundboard_user(
    headers: HeaderMap,
    Path((server_id, target_user_id)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_SOUNDBOARD, None) {
        return denied;
    }
    // Owner is immune; cannot target a member at or above your role.
    if state.db.is_server_owner(&target_user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "The server owner cannot be soundboard-disabled"}))).into_response();
    }
    let actor_pos = state.db.member_role_position(&server_id, &user_id).unwrap_or(0);
    let target_pos = state.db.member_role_position(&server_id, &target_user_id).unwrap_or(0);
    if actor_pos <= target_pos {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot soundboard-disable a member at or above your own role"}))).into_response();
    }
    match state.db.disable_soundboard_user(&server_id, &target_user_id, &user_id) {
        Ok(()) => {
            // Tell the TARGET (all their devices) live: their soundboard is now
            // disabled — without this the sound they were PLAYING (self-hear)
            // and any sound of theirs that members were hearing kept running
            // until its natural end. Also broadcast to the whole server so
            // LISTENERS stop a still-playing clip from the disabled user.
            state.ws_manager.broadcast_to_users(&[target_user_id.clone()], &serde_json::json!({
                "type": "soundboard_disabled",
                "server_id": server_id,
                "user_id": target_user_id,
                "disabled": true,
            }).to_string()).await;
            // Listeners: stop that user's sound inside every server voice room,
            // AND clear the room's stored playback state — otherwise a late
            // joiner syncs to a clip that is no longer playing. The temp audio
            // is freed too. The lock is dropped before any await below.
            let mut stopped_tokens: Vec<String> = Vec::new();
            let room_ids: Vec<String> = {
                let mut rooms = state.voice_rooms.write().unwrap();
                let ids: Vec<String> = rooms
                    .iter()
                    .filter(|(_, rm)| rm.room_type == "server" && rm.server_id.as_deref() == Some(server_id.as_str()))
                    .map(|(rid, _)| rid.clone())
                    .collect();
                for rid in &ids {
                    if let Some(room) = rooms.get_mut(rid) {
                        // Each player has their own slot — clear only the target's.
                        if let Some(sb) = room.current_soundboards.remove(target_user_id.as_str()) {
                            if !sb.temp_token.is_empty() {
                                stopped_tokens.push(sb.temp_token);
                            }
                        }
                    }
                }
                ids
            };
            for tok in stopped_tokens {
                remove_sb_temp_play(&state, &tok);
            }
            for rid in room_ids {
                crate::ws::voice_broadcast(&state, &rid, &serde_json::json!({
                    "type": "soundboard_stop",
                    "user_id": target_user_id,
                    "reason": "soundboard_disabled",
                })).await;
            }
            (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn enable_soundboard_user(
    headers: HeaderMap,
    Path((server_id, target_user_id)): Path<(String, String)>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if let Some(denied) = perm_denied(&state, &server_id, &user_id, crate::db::PERM_MANAGE_SOUNDBOARD, None) {
        return denied;
    }
    // Owner is immune; cannot target a member at or above your role.
    if state.db.is_server_owner(&target_user_id, &server_id).unwrap_or(false) {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "The server owner cannot be soundboard-disabled"}))).into_response();
    }
    let actor_pos = state.db.member_role_position(&server_id, &user_id).unwrap_or(0);
    let target_pos = state.db.member_role_position(&server_id, &target_user_id).unwrap_or(0);
    if actor_pos <= target_pos {
        return (StatusCode::FORBIDDEN, Json(serde_json::json!({"error": "Cannot soundboard-disable a member at or above your own role"}))).into_response();
    }
    match state.db.enable_soundboard_user(&server_id, &target_user_id, &user_id) {
        Ok(()) => {
            // Mirror of the disable broadcast: the target's own devices learn
            // they can play/hear again. A clip that was ALREADY playing was
            // stopped on disable (that state is gone), so there is nothing to
            // resume here — the next play goes through normally.
            state.ws_manager.broadcast_to_users(&[target_user_id.clone()], &serde_json::json!({
                "type": "soundboard_disabled",
                "server_id": server_id,
                "user_id": target_user_id,
                "disabled": false,
            }).to_string()).await;
            (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn get_disabled_soundboard_users(
    Path(server_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    match state.db.get_disabled_soundboard_users(&server_id) {
        Ok(ids) => (StatusCode::OK, Json(serde_json::json!({"users": ids}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

// === Device Pairing Handlers ===

pub async fn create_pairing_ticket(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let public_key = match body["public_key"].as_str() {
        Some(k) => base64::engine::general_purpose::STANDARD.decode(k).unwrap_or_default(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "public_key required"}))).into_response(),
    };
    let encrypted_key_blob = match body["encrypted_key_blob"].as_str() {
        Some(b) => base64::engine::general_purpose::STANDARD.decode(b).unwrap_or_default(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "encrypted_key_blob required"}))).into_response(),
    };
    let key_blob_nonce = match body["key_blob_nonce"].as_str() {
        Some(n) => base64::engine::general_purpose::STANDARD.decode(n).unwrap_or_default(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "key_blob_nonce required"}))).into_response(),
    };
    let _ = state.db.delete_expired_pairing_tickets();
    let ticket_id = uuid::Uuid::new_v4().to_string();
    let expires_at = (chrono::Utc::now() + chrono::Duration::minutes(5)).format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string();
    match state.db.create_pairing_ticket(&ticket_id, &user_id, &public_key, &encrypted_key_blob, &key_blob_nonce, &expires_at) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ticket_id": ticket_id, "expires_at": expires_at}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn get_pairing_ticket(
    Path(ticket_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    match state.db.get_pairing_ticket(&ticket_id) {
        Ok(Some(ticket)) => {
            (StatusCode::OK, Json(serde_json::json!({
                "public_key": base64::engine::general_purpose::STANDARD.encode(&ticket.1),
                "encrypted_key_blob": base64::engine::general_purpose::STANDARD.encode(&ticket.2),
                "key_blob_nonce": base64::engine::general_purpose::STANDARD.encode(&ticket.3),
                "expires_at": ticket.4,
                "claimed": ticket.5.is_some(),
            }))).into_response()
        }
        Ok(None) => (StatusCode::NOT_FOUND, Json(serde_json::json!({"error": "Ticket not found or expired"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn claim_pairing_ticket(
    headers: HeaderMap,
    Path(ticket_id): Path<String>,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let claimed_by = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.claim_pairing_ticket(&ticket_id, &claimed_by) {
        Ok(Some(owner_user_id)) => {
            let username = state.db.get_username_by_id(&owner_user_id).unwrap_or(None).unwrap_or_default();
            let session_id = uuid::Uuid::new_v4().to_string();
            // Fetch the encrypted key blob so the new device can restore encryption keys
            let key_blob_resp = state.db.get_pairing_ticket(&ticket_id)
                .ok().flatten()
                .map(|t| serde_json::json!({
                    "encrypted_key_blob": base64::engine::general_purpose::STANDARD.encode(&t.2),
                    "key_blob_nonce": base64::engine::general_purpose::STANDARD.encode(&t.3),
                })).unwrap_or(serde_json::json!({}));
            match auth::create_token_with_duration(
                &owner_user_id,
                &username,
                &session_id,
                &state.config.jwt_secret,
                chrono::Duration::days(30),
            ) {
                Ok(token) => {
                    let mut resp = serde_json::json!({"token": token, "user_id": owner_user_id});
                    if let Some(blob) = key_blob_resp.get("encrypted_key_blob").and_then(|v| v.as_str()) {
                        resp["encrypted_key_blob"] = serde_json::json!(blob);
                    }
                    if let Some(nonce) = key_blob_resp.get("key_blob_nonce").and_then(|v| v.as_str()) {
                        resp["key_blob_nonce"] = serde_json::json!(nonce);
                    }
                    (StatusCode::OK, Json(resp)).into_response()
                }
                Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
            }
        }
        Ok(None) => (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Ticket not found, expired, or already claimed"}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

// ─── Server groups (folders) ──────────────────────────────────────────────

pub async fn list_server_groups(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.list_server_groups(&user_id) {
        Ok(groups) => {
            let arr: Vec<serde_json::Value> = groups.iter().map(|(id, name, pos, collapsed, parent, color)| {
                serde_json::json!({
                    "id": id,
                    "name": name,
                    "position": pos,
                    "collapsed": collapsed,
                    "parent_group_id": parent,
                    "color": color,
                })
            }).collect();
            (StatusCode::OK, Json(serde_json::json!({"groups": arr}))).into_response()
        }
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn create_server_group(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let group_id = uuid::Uuid::new_v4().to_string();
    let name = body.get("name").and_then(|v| v.as_str()).unwrap_or("Group");
    let position = body.get("position").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
    match state.db.create_server_group(&user_id, &group_id, name, position) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "id": group_id}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn rename_server_group(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    // Handle color update (no name required)
    if let Some(color_val) = body.get("color") {
        let color: Option<&str> = match color_val {
            serde_json::Value::String(s) if !s.is_empty() => Some(s),
            _ => None,
        };
        if let Err(e) = state.db.update_group_color(&user_id, &group_id, color) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    }
    // Handle name update
    if let Some(name) = body.get("name").and_then(|v| v.as_str()) {
        if let Err(e) = state.db.rename_server_group(&user_id, &group_id, name) {
            return (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response();
        }
    }
    (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response()
}

pub async fn delete_server_group(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.delete_server_group(&user_id, &group_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

/// Merge source folder into target folder: moves all servers, deletes source.
pub async fn merge_server_groups(
    Path((source_id, target_id)): Path<(String, String)>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    if source_id == target_id {
        return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Cannot merge a group into itself"}))).into_response();
    }
    match state.db.merge_groups(&user_id, &source_id, &target_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn toggle_server_group_collapsed(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    match state.db.toggle_server_group_collapsed(&user_id, &group_id) {
        Ok(collapsed) => (StatusCode::OK, Json(serde_json::json!({"ok": true, "collapsed": collapsed}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn move_server_to_group(
    Path(server_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let group_id = body.get("group_id").and_then(|v| v.as_str());
    match state.db.move_server_to_group(&user_id, &server_id, group_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn reorder_server_groups(
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let ids: Vec<&str> = match body.get("ordered_ids").and_then(|v| v.as_array()) {
        Some(arr) => arr.iter().filter_map(|v| v.as_str()).collect(),
        None => return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "ordered_ids required"}))).into_response(),
    };
    let refs: Vec<&str> = ids.iter().map(|s| *s).collect();
    match state.db.reorder_server_groups(&user_id, &refs) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}

pub async fn move_group_to_group(
    Path(group_id): Path<String>,
    headers: HeaderMap,
    State(state): State<Arc<AppState>>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let user_id = match extract_user(&headers, &state) {
        Ok(id) => id,
        Err(e) => return e.into_response(),
    };
    let parent_id = body.get("parent_group_id").and_then(|v| v.as_str());
    match state.db.move_group_to_group(&user_id, &group_id, parent_id) {
        Ok(()) => (StatusCode::OK, Json(serde_json::json!({"ok": true}))).into_response(),
        Err(e) => (StatusCode::INTERNAL_SERVER_ERROR, Json(serde_json::json!({"error": e}))).into_response(),
    }
}
