use std::sync::Arc;

use axum::{
    http::{HeaderMap, HeaderValue},
    routing::{get, post},
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
        .route("/api/channels", get(handlers::list_channels))
        .route("/api/channels/{channel_id}/messages", get(handlers::list_messages))
        .route("/api/keys/{user_id}", get(handlers::get_key_bundle))
        .route("/api/user/{username}", get(handlers::get_user_id))
        .route("/api/admin/login", post(handlers::admin_login))
        .route("/api/admin/users", get(handlers::admin_list_users))
        .route("/api/admin/users/{user_id}", axum::routing::delete(handlers::admin_delete_user))
        .route("/ws", get(ws::ws_handler))
        .fallback(get(serve_static))
        .with_state(state);

    let addr = format!("0.0.0.0:{}", config.port);
    tracing::info!("Server starting on {}", addr);
    let listener = tokio::net::TcpListener::bind(&addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}
