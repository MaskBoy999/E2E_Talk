use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use axum::{
    extract::State,
    http::{HeaderMap, HeaderValue, StatusCode},
    response::IntoResponse,
    routing::{get, post, put, delete, patch},
    Router,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt, EnvFilter};

mod auth;
mod config;
mod db;
mod handlers;
mod ws;

pub struct AppState {
    pub db: db::Database,
    pub config: config::Config,
    pub ws_manager: ws::WsManager,
    /// Whether the database has been set up (admin password set OR users exist).
    /// Starts as false on a fresh DB; set to true once admin password is set
    /// or the first user registers. Used to redirect visitors to admin setup.
    pub setup_complete: AtomicBool,
}

async fn serve_static(
    uri: axum::http::Uri,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    let path = format!("../static{}", uri.path());
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
                "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
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
            let mut headers = HeaderMap::new();
            headers.insert("content-type", HeaderValue::from_static("text/plain"));
            (headers, b"404 Not Found".to_vec()).into_response()
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
    let ws_manager = ws::WsManager::new();

    let fresh = db.is_fresh_db().unwrap_or(true);
    tracing::info!("Database setup status: {}", if fresh { "fresh — redirecting to admin setup" } else { "configured" });
    let state = Arc::new(AppState {
        setup_complete: AtomicBool::new(!fresh),
        db,
        config: config.clone(),
        ws_manager,
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

    let app = Router::new()
        .route("/api/auth-params/{username}", get(handlers::get_auth_params))
        .route("/api/register", post(handlers::register))
        .route("/api/login", post(handlers::login))
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
        .route("/api/channels/{channel_id}", delete(handlers::delete_channel))
        .route("/api/invites/join", post(handlers::join_server))
        .route("/api/identity/{user_id}", get(handlers::get_identity_key))
        // Device management routes
        .route("/api/logout", post(handlers::logout).get(handlers::logout_get))
        .route("/api/reauth", post(handlers::reauth))
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
        .route("/api/admin/users", get(handlers::admin_list_users))
        .route("/api/admin/users/{user_id}", delete(handlers::admin_delete_user))
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
        .route("/api/admin/prekey-bundles", get(handlers::admin_list_prekey_bundles))
        .route("/api/admin/sessions", get(handlers::admin_list_sessions))
        .route("/api/admin/user-public-keys", get(handlers::admin_list_user_public_keys))
        .route("/api/admin/user-key-escrow", get(handlers::admin_list_user_key_escrow))
        .route("/api/admin/user-device-escrow", get(handlers::admin_list_user_device_escrow))
        .route("/api/admin/clear", post(handlers::admin_clear_all))
        // Phase 4: Friends + DMs
        .route("/api/me", get(handlers::get_me).delete(handlers::delete_me))
        .route("/api/hmac-key", get(handlers::get_hmac_key))
        .route("/api/friend-code", get(handlers::get_my_friend_code))
        .route("/api/friend-code/store-encrypted", post(handlers::store_encrypted_friend_code))
        .route("/api/friend-code/regenerate", post(handlers::server_regenerate_friend_code))
        .route("/api/friend-code/regen-with-password", post(handlers::regen_friend_code_with_password))
        .route("/api/friends", get(handlers::list_friends))
        .route("/api/notification-sound", post(handlers::upload_notification_sound).get(handlers::get_notification_sound).delete(handlers::delete_notification_sound))
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
            let https_port = 3443u16;
            let https_addr: std::net::SocketAddr = format!("0.0.0.0:{}", https_port).parse().unwrap();
            tracing::info!("HTTPS available on https://localhost:{}", https_port);
            tracing::info!("HTTP available on http://localhost:{}", config.port);

            // Serve HTTP on the main port
            let http_addr = addr.clone();
            let app_clone = app.clone();
            tokio::spawn(async move {
                let listener = tokio::net::TcpListener::bind(&http_addr).await.unwrap();
                axum::serve(listener, app_clone).await.unwrap();
            });

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


