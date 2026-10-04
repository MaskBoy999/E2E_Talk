// The runtime-tuning JSON response carries every tunable (50+ fields) in one
// `serde_json::json!` literal; the macro expands recursively per field, which
// overruns the default recursion limit.
#![recursion_limit = "512"]

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
mod push;
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
    /// F3 — single-use login nonces. `/api/auth-params/{username}` hands one
    /// out per account; the login signature covers exactly one of them and it
    /// is consumed on first use (2-minute TTL, bounded per user), so a
    /// captured signed login can never be replayed.
    pub login_nonces: std::sync::Mutex<std::collections::HashMap<String, Vec<(String, std::time::Instant)>>>,
    /// Temporary soundboard play audio (token → (bytes, created_at)).
    /// Clients upload decrypted audio here, send the token via WS,
    /// and receivers fetch via HTTP — avoids base64-enormous WS payloads.
    pub sb_temp_play: std::sync::RwLock<std::collections::HashMap<String, (Vec<u8>, std::time::Instant)>>,
    /// VAPID keypair for Web Push (self-generated on first boot, persisted
    /// next to the database). None if key generation failed — push is then
    /// disabled but everything else keeps working.
    pub vapid: Option<push::VapidKeys>,
    /// Optional Firebase service-account key (env `FCM_SERVICE_ACCOUNT_JSON`,
    /// raw JSON or a path). None = Android push off.
    pub fcm: Option<push::FcmCredentials>,
    /// Cached OAuth2 access token for the FCM v1 API.
    pub fcm_token: push::FcmTokenCache,
    /// Shared HTTP client for push sends (connection pooling).
    pub push_http: reqwest::Client,
    /// Hostnames this server answers to. A DNS-rebinding request arrives with
    /// the attacker's hostname in `Host` while connected to this server's IP,
    /// so comparing Origin to Host cannot catch it (they match by design).
    /// Built at startup from localhost + every local interface address +
    /// `TLS_SAN` / `ALLOWED_HOSTS`; empty disables the check (`ALLOWED_HOSTS=*`).
    pub allowed_hosts: Vec<String>,
}

/// Hostnames/Host-ports this server is allowed to answer for. A DNS-rebinding
/// attack hits the server's IP with the attacker's *hostname* in Host; the
/// only reliable defence is a list of names the server actually owns.
/// `ALLOWED_HOSTS=*` disables the check for exotic reverse-proxy setups.
fn build_allowed_hosts() -> Vec<String> {
    fn push(haystack: &mut Vec<String>, raw: &str) {
        let name = raw.trim().to_ascii_lowercase();
        if name.is_empty() { return; }
        if !haystack.contains(&name) { haystack.push(name); }
    }
    if let Ok(val) = std::env::var("ALLOWED_HOSTS") {
        if val.split(',').any(|s| s.trim() == "*") {
            return Vec::new();
        }
    }
    let mut hosts: Vec<String> = Vec::new();
    for base in ["localhost", "127.0.0.1", "[::1]", "::1"] {
        push(&mut hosts, base);
    }
    for var in ["ALLOWED_HOSTS", "TLS_SAN"] {
        if let Ok(val) = std::env::var(var) {
            for entry in val.split(',') { push(&mut hosts, entry); }
        }
    }
    if let Ok(addrs) = local_ip_address::list_afinet_netifas() {
        for (_name, ip) in addrs { push(&mut hosts, &ip.to_string()); }
    }
    hosts
}

/// Strip a port from a Host header value, preserving IPv6 brackets
/// (`[::1]:3443` → `[::1]`, `localhost:3443` → `localhost`).
fn host_without_port(host: &str) -> String {
    let host = host.trim().to_ascii_lowercase();
    if host.starts_with('[') {
        if let Some(end) = host.find(']') { return host[..=end].to_string(); }
        return host;
    }
    match host.rsplit_once(':') {
        Some((name, port))
            if !port.is_empty() && port.chars().all(|c| c.is_ascii_digit()) =>
        {
            name.to_string()
        }
        _ => host,
    }
}

/// The app's Permissions-Policy. Calls and screen share keep camera,
/// microphone and display-capture on this origin; everything the app never
/// uses is denied outright, so a successful XSS cannot reach the mic, the
/// camera or the user's location.
const PERMISSIONS_POLICY: &str = "camera=(self), microphone=(self), display-capture=(self), geolocation=(), payment=(), usb=(), serial=(), hid=(), midi=(), idle-detection=()";

impl AppState {
    /// HMAC under the published client-pseudonym key (never the master). Use
    /// this for every value a client must be able to recompute: sender /
    /// reactor / voter / acker ids, friend-request user ids, and notification
    /// type blinding. Friend/invite code hashes use `config.hmac_key` directly
    /// and stay server-side, so a fetched client key cannot hash codes.
    pub fn client_hmac_hex(&self, data: &str) -> String {
        db::hmac_sha256_hex(self.config.client_key.as_bytes(), data)
    }

    /// F3 — mint a fresh single-use login nonce (32 random bytes, hex).
    pub fn issue_login_nonce(&self, username: &str) -> String {
        use rand::Rng;
        let mut rng = rand::thread_rng();
        let nonce: String = (0..32).map(|_| format!("{:02x}", rng.gen::<u8>())).collect();
        let mut map = self.login_nonces.lock().unwrap();
        // Bound the map: drop expired entries when it grows past a sane cap.
        if map.len() > 10_000 {
            map.retain(|_, v| {
                v.retain(|(_, t)| t.elapsed() < LOGIN_NONCE_TTL);
                !v.is_empty()
            });
        }
        let entry = map.entry(username.to_string()).or_default();
        entry.retain(|(_, t)| t.elapsed() < LOGIN_NONCE_TTL);
        if entry.len() >= LOGIN_NONCE_MAX_PER_USER {
            entry.remove(0);
        }
        entry.push((nonce.clone(), std::time::Instant::now()));
        nonce
    }

    /// F3 — verify and consume a login nonce. True only for a live, unused
    /// nonce of that exact account; a replay finds it already gone.
    pub fn consume_login_nonce(&self, username: &str, nonce: &str) -> bool {
        let mut map = self.login_nonces.lock().unwrap();
        let Some(entry) = map.get_mut(username) else { return false };
        let Some(pos) = entry
            .iter()
            .position(|(n, t)| n == nonce && t.elapsed() < LOGIN_NONCE_TTL)
        else {
            return false;
        };
        entry.remove(pos);
        if entry.is_empty() {
            map.remove(username);
        }
        true
    }
}

/// F3 — lifetime and per-account cap of login nonces handed out by
/// `/api/auth-params` (multi-device safe: several live nonces per account).
const LOGIN_NONCE_TTL: std::time::Duration = std::time::Duration::from_secs(120);
const LOGIN_NONCE_MAX_PER_USER: usize = 8;

