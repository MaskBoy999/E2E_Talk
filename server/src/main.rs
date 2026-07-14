use std::sync::Arc;

use axum::{
    http::{HeaderMap, HeaderValue},
    routing::{get, post, delete},
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
        .route("/api/channels/{channel_id}/messages", get(handlers::list_messages))
        .route("/api/channels/{channel_id}", delete(handlers::delete_channel))
        .route("/api/invites/join", post(handlers::join_server))
        .route("/api/keys/{user_id}", get(handlers::get_key_bundle))
        .route("/api/identity/{user_id}", get(handlers::get_identity_key))
        .route("/api/identity/upload", post(handlers::upload_identity_key))
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
        .route("/ws", get(ws::ws_handler))
        .fallback(get(serve_static))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", config.port);
    tracing::info!("Server starting on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
