use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::{
    extract::{Request, State},
    http::{HeaderMap, HeaderValue, Method, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post, put, delete, patch},
    Router,
};
use axum::extract::DefaultBodyLimit;
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

mod auth;
mod config;
mod db;
mod handlers;
mod totp;
mod ws;

pub struct AppState {
    pub db: db::Database,
    pub config: config::Config,
    pub ws_manager: ws::WsManager,
    /// In-memory voice rooms (server voice channels + DM calls).
    /// Keyed by room id (channel_id for server rooms, dm_channel_id for DM calls).
    pub voice_rooms: std::sync::RwLock<std::collections::HashMap<String, ws::VoiceRoom>>,
    /// Whether the database has been set up (admin password set OR users exist).
    /// Starts as false on a fresh DB; set to true once admin password is set
    /// or the first user registers. Used to redirect visitors to admin setup.
    pub setup_complete: AtomicBool,
    /// G2 runtime-tunable limits, editable live from the admin panel (the
    /// admin-config tab) without a restart. Cached in memory so the hot path
    /// (every authenticated mutation + every file-upload init) never touches
    /// the DB. Precedence per value: admin_config DB row → env var → default.
    pub runtime_tuning: std::sync::Arc<std::sync::RwLock<RuntimeTuning>>,
}

/// G2 limits that can be tuned at runtime from the admin panel.
/// `0` means "unlimited" for every field.
#[derive(Clone, Debug)]
pub struct RuntimeTuning {
    /// Per-user mutation budget per 10s window (default 120).
    pub mutation_user_max: u32,
    /// Per-IP mutation budget per 10s window (default 1000).
    pub mutation_ip_max: u32,
    /// Per-user file-storage cap in bytes (default 1 GiB).
    pub file_storage_quota_bytes: i64,
    /// Where each value came from: "db" | "env" | "default" (for the admin UI).
    pub sources: [&'static str; 3],
}

impl RuntimeTuning {
    /// Load the tuning, honoring admin_config DB rows, then env vars, then defaults.
    pub fn load(db: &db::Database) -> Self {
        // Returns (db_value, env_value, default) as Option<u64>.
        let resolve = |key: &str, env: &str, default: u64| -> (Option<u64>, Option<u64>, u64) {
            let db_val = db.get_config_value(key).ok().flatten().and_then(|v| v.trim().parse::<u64>().ok());
            let env_val = std::env::var(env).ok().and_then(|v| v.trim().parse::<u64>().ok());
            (db_val, env_val, default)
        };

        let (db_user, env_user, def_user) = resolve("mutation_user_max", "MUTATION_USER_MAX", 120);
        let (db_ip, env_ip, def_ip) = resolve("mutation_ip_max", "MUTATION_IP_MAX", 1000);
        let (db_quota, env_quota, def_quota) = resolve("file_storage_quota_bytes", "FILE_STORAGE_QUOTA_BYTES", 1024 * 1024 * 1024);

        let pick = |db: Option<u64>, env: Option<u64>, def: u64| -> (u64, &'static str) {
            if let Some(v) = db {
                (v, "db")
            } else if let Some(v) = env {
                (v, "env")
            } else {
                (def, "default")
            }
        };

        let (user, src_user) = pick(db_user, env_user, def_user);
        let (ip, src_ip) = pick(db_ip, env_ip, def_ip);
        let (quota, src_quota) = pick(db_quota, env_quota, def_quota);

        RuntimeTuning {
            mutation_user_max: user as u32,
            mutation_ip_max: ip as u32,
            file_storage_quota_bytes: quota as i64,
            sources: [src_user, src_ip, src_quota],
        }
    }
}

/// G1 — Security headers on EVERY response (static pages AND API).
/// The static-file handler also sets these for HTML/JS/CSS; this middleware
/// guarantees the same protections for JSON/error responses too. HSTS is
/// emitted unconditionally: per RFC 6797 the browser ignores it on plain-HTTP
/// responses (the app also serves a dev HTTP port), so this is safe and matches
/// the static-file handler's behavior.
async fn security_headers_mw(request: Request, next: Next) -> Response {
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static(
            "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
        ),
    );
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert(
        "strict-transport-security",
        HeaderValue::from_static("max-age=31536000; includeSubDomains; preload"),
    );
    response
}