/// F3 — derivation label for the Ed25519 login signing key the client derives
/// from the same secret as the legacy login credential. Both sides must agree
/// on the exact message the signature covers (see `verify_login_signature`).
pub const LOGIN_SIGNING_CONTEXT: &str = "e2e-login-v1";

pub fn login_signing_message(username: &str, nonce: &str) -> String {
    format!("{}|{}|{}", LOGIN_SIGNING_CONTEXT, username, nonce)
}

/// Decode/validate a base64 Ed25519 public key (32 bytes).
pub fn decode_login_public_key(public_key_b64: &str) -> Option<[u8; 32]> {
    use base64::Engine as _;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(public_key_b64.trim())
        .ok()?;
    <[u8; 32]>::try_from(bytes.as_slice()).ok()
}

/// F3 — verify a nonce-bound Ed25519 login signature. Failure (bad length,
/// bad point, bad signature) is a plain `false`, never a server error.
pub fn verify_login_signature(
    public_key_b64: &str,
    username: &str,
    nonce: &str,
    signature_b64: &str,
) -> bool {
    use base64::Engine as _;
    let Some(pk) = decode_login_public_key(public_key_b64) else { return false };
    let Ok(vk) = ed25519_dalek::VerifyingKey::from_bytes(&pk) else { return false };
    let Ok(sig_bytes) = base64::engine::general_purpose::STANDARD.decode(signature_b64.trim()) else {
        return false;
    };
    let Ok(sig) = ed25519_dalek::Signature::from_slice(&sig_bytes) else { return false };
    vk.verify_strict(login_signing_message(username, nonce).as_bytes(), &sig)
        .is_ok()
}

/// Runtime-tunable limits, editable live from the admin panel (the
/// runtime-limits modal) without a restart. Cached in memory so hot paths
/// never touch the DB. Precedence per value: admin_config DB row → env var →
/// default. `0` means "unlimited" for every field.
///
/// This is the single home for limits that used to be hardcoded: mutation
/// budgets (G2), every auth/WS rate limit, the WebSocket message/frame caps and
/// per-socket inbound budget, the request body limits (default / admin import /
/// vault), and the request timeout.
#[derive(Clone, Debug)]
pub struct RuntimeTuning {
    /// Per-user mutation budget per 10s window (default 120).
    pub mutation_user_max: u32,
    /// Per-IP mutation budget per 10s window (default 1000).
    pub mutation_ip_max: u32,
    /// Per-user file-storage cap in bytes (default 1 GiB).
    pub file_storage_quota_bytes: i64,
    /// Max single-file upload size in MB (default 1024 = 1 GiB; 0 = unlimited).
    pub max_file_size_mb: i64,
    // ---- WebSocket (finding 7) ----
    /// Max size of a single WS message in bytes (default 1 MiB).
    pub ws_max_message_bytes: u64,
    /// Max size of a single WS frame in bytes (default 1 MiB).
    pub ws_max_frame_bytes: u64,
    /// Per-socket inbound byte budget per window (default 32 MiB).
    pub ws_socket_budget_bytes: u64,
    /// Length of the per-socket inbound budget window (default 10s).
    pub ws_socket_budget_window_secs: u64,
    /// Max failed WS auth attempts per IP per minute (default 10).
    pub ws_auth_max: u32,
    // ---- Request bodies (finding 7) ----
    /// Default max request-body size in bytes (default 64 MiB).
    pub body_limit_default_bytes: u64,
    /// Max body for admin DB/upload imports in bytes (default 4 GiB).
    pub body_limit_import_bytes: u64,
    /// Max body for vault uploads in bytes (default 2 GiB).
    pub body_limit_vault_bytes: u64,
    // ---- Timeouts (finding 7) ----
    /// Whole-request timeout in seconds (default 300; 0 = no timeout).
    pub request_timeout_secs: u64,
    // ---- Auth rate limits (finding 7) ----
    /// Login attempts per IP per 5 min (default 10; 0 = disabled).
    pub login_ip_max: u32,
    /// Login attempts per username per 5 min (default 10).
    pub login_user_max: u32,
    /// Failed passwords per username per 15 min (default 3).
    pub login_user_fail_max: u32,
    /// Registrations per IP per 10 min (default 5).
    pub register_ip_max: u32,
    /// Kill-switch proof attempts per IP per 5 min (default 5).
    pub kill_switch_ip_max: u32,
    /// Kill-switch proof attempts per account per 5 min (default 5).
    pub kill_switch_user_max: u32,
    /// 2FA code attempts per IP per 5 min (default 10).
    pub login_2fa_ip_max: u32,
    /// Failed-login notifications per account per 10 min (default 5).
    pub login_fail_notify_max: u32,
    /// /api/auth-params requests per IP per minute (default 10).
    pub auth_params_ip_max: u32,
    /// Session re-auth attempts per IP per 5 min (default 10).
    pub reauth_ip_max: u32,
    /// Session re-auth attempts per account per 5 min (default 10).
    pub reauth_user_max: u32,
    /// Server creations per account per hour (default 30).
    pub create_server_max: u32,
    /// Admin-panel login attempts per IP per 5 min (default 10).
    pub admin_login_ip_max: u32,
    /// /api/hmac-key fetches per IP per minute (default 6).
    pub hmac_key_ip_max: u32,
    /// /api/client-config fetches per IP per minute (default 60).
    pub client_config_ip_max: u32,
    /// /api/search requests per IP per minute (default 300).
    pub search_ip_max: u32,
    /// Friend requests per IP per 10 min (default 10).
    pub friend_request_ip_max: u32,
    /// Friend requests per account per 10 min (default 10).
    pub friend_request_user_max: u32,
    /// Registration attempts per username (default 10). The per-username twin
    /// of `register_ip_max`, so one name cannot be hammered from many IPs.
    pub register_user_max: u32,
    /// Server joins per account (default 10).
    pub join_server_user_max: u32,
    /// Voice media frames/signals per account (default 3000).
    pub voice_media_max: u32,
    /// Largest accepted ciphertext for one icon slot, in bytes (default 4 MiB).
    /// Must match the client's cap, so the value is also served from
    /// /api/client-config.
    pub icon_slot_max_bytes: u64,
    /// Largest accepted size for one file-upload chunk, in bytes (default
    /// 1 MiB; the client splits plaintext into 64 KiB chunks, so an encrypted
    /// chunk is under 66 KiB — this is the server's abuse bound, not a
    /// functional limit).
    pub upload_chunk_max_bytes: u64,
    // ---- Rate-limit windows ----
    // A "10 per 5 min" limit is not tunable while the 5 min is not, so every
    // window that belonged to a limit is a field of its own.
    /// Mutation budget window in seconds (default 10).
    pub mutation_window_secs: u64,
    /// Login / 2FA / registration-username window in seconds (default 300).
    pub login_window_secs: u64,
    /// Kill-switch proof window in seconds (default 300).
    pub kill_switch_window_secs: u64,
    /// Session re-auth window in seconds (default 300).
    pub reauth_window_secs: u64,
    /// /api/auth-params window in seconds (default 60).
    pub auth_params_window_secs: u64,
    /// Registration per-IP window in seconds (default 600).
    pub register_ip_window_secs: u64,
    /// Server-join window in seconds (default 600).
    pub join_server_window_secs: u64,
    /// Friend-request window in seconds (default 600).
    pub friend_request_window_secs: u64,
    /// /api/hmac-key window in seconds (default 60).
    pub hmac_key_window_secs: u64,
    /// /api/client-config window in seconds (default 60).
    pub client_config_window_secs: u64,
    /// /api/search window in seconds (default 60).
    pub search_window_secs: u64,
    /// WebSocket auth window in seconds (default 60).
    pub ws_auth_window_secs: u64,
    /// Voice media budget window in seconds (default 10).
    pub voice_media_window_secs: u64,
    /// Server-creation window in seconds (default 3600).
    pub create_server_window_secs: u64,
    /// Admin-panel login window in seconds (default 300; keeps accepting the
    /// ADMIN_LOGIN_IP_WINDOW_SECS env var).
    pub admin_login_window_secs: u64,
    /// Failed-login notification window in seconds (default 600).
    pub login_fail_notify_window_secs: u64,
    /// Where each value came from: field name → "db" | "env" | "default".
    pub sources: std::collections::HashMap<&'static str, &'static str>,
}

