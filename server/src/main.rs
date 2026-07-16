use std::sync::Arc;

use axum::{
    http::{HeaderMap, HeaderValue},
    routing::{get, post, delete, patch},
    Router,
};
use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

mod auth;
mod config;
mod db;
mod handlers;
mod ws;

pub struct AppState {
    pub db: db::Database,
    pub config: config::Config,
    pub ws_manager: ws::WsManager,
}

async fn serve_static(uri: axum::http::Uri) -> impl axum::response::IntoResponse {
    let path = format!("../static{}", uri.path());
    let path = if std::path::Path::new(&path).is_dir() {
        format!("{}index.html", path)
    } else {
        path
    };

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
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
            ));
            headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
            headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
            headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
            headers.insert("strict-transport-security", HeaderValue::from_static(
                "max-age=31536000; includeSubDomains; preload"
            ));

            (headers, contents)
        }
        Err(_) => {
            let mut headers = HeaderMap::new();
            headers.insert("content-type", HeaderValue::from_static("text/plain"));
            (headers, b"404 Not Found".to_vec())
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
        .with(tracing_subscriber::fmt::layer())
        .init();

    let config = config::Config::from_env();
    let db = db::Database::new(&config.database_url).expect("Failed to initialize database");
    let ws_manager = ws::WsManager::new();

    let state = Arc::new(AppState {
        db,
        config: config.clone(),
        ws_manager,
    });

    let app = Router::new()
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
        .route("/api/channels/{channel_id}/messages", get(handlers::list_messages))
        .route("/api/channels/{channel_id}/messages/around/{message_id}", get(handlers::list_messages_around))
        .route("/api/channels/{channel_id}", delete(handlers::delete_channel))
        .route("/api/invites/join", post(handlers::join_server))
        .route("/api/keys/{user_id}", get(handlers::get_key_bundle))
        .route("/api/identity/{user_id}", get(handlers::get_identity_key))
        .route("/api/identity/upload", post(handlers::upload_identity_key))
        .route("/api/identity/add-key", post(handlers::add_device_key))
        .route("/api/identity/escrow", post(handlers::upload_escrowed_key).get(handlers::get_escrowed_key))
        .route("/api/reauth", post(handlers::reauth))
        .route("/api/user/{username}", get(handlers::get_user_id))
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
        .route("/api/admin/prekey-bundles", get(handlers::admin_list_prekey_bundles))
        .route("/api/admin/sessions", get(handlers::admin_list_sessions))
        .route("/api/admin/server-bans", get(handlers::admin_list_server_bans))
        .route("/api/admin/dm-channels", get(handlers::admin_list_dm_channels))
        .route("/api/admin/dm-members", get(handlers::admin_list_dm_members))
        .route("/api/admin/dm-messages", get(handlers::admin_list_dm_messages))
        .route("/api/admin/dm-keys", get(handlers::admin_list_dm_keys))
        .route("/api/admin/friend-requests", get(handlers::admin_list_friend_requests))
        .route("/api/admin/friendships", get(handlers::admin_list_friendships))
        .route("/api/admin/user-public-keys", get(handlers::admin_list_user_public_keys))
.route("/api/admin/files", get(handlers::admin_list_files))
.route("/api/admin/user-stickers", get(handlers::admin_list_user_stickers))
.route("/api/admin/server-stickers", get(handlers::admin_list_server_stickers))
.route("/api/admin/user-key-escrow", get(handlers::admin_list_user_key_escrow))
.route("/api/admin/clear", post(handlers::admin_clear_all))
        // Phase 4: Friends + DMs
        .route("/api/me", get(handlers::get_me).delete(handlers::delete_me))
        .route("/api/friends", get(handlers::list_friends))
        .route("/api/friends/remove", post(handlers::remove_friend))
        .route("/api/friends/request", post(handlers::send_friend_request))
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
        // Phase 10: Server Stickers
        .route("/api/servers/{server_id}/stickers", get(handlers::list_server_stickers).post(handlers::add_server_sticker))
        .route("/api/servers/{server_id}/stickers/{sticker_id}", delete(handlers::remove_server_sticker))
        // Phase 12: User Stickers/GIFs
        .route("/api/users/me/stickers", get(handlers::list_user_stickers).post(handlers::add_user_sticker))
        .route("/api/users/me/stickers/{sticker_id}", delete(handlers::remove_user_sticker))
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