/// G2 — Per-user + per-IP rate limit on authenticated state-changing /api calls.
/// Skips the endpoints that have their own limiters (login/register/reauth,
/// admin, friend-request, WS) and file-chunk uploads (bounded by quota instead).
async fn mutation_rate_limit_mw(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let is_state_changing = matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    if is_state_changing && path.starts_with("/api/") {
        let skip = path.starts_with("/api/login")
            || path.starts_with("/api/register")
            || path.starts_with("/api/reauth")
            || path.starts_with("/api/admin/")
            || path.starts_with("/api/friends/request")
            || path.contains("/chunk/");
        if !skip {
            if let Some((status, json)) =
                handlers::check_mutation_rate_limit(request.headers(), &state)
            {
                return (status, json).into_response();
            }
        }
    }
    next.run(request).await
}

/// G3 — Same-origin check on state-changing endpoints. Browsers always send
/// Origin on POST/PUT/PATCH/DELETE; a mismatched host (DNS rebinding, CSRF via
/// cookie fallback) is rejected. Non-browser clients without Origin are allowed
/// (Bearer auth still applies).
async fn origin_check_mw(request: Request, next: Next) -> Response {
    let method = request.method().clone();
    let path = request.uri().path().to_string();
    let is_state_changing = matches!(
        method,
        Method::POST | Method::PUT | Method::PATCH | Method::DELETE
    );
    if is_state_changing && path.starts_with("/api/") {
        let origin = request
            .headers()
            .get("origin")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        let host = request
            .headers()
            .get("host")
            .and_then(|v| v.to_str().ok())
            .map(|s| s.to_string());
        if let (Some(origin), Some(host)) = (origin, host) {
            if !origin_host_matches(&origin, &host) {
                return (
                    StatusCode::FORBIDDEN,
                    axum::Json(serde_json::json!({"error": "Cross-origin request blocked"})),
                )
                    .into_response();
            }
        }
    }
    next.run(request).await
}

/// Compare an Origin header (e.g. "https://localhost:3443") with the Host
/// header ("localhost:3443"). Ignores the scheme; compares host+port
/// case-insensitively. Accepts the "null" origin (sandboxed/file contexts).
/// Also used by the WS handler (F6 — cross-site WebSocket hijacking guard).
pub(crate) fn origin_host_matches(origin: &str, host: &str) -> bool {
    if origin == "null" {
        return true;
    }
    let origin_host = origin
        .strip_prefix("http://")
        .or_else(|| origin.strip_prefix("https://"))
        .unwrap_or(origin)
        .split('/')
        .next()
        .unwrap_or("")
        .to_lowercase();
    let host_lower = host.to_lowercase();
    // Normalize default ports so https://example.com matches Host: example.com
    let origin_host = if origin_host.ends_with(":80") && origin.starts_with("http://") {
        origin_host.trim_end_matches(":80").to_string()
    } else if origin_host.ends_with(":443") && origin.starts_with("https://") {
        origin_host.trim_end_matches(":443").to_string()
    } else {
        origin_host
    };
    origin_host == host_lower
}