impl RuntimeTuning {
    /// Load the tuning, honoring admin_config DB rows, then env vars, then defaults.
    pub fn load(db: &db::Database) -> Self {
        // Returns (db value, env value, default) with provenance.
        let resolve = |key: &str, env: &str, default: u64| -> (u64, &'static str) {
            let db_val = db
                .get_config_value(key)
                .ok()
                .flatten()
                .and_then(|v| v.trim().parse::<u64>().ok());
            let env_val = std::env::var(env)
                .ok()
                .and_then(|v| v.trim().parse::<u64>().ok());
            if let Some(v) = db_val {
                (v, "db")
            } else if let Some(v) = env_val {
                (v, "env")
            } else {
                (default, "default")
            }
        };
        let mut sources: std::collections::HashMap<&'static str, &'static str> =
            std::collections::HashMap::new();
        macro_rules! tuned {
            ($key:literal, $env:literal, $default:expr) => {{
                let (v, src) = resolve($key, $env, $default);
                sources.insert($key, src);
                v
            }};
        }

        let mutation_user_max = tuned!("mutation_user_max", "MUTATION_USER_MAX", 120) as u32;
        let mutation_ip_max = tuned!("mutation_ip_max", "MUTATION_IP_MAX", 1000) as u32;
        let file_storage_quota_bytes =
            tuned!("file_storage_quota_bytes", "FILE_STORAGE_QUOTA_BYTES", 1024 * 1024 * 1024) as i64;
        let max_file_size_mb = tuned!("max_file_size_mb", "MAX_FILE_SIZE_MB", 1024) as i64;
        // WebSocket caps default to the previously hardcoded 1 MiB / 32 MiB;
        // operators can tighten them (256 KiB is a good default target) or
        // loosen them live from the admin panel.
        let ws_max_message_bytes =
            tuned!("ws_max_message_bytes", "WS_MAX_MESSAGE_BYTES", 1024 * 1024);
        let ws_max_frame_bytes = tuned!("ws_max_frame_bytes", "WS_MAX_FRAME_BYTES", 1024 * 1024);
        let ws_socket_budget_bytes =
            tuned!("ws_socket_budget_bytes", "WS_SOCKET_BUDGET_BYTES", 32 * 1024 * 1024);
        let ws_socket_budget_window_secs =
            tuned!("ws_socket_budget_window_secs", "WS_SOCKET_BUDGET_WINDOW_SECS", 10);
        let ws_auth_max = tuned!("ws_auth_max", "WS_AUTH_MAX", 10) as u32;
        let body_limit_default_bytes =
            tuned!("body_limit_default_bytes", "BODY_LIMIT_DEFAULT_BYTES", 64 * 1024 * 1024);
        let body_limit_import_bytes = tuned!(
            "body_limit_import_bytes",
            "BODY_LIMIT_IMPORT_BYTES",
            4u64 * 1024 * 1024 * 1024
        );
        let body_limit_vault_bytes = tuned!(
            "body_limit_vault_bytes",
            "BODY_LIMIT_VAULT_BYTES",
            2u64 * 1024 * 1024 * 1024
        );
        let request_timeout_secs =
            tuned!("request_timeout_secs", "REQUEST_TIMEOUT_SECS", 300);
        let login_ip_max = tuned!("login_ip_max", "LOGIN_IP_MAX", 10) as u32;
        let login_user_max = tuned!("login_user_max", "LOGIN_USER_MAX", 10) as u32;
        let login_user_fail_max = tuned!("login_user_fail_max", "LOGIN_USER_FAIL_MAX", 3) as u32;
        let register_ip_max = tuned!("register_ip_max", "REGISTER_IP_MAX", 5) as u32;
        let kill_switch_ip_max = tuned!("kill_switch_ip_max", "KILL_SWITCH_IP_MAX", 5) as u32;
        let kill_switch_user_max =
            tuned!("kill_switch_user_max", "KILL_SWITCH_USER_MAX", 5) as u32;
        let login_2fa_ip_max = tuned!("login_2fa_ip_max", "LOGIN_2FA_IP_MAX", 10) as u32;
        let login_fail_notify_max =
            tuned!("login_fail_notify_max", "LOGIN_FAIL_NOTIFY_MAX", 5) as u32;
        let auth_params_ip_max = tuned!("auth_params_ip_max", "AUTH_PARAMS_IP_MAX", 10) as u32;
        let reauth_ip_max = tuned!("reauth_ip_max", "REAUTH_IP_MAX", 10) as u32;
        let reauth_user_max = tuned!("reauth_user_max", "REAUTH_USER_MAX", 10) as u32;
        let create_server_max = tuned!("create_server_max", "CREATE_SERVER_MAX", 30) as u32;
        let admin_login_ip_max =
            tuned!("admin_login_ip_max", "ADMIN_LOGIN_IP_MAX", 10) as u32;
        let hmac_key_ip_max = tuned!("hmac_key_ip_max", "HMAC_KEY_IP_MAX", 6) as u32;
        let client_config_ip_max =
            tuned!("client_config_ip_max", "CLIENT_CONFIG_IP_MAX", 60) as u32;
        let search_ip_max = tuned!("search_ip_max", "SEARCH_IP_MAX", 300) as u32;
        let friend_request_ip_max =
            tuned!("friend_request_ip_max", "FRIEND_REQUEST_IP_MAX", 10) as u32;
        let friend_request_user_max =
            tuned!("friend_request_user_max", "FRIEND_REQUEST_USER_MAX", 10) as u32;
        let register_user_max = tuned!("register_user_max", "REGISTER_USER_MAX", 10) as u32;
        let join_server_user_max =
            tuned!("join_server_user_max", "JOIN_SERVER_USER_MAX", 10) as u32;
        let voice_media_max = tuned!("voice_media_max", "VOICE_MEDIA_MAX", 3000) as u32;
        // Default lives next to the upload handler so the two cannot drift;
        // the panel/env can raise or lower it live.
        let icon_slot_max_bytes = tuned!(
            "icon_slot_max_bytes",
            "ICON_SLOT_MAX_BYTES",
            crate::handlers::MAX_ICON_SLOT_B64 as u64
        );
        let upload_chunk_max_bytes =
            tuned!("upload_chunk_max_bytes", "UPLOAD_CHUNK_MAX_BYTES", 1024 * 1024);
        let mutation_window_secs = tuned!("mutation_window_secs", "MUTATION_WINDOW_SECS", 10);
        let login_window_secs = tuned!("login_window_secs", "LOGIN_WINDOW_SECS", 300);
        let kill_switch_window_secs =
            tuned!("kill_switch_window_secs", "KILL_SWITCH_WINDOW_SECS", 300);
        let reauth_window_secs = tuned!("reauth_window_secs", "REAUTH_WINDOW_SECS", 300);
        let auth_params_window_secs =
            tuned!("auth_params_window_secs", "AUTH_PARAMS_WINDOW_SECS", 60);
        let register_ip_window_secs =
            tuned!("register_ip_window_secs", "REGISTER_IP_WINDOW_SECS", 600);
        let join_server_window_secs =
            tuned!("join_server_window_secs", "JOIN_SERVER_WINDOW_SECS", 600);
        let friend_request_window_secs =
            tuned!("friend_request_window_secs", "FRIEND_REQUEST_WINDOW_SECS", 600);
        let hmac_key_window_secs = tuned!("hmac_key_window_secs", "HMAC_KEY_WINDOW_SECS", 60);
        let client_config_window_secs =
            tuned!("client_config_window_secs", "CLIENT_CONFIG_WINDOW_SECS", 60);
        let search_window_secs = tuned!("search_window_secs", "SEARCH_WINDOW_SECS", 60);
        let ws_auth_window_secs = tuned!("ws_auth_window_secs", "WS_AUTH_WINDOW_SECS", 60);
        let voice_media_window_secs =
            tuned!("voice_media_window_secs", "VOICE_MEDIA_WINDOW_SECS", 10);
        let create_server_window_secs =
            tuned!("create_server_window_secs", "CREATE_SERVER_WINDOW_SECS", 3600);
        let admin_login_window_secs = tuned!(
            "admin_login_window_secs",
            "ADMIN_LOGIN_IP_WINDOW_SECS",
            300
        );
        let login_fail_notify_window_secs = tuned!(
            "login_fail_notify_window_secs",
            "LOGIN_FAIL_NOTIFY_WINDOW_SECS",
            600
        );

        RuntimeTuning {
            mutation_user_max,
            mutation_ip_max,
            file_storage_quota_bytes,
            max_file_size_mb,
            ws_max_message_bytes,
            ws_max_frame_bytes,
            ws_socket_budget_bytes,
            ws_socket_budget_window_secs,
            ws_auth_max,
            body_limit_default_bytes,
            body_limit_import_bytes,
            body_limit_vault_bytes,
            request_timeout_secs,
            login_ip_max,
            login_user_max,
            login_user_fail_max,
            register_ip_max,
            kill_switch_ip_max,
            kill_switch_user_max,
            login_2fa_ip_max,
            login_fail_notify_max,
            auth_params_ip_max,
            reauth_ip_max,
            reauth_user_max,
            create_server_max,
            admin_login_ip_max,
            hmac_key_ip_max,
            client_config_ip_max,
            search_ip_max,
            friend_request_ip_max,
            friend_request_user_max,
            register_user_max,
            join_server_user_max,
            voice_media_max,
            icon_slot_max_bytes,
            upload_chunk_max_bytes,
            mutation_window_secs,
            login_window_secs,
            kill_switch_window_secs,
            reauth_window_secs,
            auth_params_window_secs,
            register_ip_window_secs,
            join_server_window_secs,
            friend_request_window_secs,
            hmac_key_window_secs,
            client_config_window_secs,
            search_window_secs,
            ws_auth_window_secs,
            voice_media_window_secs,
            create_server_window_secs,
            admin_login_window_secs,
            login_fail_notify_window_secs,
            sources,
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
    let path = request.uri().path().to_string();
    let mut response = next.run(request).await;
    let headers = response.headers_mut();
    headers.insert(
        "content-security-policy",
        HeaderValue::from_static(
            CSP,

        ),
    );
    headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
    headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
    headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
    headers.insert("permissions-policy", HeaderValue::from_static(PERMISSIONS_POLICY));
    headers.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
    headers.insert("cross-origin-embedder-policy", HeaderValue::from_static("require-corp"));
    // Vendored parser libraries (/libs/*) are loaded by the sandboxed document
    // preview, whose opaque origin can never match `same-origin`; they are
    // public code, so they are explicitly embeddable. Everything else stays
    // same-origin. Without this the preview frame's scripts die with
    // ERR_BLOCKED_BY_RESPONSE and the document never renders.
    if path.starts_with("/libs/") {
        headers.insert("cross-origin-resource-policy", HeaderValue::from_static("cross-origin"));
    } else {
        headers.insert("cross-origin-resource-policy", HeaderValue::from_static("same-origin"));
    }
    headers.insert("x-robots-tag", HeaderValue::from_static("noindex, nofollow, noarchive, nosnippet"));
    if path.starts_with("/api/") {
        // API bodies are per-user secrets or state; never let a shared cache
        // or the disk cache keep a copy. `no-store` matches the static
        // handler's behaviour and the middleware runs on JSON/error responses
        // that handler never touches.
        headers.insert("cache-control", HeaderValue::from_static("no-store"));
    }
    // HSTS without `preload`: the token is meaningless for a self-hosted
    // hostname (preload requires a public domain) and opt-in lists should
    // never receive a name the operator did not submit themselves.
    headers.insert(
        "strict-transport-security",
        HeaderValue::from_static("max-age=31536000; includeSubDomains"),
    );
    response
}

/// The app's Content-Security-Policy, in one place so the two responses that
/// carry it (the middleware above and the static-file handler below) cannot
/// drift apart.
///
/// **No external origin is named.** `script-src` used to include
/// `https://cdn.jsdelivr.net` for jsQR and qrcode-generator; both now ship with
/// the app (`static/vendor/jsqr/jsQR.js`; qrcode-generator was already there as
/// `static/qrcode.js`), so a third-party CDN is no longer in the script path of
/// an origin that holds decrypted messages and the session token. That is also
/// why the HTML no longer carries `integrity=` attributes: SRI protects against
/// a *changed* file, not against the vendor being in the path at all.
///
/// The two remaining weakenings are deliberate and documented, because both are
/// load-bearing today:
///   * `'unsafe-inline'` — the app's HTML carries inline bootstrap scripts. The
///     fix (per-response nonce injected by the static handler, then dropping
///     this) is tracked; until then, treat every injection sink as XSS.
///   * `'unsafe-eval'` — the vendored speech stack (onnxruntime-web / the
///     transformers.js bundle) and `libsodium-sumo.js` are large generated
///     bundles; `wasm-unsafe-eval` covers WebAssembly, and this one is kept for
///     the JS they generate at load time. It is the next thing to remove, after
///     checking the ASR path in a real call.
// `connect-src` names exactly one external origin: the Have I Been Pwned
// k-anonymity range API, used by the registration-time breach check (finding
// 3). Only the first 5 hex chars of the password's SHA-1 leave the device, the
// check fails open when offline, and no other code path may talk to it.
const CSP: &str = "default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; media-src 'self' blob:; font-src 'self' data:; object-src 'none'; frame-src blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'";

/// Reject requests whose Host header is not a name this server actually owns.
/// This is the DNS-rebinding half of the origin check: under rebinding the
/// attacker's page is same-origin with the rebound server, so Origin and Host
/// both say `evil.example` and match — only knowing the server's own names
/// (`allowed_hosts`) catches it. Non-browser clients are unaffected because
/// they target the real host anyway. A missing Host header is left to the
/// HTTP stack (Hyper rejects HTTP/1.1 requests without one).
async fn host_allowlist_mw(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    if !state.allowed_hosts.is_empty() {
        if let Some(host) = request.headers().get("host").and_then(|v| v.to_str().ok()) {
            let bare = host_without_port(host);
            if !state.allowed_hosts.iter().any(|h| h == &bare) {
                tracing::warn!("Rejected request with unknown Host header: {}", bare);
                return (
                    StatusCode::MISDIRECTED_REQUEST,
                    axum::Json(serde_json::json!({"error": "Unknown host"})),
                )
                    .into_response();
            }
        }
    }
    next.run(request).await
}

/// Bound how long one request may occupy its task before it is answered with
/// 408. This is the Slowloris-class guard: a client that dribbles a body or
/// stalls a handler forever would otherwise hold the connection (and any
/// per-connection buffers) indefinitely. Downloads are unaffected — their
/// response future completes as soon as the stream body is handed back.
/// The limit is live-tunable from the admin panel (`request_timeout_secs`,
/// 0 = no timeout).
async fn request_timeout_mw(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let secs = state.runtime_tuning.read().unwrap().request_timeout_secs;
    if secs == 0 {
        return next.run(request).await;
    }
    match tokio::time::timeout(std::time::Duration::from_secs(secs), next.run(request)).await {
        Ok(response) => response,
        Err(_) => (
            StatusCode::REQUEST_TIMEOUT,
            axum::Json(serde_json::json!({"error": "Request timed out"})),
        )
            .into_response(),
    }
}

fn payload_too_large() -> Response {
    (
        StatusCode::PAYLOAD_TOO_LARGE,
        axum::Json(serde_json::json!({"error": "Payload too large"})),
    )
        .into_response()
}

/// Finding 7 — live-configurable request-body caps, replacing the old hardcoded
/// `DefaultBodyLimit` layers so an operator can retune them (KB/MB/GB) from the
/// admin panel without a restart. The path selects the configured limit
/// (default / admin import / vault). A Content-Length over the limit is rejected
/// up front; a chunked body (or one that lies about its length) is cut off
/// mid-stream and answered with 413 as soon as the limit is crossed, so no
/// handler can ever buffer past it.
async fn body_limit_mw(
    State(state): State<Arc<AppState>>,
    request: Request,
    next: Next,
) -> Response {
    let method = request.method().clone();
    if !matches!(method, Method::POST | Method::PUT | Method::PATCH | Method::DELETE) {
        return next.run(request).await;
    }
    let limit = {
        let path = request.uri().path();
        let tuning = state.runtime_tuning.read().unwrap();
        if path.starts_with("/api/admin/import-") {
            tuning.body_limit_import_bytes
        } else if path == "/api/vault/upload" {
            tuning.body_limit_vault_bytes
        } else {
            tuning.body_limit_default_bytes
        }
    };
    if limit == 0 {
        return next.run(request).await;
    }
    if let Some(len) = request
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
    {
        if len > limit {
            return payload_too_large();
        }
    }
    let exceeded = Arc::new(AtomicBool::new(false));
    let exceeded_flag = exceeded.clone();
    let (parts, body) = request.into_parts();
    use futures::StreamExt as _;
    let body_stream = Box::pin(body.into_data_stream());
    let stream = futures::stream::unfold((body_stream, 0u64), move |(mut stream, seen)| {
        let exceeded_flag = exceeded_flag.clone();
        async move {
            match stream.next().await {
                Some(Ok(bytes)) => {
                    let seen = seen.saturating_add(bytes.len() as u64);
                    if seen > limit {
                        exceeded_flag.store(true, Ordering::Relaxed);
                        return Some((
                            Err(axum::Error::new(std::io::Error::other(
                                "request body limit exceeded",
                            ))),
                            (stream, seen),
                        ));
                    }
                    Some((Ok(bytes), (stream, seen)))
                }
                Some(Err(e)) => Some((Err(e), (stream, seen))),
                None => None,
            }
        }
    });
    let response = next
        .run(Request::from_parts(parts, axum::body::Body::from_stream(stream)))
        .await;
    if exceeded.load(Ordering::Relaxed) {
        return payload_too_large();
    }
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
        // A `null` Origin is a sandboxed iframe, a data: page, or a file://
        // document — none of them is this app, and the WS/CSRF guards above
        // only compare host strings, so `null` must never be treated as a
        // match. Non-browser clients send no Origin at all and stay allowed.
        if origin.as_deref() == Some("null") {
            return (
                StatusCode::FORBIDDEN,
                axum::Json(serde_json::json!({"error": "Cross-origin request blocked"})),
            )
                .into_response();
        }
        // Fetch Metadata: browsers label each request with its relationship to
        // the target. A cross-site POST/PUT/PATCH/DELETE to this API is never
        // the app (which is same-origin) — reject it even when Origin was
        // omitted or forged. Missing header = non-browser client, still allowed
        // (Bearer auth applies).
        if let Some(site) = request.headers().get("sec-fetch-site").and_then(|v| v.to_str().ok()) {
            if site.eq_ignore_ascii_case("cross-site") {
                return (
                    StatusCode::FORBIDDEN,
                    axum::Json(serde_json::json!({"error": "Cross-site request blocked"})),
                )
                    .into_response();
            }
        }
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
/// case-insensitively. Callers reject the "null" origin before calling this.
/// Also used by the WS handler (F6 — cross-site WebSocket hijacking guard).
pub(crate) fn origin_host_matches(origin: &str, host: &str) -> bool {
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

/// Percent-decode a URL path. Returns `None` for a malformed escape or a byte
/// sequence that is not valid UTF-8 — neither can be a legitimate static path.
fn percent_decode_path(raw: &str) -> Option<String> {
    let bytes = raw.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return None;
            }
            let hi = (bytes[i + 1] as char).to_digit(16)?;
            let lo = (bytes[i + 2] as char).to_digit(16)?;
            out.push((hi * 16 + lo) as u8);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

/// Vetted path *relative to* `static/`. `None` (→ 404) for anything that could
/// escape the static root:
///   * a `.`/`..` component in **either** separator form — Windows treats `\`
///     as a path separator, so a single `/..\server\.env` segment used to slip
///     past a `split('/')`-only check and resolve into the live `server/.env`
///     (leaking `JWT_SECRET` / `HMAC_KEY`);
///   * a NUL byte, a drive/stream `:`, or a malformed percent-escape.
///
/// Separators are normalised *after* full percent-decoding, so `\`, `%5c` and
/// `%2e%2e` are all judged by the same rule.
fn static_subpath(raw_path: &str) -> Option<String> {
    let decoded = percent_decode_path(raw_path)?;
    if decoded.contains('\0') {
        return None;
    }
    let normalized = decoded.replace('\\', "/");
    // A colon is a Windows drive ("C:") or NTFS alternate data stream; no
    // static asset this app ships has one.
    if normalized.contains(':') {
        return None;
    }
    if normalized.split('/').any(|seg| seg == "." || seg == "..") {
        return None;
    }
    Some(normalized.trim_start_matches('/').to_string())
}

/// A real 404 (status, not just a body) for a missing or rejected static path.
fn static_not_found() -> axum::response::Response {
    let mut headers = HeaderMap::new();
    headers.insert("content-type", HeaderValue::from_static("text/plain"));
    (StatusCode::NOT_FOUND, headers, b"404 Not Found".to_vec()).into_response()
}

async fn serve_static(
    uri: axum::http::Uri,
    State(state): State<Arc<AppState>>,
) -> axum::response::Response {
    // F9 — hard-block parent-directory traversal BEFORE touching the filesystem.
    // The vetted relative path comes first; then the resolved (canonical) path
    // must still live inside ../static. The old check split on '/' only, which
    // Windows does not honour: "/..\server\.env" arrived as one segment, cleared
    // the check, and served the live server/.env (JWT_SECRET / HMAC_KEY).
    let rel = match static_subpath(uri.path()) {
        Some(p) => p,
        None => return static_not_found(),
    };
    let static_root = match tokio::fs::canonicalize("../static").await {
        Ok(p) => p,
        Err(_) => return static_not_found(),
    };
    // `join` only appends the already-vetted relative path; canonicalizing the
    // result and re-checking containment is the belt-and-braces guard against
    // anything the component check could miss (symlinks, drive prefixes).
    let joined = if rel.is_empty() {
        static_root.clone()
    } else {
        static_root.join(&rel)
    };
    let canonical = match tokio::fs::canonicalize(&joined).await {
        Ok(p) => p,
        Err(_) => return static_not_found(),
    };
    if !canonical.starts_with(&static_root) {
        return static_not_found();
    }
    let path = if canonical.is_dir() {
        canonical.join("index.html")
    } else {
        canonical
    };
    let path = path.to_string_lossy().into_owned();

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
            // Every type the app actually ships has to be named here, because
            // these responses carry `X-Content-Type-Options: nosniff` — the
            // browser then refuses to sniff a wrong type. Images used to fall
            // through to `application/octet-stream`, so `/favicon.ico` and the
            // PWA/home-screen PNGs were downloaded and then **ignored**: the tab
            // and the installed app fell back to a generic placeholder icon no
            // matter what artwork they contained.
            let mime = if path.ends_with(".html") {
                "text/html"
            } else if path.ends_with(".js") || path.ends_with(".mjs") {
                // .mjs matters: the bundled offline speech runtime
                // (static/vendor/asr/*.mjs) is loaded as an ES module, and
                // `nosniff` means an octet-stream response is refused outright --
                // which also means the extension must never be dropped from this
                // list without captions breaking again.
                "application/javascript"
            } else if path.ends_with(".css") {
                "text/css"
            } else if path.ends_with(".json") || path.ends_with(".webmanifest") {
                "application/json"
            } else if path.ends_with(".png") {
                "image/png"
            } else if path.ends_with(".ico") {
                "image/x-icon"
            } else if path.ends_with(".svg") {
                "image/svg+xml"
            } else if path.ends_with(".webp") {
                "image/webp"
            } else if path.ends_with(".jpg") || path.ends_with(".jpeg") {
                "image/jpeg"
            } else if path.ends_with(".wasm") {
                "application/wasm"
            } else if path.ends_with(".woff2") {
                "font/woff2"
            } else if path.ends_with(".txt") {
                "text/plain; charset=utf-8"
            } else {
                "application/octet-stream"
            };

            let mut headers = HeaderMap::new();
            headers.insert("content-type", HeaderValue::from_static(mime));
            headers.insert("cache-control", HeaderValue::from_static("no-store, no-cache, must-revalidate"));
            headers.insert("pragma", HeaderValue::from_static("no-cache"));
            headers.insert("expires", HeaderValue::from_static("0"));
            headers.insert("content-security-policy", HeaderValue::from_static(
                CSP
            ));
            headers.insert("x-content-type-options", HeaderValue::from_static("nosniff"));
            headers.insert("x-frame-options", HeaderValue::from_static("DENY"));
            headers.insert("referrer-policy", HeaderValue::from_static("no-referrer"));
            headers.insert("cross-origin-opener-policy", HeaderValue::from_static("same-origin"));
            headers.insert("cross-origin-embedder-policy", HeaderValue::from_static("require-corp"));
            headers.insert("strict-transport-security", HeaderValue::from_static(
                "max-age=31536000; includeSubDomains"
            ));

            (headers, contents).into_response()
        }
        Err(_) => static_not_found(),
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
    let db = db::Database::new(&config.database_url, &config.upload_dir)
        .expect("Failed to initialize database");
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

    // Web Push (VAPID): load or self-generate the keypair. Failure disables
    // push but must never take the server down.
    let vapid = match push::load_or_create_vapid(std::path::Path::new(&config.database_url)) {
        Ok(k) => Some(k),
        Err(e) => {
            tracing::warn!("push: VAPID keys unavailable, Web Push disabled: {e}");
            None
        }
    };
    let fcm = push::load_fcm_credentials();
    if fcm.is_none() {
        tracing::info!(
            "push: no Firebase service account set (FCM_SERVICE_ACCOUNT_JSON) — Android push disabled"
        );
    }

    let state = Arc::new(AppState {
        allowed_hosts: build_allowed_hosts(),
        setup_complete: AtomicBool::new(!fresh),
        db,
        config: config.clone(),
        ws_manager,
        voice_rooms: std::sync::RwLock::new(std::collections::HashMap::new()),
        runtime_tuning,
        login_nonces: std::sync::Mutex::new(std::collections::HashMap::new()),
        sb_temp_play: std::sync::RwLock::new(std::collections::HashMap::new()),
        vapid,
        fcm,
        fcm_token: tokio::sync::Mutex::new(None),
        push_http: reqwest::Client::new(),
    });

    // Run orphan file cleanup on startup, then periodically every hour
    // Uses spawn_blocking because filesystem operations are synchronous.
    {
        let state_for_cleanup = state.clone();
        tokio::spawn(async move {
            // Initial cleanup on startup
            tracing::info!("Running orphan file cleanup...");
            let s = state_for_cleanup.clone();
            let upload_dir = s.config.upload_dir.clone();
            let _ = tokio::task::spawn_blocking(move || {
                s.db.cleanup_orphan_files(&upload_dir);
            }).await;
            tracing::info!("Orphan file cleanup complete.");

            // Schedule periodic cleanup every hour
            let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(3600));
            loop {
                interval.tick().await;
                let s = state_for_cleanup.clone();
                let upload_dir = s.config.upload_dir.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    s.db.cleanup_orphan_files(&upload_dir);
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

    // Disappearing-message sweeper: every ~5s, shred messages whose TTL has
    // passed and broadcast so clients remove them live. The TTL is plaintext
    // metadata the server enforces; the content stays E2E-encrypted and the
    // row + attached file are hard-deleted (cascading to tokens/reactions/
    // poll votes/acks/pins), so expired ciphertext never lingers on the host.
    {
        let state_for_expiry = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(5));
            loop {
                interval.tick().await;
                ws::sweep_expired_messages(&state_for_expiry).await;
            }
        });
    }

    // F3-14: Self-Destructing Accounts — check every hour for inactive users
    {
        let state_for_sd = state.clone();
        tokio::spawn(async move {
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(3600));
            loop {
                interval.tick().await;
                let s = state_for_sd.clone();
                let _ = tokio::task::spawn_blocking(move || {
                    if let Ok(user_ids) = s.db.get_inactive_users_for_deletion() {
                        for uid in &user_ids {
                            tracing::info!("Self-destruct: deleting inactive user {}", uid);
                            // Use the full delete_user which cleans up all related
                            // tables (vault files, reactions, voice state, DMs, etc.)
                            match s.db.self_destruct_user(uid) {
                                Ok(file_ids) => {
                                    // Clean up on-disk upload chunks
                                    for fid in &file_ids {
                                        let dir = format!("{}/{}", s.config.upload_dir, fid);
                                        let _ = std::fs::remove_dir_all(&dir);
                                    }
                                }
                                Err(e) => {
                                    tracing::error!("Self-destruct failed for {}: {}", uid, e);
                                }
                            }
                        }
                    }
                }).await;
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
        .route("/api/push/vapid-public-key", get(handlers::push_vapid_public_key))
        .route("/api/push/register", post(handlers::push_register))
        .route("/api/push/unregister", post(handlers::push_unregister))
        .route("/api/password/change", post(handlers::change_password))
        .route("/api/servers", get(handlers::list_servers).post(handlers::create_server))
        .route("/api/servers/{server_id}/channels", get(handlers::list_channels).post(handlers::create_channel))
        .route("/api/servers/{server_id}/members", get(handlers::list_server_members))
        // Roles & permissions: roles are the only way permissions are granted.
        .route("/api/servers/{server_id}/roles", get(handlers::list_server_roles).post(handlers::create_server_role))
        .route("/api/servers/{server_id}/roles/reorder", put(handlers::reorder_roles))
        .route("/api/servers/{server_id}/roles/{role_id}", put(handlers::update_server_role).delete(handlers::delete_server_role))
        .route("/api/servers/{server_id}/roles/{role_id}/overwrite", put(handlers::set_role_overwrite))
        .route("/api/servers/{server_id}/member-role/{user_id}", put(handlers::set_member_role))
        .route("/api/servers/{server_id}/my-permissions", get(handlers::get_my_permissions))
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
        .route("/api/channels/{channel_id}/thread/{parent_id}", get(handlers::list_thread_messages))
        .route("/api/servers/{server_id}/categories", get(handlers::list_categories).post(handlers::create_category))
        .route("/api/servers/{server_id}/categories/{category_id}", put(handlers::rename_category).delete(handlers::delete_category))
        .route("/api/servers/{server_id}/channels/{channel_id}/category", put(handlers::move_channel_to_category))
        .route("/api/servers/reorder", put(handlers::reorder_servers))
        .route("/api/server-groups", get(handlers::list_server_groups).post(handlers::create_server_group))
        .route("/api/server-groups/reorder", put(handlers::reorder_server_groups))
        .route("/api/server-groups/{group_id}", patch(handlers::rename_server_group).delete(handlers::delete_server_group))
        .route("/api/server-groups/{group_id}/toggle", patch(handlers::toggle_server_group_collapsed))
        .route("/api/server-groups/{source_id}/merge/{target_id}", put(handlers::merge_server_groups))
        .route("/api/servers/{server_id}/group", put(handlers::move_server_to_group))
        .route("/api/dm/reorder", put(handlers::reorder_dms))
        .route("/api/blocks", get(handlers::get_blocked_users))
        .route("/api/blocks/{user_id}", put(handlers::block_user).delete(handlers::unblock_user))
        .route("/api/servers/{server_id}/categories/reorder", put(handlers::reorder_categories))
        .route("/api/servers/{server_id}/channels/reorder", put(handlers::reorder_channels))
        // F14: User Custom CSS slots
        .route("/api/user-css/slots", get(handlers::get_css_slots))
        .route("/api/user-css/slot/{slot}", put(handlers::save_css_slot).delete(handlers::delete_css_slot))
        .route("/api/user-css/active", put(handlers::set_css_active_slot))
        // F15: user custom UI icon slots (app-only settings tab)
        .route("/api/user-icons/slots", get(handlers::get_icon_slots))
        .route("/api/user-icons/slot/{slot}", put(handlers::save_icon_slot).delete(handlers::delete_icon_slot))
        .route("/api/user-icons/active", put(handlers::set_icon_active_slot))

        .route("/api/channels/{channel_id}", delete(handlers::delete_channel))
        // E2E blind-index message search (GET query + client token-index backfill)
        .route("/api/search", get(handlers::search_messages_handler).post(handlers::index_search_tokens))
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
        // Soundboard temp play (fast audio delivery via HTTP, avoids huge WS payloads)
        .route("/api/soundboard/temp-play", post(handlers::upload_sb_temp_play).get(handlers::sb_temp_play_cleanup))
        .route("/api/soundboard/temp-play/{token}", get(handlers::get_sb_temp_play))
        // Soundboard
        .route("/api/soundboard", post(handlers::upload_soundboard_clip))
        .route("/api/soundboard/my", get(handlers::list_my_soundboard_clips))
        .route("/api/soundboard/{server_id}", get(handlers::list_soundboard_clips))
        .route("/api/soundboard/clip/{clip_id}", delete(handlers::delete_soundboard_clip))
        .route("/api/soundboard/mute/{server_id}/{user_id}", put(handlers::mute_soundboard).delete(handlers::unmute_soundboard))
        .route("/api/soundboard/muted/{server_id}", get(handlers::list_muted_soundboard))
        .route("/api/soundboard/global-mute/{server_id}", put(handlers::toggle_soundboard_global_mute).get(handlers::get_soundboard_global_mute))
        .route("/api/soundboard/disable/{server_id}/{user_id}", put(handlers::disable_soundboard_user).delete(handlers::enable_soundboard_user))
        .route("/api/soundboard/disabled/{server_id}", get(handlers::get_disabled_soundboard_users))
        // Device pairing (QR-code second-device login)
        .route("/api/pairing", post(handlers::create_pairing_ticket))
        .route("/api/pairing/{ticket_id}", get(handlers::get_pairing_ticket).post(handlers::claim_pairing_ticket))
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
        .route("/api/admin/verify-2fa", post(handlers::admin_verify_2fa))
        .route("/api/admin/2fa/status", get(handlers::admin_2fa_status))
        .route("/api/admin/2fa/enroll", post(handlers::admin_enroll_2fa))
        .route("/api/admin/2fa/verify-enroll", post(handlers::admin_verify_enroll_2fa))
        .route("/api/admin/2fa/disable", post(handlers::admin_disable_self_2fa))
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
        .route("/api/admin/tables", get(handlers::admin_list_tables))
        .route("/api/admin/table/{table}", get(handlers::admin_table_rows))
        .route("/api/admin/export-db", get(handlers::admin_export_db))
        .route("/api/admin/export-uploads", get(handlers::admin_export_uploads))
        .route("/api/admin/clear", post(handlers::admin_clear_all))
        .route("/api/admin/audit-log", get(handlers::admin_audit_log))
        .route(
            "/api/admin/runtime-config",
            get(handlers::admin_get_runtime_config).put(handlers::admin_set_runtime_config),
        )
        .route("/api/admin/rate-limit-usage", get(handlers::admin_get_rate_limit_usage))
        // Phase 4: Friends + DMs
        .route("/api/me", get(handlers::get_me).delete(handlers::delete_me))
        .route("/api/me/kill-switch", post(handlers::set_kill_switch).delete(handlers::clear_kill_switch))
        .route("/api/hmac-key", get(handlers::get_hmac_key))
        .route("/api/client-config", get(handlers::client_config))
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
        // Cancel a cancelled upload: drops the record + every chunk written so far.
        .route("/api/files/{file_id}", delete(handlers::cancel_file_upload))
        .route("/api/files/{file_id}/download", get(handlers::download_file))
        .route("/api/files/by-hash/{hash}/download", get(handlers::download_file_by_hash))
        // Phase 10: Server Stickers
        
        // Phase 12: User Stickers/GIFs
        .route("/api/users/me/stickers", get(handlers::list_user_stickers).post(handlers::add_user_sticker))
        .route("/api/users/me/stickers/{sticker_id}", delete(handlers::remove_user_sticker))
        .route("/api/online", get(handlers::list_online_users))
        .route("/api/link-preview", get(handlers::link_preview))
        .route("/api/vault/files", get(handlers::vault_list))
        .route("/api/vault/files/{file_id}", get(handlers::vault_download).delete(handlers::vault_delete))
        .route("/api/me/export", get(handlers::export_user_data))
        .route("/api/me/self-destruct", get(handlers::get_self_destruct).put(handlers::set_self_destruct))
        .route("/ws", get(ws::ws_handler))
        .fallback(get(serve_static));

    // Admin DB backups can be far larger than any other body (a full app DB
    // with messages/files is often 40 MB+, and the uploads bundle grows it
    // further); the endpoints are admin-token-gated. Vault files can be 1 GB+
    // after compression+encryption — the vault quota check in the handler is
    // the real size gate. These routes are merged BEFORE the global layers so
    // every hardening layer (host allowlist, origin check, security headers,
    // the configurable body caps) applies to them too; the body caps are
    // path-selected inside `body_limit_mw` (default / import / vault).
    let import_routes = Router::new()
        .route("/api/admin/import-db", post(handlers::admin_import_db))
        .route("/api/admin/import-uploads", post(handlers::admin_import_uploads));
    let vault_routes = Router::new().route("/api/vault/upload", post(handlers::vault_upload));
    let app = app.merge(import_routes).merge(vault_routes);

    // `DefaultBodyLimit` no longer fixes the real limits: every request body is
    // streamed through `body_limit_mw`, which enforces the live admin-configured
    // caps. The layer below only raises axum's built-in 2 MB extractor ceiling
    // to "unbounded" so the middleware is the single source of truth.
    let app = app
        .layer(DefaultBodyLimit::max(usize::MAX))
        .layer(middleware::from_fn_with_state(state.clone(), body_limit_mw))
        .layer(middleware::from_fn_with_state(state.clone(), mutation_rate_limit_mw))
        .layer(middleware::from_fn(origin_check_mw))
        .layer(middleware::from_fn_with_state(state.clone(), request_timeout_mw))
        .layer(middleware::from_fn(security_headers_mw))
        .layer(middleware::from_fn_with_state(state.clone(), host_allowlist_mw))
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

#[cfg(test)]
mod static_path_tests {
    use super::{percent_decode_path, static_subpath};

    #[test]
    fn rejects_traversal_in_every_separator_and_encoding() {
        for bad in [
            "/../server/.env",
            "/..\\server\\.env",       // Windows separator — the live leak
            "/..\\..\\server\\.env",
            "/%2e%2e/server/.env",
            "/%2E%2E%5cserver%5c.env", // encoded "..\\server\\.env"
            "/static/../server/.env",
            "/./index.html",
            "/a/../../b",
            "/server/.env%00",
            "/C:/windows/system32/config/sam",
            "/index.html%",
            "/index.html%2",
        ] {
            assert!(static_subpath(bad).is_none(), "must reject {bad}");
        }
    }

    #[test]
    fn keeps_ordinary_asset_paths_unchanged() {
        assert_eq!(static_subpath("/").as_deref(), Some(""));
        assert_eq!(static_subpath("/index.html").as_deref(), Some("index.html"));
        assert_eq!(static_subpath("/chat.js").as_deref(), Some("chat.js"));
        assert_eq!(
            static_subpath("/vendor/asr/whisper-tiny/onnx/encoder.onnx").as_deref(),
            Some("vendor/asr/whisper-tiny/onnx/encoder.onnx")
        );
        // Double-encoded "%2e%2e" decodes to a literal '%2e' filename byte —
        // it is not traversal and must survive the check.
        assert_eq!(static_subpath("/a%252e%252e/b").as_deref(), Some("a%2e%2e/b"));
        // A hyphenated name that merely contains dots is not a dot segment.
        assert_eq!(static_subpath("/foo..bar.txt").as_deref(), Some("foo..bar.txt"));
        assert_eq!(percent_decode_path("/a%20b").as_deref(), Some("/a b"));
    }
}