/// F1 — 301-redirect every plaintext-HTTP request to the HTTPS listener,
/// preserving the hostname (Tailscale IP / domain) and path.
async fn http_to_https_redirect(
    uri: axum::http::Uri,
    headers: HeaderMap,
    State(https_port): State<u16>,
) -> Response {
    let host = headers
        .get("host")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| "localhost".to_string());
    // Strip any port from the Host so the redirect lands on the HTTPS port.
    let host_no_port = match host.rfind(':') {
        Some(idx) if host[idx + 1..].chars().all(|c| c.is_ascii_digit()) => host[..idx].to_string(),
        _ => host,
    };
    let target = format!(
        "https://{}:{}{}",
        host_no_port,
        https_port,
        uri.path_and_query().map(|pq| pq.as_str()).unwrap_or("/")
    );
    let mut response = Response::new(axum::body::Body::empty());
    *response.status_mut() = StatusCode::MOVED_PERMANENTLY;
    response
        .headers_mut()
        .insert("location", HeaderValue::from_str(&target).unwrap());
    response.headers_mut().insert("cache-control", HeaderValue::from_static("no-store"));
    response
}

async fn serve_static(
    uri: axum::http::Uri,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    // F9 — hard-block parent-directory traversal BEFORE touching the filesystem.
    // Percent-decode first ("%2e%2e" must not bypass the check), then reject any
    // path whose segments contain ".." or ".". This closes the real leak where
    // "/../server/.env" resolved through ../static back into the server dir and
    // served the live JWT_SECRET / HMAC_KEY.
    let raw_path = uri.path();
    let decoded_probe = raw_path.replace("%2e", ".").replace("%2E", ".");
    let has_traversal = decoded_probe.split('/').any(|seg| seg == ".." || seg == ".");
    if has_traversal {
        let mut headers = HeaderMap::new();
        headers.insert("content-type", HeaderValue::from_static("text/plain"));
        return (
            StatusCode::NOT_FOUND,
            headers,
            b"404 Not Found".to_vec(),
        )
            .into_response();
    }
    let path = format!("../static{}", raw_path);
    let path = if std::path::Path::new(&path).is_dir() {
        format!("{}index.html", path)
    } else {
        path
    };

    // If the database is freshly initialized (no admin password, no users),
    // redirect the visitor to the admin setup page so the host can configure
    // the admin password before anyone else uses the app.
    // Skip the redirect for /admin.html and static assets needed to render
    // the admin page.
    if !state.setup_complete.load(Ordering::Relaxed) {
        let req_path = uri.path();
        // Allow access to the admin setup page, its assets, and API calls
        // needed to check/set the admin password.
        let is_admin_path = req_path.starts_with("/admin")
            || req_path.starts_with("/api/admin/")
            || req_path.ends_with(".js")
            || req_path.ends_with(".css")
            || req_path == "/favicon.ico";
        if !is_admin_path {
            let mut headers = HeaderMap::new();
            headers.insert("location", HeaderValue::from_str("/admin.html").unwrap());
            return (StatusCode::FOUND, headers, Vec::new()).into_response();
        }
    }

    match tokio::fs::read(&path).await {
        Ok(contents) => {
            let mime = if path.ends_with(".html") {
                "text/html"
            } else if path.ends_with(".js") {
                "application/javascript"
            } else if path.ends_with(".css") {
                "text/css"
            } else if path.ends_with(".json") {
                "application/json"
            } else {
                "application/octet-stream"
            };

            let mut headers = HeaderMap::new();
            headers.insert("content-type", HeaderValue::from_static(mime));
            headers.insert("cache-control", HeaderValue::from_static("no-store, no-cache, must-revalidate"));
            headers.insert("pragma", HeaderValue::from_static("no-cache"));
            headers.insert("expires", HeaderValue::from_static("0"));
            headers.insert("content-security-policy", HeaderValue::from_static(
                "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; object-src 'none'; frame-src 'none'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
            ));
            headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
            headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
            headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
            headers.insert("strict-transport-security", HeaderValue::from_static(
                "max-age=31536000; includeSubDomains; preload"
            ));

            (headers, contents).into_response()
        }
        Err(_) => {
            // F9 — a missing (or path-traversed) file must return a REAL 404
            // status, not 200 with a "404 Not Found" body.
            let mut headers = HeaderMap::new();
            headers.insert("content-type", HeaderValue::from_static("text/plain"));
            (
                StatusCode::NOT_FOUND,
                headers,
                b"404 Not Found".to_vec(),
            )
                .into_response()
        }
    }
}

fn generate_self_signed_cert(cert_dir: &str) -> Result<(String, String), Box<dyn std::error::Error>> {
    use rcgen::CertificateParams;

    std::fs::create_dir_all(cert_dir)?;

    let cert_path = format!("{}/cert.pem", cert_dir);
    let key_path = format!("{}/key.pem", cert_dir);

    // Check if certs already exist
    if std::path::Path::new(&cert_path).exists() && std::path::Path::new(&key_path).exists() {
        return Ok((cert_path, key_path));
    }

    let mut params = CertificateParams::new(vec!["localhost".to_string()])?;
    params.subject_alt_names = vec![
        rcgen::SanType::DnsName("localhost".try_into()?),
        rcgen::SanType::IpAddress("127.0.0.1".parse()?),
        rcgen::SanType::IpAddress("::1".parse()?),
    ];

    // Auto-detect Tailscale IPs from network interfaces
    if let Ok(addrs) = local_ip_address::list_afinet_netifas() {
        for (_name, ip) in addrs {
            if ip.is_loopback() { continue; }
            if let std::net::IpAddr::V4(v4) = ip {
                let octets = v4.octets();
                // Tailscale CGNAT range: 100.64.0.0/10
                if octets[0] == 100 && (octets[1] & 0xC0) == 64 {
                    params.subject_alt_names.push(rcgen::SanType::IpAddress(ip));
                    tracing::info!("Auto-detected Tailscale IP: {}", ip);
                }
            }
        }
    }

    // Allow additional SANs via env var (e.g., TLS_SAN=100.80.1.2,myhostname)
    if let Ok(extra_sans) = std::env::var("TLS_SAN") {
        for san in extra_sans.split(',') {
            let san = san.trim();
            if let Ok(ip) = san.parse::<std::net::IpAddr>() {
                params.subject_alt_names.push(rcgen::SanType::IpAddress(ip));
            } else if let Ok(dns) = san.try_into() {
                params.subject_alt_names.push(rcgen::SanType::DnsName(dns));
            }
        }
    }

    let key_pair = rcgen::KeyPair::generate()?;
    let cert = params.self_signed(&key_pair)?;

    std::fs::write(&cert_path, cert.pem())?;
    std::fs::write(&key_path, key_pair.serialize_pem())?;

    Ok((cert_path, key_path))
}

#[tokio::main]
async fn main() {
    tracing_subscriber::registry()
        .with(EnvFilter::new("info"))
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = config::Config::from_env();
    let db = db::Database::new(&config.database_url).expect("Failed to initialize database");
    // A server restart invalidates every in-memory voice room, so any persisted
    // DM-call waiting state is stale (the waiting user's connection died with
    // the server). Clear it so nobody is left with a phantom "waiting for you
    // to join" indicator after a restart.
    match db.clear_all_dm_call_waiting() {
        Ok(()) => tracing::info!("Cleared stale DM-call waiting state on startup."),
        Err(e) => tracing::warn!("Could not clear stale DM-call waiting state: {}", e),
    }
    let ws_manager = ws::WsManager::new();

    let fresh = db.is_fresh_db().unwrap_or(true);
    tracing::info!("Database setup status: {}", if fresh { "fresh — redirecting to admin setup" } else { "configured" });
    let runtime_tuning = std::sync::Arc::new(std::sync::RwLock::new(RuntimeTuning::load(&db)));
    let state = Arc::new(AppState {
        setup_complete: AtomicBool::new(!fresh),
        db,
        config: config.clone(),
        ws_manager,
        voice_rooms: std::sync::RwLock::new(std::collections::HashMap::new()),
        runtime_tuning,
    });

    // Run orphan file cleanup on startup, then periodically every hour
    // Uses spawn_blocking because filesystem operations are synchronous.
    {
        let state_for_cleanup = state.clone();
        tokio::spawn(async move {
            // Initial cleanup on startup
            tracing::info!("Running orphan file cleanup...");
            let s = state_for_cleanup.clone();
            let _ = tokio::task::spawn_blocking(move || {
                s.db.cleanup_orphan_files("uploads");
            }).await;
            tracing::info!("Orphan file cleanup complete.");

            // Schedule periodic cleanup every hour
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(3600));
            loop {
                interval.tick().await;
                let s = state_for_cleanup.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    s.db.cleanup_orphan_files("uploads");
                }).await;
            }
        });
    }

    // Periodic sweep of stale DM-call waiting markers (owner gone longer than
    // the grace window without a clean disconnect: crash, network loss, or the
    // server dropping the socket without firing the disconnect cleanup). Runs
    // alongside the per-disconnect grace task as the safety net — a refresh
    // re-joins within the grace window, so it is never swept.
    {
        let state_for_sweep = state.clone();
        tokio::spawn(async move {
            let interval_secs = state_for_sweep.config.voice_wait_sweep_secs.max(5);
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(interval_secs));
            loop {
                interval.tick().await;
                ws::sweep_stale_waiting(&state_for_sweep).await;
            }
        });
    }

    let app = Router::new()
        .route("/api/auth-params/{username}", get(handlers::get_auth_params))
        .route("/api/register", post(handlers::register))
        .route("/api/login", post(handlers::login))
        .route("/api/login/2fa", post(handlers::login_2fa))
        .route("/api/2fa/enroll", post(handlers::enroll_2fa))
        .route("/api/2fa/verify-enroll", post(handlers::verify_enroll_2fa))
        .route("/api/2fa/disable", post(handlers::disable_2fa))
        .route("/api/2fa/status", get(handlers::get_2fa_status))
        .route("/api/password/change", post(handlers::change_password))
        .route("/api/servers", get(handlers::list_servers).post(handlers::create_server))
        .route("/api/servers/{server_id}/channels", get(handlers::list_channels).post(handlers::create_channel))
        .route("/api/servers/{server_id}/members", get(handlers::list_server_members))
        .route("/api/servers/{server_id}/members/kick", post(handlers::kick_member))
        .route("/api/servers/{server_id}/members/ban", post(handlers::ban_member))
        .route("/api/servers/{server_id}/members/unban/{user_id}", post(handlers::unban_member))
        .route("/api/servers/{server_id}/bans", get(handlers::list_server_bans))
        .route("/api/servers/{server_id}/leave", post(handlers::leave_server))
        .route("/api/servers/{server_id}/invite", get(handlers::get_invite).post(handlers::regenerate_invite))
        .route("/api/servers/{server_id}/keys", get(handlers::get_server_keys).post(handlers::upload_server_key))
        .route("/api/servers/{server_id}/keys/rotate", post(handlers::rotate_server_keys))
        .route("/api/servers/{server_id}/settings", patch(handlers::set_joins_disabled))
        .route("/api/servers/{server_id}/name", put(handlers::update_server_name))
        .route("/api/servers/{server_id}/picture", put(handlers::update_server_picture))
        .route("/api/servers/{server_id}/channels/{channel_id}/name", put(handlers::update_channel_name))
        .route("/api/channels/{channel_id}/messages", get(handlers::list_messages))
        .route("/api/channels/{channel_id}/messages/around/{message_id}", get(handlers::list_messages_around))
        .route("/api/channels/{channel_id}/pins", get(handlers::list_channel_pins))
        .route("/api/channels/{channel_id}", delete(handlers::delete_channel))
        .route("/api/invites/join", post(handlers::join_server))
        .route("/api/identity/{user_id}", get(handlers::get_identity_key))
        // Voice: TURN server config for WebRTC calls (strict NAT traversal)
        .route("/api/voice/turn-config", get(handlers::get_turn_config))
        // Device management routes
        .route("/api/logout", post(handlers::logout).get(handlers::logout_get))
        .route("/api/reauth", post(handlers::reauth))
        .route("/api/auth/sessions", get(handlers::list_auth_sessions))
        .route("/api/auth/sessions/kick", post(handlers::kick_auth_session))
        .route("/api/auth/sessions/kick-all", post(handlers::kick_all_auth_sessions))
        .route("/api/key-blob", put(handlers::save_user_key_blob).get(handlers::get_user_key_blob))
        .route("/api/user/{username}", get(handlers::get_user_id))
        // Specific routes must come before parameterized routes to avoid Axum
        // matching literal path segments as parameters and returning 405.
        .route("/api/profile/data-key", put(handlers::save_profile_data_key))
        .route("/api/profile/data-key/{user_id}", get(handlers::get_profile_data_key))
        .route("/api/profile/data-key/shared", put(handlers::save_shared_profile_data_key))
        .route("/api/profile/data-key/shared/batch", post(handlers::get_shared_profile_data_keys_batch))
        .route("/api/profile/data-key/shared/{target_type}/{target_id}", get(handlers::get_shared_profile_data_keys).delete(handlers::delete_shared_profile_data_key))
        .route("/api/profile", patch(handlers::update_profile))
        .route("/api/profile/{user_id}", get(handlers::get_profile))
        .route("/api/profile/conversation", put(handlers::upsert_conversation_profile))
        .route("/api/profile/{target_user_id}/conversation/{conv_type}/{conv_id}", get(handlers::get_conversation_profile))
        .route("/api/admin/login", post(handlers::admin_login))
        .route("/api/admin/logout", post(handlers::admin_logout))
        .route("/api/admin/users", get(handlers::admin_list_users))
        .route("/api/admin/users/{user_id}", delete(handlers::admin_delete_user))
        .route("/api/admin/users/{user_id}/disable-2fa", post(handlers::admin_disable_user_2fa))
        .route("/api/admin/users/{user_id}/stats", get(handlers::admin_user_cascade_stats))
        .route("/api/admin/servers", get(handlers::admin_list_servers))
        .route("/api/admin/servers/{server_id}", delete(handlers::admin_delete_server))
        .route("/api/admin/channels", get(handlers::admin_list_channels))
        .route("/api/admin/channels/{channel_id}", delete(handlers::admin_delete_channel))
        .route("/api/admin/messages", get(handlers::admin_list_messages))
        .route("/api/admin/server-keys", get(handlers::admin_list_server_keys))
        .route("/api/admin/server-members", get(handlers::admin_list_server_members))
        .route("/api/admin/server-bans", get(handlers::admin_list_server_bans))
        .route("/api/admin/dm-channels", get(handlers::admin_list_dm_channels))
        .route("/api/admin/dm-members", get(handlers::admin_list_dm_members))
        .route("/api/admin/dm-messages", get(handlers::admin_list_dm_messages))
        .route("/api/admin/dm-keys", get(handlers::admin_list_dm_keys))
        .route("/api/admin/friend-requests", get(handlers::admin_list_friend_requests))
        .route("/api/admin/friendships", get(handlers::admin_list_friendships))
.route("/api/admin/files", get(handlers::admin_list_files)).route("/api/admin/user-stickers", get(handlers::admin_list_user_stickers))
        .route("/api/admin/notification-sounds", get(handlers::admin_list_notification_sounds))
        .route("/api/admin/admin-config", get(handlers::admin_list_admin_config))
        .route("/api/admin/user-key-escrow", get(handlers::admin_list_user_key_escrow))
        .route("/api/admin/user-device-escrow", get(handlers::admin_list_user_device_escrow))
        .route("/api/admin/pending-events", get(handlers::admin_list_pending_events))
        .route("/api/admin/pending-notifications", get(handlers::admin_list_pending_notifications))
        .route("/api/admin/voice-sessions", get(handlers::admin_list_voice_sessions))
        .route("/api/admin/voice-participants", get(handlers::admin_list_voice_participants))
        .route("/api/admin/user-media", get(handlers::admin_list_user_media))
        .route("/api/admin/user-key-blobs", get(handlers::admin_list_user_key_blobs))
        .route("/api/admin/profile-data-keys", get(handlers::admin_list_profile_data_keys))
        .route("/api/admin/shared-profile-data-keys", get(handlers::admin_list_shared_profile_data_keys))
        .route("/api/admin/export-db", get(handlers::admin_export_db))
        .route("/api/admin/import-db", post(handlers::admin_import_db))
        .route("/api/admin/clear", post(handlers::admin_clear_all))
        .route("/api/admin/audit-log", get(handlers::admin_audit_log))
        .route(
            "/api/admin/runtime-config",
            get(handlers::admin_get_runtime_config).put(handlers::admin_set_runtime_config),
        )
        .route("/api/admin/rate-limit-usage", get(handlers::admin_get_rate_limit_usage))
        // Phase 4: Friends + DMs
        .route("/api/me", get(handlers::get_me).delete(handlers::delete_me))
        .route("/api/hmac-key", get(handlers::get_hmac_key))
        .route("/api/friend-code", get(handlers::get_my_friend_code))
        .route("/api/friend-code/store-encrypted", post(handlers::store_encrypted_friend_code))
        .route("/api/friend-code/regenerate", post(handlers::server_regenerate_friend_code))
        .route("/api/friend-code/regen-with-password", post(handlers::regen_friend_code_with_password))
        .route("/api/friends", get(handlers::list_friends))
        .route("/api/notification-sound", post(handlers::upload_notification_sound).get(handlers::get_notification_sound).delete(handlers::delete_notification_sound))
        .route("/api/ringtone", post(handlers::upload_ringtone).get(handlers::get_ringtone).delete(handlers::delete_ringtone))
        .route("/api/friends/remove", post(handlers::remove_friend))
        .route("/api/friends/request", post(handlers::send_friend_request))
        .route("/api/friends/requests/disabled", get(handlers::get_friend_requests_disabled).post(handlers::set_friend_requests_disabled))
        .route("/api/friends/requests/incoming", get(handlers::list_incoming_friend_requests))
        .route("/api/friends/requests/outgoing", get(handlers::list_outgoing_friend_requests))
        .route("/api/friends/requests/accept", post(handlers::accept_friend_request))
        .route("/api/friends/requests/decline", post(handlers::decline_friend_request))
        .route("/api/dm/conversations", get(handlers::list_dm_conversations))
        .route("/api/dm/{friend_user_id}", post(handlers::get_or_create_dm))
        .route("/api/dm/{dm_channel_id}/messages", get(handlers::list_dm_messages))
        .route("/api/dm/{dm_channel_id}/pins", get(handlers::list_dm_pins))
        .route("/api/dm/{dm_channel_id}/keys", get(handlers::get_dm_keys).post(handlers::upload_dm_key))
        // Phase 5: File Sharing
        .route("/api/files/init", post(handlers::init_file_upload))
        .route("/api/files/{file_id}/chunk/{index}", post(handlers::upload_file_chunk))
        .route("/api/files/{file_id}/complete", post(handlers::complete_file_upload))
        .route("/api/files/{file_id}/download", get(handlers::download_file))
        .route("/api/files/by-hash/{hash}/download", get(handlers::download_file_by_hash))
        // Phase 10: Server Stickers
        
        // Phase 12: User Stickers/GIFs
        .route("/api/users/me/stickers", get(handlers::list_user_stickers).post(handlers::add_user_sticker))
        .route("/api/users/me/stickers/{sticker_id}", delete(handlers::remove_user_sticker))
        .route("/api/online", get(handlers::list_online_users))
        .route("/ws", get(ws::ws_handler))
        .fallback(get(serve_static))
        // Encrypted audio blobs (notification sounds, ringtones) are base64 in
        // JSON bodies — a 30s 48kHz WAV is several MB, far over axum's default
        // 2MB Json limit. Raise it to 32MB (still way below any DoS concern
        // since payloads are per-authenticated-user and rate-limited).
        .layer(DefaultBodyLimit::max(32 * 1024 * 1024))
        // G1/G2/G3 hardening layers. Order (last layer = outermost): the
        // security headers wrap everything; the origin check and mutation
        // rate limit run before handlers. File-chunk uploads are exempt from
        // the mutation limiter (bounded by the storage quota instead).
        .layer(middleware::from_fn_with_state(state.clone(), mutation_rate_limit_mw))
        .layer(middleware::from_fn(origin_check_mw))
        .layer(middleware::from_fn(security_headers_mw))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", config.port);

    // Determine TLS configuration
    let use_tls = match (&config.tls_cert_path, &config.tls_key_path) {
        (Some(cert), Some(key)) => {
            tracing::info!("Using provided TLS certificates: cert={}, key={}", cert, key);
            Some(axum_server::tls_rustls::RustlsConfig::from_pem_file(cert, key)
                .await
                .expect("Failed to load TLS certificates"))
        }
        _ => {
            // Auto-generate self-signed cert for development
            let cert_dir = "certs";
            match generate_self_signed_cert(cert_dir) {
                Ok((cert, key)) => {
                    tracing::info!("Auto-generated self-signed TLS certificates in {}", cert_dir);
                    tracing::info!("For trusted HTTPS, install mkcert and run:");
                    tracing::info!("  mkcert -install");
                    tracing::info!("  mkcert localhost 127.0.0.1 ::1");
                    tracing::info!("Then set TLS_CERT_PATH and TLS_KEY_PATH env vars");
                    Some(axum_server::tls_rustls::RustlsConfig::from_pem_file(&cert, &key)
                        .await
                        .expect("Failed to load auto-generated TLS certificates"))
                }
                Err(e) => {
                    tracing::warn!("Could not generate TLS certificates: {}. Running without TLS.", e);
                    None
                }
            }
        }
    };

    tracing::info!("Server starting on {}", addr);

    match use_tls {
        Some(tls_config) => {
            // HTTPS_PORT lets tests run a second instance sharing the DB (for
            // the server-restart behavior) without colliding with the main one.
            let https_port: u16 = std::env::var("HTTPS_PORT")
                .ok()
                .and_then(|s| s.parse().ok())
                .unwrap_or(3443u16);
            let https_addr: std::net::SocketAddr = format!("0.0.0.0:{}", https_port).parse().unwrap();
            tracing::info!("HTTPS available on https://localhost:{}", https_port);

            // F1 — the plaintext port NEVER serves the app. When TLS is on it
            // only issues a 301 redirect to the HTTPS listener (same host),
            // so credentials / keys are never exposed in the clear. Set
            // PORT=0 to disable the plaintext port entirely.
            if config.port != 0 {
                tracing::info!(
                    "HTTP on http://localhost:{} redirects to HTTPS :{}",
                    config.port,
                    https_port
                );
                let http_addr = addr.clone();
                let redirect_router = Router::new()
                    .fallback(http_to_https_redirect)
                    .with_state(https_port);
                tokio::spawn(async move {
                    let listener = tokio::net::TcpListener::bind(&http_addr).await.unwrap();
                    axum::serve(listener, redirect_router).await.unwrap();
                });
            } else {
                tracing::info!("Plaintext HTTP listener disabled (PORT=0)");
            }

            // Serve HTTPS on port+1
            axum_server::bind_rustls(https_addr, tls_config)
                .serve(app.into_make_service())
                .await
                .unwrap();
        }
        None => {
            tracing::info!("Running without TLS on http://{}", addr);
            let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
            axum::serve(listener, app).await.unwrap();
        }
    }
}


