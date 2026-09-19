use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use std::time::{Duration, Instant};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    http::{HeaderMap, StatusCode},
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use base64::Engine;
use chrono::Utc;
use crate::auth;
use crate::AppState;

/// Message variant for the WebSocket channel: either text (JSON) or raw binary.
/// Relay frames use Binary to skip JSON serialization/deserialization entirely.
#[derive(Clone)]
pub enum WsMessage {
    Text(String),
    Binary(Vec<u8>),
}

/// Compute the fixed-width RFC3339 expiry for a disappearing-message TTL in
/// seconds (same format as message timestamps so lexicographic comparison
/// works). None when ttl_seconds is absent or outside the 5s..24h bounds.
fn disappearing_expiry(parsed: &serde_json::Value) -> Option<String> {
    let secs = parsed.get("ttl_seconds").and_then(|v| v.as_i64())?;
    if !(5..=86400).contains(&secs) {
        return None;
    }
    Some((Utc::now() + chrono::Duration::seconds(secs)).format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string())
}

static CONN_COUNTER: AtomicU64 = AtomicU64::new(1);

struct WsRateLimiter {
    attempts: Mutex<HashMap<String, (u32, Instant)>>,
}

impl WsRateLimiter {
    fn check_and_increment(&self, key: &str, max_attempts: u32, window: Duration) -> bool {
        let mut map = self.attempts.lock().unwrap();
        let now = Instant::now();
        // Evict expired entries when map grows large to prevent unbounded memory growth
        if map.len() > 1000 {
            map.retain(|_, (_, first)| now.duration_since(*first) <= window);
        }
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

static WS_AUTH_RATE_LIMITER: LazyLock<WsRateLimiter> = LazyLock::new(|| WsRateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

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

// ========================= Voice calls & voice channels =========================

#[derive(Clone, Debug, serde::Serialize)]
pub struct VoiceMember {
    pub user_id: String,
    pub username: String,
    pub muted: bool,
    pub deafened: bool,
    pub camera: bool,
    pub screen: bool,
    pub speaking: bool,
    pub force_muted: bool,
    pub force_deafened: bool,
    pub is_owner: bool,
    pub role_position: i64,
    // Track ids the member is currently sending. Receivers match incoming
    // video tracks against these so a screen share can never be mistaken for
    // a camera feed (or vice versa) when flags + track arrival race.
    pub camera_track_id: Option<String>,
    pub screen_track_id: Option<String>,
    // Per-member RECEIVE resolution preference (Settings → Voice). Broadcast
    // so every sender can scale the stream it sends THIS member down to what
    // they asked for ("what the user sends to that person"). 0 = not declared
    // (sender falls back to its own receive default).
    pub recv_camera_res: i64,
    pub recv_screen_res: i64,
    // Manual video-load state: whether this viewer has per-feed loading on, and
    // which feeds ("sender_uid:kind") they have explicitly LOADED / UNLOADED.
    // Senders use it to stop sending a feed nobody is watching (bitrate) —
    // plain metadata, same class as the camera/screen flags, never content.
    pub manual_video_load: bool,
    pub loaded_feeds: Vec<String>,
    pub unloaded_feeds: Vec<String>,
    // Audio/video mode override broadcast by the member (auto/mesh/relay).
    // Peers read these to show M/R badges next to each member's name.
    pub audio_mode: String,
    pub video_mode: String,
    // Per-member audio quality preferences (Settings → Voice → Audio Quality).
    // Broadcast so relay receivers can compute min(sender, recv) for sample rate.
    // Mesh senders use recv_audio_quality to set per-receiver Opus bitrate.
    pub recv_audio_quality: String,
    pub send_audio_quality: String,
    pub recv_screen_audio_quality: String,
    pub send_screen_audio_quality: String,
    pub camera_mode: String,
    pub screen_mode: String,
}

pub struct VoiceRoom {
    pub room_type: String, // "server" | "dm"
    pub server_id: Option<String>,
    pub channel_id: Option<String>,
    pub dm_channel_id: Option<String>,
    pub session_id: Option<String>,
    pub members: HashMap<String, VoiceMember>,
    // user_id -> device_id of the device that CURRENTLY occupies the room.
    // When the same user re-joins from another device, the old device is kicked
    // and this map is updated so a stale device's later disconnect / page-load
    // voice_leave_all can never evict the device that replaced it.
    pub device_map: HashMap<String, String>,
    // Currently playing soundboard clips, keyed by the player's user id. Each
    // player gets their OWN slot: one person starting a sound no longer
    // clobbers another's playback state, so late joiners sync to every clip
    // that is actually still playing and multiple people can play at once.
    pub current_soundboards: HashMap<String, SoundboardPlayback>,
}

#[derive(Clone)]
pub struct SoundboardPlayback {
    pub user_id: String,
    pub clip_id: String,
    pub temp_token: String,
    pub started_at_ms: i64, // timestamp when playback started
    pub duration_ms: i64,    // estimated total duration
    // The player's Loop toggle. A looping clip NEVER "has definitely finished"
    // for late joiners: they always pick it up at the current cycle position.
    // (JSON key stays "loop"; `loop` is a Rust keyword so the field is r#loop.)
    pub r#loop: bool,
}

fn voice_member_json(m: &VoiceMember) -> serde_json::Value {
    serde_json::json!({
        "user_id": m.user_id,
        "username": m.username,
        "muted": m.muted,
        "deafened": m.deafened,
        "camera": m.camera,
        "screen": m.screen,
        "speaking": m.speaking,
        "force_muted": m.force_muted,
        "force_deafened": m.force_deafened,
        "is_owner": m.is_owner,
        "role_position": m.role_position,
        "camera_track_id": m.camera_track_id,
        "screen_track_id": m.screen_track_id,
        "recv_camera_res": m.recv_camera_res,
        "recv_screen_res": m.recv_screen_res,
        "manual_video_load": m.manual_video_load,
        "loaded_feeds": m.loaded_feeds,
        "unloaded_feeds": m.unloaded_feeds,
        "audio_mode": m.audio_mode,
        "video_mode": m.video_mode,
        "recv_audio_quality": m.recv_audio_quality,
        "send_audio_quality": m.send_audio_quality,
        "recv_screen_audio_quality": m.recv_screen_audio_quality,
        "send_screen_audio_quality": m.send_screen_audio_quality,
        "camera_mode": m.camera_mode,
        "screen_mode": m.screen_mode,
    })
}

/// Simple per-user rate limiter for voice signaling (offers/answers/ICE).
static VOICE_SIGNAL_LIMITER: LazyLock<WsRateLimiter> = LazyLock::new(|| WsRateLimiter {
    attempts: Mutex::new(HashMap::new()),
});

/// Room id used to key the voice_rooms map.
fn voice_room_id(room_type: &str, channel_id: &str, dm_channel_id: &str) -> String {
    if room_type == "dm" {
        format!("dm:{}", dm_channel_id)
    } else {
        format!("srv:{}", channel_id)
    }
}

/// Send a JSON message to a single user's WS connection(s).
async fn send_to_user(state: &Arc<AppState>, user_id: &str, json: &serde_json::Value) {
    state
        .ws_manager
        .broadcast_to_users(&[user_id.to_string()], &json.to_string())
        .await;
}

/// Broadcast a voice message to every member of a room (via their user ids).
/// The caller must NOT hold the voice_rooms lock while calling this (it awaits).
pub(crate) async fn voice_broadcast(state: &Arc<AppState>, room_id: &str, json: &serde_json::Value) {
    let ids: Vec<String> = match state.voice_rooms.read() {
        Ok(r) => r.get(room_id).map(|rm| rm.members.keys().cloned().collect()).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    state.ws_manager.broadcast_to_users(&ids, &json.to_string()).await;
}

/// Snapshot of every server voice room's members, for a given server.
/// Used so ANY server member (not just room participants) can render who is in
/// each voice channel and who is currently speaking (Discord-style presence).
fn voice_presence_json(state: &Arc<AppState>, server_id: &str) -> serde_json::Value {
    let channels: Vec<serde_json::Value> = {
        let rooms = match state.voice_rooms.read() {
            Ok(r) => r,
            Err(_) => return serde_json::json!({ "type": "voice_presence", "server_id": server_id, "channels": [] }),
        };
        rooms
            .iter()
            .filter(|(_, rm)| rm.room_type == "server" && rm.server_id.as_deref() == Some(server_id))
            .map(|(room_id, rm)| {
                let members: Vec<serde_json::Value> = rm.members.values().map(voice_member_json).collect();
                serde_json::json!({
                    "room_id": room_id,
                    "channel_id": rm.channel_id,
                    "members": members,
                })
            })
            .collect()
    };
    serde_json::json!({ "type": "voice_presence", "server_id": server_id, "channels": channels })
}

/// Broadcast the voice presence snapshot to every member of the server.
/// The caller must NOT hold the voice_rooms lock while calling this (it awaits).
async fn voice_broadcast_server_presence(state: &Arc<AppState>, server_id: &str) {
    let msg = voice_presence_json(state, server_id);
    match state.db.get_server_members(server_id) {
        Ok(members) => {
            state.ws_manager.broadcast_to_users(&members, &msg.to_string()).await;
        }
        Err(_) => {}
    }
}

pub struct WsManager {
    connections: tokio::sync::RwLock<std::collections::HashMap<u64, (String, Option<String>, mpsc::UnboundedSender<WsMessage>)>>,
}

impl WsManager {
    pub fn new() -> Self {
        Self {
            connections: tokio::sync::RwLock::new(std::collections::HashMap::new()),
        }
    }

    pub async fn add_connection(&self, user_id: String, device_id: Option<String>, sender: mpsc::UnboundedSender<WsMessage>) -> u64 {
        // Remove any existing connection for this device
        if let Some(ref dev_id) = device_id {
            let mut conns = self.connections.write().await;
            conns.retain(|_, (uid, did, _)| uid != &user_id || did.as_ref() != Some(dev_id));
        }
        let id = CONN_COUNTER.fetch_add(1, Ordering::Relaxed);
        self.connections.write().await.insert(id, (user_id, device_id, sender));
        id
    }

    pub async fn remove_connection(&self, conn_id: u64) {
        self.connections.write().await.remove(&conn_id);
    }

    /// Force-disconnect every live connection of a user (account deleted).
    /// Sends the message first (while the senders are still registered), then
    /// drops the connections so each socket's send task ends and the WS
    /// cleanup path (voice rooms, presence) runs normally.
    pub async fn disconnect_user(&self, user_id: &str, message: &str) {
        let conns = self.connections.read().await;
        let mut ids = Vec::new();
        for (id, (uid, _did, sender)) in conns.iter() {
            if uid == user_id {
                let _ = sender.send(WsMessage::Text(message.to_string()));
                ids.push(*id);
            }
        }
        drop(conns);
        for id in ids {
            self.remove_connection(id).await;
        }
    }

    pub async fn is_user_connected(&self, user_id: &str) -> bool {
        let conns = self.connections.read().await;
        conns.values().any(|(uid, _, _)| uid == user_id)
    }

    pub async fn broadcast_to_device(&self, user_id: &str, device_id: &str, message: &str) {
        let conns = self.connections.read().await;
        for (uid, did, sender) in conns.values() {
            if uid == user_id && did.as_deref() == Some(device_id) {
                let _ = sender.send(WsMessage::Text(message.to_string()));
            }
        }
    }

    pub async fn broadcast_to_users(&self, user_ids: &[String], message: &str) {
        let conns = self.connections.read().await;
        for (uid, _did, sender) in conns.values() {
            if user_ids.contains(uid) {
                let _ = sender.send(WsMessage::Text(message.to_string()));
            }
        }
    }

    /// Broadcast binary data to the given users. Used for relay frames to avoid
    /// JSON serialization/deserialization overhead.
    pub async fn broadcast_binary_to_users(&self, user_ids: &[String], data: Vec<u8>) {
        let conns = self.connections.read().await;
        for (uid, _did, sender) in conns.values() {
            if user_ids.contains(uid) {
                let _ = sender.send(WsMessage::Binary(data.clone()));
            }
        }
    }

    /// Broadcast to every connection of the given users EXCEPT the connection
    /// whose device_id matches `exclude_device` (used to kick the OLD device of
    /// a user who just re-joined a voice room from another device, without
    /// kicking the device that is joining).
    pub async fn broadcast_to_users_except_device(&self, user_ids: &[String], exclude_device: &str, message: &str) {
        let conns = self.connections.read().await;
        for (uid, did, sender) in conns.values() {
            if user_ids.contains(uid) {
                let is_excluded = !exclude_device.is_empty() && did.as_deref() == Some(exclude_device);
                if !is_excluded {
                    let _ = sender.send(WsMessage::Text(message.to_string()));
                }
            }
        }
    }

    pub async fn broadcast_to_server(&self, _server_id: &str, message: &str) {
        let conns = self.connections.read().await;
        for (_conn_id, _did, sender) in conns.values() {
            let _ = sender.send(WsMessage::Text(message.to_string()));
        }
    }

    pub async fn get_online_user_ids(&self) -> Vec<String> {
        let conns = self.connections.read().await;
        let mut seen = std::collections::HashSet::new();
        let mut result = Vec::new();
        for (uid, _, _) in conns.values() {
            if seen.insert(uid.clone()) {
                result.push(uid.clone());
            }
        }
        result
    }

    pub async fn broadcast_all(&self, message: &str) {
        let conns = self.connections.read().await;
        for (_, _, sender) in conns.values() {
            let _ = sender.send(WsMessage::Text(message.to_string()));
        }
    }
}

#[derive(Deserialize)]
struct WsAuthMessage {
    #[serde(rename = "type")]
    msg_type: String,
    token: String,
    #[serde(default)]
    device_id: Option<String>,
    /// Client-provided ISO 8601 timestamp of when the user last had the page open.
    /// Used to count missed messages since they were last online.
    #[serde(default)]
    last_seen_timestamp: Option<String>,
}

#[derive(Serialize)]
struct OutgoingMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    server_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    dm_channel_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    message: Option<OutgoingChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    user_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct OutgoingChatMessage {
    id: String,
    channel_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    dm_channel_id: Option<String>,
    sender_id: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender_user_id: Option<String>,
    encrypted_sender_username: Option<String>,
    sender_username_nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender_id_hash: Option<String>,
    encrypted_content: String,
    nonce: String,
    timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    edited_at: Option<String>,
    // Streamlined E2E fields
    #[serde(skip_serializing_if = "Option::is_none")]
    key_version: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted_profile_snapshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_snapshot_nonce: Option<String>,
    // Disappearing-message wall-clock expiry (NULL = never). Plaintext
    // metadata so the client can render the countdown immediately.
    #[serde(skip_serializing_if = "Option::is_none")]
    expires_at: Option<String>,
    // F3: Threaded replies
    #[serde(skip_serializing_if = "Option::is_none")]
    thread_parent_id: Option<String>,
}

pub async fn ws_handler(
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    // F6 — Cross-Site WebSocket Hijacking guard: browsers always send an
    // Origin on WS handshakes. If present and it does not match the Host
    // (scheme ignored), refuse the upgrade. Clients without an Origin header
    // (native apps, headless tools) are allowed — Bearer auth still applies.
    if let Some(origin) = headers.get("origin").and_then(|v| v.to_str().ok()) {
        if let Some(host) = headers.get("host").and_then(|v| v.to_str().ok()) {
            if origin != "null" && !crate::origin_host_matches(origin, host) {
                return StatusCode::FORBIDDEN.into_response();
            }
        }
    }
    let client_ip = get_client_ip(&headers);
    ws.on_upgrade(move |socket| handle_socket(socket, state, client_ip))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>, client_ip: String) {
    let (mut sender, mut receiver) = socket.split();

    let (user_id, device_id, last_seen_timestamp) = loop {
        match receiver.next().await {
            Some(Ok(Message::Text(text))) => {
                match serde_json::from_str::<WsAuthMessage>(text.as_str()) {
                    Ok(auth_msg) if auth_msg.msg_type == "auth" => {
                        match auth::validate_token(&auth_msg.token, &state.config.jwt_secret) {
                            Ok(claims) => {
                                // Server-side session check: a force-kicked
                                // (revoked) session is rejected on WS auth, so
                                // a kicked device is signed out even after a
                                // refresh. Tokens without a sid (pre-migration)
                                // are rejected so the user re-logs in once.
                                let session_ok = if claims.sid.is_empty() {
                                    false
                                } else {
                                    state.db.auth_session_valid(&claims.sid).unwrap_or(false)
                                };
                                if !session_ok {
                                    let err = OutgoingMessage {
                                        msg_type: "auth_error".to_string(),
                                        channel_id: None,
                                        server_id: None,
                                        dm_channel_id: None,
                                        message: None,
                                        user_id: None,
                                        username: None,
                                        error: Some("Session revoked — please sign in again".to_string()),
                                    };
                                    let _ = sender
                                        .send(Message::Text(serde_json::to_string(&err).unwrap().into()))
                                        .await;
                                    return;
                                }
                                // Refresh the session's last-active marker.
                                let _ = state.db.touch_auth_session(&claims.sid);
                                // F3-14: Update last_active_at for self-destruct check
                                let _ = state.db.touch_last_active(&claims.sub);
                                break (claims.sub, auth_msg.device_id, auth_msg.last_seen_timestamp);
                            }
                            Err(_) => {
                                // Rate limit failed auth attempts per IP
                                if !WS_AUTH_RATE_LIMITER.check_and_increment(&format!("ws_auth:{}", client_ip), 10, Duration::from_secs(60)) {
                                    let err = OutgoingMessage {
                                        msg_type: "auth_error".to_string(),
                                        channel_id: None,
                                        server_id: None,
                                        dm_channel_id: None,
                                        message: None,
                                        user_id: None,
                                        username: None,
                                        error: Some("Too many auth attempts. Try again in 1 minute.".to_string()),
                                    };
                                    let _ = sender
                                        .send(Message::Text(serde_json::to_string(&err).unwrap().into()))
                                        .await;
                                    return;
                                }
                                let err = OutgoingMessage {
                                    msg_type: "auth_error".to_string(),
                                    channel_id: None,
                                    server_id: None,
                                    dm_channel_id: None,
                                    message: None,
                                    user_id: None,
                                    username: None,
                                    error: Some("Invalid token".to_string()),
                                };
                                let _ = sender
                                    .send(Message::Text(serde_json::to_string(&err).unwrap().into()))
                                    .await;
                                return;
                            }
                        }
                    }
            _ => {
                        // Rate limit non-auth first messages per IP
                        if !WS_AUTH_RATE_LIMITER.check_and_increment(&format!("ws_auth:{}", client_ip), 10, Duration::from_secs(60)) {
                            let err = OutgoingMessage {
                                msg_type: "auth_error".to_string(),
                                channel_id: None,
                                server_id: None,
                                dm_channel_id: None,
                                message: None,
                                user_id: None,
                                username: None,
                                error: Some("Too many auth attempts. Try again in 1 minute.".to_string()),
                            };
                            let _ = sender
                                .send(Message::Text(serde_json::to_string(&err).unwrap().into()))
                                .await;
                            return;
                        }
                        let err = OutgoingMessage {
                            msg_type: "auth_error".to_string(),
                            channel_id: None,
                            server_id: None,
                            dm_channel_id: None,
                            message: None,
                            user_id: None,
                            username: None,
                            error: Some("First message must be auth".to_string()),
                        };
                        let _ = sender
                            .send(Message::Text(serde_json::to_string(&err).unwrap().into()))
                            .await;
                        return;
                    }
                }
            }
            _ => return,
        }
    };

    let user = match state.db.get_user_by_id(&user_id) {
        Ok(u) => u,
        Err(_) => {
            let err = OutgoingMessage {
                msg_type: "auth_error".to_string(),
                channel_id: None,
                server_id: None,
                dm_channel_id: None,
                message: None,
                user_id: None,
                username: None,
                error: Some("Account no longer exists".to_string()),
            };
            let _ = sender
                .send(Message::Text(serde_json::to_string(&err).unwrap().into()))
                .await;
            return;
        }
    };

    let auth_ok = OutgoingMessage {
        msg_type: "auth_ok".to_string(),
        channel_id: None,
        server_id: None,
        dm_channel_id: None,
        message: None,
        user_id: Some(user.id.clone()),
        username: Some(user.username.clone()),
        error: None,
    };
    let _ = sender
        .send(Message::Text(serde_json::to_string(&auth_ok).unwrap().into()))
        .await;

    // Check for missed messages since the client's last_seen_timestamp (saved on beforeunload)
    if let Some(since) = &last_seen_timestamp {
        let new_dms = state.db.count_new_dm_messages(&user_id, since).unwrap_or(0);
        let new_server_msgs = state.db.count_new_server_messages(&user_id, since).unwrap_or(0);
        if new_dms > 0 || new_server_msgs > 0 {
            let missed = serde_json::json!({
                "type": "missed_summary",
                "new_dms": new_dms,
                "new_server_messages": new_server_msgs,
            });
            let _ = sender.send(Message::Text(missed.to_string().into())).await;
        }
    }

    // Replay pending events (key rotation notifications for servers where owner was offline)
    if let Ok(events) = state.db.get_and_delete_pending_events(&user_id) {
        for (server_id, event_type, affected_user_id) in events {
            let replay_msg = serde_json::json!({
                "type": event_type,
                "server_id": server_id,
                "user_id": affected_user_id,
            });
            let _ = sender.send(Message::Text(replay_msg.to_string().into())).await;
        }
    }

    // Replay pending notifications (DMs, mentions, replies while offline)
    if let Ok(notifs) = state.db.get_and_delete_pending_notifications(&user_id) {
        for (notif_type, payload) in notifs {
            // ECDH-encrypted notifications are NOT valid JSON — they look like
            // "base64epk:base64nonce:base64ciphertext". Wrap them in a JSON envelope
            // so the client can identify and decrypt them.
            if payload.starts_with('{') || payload.starts_with('[') {
                // Plaintext JSON — parse and forward as-is
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&payload) {
                    let _ = sender.send(Message::Text(parsed.to_string().into())).await;
                }
            } else {
                // Encrypted notification — wrap in JSON for the client to decrypt
                let wrapper = serde_json::json!({
                    "type": "encrypted_notification",
                    "notification_type": notif_type,
                    "encrypted_payload": payload,
                });
                let _ = sender.send(Message::Text(wrapper.to_string().into())).await;
            }
        }
    }

    let (tx, mut rx) = mpsc::unbounded_channel::<WsMessage>();

    let conn_id = state.ws_manager.add_connection(user_id.clone(), device_id.clone(), tx).await;

    // Broadcast presence: this user is now online
    {
        let online = state.ws_manager.get_online_user_ids().await;
        let presence_msg = serde_json::json!({
            "type": "presence_update",
            "online_user_ids": online,
        });
        state.ws_manager.broadcast_all(&presence_msg.to_string()).await;
    }

    let mut send_task = tokio::spawn(async move {
        while let Some(msg) = rx.recv().await {
            let ws_msg = match msg {
                WsMessage::Text(s) => Message::Text(s.into()),
                WsMessage::Binary(b) => Message::Binary(b.into()),
            };
            if sender.send(ws_msg).await.is_err() {
                break;
            }
        }
    });

    let state_clone = state.clone();
    let user_id_clone = user_id.clone();

    let mut recv_task = tokio::spawn(async move {
        while let Some(Ok(msg)) = receiver.next().await {
            match msg {
                Message::Text(text) => {
                    handle_ws_message(text.as_str(), &state_clone, &user_id_clone).await;
                }
                Message::Binary(data) => {
                    handle_ws_binary(&data, &state_clone, &user_id_clone).await;
                }
                Message::Close(_) => break,
                _ => {}
            }
        }
    });

    tokio::select! {
        _ = &mut send_task => recv_task.abort(),
        _ = &mut recv_task => send_task.abort(),
    }

    state.ws_manager.remove_connection(conn_id).await;

    // Remove the user from any voice rooms THIS device occupied and notify
    // others. Scoped by device_id: when the same account is signed in on
    // another device that replaced this one in a room, this connection's
    // disconnect must not evict the replacement from the call.
    voice_remove_user_all_for_device(&state, &user_id, device_id.as_deref().unwrap_or("")).await;

    // Broadcast presence: this user is now offline
    {
        let online = state.ws_manager.get_online_user_ids().await;
        let presence_msg = serde_json::json!({
            "type": "presence_update",
            "online_user_ids": online,
        });
        state.ws_manager.broadcast_all(&presence_msg.to_string()).await;
    }
}

/// B2: deliver a mention/reply notification to the given users. Connected
/// users get a per-recipient ECDH-encrypted envelope — the exact
/// `{"type":"encrypted_notification", ...}` shape the client already decrypts
/// on the offline path — so the live relay no longer exposes
/// channel_id/server_id/dm_channel_id/message_id in plaintext. Offline users
/// get it queued (which encrypts with a fresh ephemeral key). The envelope's
/// notification_type is blinded (B4); the real type rides inside the encrypted
/// payload, which is what the client dispatches on.
pub(crate) async fn deliver_encrypted_notification(
    state: &Arc<AppState>,
    user_ids: &[String],
    notification_type: &str,
    payload: &str,
) {
    let blind_type = crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), &format!("notif_type:{}", notification_type));
    for uid in user_ids {
        if state.ws_manager.is_user_connected(uid).await {
            if let Ok(enc) = state.db.encrypt_notification_for_user(uid, payload) {
                let wrapper = serde_json::json!({
                    "type": "encrypted_notification",
                    "notification_type": blind_type,
                    "encrypted_payload": enc,
                });
                state.ws_manager.broadcast_to_users(&[uid.clone()], &wrapper.to_string()).await;
            }
        } else {
            let _ = state.db.save_pending_notification(uid, notification_type, payload, state.config.hmac_key.as_bytes());
        }
    }
}

// ========================= Binary WebSocket protocol =========================
// Relay frames use a compact binary format to avoid JSON serialization overhead.
//
// Client → Server binary relay frame:
//   [kind: u8]                 0=camera, 1=screen, 2=audio,
//                              3..=6=audio_low/med/high/ultra,
//                              7..=11=screen_audio[_low/med/high/ultra]
//   [room_type_len: u8]
//   [room_type: utf8]
//   [channel_id_len: u16 LE]
//   [channel_id: utf8]
//   [dm_channel_id_len: u16 LE]
//   [dm_channel_id: utf8]
//   [nonce: 24 bytes]
//   [ciphertext: remaining bytes]
//
// Server → Client binary relay frame:
//   [0x01: marker]             identifies this as a binary relay frame
//   [from_user_id_len: u8]
//   [from_user_id: utf8]
//   [kind: u8]
//   [nonce: 24 bytes]
//   [ciphertext: remaining bytes]

fn read_u8(data: &[u8], pos: &mut usize) -> Option<u8> {
    if *pos >= data.len() { return None; }
    let v = data[*pos];
    *pos += 1;
    Some(v)
}

fn read_u16_le(data: &[u8], pos: &mut usize) -> Option<u16> {
    if *pos + 2 > data.len() { return None; }
    let v = u16::from_le_bytes([data[*pos], data[*pos + 1]]);
    *pos += 2;
    Some(v)
}

fn read_bytes<'a>(data: &'a [u8], pos: &mut usize, len: usize) -> Option<&'a [u8]> {
    if *pos + len > data.len() { return None; }
    let slice = &data[*pos..*pos + len];
    *pos += len;
    Some(slice)
}

// Audio kinds 3..=6 are mic audio at a specific sample rate (the sender picks
// the kind from its sendAudioQuality and downsamples to match); 7..=11 are the
// same for screen-share audio. These MUST round-trip here, otherwise the client
// encodes a rate-tagged kind and the server silently drops the frame.
fn kind_to_str(kind: u8) -> &'static str {
    match kind {
        0 => "camera",
        1 => "screen",
        2 => "audio",
        3 => "audio_low",
        4 => "audio_med",
        5 => "audio_high",
        6 => "audio_ultra",
        7 => "screen_audio",
        8 => "screen_audio_low",
        9 => "screen_audio_med",
        10 => "screen_audio_high",
        11 => "screen_audio_ultra",
        _ => "camera",
    }
}

/// Highest valid client→server kind byte (see the binary protocol above).
const RELAY_KIND_MAX: u8 = 11;

fn str_to_kind(s: &str) -> u8 {
    match s {
        "camera" => 0,
        "screen" => 1,
        "audio" => 2,
        "audio_low" => 3,
        "audio_med" => 4,
        "audio_high" => 5,
        "audio_ultra" => 6,
        "screen_audio" => 7,
        "screen_audio_low" => 8,
        "screen_audio_med" => 9,
        "screen_audio_high" => 10,
        "screen_audio_ultra" => 11,
        _ => 0,
    }
}

/// Encode a user ID + kind + nonce + ciphertext into the server→client binary
/// relay frame format. Returns a pre-allocated Vec<u8>.
fn encode_binary_relay_out(from_uid: &str, kind: u8, nonce: &[u8], ciphertext: &[u8]) -> Vec<u8> {
    let uid_bytes = from_uid.as_bytes();
    let total = 1 + 1 + uid_bytes.len() + 1 + nonce.len() + ciphertext.len();
    let mut out = Vec::with_capacity(total);
    out.push(0x01); // relay marker
    out.push(uid_bytes.len() as u8);
    out.extend_from_slice(uid_bytes);
    out.push(kind);
    out.extend_from_slice(nonce);
    out.extend_from_slice(ciphertext);
    out
}

/// Handle an incoming binary WebSocket message. Only relay frames use binary;
/// everything else falls through to the text handler.
async fn handle_ws_binary(
    data: &[u8],
    state: &Arc<AppState>,
    user_id: &str,
) {
    if data.is_empty() { return; }

    // Binary relay frames from client: first byte is the kind byte
    // (0=camera, 1=screen, 2=audio, 3..=6 rate-tagged mic audio,
    // 7..=11 rate-tagged screen audio). We verify it's a valid kind before
    // proceeding — audio kinds above 2 used to be rejected here, which made
    // every relayed microphone frame disappear.
    let mut pos = 0;
    let kind_byte = match read_u8(data, &mut pos) {
        Some(k) if k <= RELAY_KIND_MAX => k,
        _ => return,
    };
    let kind_str = kind_to_str(kind_byte);

    // room_type_len (u8)
    let rt_len = match read_u8(data, &mut pos) {
        Some(l) => l as usize,
        None => return,
    };
    let room_type = match read_bytes(data, &mut pos, rt_len) {
        Some(b) => match std::str::from_utf8(b) { Ok(s) => s.to_string(), Err(_) => return },
        None => return,
    };

    // channel_id_len (u16 LE)
    let ci_len = match read_u16_le(data, &mut pos) {
        Some(l) => l as usize,
        None => return,
    };
    let channel_id = match read_bytes(data, &mut pos, ci_len) {
        Some(b) => match std::str::from_utf8(b) { Ok(s) => s.to_string(), Err(_) => return },
        None => return,
    };

    // dm_channel_id_len (u16 LE)
    let di_len = match read_u16_le(data, &mut pos) {
        Some(l) => l as usize,
        None => return,
    };
    let dm_channel_id = match read_bytes(data, &mut pos, di_len) {
        Some(b) => match std::str::from_utf8(b) { Ok(s) => s.to_string(), Err(_) => return },
        None => return,
    };

    // nonce (24 bytes)
    let nonce = match read_bytes(data, &mut pos, 24) {
        Some(b) => b,
        None => return,
    };

    // ciphertext = remaining bytes
    let ciphertext = &data[pos..];

    let room_id = voice_room_id(&room_type, &channel_id, &dm_channel_id);

    // Rate limit
    if !VOICE_SIGNAL_LIMITER.check_and_increment(
        &format!("voice_media:{}", user_id),
        3000,
        Duration::from_secs(10),
    ) {
        return;
    }

    // Sender must be in the room
    let is_member = {
        let rooms = match state.voice_rooms.read() {
            Ok(r) => r,
            Err(_) => return,
        };
        match rooms.get(&room_id) {
            Some(room) => room.members.contains_key(user_id),
            None => false,
        }
    };
    if !is_member { return; }

    // Drop MIC audio from muted users. Must cover every rate-tagged mic kind
    // (audio, audio_low, audio_med, audio_high, audio_ultra) — an exact
    // "audio" match would let a muted user be heard via the quality kinds.
    // Screen-share audio is deliberately not covered here (it is its own feed,
    // gated by the sharer stopping the share).
    let is_mic_audio = kind_str == "audio" || kind_str.starts_with("audio_");
    // Roles can deny SPEAK per voice channel/category (mic audio only).
    if is_mic_audio && room_type == "server" && !channel_id.is_empty() {
        if let Ok(sid) = state.db.get_server_id_for_channel(&channel_id) {
            if !state.db.member_has_permission(&sid, user_id, crate::db::PERM_SPEAK, Some(&channel_id)) {
                return;
            }
        }
    }
    if is_mic_audio {
        let muted = {
            let rooms = match state.voice_rooms.read() {
                Ok(r) => r,
                Err(_) => return,
            };
            rooms.get(&room_id)
                .and_then(|room| room.members.get(user_id))
                .map(|m| m.force_muted || m.muted)
                .unwrap_or(true)
        };
        if muted { return; }
    }

    // Collect member IDs (excluding sender). For camera/screen relay,
    // skip receivers who have this feed unloaded (manual video load).
    // For audio (including screen_audio), skip deafened receivers to save bandwidth.
    let feed_key = format!("{}:{}", user_id, kind_str);
    let is_audio = kind_str.starts_with("audio") || kind_str.starts_with("screen_audio");
    let ids: Vec<String> = {
        let rooms = match state.voice_rooms.read() {
            Ok(r) => r,
            Err(_) => return,
        };
        match rooms.get(&room_id) {
            Some(room) => room.members.iter()
                .filter(|(id, m)| {
                    if id.as_str() == user_id { return false; }
                    // Deafened members can't hear audio — skip to save bandwidth
                    if is_audio && (m.deafened || m.force_deafened) {
                        return false;
                    }
                    // For camera/screen video, skip if receiver unloaded this feed
                    if (kind_str == "camera" || kind_str == "screen") && m.unloaded_feeds.contains(&feed_key) {
                        return false;
                    }
                    true
                })
                .map(|(id, _)| id.clone())
                .collect(),
            None => return,
        }
    };

    // Build server→client binary relay frame: [0x01][uid_len][uid][kind][nonce][ciphertext]
    let binary_frame = encode_binary_relay_out(user_id, kind_byte, nonce, ciphertext);
    state.ws_manager.broadcast_binary_to_users(&ids, binary_frame).await;
}

async fn handle_ws_message(
    text: &str,
    state: &Arc<AppState>,
    user_id: &str,
) {
    let mut parsed: serde_json::Value = match serde_json::from_str(text) {
        Ok(v) => v,
        Err(_) => return,
    };

    let msg_type = match parsed.get("type").and_then(|t| t.as_str()) {
        Some(t) => t,
        None => return,
    };

    match msg_type {
        "message_send" => {
            let channel_id = match parsed.get("channel_id").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };
            let encrypted_content_b64 = match parsed.get("encrypted_content").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };
            let nonce_b64 = match parsed.get("nonce").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };

            // Check user is member of the server this channel belongs to
            let server_id = match state.db.get_server_id_for_channel(channel_id) {
                Ok(id) => id,
                Err(_) => return,
            };
            if !state.db.is_member_of_server(user_id, &server_id).unwrap_or(false) {
                return;
            }
            // Role permissions: sending needs SEND_MESSAGES in this channel, and
            // a thread reply needs REPLY_IN_THREADS (both can be denied per
            // channel or per category).
            let thread_parent_id_check = parsed.get("thread_parent_id").and_then(|c| c.as_str());
            let needed = if thread_parent_id_check.is_some() {
                crate::db::PERM_SEND_MESSAGES | crate::db::PERM_REPLY_IN_THREADS
            } else {
                crate::db::PERM_SEND_MESSAGES
            };
            if !state.db.member_has_permission(&server_id, user_id, needed, Some(channel_id)) {
                return;
            }

            let encrypted_content = match base64::engine::general_purpose::STANDARD.decode(encrypted_content_b64) {
                Ok(b) => b,
                Err(_) => return,
            };
            let nonce = match base64::engine::general_purpose::STANDARD.decode(nonce_b64) {
                Ok(b) => b,
                Err(_) => return,
            };

            let encrypted_profile_snapshot = parsed.get("encrypted_profile_snapshot").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
            let profile_snapshot_nonce = parsed.get("profile_snapshot_nonce").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

            // Parse encrypted sender_username from incoming message
            let encrypted_sender_username = parsed.get("encrypted_sender_username").and_then(|c| c.as_str()).map(|s| s.to_string());
            let sender_username_nonce = parsed.get("sender_username_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());

            let raw_file_id = parsed.get("file_id").and_then(|c| c.as_str()).map(|s| s.to_string());
            // Store SHA-256 hash instead of raw UUID so the host can't map message file_ids
            let file_id_hash = raw_file_id.as_ref().map(|fid| crate::db::sha256_hex(fid));
            // Disappearing-message TTL: optional plaintext seconds (clamped to
            // 5s..24h); the server enforces the countdown + shreds at expiry.
            let expires_at = disappearing_expiry(&parsed);
            let thread_parent_id = parsed.get("thread_parent_id").and_then(|c| c.as_str());

            let message = match state.db.save_encrypted_message(channel_id, user_id, &encrypted_content, &nonce, encrypted_profile_snapshot.as_deref(), profile_snapshot_nonce.as_deref(), encrypted_sender_username.as_deref(), sender_username_nonce.as_deref(), file_id_hash.as_deref(), expires_at.as_deref(), thread_parent_id) {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("Failed to save message: {}", e);
                    return;
                }
            };

            // E2E search blind index: the sender's client includes HMAC tokens
            // for each keyword (keyed by the server key the host never sees).
            // Stored insert-only; content stays encrypted.
            if let Some(tokens) = parsed.get("search_tokens").and_then(|t| t.as_array()) {
                let toks: Vec<String> = tokens.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).take(400).collect();
                if !toks.is_empty() {
                    let _ = state.db.index_message_tokens(&message.id, &toks);
                }
            }

            let server_id_clone = server_id.clone();
            let msg_id = message.id.clone();
            let outgoing = OutgoingMessage {
                msg_type: "message_new".to_string(),
                channel_id: Some(message.channel_id.clone()),
                server_id: Some(server_id_clone),
                dm_channel_id: None,
                message: Some(OutgoingChatMessage {
                    sender_id: crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), user_id),
                    sender_user_id: Some(user_id.to_string()),
                    id: message.id,
                    channel_id: message.channel_id,
                    dm_channel_id: None,
                    sender_id_hash: message.sender_id_hash.clone(),
                    encrypted_sender_username: message.encrypted_sender_username.clone(),
                    sender_username_nonce: message.sender_username_nonce.clone(),
                    encrypted_content: encrypted_content_b64.to_string(),
                    nonce: nonce_b64.to_string(),
                    timestamp: message.timestamp,
                    edited_at: None,
                    key_version: None,
                    encrypted_profile_snapshot: encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    profile_snapshot_nonce: profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    expires_at: expires_at.clone(),
                    thread_parent_id: thread_parent_id.map(|s| s.to_string()),
                }),
                user_id: None,
                username: None,
                error: None,
            };

            let json = serde_json::to_string(&outgoing).unwrap();

            // Only broadcast to members of this server
            match state.db.get_server_members(&server_id) {
                Ok(members) => {
                    state.ws_manager.broadcast_to_users(&members, &json).await;
                    // Push (app-closed): metadata-only payload — no message
                    // plaintext ever leaves the E2EE layer — to devices of
                    // members with no live websocket.
                    let recipients: Vec<String> =
                        members.iter().filter(|m| *m != user_id).cloned().collect();
                    crate::handlers::spawn_push_to_users(
                        state,
                        recipients,
                        "E2E Chat".to_string(),
                        "New message in a channel".to_string(),
                        format!("ch:{channel_id}"),
                        format!("/?server={server_id}&channel={channel_id}"),
                    );
                }
                Err(e) => {
                    tracing::error!("Failed to get server members: {}", e);
                }
            }

            // Notify mentioned users
            if let Some(mentions) = parsed.get("mentions").and_then(|m| m.as_array()) {
                let mentioned_ids: Vec<String> = mentions
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .filter(|id| id != user_id)
                    .collect();
                if !mentioned_ids.is_empty() {
                    let ch_enc = state.db.get_channel_encrypted_name(channel_id).ok();
                    let sv_enc = state.db.get_server_encrypted_name(&server_id).ok();
                    let ch_enc_name = ch_enc.as_ref().map(|(n, _)| base64::engine::general_purpose::STANDARD.encode(n));
                    let ch_name_nonce = ch_enc.as_ref().map(|(_, nn)| base64::engine::general_purpose::STANDARD.encode(nn));
                    let sv_enc_name = sv_enc.as_ref().map(|(n, _)| base64::engine::general_purpose::STANDARD.encode(n));
                    let sv_name_nonce = sv_enc.as_ref().map(|(_, nn)| base64::engine::general_purpose::STANDARD.encode(nn));
                    let mention_notification = serde_json::json!({
                        "type": "mention_notification",
                        "channel_id": channel_id,
                        "server_id": server_id,
                        "channel_encrypted_name": ch_enc_name,
                        "channel_name_nonce": ch_name_nonce,
                        "server_encrypted_name": sv_enc_name,
                        "server_name_nonce": sv_name_nonce,
                        "encrypted_sender_username": message.encrypted_sender_username,
                        "sender_username_nonce": message.sender_username_nonce,
                        "message_id": msg_id
                    });
                    // B2: encrypt the live relay per recipient (offline users are
                    // queued with the same encrypted scheme).
                    let notif_str = mention_notification.to_string();
                    deliver_encrypted_notification(state, &mentioned_ids, "mention_notification", &notif_str).await;
                }
            }

            // Notify replied user
            if let Some(reply_to_user_id) = parsed.get("reply_to_user_id").and_then(|r| r.as_str()) {
                if reply_to_user_id != user_id {
                    let ch_enc = state.db.get_channel_encrypted_name(channel_id).ok();
                    let sv_enc = state.db.get_server_encrypted_name(&server_id).ok();
                    let ch_enc_name = ch_enc.as_ref().map(|(n, _)| base64::engine::general_purpose::STANDARD.encode(n));
                    let ch_name_nonce = ch_enc.as_ref().map(|(_, nn)| base64::engine::general_purpose::STANDARD.encode(nn));
                    let sv_enc_name = sv_enc.as_ref().map(|(n, _)| base64::engine::general_purpose::STANDARD.encode(n));
                    let sv_name_nonce = sv_enc.as_ref().map(|(_, nn)| base64::engine::general_purpose::STANDARD.encode(nn));
                    let reply_notification = serde_json::json!({
                        "type": "reply_notification",
                        "channel_id": channel_id,
                        "server_id": server_id,
                        "channel_encrypted_name": ch_enc_name,
                        "channel_name_nonce": ch_name_nonce,
                        "server_encrypted_name": sv_enc_name,
                        "server_name_nonce": sv_name_nonce,
                        "encrypted_sender_username": message.encrypted_sender_username,
                        "sender_username_nonce": message.sender_username_nonce,
                        "message_id": msg_id
                    });
                    let reply_str = reply_notification.to_string();
                    deliver_encrypted_notification(state, &[reply_to_user_id.to_string()], "reply_notification", &reply_str).await;
                }
            }
        }
        "upload_key_bundle" => {
            let _identity_key_public = match parsed.get("identity_key_public").and_then(|v| v.as_str()) {
                Some(k) => k,
                None => return,
            };
            let _signed_prekey_public = match parsed.get("signed_prekey_public").and_then(|v| v.as_str()) {
                Some(k) => k,
                None => return,
            };
            let _signed_prekey_signature = match parsed.get("signed_prekey_signature").and_then(|v| v.as_str()) {
                Some(k) => k,
                None => return,
            };
            // Key bundle upload removed (legacy X3DH)
        }
        "dm_send" => {
            let dm_channel_id = match parsed.get("dm_channel_id").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };
            let encrypted_content_b64 = match parsed.get("encrypted_content").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };
            let nonce_b64 = match parsed.get("nonce").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };

            // Must be a member of this DM channel.
            if !state.db.is_dm_member(dm_channel_id, user_id).unwrap_or(false) {
                return;
            }

            let encrypted_content = match base64::engine::general_purpose::STANDARD.decode(encrypted_content_b64) {
                Ok(b) => b,
                Err(_) => return,
            };
            let nonce = match base64::engine::general_purpose::STANDARD.decode(nonce_b64) {
                Ok(b) => b,
                Err(_) => return,
            };

            let encrypted_profile_snapshot = parsed.get("encrypted_profile_snapshot").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
            let profile_snapshot_nonce = parsed.get("profile_snapshot_nonce").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

            // Parse encrypted sender_username from incoming dm_send
            let encrypted_sender_username = parsed.get("encrypted_sender_username").and_then(|c| c.as_str()).map(|s| s.to_string());
            let sender_username_nonce = parsed.get("sender_username_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());

            let raw_file_id = parsed.get("file_id").and_then(|c| c.as_str()).map(|s| s.to_string());
            // Store SHA-256 hash instead of raw UUID so the host can't map message file_ids
            let file_id_hash = raw_file_id.as_ref().map(|fid| crate::db::sha256_hex(fid));
            // Disappearing-message TTL (same bounds as channel messages).
            let expires_at = disappearing_expiry(&parsed);

            let message = match state.db.save_dm_message(dm_channel_id, user_id, &encrypted_content, &nonce, encrypted_profile_snapshot.as_deref(), profile_snapshot_nonce.as_deref(), encrypted_sender_username.as_deref(), sender_username_nonce.as_deref(), file_id_hash.as_deref(), expires_at.as_deref()) {
                            Ok(m) => m,
                            Err(e) => {
                                tracing::error!("Failed to save DM message: {}", e);
                    return;
                }
            };

            // E2E search blind index for DMs (same scheme as channel messages).
            if let Some(tokens) = parsed.get("search_tokens").and_then(|t| t.as_array()) {
                let toks: Vec<String> = tokens.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).take(400).collect();
                if !toks.is_empty() {
                    let _ = state.db.index_dm_message_tokens(&message.id, &toks);
                }
            }

            let msg_id = message.id.clone();
            let _msg_sender_username = state.db.get_user_by_id(&user_id).map(|u| u.username).unwrap_or_default();
            let outgoing = OutgoingMessage {
                msg_type: "dm_new".to_string(),
                channel_id: None,
                server_id: None,
                dm_channel_id: Some(message.dm_channel_id.clone()),
                message: Some(OutgoingChatMessage {
                    sender_id: crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), user_id),
                    sender_user_id: Some(user_id.to_string()),
                    id: message.id,
                    channel_id: String::new(),
                    dm_channel_id: Some(message.dm_channel_id.clone()),
                    encrypted_sender_username: message.encrypted_sender_username.clone(),
                    sender_username_nonce: message.sender_username_nonce.clone(),
                    sender_id_hash: message.sender_id_hash.clone(),
                    encrypted_content: encrypted_content_b64.to_string(),
                    nonce: nonce_b64.to_string(),
                    timestamp: message.timestamp,
                    edited_at: None,
                    key_version: None,
                    encrypted_profile_snapshot: encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    profile_snapshot_nonce: profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    expires_at: expires_at.clone(),
                    thread_parent_id: None,
                }),
                user_id: None,
                username: None,
                error: None,
            };

            let json = serde_json::to_string(&outgoing).unwrap();

            // Broadcast to both DM members.
            match state.db.get_dm_members(dm_channel_id) {
                Ok(members) => {
                    state.ws_manager.broadcast_to_users(&members, &json).await;
                    // Push (app-closed) for the offline side of the DM.
                    let recipients: Vec<String> =
                        members.iter().filter(|m| *m != user_id).cloned().collect();
                    crate::handlers::spawn_push_to_users(
                        state,
                        recipients,
                        "E2E Chat".to_string(),
                        "New direct message".to_string(),
                        format!("dm:{dm_channel_id}"),
                        format!("/?dm={dm_channel_id}"),
                    );
                    // Save notification for offline members. B4: the payload is
                    // wrapped with "type" so the client can dispatch it purely
                    // from the decrypted payload (the DB/envelope type is blinded).
                    for member_id in &members {
                        if member_id != user_id && !state.ws_manager.is_user_connected(member_id).await {
                            let dm_notif = serde_json::json!({
                                "type": "dm_new",
                                "dm_channel_id": dm_channel_id,
                            });
                            let _ = state.db.save_pending_notification(member_id, "dm_new", &dm_notif.to_string(), state.config.hmac_key.as_bytes());
                        }
                    }
                }
                Err(e) => {
                    tracing::error!("Failed to get DM members: {}", e);
                }
            }

            // Notify mentioned user in DM
            if let Some(mentions) = parsed.get("mentions").and_then(|m| m.as_array()) {
                let mentioned_ids: Vec<String> = mentions
                    .iter()
                    .filter_map(|v| v.as_str().map(|s| s.to_string()))
                    .filter(|id| id != user_id)
                    .collect();
                if !mentioned_ids.is_empty() {
                    let mention_notification = serde_json::json!({
                        "type": "mention_notification",
                        "dm_channel_id": dm_channel_id,
                        "encrypted_sender_username": message.encrypted_sender_username,
                        "sender_username_nonce": message.sender_username_nonce,
                        "message_id": msg_id
                    });
                    let notif_str = mention_notification.to_string();
                    deliver_encrypted_notification(state, &mentioned_ids, "mention_notification", &notif_str).await;
                }
            }

            // Notify replied user in DM
            if let Some(reply_to_user_id) = parsed.get("reply_to_user_id").and_then(|r| r.as_str()) {
                if reply_to_user_id != user_id {
                    let reply_notification = serde_json::json!({
                        "type": "reply_notification",
                        "dm_channel_id": dm_channel_id,
                        "encrypted_sender_username": message.encrypted_sender_username,
                        "sender_username_nonce": message.sender_username_nonce,
                        "message_id": msg_id
                    });
                    let reply_str = reply_notification.to_string();
                    deliver_encrypted_notification(state, &[reply_to_user_id.to_string()], "reply_notification", &reply_str).await;
                }
            }
        }
        "message_edit" => {
            let message_id = match parsed.get("message_id").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };
            let encrypted_content_b64 = match parsed.get("encrypted_content").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };
            let nonce_b64 = match parsed.get("nonce").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };

            let encrypted_content = match base64::engine::general_purpose::STANDARD.decode(encrypted_content_b64) {
                Ok(b) => b,
                Err(_) => return,
            };
            let nonce = match base64::engine::general_purpose::STANDARD.decode(nonce_b64) {
                Ok(b) => b,
                Err(_) => return,
            };


            let message = match state.db.edit_encrypted_message(message_id, user_id, &encrypted_content, &nonce) {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("Failed to edit message: {}", e);
                    return;
                }
            };

            // Edited messages get a fresh token set (the plaintext changed).
            if let Some(tokens) = parsed.get("search_tokens").and_then(|t| t.as_array()) {
                let toks: Vec<String> = tokens.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).take(400).collect();
                let _ = state.db.replace_message_tokens(&message.id, &toks);
            }

            let server_id = match state.db.get_server_id_for_channel(&message.channel_id) {
                Ok(id) => id,
                Err(_) => return,
            };
            let outgoing = OutgoingMessage {                    msg_type: "message_edited".to_string(),
                channel_id: Some(message.channel_id.clone()),
                server_id: Some(server_id.clone()),
                dm_channel_id: None,
                message: Some(OutgoingChatMessage {
                    sender_id: crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), user_id),
                    sender_user_id: Some(user_id.to_string()),
                    id: message.id,
                    channel_id: message.channel_id,
                    dm_channel_id: None,
                    encrypted_sender_username: message.encrypted_sender_username.clone(),
                    sender_username_nonce: message.sender_username_nonce.clone(),
                    sender_id_hash: message.sender_id_hash.clone(),
                    encrypted_content: encrypted_content_b64.to_string(),
                    nonce: nonce_b64.to_string(),
                    timestamp: message.timestamp,
                    edited_at: message.edited_at,
                    key_version: None,
                    encrypted_profile_snapshot: None,
                    profile_snapshot_nonce: None,
                    expires_at: None,
                    thread_parent_id: None,
                }),
                user_id: None,
                username: None,
                error: None,
            };

            let json = serde_json::to_string(&outgoing).unwrap();
            match state.db.get_server_members(&server_id) {
                Ok(members) => {
                    state.ws_manager.broadcast_to_users(&members, &json).await;
                }
                Err(e) => {
                    tracing::error!("Failed to get server members: {}", e);
                }
            }
        }
        "message_delete" => {
            let message_id = match parsed.get("message_id").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };

            let channel_id = match state.db.get_message_channel_id(message_id) {
                Ok(cid) => cid,
                Err(_) => return,
            };

            // Own messages can always be deleted; deleting someone else's needs
            // MANAGE_MESSAGES in this channel.
            match state.db.delete_message(message_id, user_id) {
                Ok(()) => {}
                Err(_) => {
                    let server_id_for_perm = state.db.get_server_id_for_channel(&channel_id).unwrap_or_default();
                    if server_id_for_perm.is_empty()
                        || !state.db.member_has_permission(&server_id_for_perm, user_id, crate::db::PERM_MANAGE_MESSAGES, Some(&channel_id))
                    {
                        return;
                    }
                    if let Err(e) = state.db.delete_message_any(message_id) {
                        tracing::error!("Failed to delete message: {}", e);
                        return;
                    }
                }
            };

            let server_id = match state.db.get_server_id_for_channel(&channel_id) {
                Ok(id) => id,
                Err(_) => return,
            };

            let outgoing = serde_json::json!({
                "type": "message_deleted",
                "channel_id": channel_id,
                "message_id": message_id,
            });

            let json = outgoing.to_string();
            match state.db.get_server_members(&server_id) {
                Ok(members) => {
                    state.ws_manager.broadcast_to_users(&members, &json).await;
                }
                Err(e) => {
                    tracing::error!("Failed to get server members: {}", e);
                }
            }
        }
        "dm_edit" => {
            let message_id = match parsed.get("message_id").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };
            let encrypted_content_b64 = match parsed.get("encrypted_content").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };
            let nonce_b64 = match parsed.get("nonce").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };

            let encrypted_content = match base64::engine::general_purpose::STANDARD.decode(encrypted_content_b64) {
                Ok(b) => b,
                Err(_) => return,
            };
            let nonce = match base64::engine::general_purpose::STANDARD.decode(nonce_b64) {
                Ok(b) => b,
                Err(_) => return,
            };


            let message = match state.db.edit_dm_message(message_id, user_id, &encrypted_content, &nonce) {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("Failed to edit DM message: {}", e);
                    return;
                }
            };
            // Edited DM messages get a fresh token set (the plaintext changed).
            if let Some(tokens) = parsed.get("search_tokens").and_then(|t| t.as_array()) {
                let toks: Vec<String> = tokens.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).take(400).collect();
                let _ = state.db.replace_dm_message_tokens(&message.id, &toks);
            }
            let outgoing = OutgoingMessage {                    msg_type: "dm_edited".to_string(),
                channel_id: None,
                server_id: None,
                dm_channel_id: Some(message.dm_channel_id.clone()),
                message: Some(OutgoingChatMessage {
                    sender_id: crate::db::hmac_sha256_hex(state.config.hmac_key.as_bytes(), user_id),
                    sender_user_id: Some(user_id.to_string()),
                    id: message.id,
                    channel_id: String::new(),
                    dm_channel_id: Some(message.dm_channel_id.clone()),
                    encrypted_sender_username: message.encrypted_sender_username.clone(),
                    sender_username_nonce: message.sender_username_nonce.clone(),
                    sender_id_hash: message.sender_id_hash.clone(),
                    encrypted_content: encrypted_content_b64.to_string(),
                    nonce: nonce_b64.to_string(),
                    timestamp: message.timestamp,
                    edited_at: message.edited_at,
                    key_version: None,
                    encrypted_profile_snapshot: None,
                    profile_snapshot_nonce: None,
                    expires_at: None,
                    thread_parent_id: None,
                }),
                user_id: None,
                username: None,
                error: None,
            };

            let json = serde_json::to_string(&outgoing).unwrap();
            match state.db.get_dm_members(&message.dm_channel_id) {
                Ok(members) => {
                    state.ws_manager.broadcast_to_users(&members, &json).await;
                }
                Err(e) => {
                    tracing::error!("Failed to get DM members: {}", e);
                }
            }
        }
        "dm_delete" => {
            let message_id = match parsed.get("message_id").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };

            let dm_channel_id = match state.db.get_dm_message_channel_id(message_id) {
                Ok(cid) => cid,
                Err(_) => return,
            };

            match state.db.delete_dm_message(message_id, user_id) {
                Ok(()) => {}
                Err(e) => {
                    tracing::error!("Failed to delete DM message: {}", e);
                    return;
                }
            };

            let outgoing = serde_json::json!({
                "type": "dm_deleted",
                "dm_channel_id": dm_channel_id,
                "message_id": message_id,
            });

            let json = outgoing.to_string();
            match state.db.get_dm_members(&dm_channel_id) {
                Ok(members) => {
                    state.ws_manager.broadcast_to_users(&members, &json).await;
                }
                Err(e) => {
                    tracing::error!("Failed to get DM members: {}", e);
                }
            }
        }
        "message_forwarded" => {
            // Client notifies us that a message was forwarded by someone.
            // We do NOT verify the forwarder is the original author — the whole point is
            // that OTHER users forward YOUR message and you see the indicator.
            // Privacy is enforced client-side: each client only shows the indicator on
            // messages where data-sender-user-id matches their own user ID.
            let message_id = match parsed.get("message_id").and_then(|c| c.as_str()) {
                Some(m) => m,
                None => return,
            };
            let channel_id = match parsed.get("channel_id").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => {
                    match state.db.get_message_channel_id(message_id) {
                        Ok(cid) => cid,
                        Err(_) => return,
                    }
                }
            };

            let server_id = match state.db.get_server_id_for_channel(&channel_id) {
                Ok(id) => id,
                Err(_) => return,
            };

            // Broadcast to server members so the original author's client can show the indicator
            let outgoing = serde_json::json!({
                "type": "message_forwarded",
                "channel_id": channel_id,
                "message_id": message_id,
                "server_id": server_id,
            });

            let json = outgoing.to_string();
            match state.db.get_server_members(&server_id) {
                Ok(members) => {
                    state.ws_manager.broadcast_to_users(&members, &json).await;
                }
                Err(e) => {
                    tracing::error!("Failed to get server members for forward notification: {}", e);
                }
            }
        }
        "dm_message_forwarded" => {
            // Client notifies us that a DM message was forwarded.
            // Same privacy model: broadcast to DM members, each client filters locally.
            let message_id = match parsed.get("message_id").and_then(|c| c.as_str()) {
                Some(m) => m,
                None => return,
            };
            let dm_channel_id = match parsed.get("dm_channel_id").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => {
                    match state.db.get_dm_message_channel_id(message_id) {
                        Ok(cid) => cid,
                        Err(_) => return,
                    }
                }
            };

            let outgoing = serde_json::json!({
                "type": "message_forwarded",
                "dm_channel_id": dm_channel_id,
                "message_id": message_id,
            });

            let json = outgoing.to_string();
            match state.db.get_dm_members(&dm_channel_id) {
                Ok(members) => {
                    state.ws_manager.broadcast_to_users(&members, &json).await;
                }
                Err(e) => {
                    tracing::error!("Failed to get DM members for forward notification: {}", e);
                }
            }
        }
        "typing" => {
            // Ephemeral typing indicator: relayed to the OTHER members of the
            // channel/DM so they can render "X is typing…". Nothing is stored.
            // The payload carries only user_id + channel/dm ids (metadata, no
            // message content) — the recipient renders the display name from
            // their own decrypted profile cache.
            let channel_id = parsed.get("channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
            let dm_channel_id = parsed.get("dm_channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
            if !channel_id.is_empty() {
                let server_id = match state.db.get_server_id_for_channel(&channel_id) {
                    Ok(id) => id,
                    Err(_) => return,
                };
                if !state.db.is_member_of_server(user_id, &server_id).unwrap_or(false) {
                    return;
                }
                let typing = serde_json::json!({
                    "type": "typing",
                    "channel_id": channel_id,
                    "user_id": user_id,
                });
                match state.db.get_server_members(&server_id) {
                    Ok(members) => {
                        let others: Vec<String> = members.into_iter().filter(|m| m != user_id).collect();
                        state.ws_manager.broadcast_to_users(&others, &typing.to_string()).await;
                    }
                    Err(_) => {}
                }
            } else if !dm_channel_id.is_empty() {
                if !state.db.is_dm_member(&dm_channel_id, user_id).unwrap_or(false) {
                    return;
                }
                let typing = serde_json::json!({
                    "type": "typing",
                    "dm_channel_id": dm_channel_id,
                    "user_id": user_id,
                });
                match state.db.get_dm_members(&dm_channel_id) {
                    Ok(members) => {
                        let others: Vec<String> = members.into_iter().filter(|m| m != user_id).collect();
                        state.ws_manager.broadcast_to_users(&others, &typing.to_string()).await;
                    }
                    Err(_) => {}
                }
            }
        }
        "soundboard_play" => {
            // Relay soundboard play to all voice room participants
            let room_type = parsed.get("room_type").and_then(|s| s.as_str()).unwrap_or("server");
            // Playing a clip needs USE_SOUNDBOARD in this server (server rooms
            // only; DM calls have no server roles).
            if room_type != "dm" {
                let sid = parsed.get("server_id").and_then(|s| s.as_str()).unwrap_or("");
                let ch_id = parsed.get("channel_id").and_then(|s| s.as_str());
                if sid.is_empty() || !state.db.member_has_permission(sid, user_id, crate::db::PERM_USE_SOUNDBOARD, ch_id) {
                    return;
                }
            }
            if room_type == "dm" {
                // DM call: relay to the DM voice room
                let dm_ch = parsed.get("dm_channel_id").and_then(|s| s.as_str()).unwrap_or("").to_string();
                if !dm_ch.is_empty() {
                    let target_room: Option<String> = {
                        let rooms_lock = state.voice_rooms.read().unwrap();
                        rooms_lock.iter()
                            .find(|(_, rm)| rm.room_type == "dm" && rm.dm_channel_id.as_deref() == Some(dm_ch.as_str()))
                            .map(|(rid, _)| rid.clone())
                    };
                    if let Some(room_id) = target_room {
                        // Stamp authoritative start time for late-join offset math
                        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
                        let replaced_token = {
                            let mut rooms = state.voice_rooms.write().unwrap();
                            if let Some(room) = rooms.get_mut(&room_id) {
                                room.current_soundboards.insert(user_id.to_string(), SoundboardPlayback {
                                    user_id: user_id.to_string(),
                                    clip_id: parsed.get("clip_id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                                    temp_token: parsed.get("temp_token").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                                    started_at_ms: now_ms,
                                    duration_ms: parsed.get("duration_ms").and_then(|v| v.as_i64()).unwrap_or(0),
                                    r#loop: parsed.get("loop").and_then(|v| v.as_bool()).unwrap_or(false),
                                }).map(|old| old.temp_token)
                            } else {
                                None
                            }
                        };
                        // A player re-playing replaced their OWN previous slot —
                        // free that clip's temp audio so it doesn't leak.
                        if let Some(tok) = replaced_token {
                            if !tok.is_empty() {
                                crate::handlers::remove_sb_temp_play(state, &tok);
                            }
                        }
                        if let Some(obj) = parsed.as_object_mut() {
                            obj.insert("play_start_ms".to_string(), serde_json::json!(now_ms));
                            obj.insert("server_now_ms".to_string(), serde_json::json!(now_ms));
                            // The sender is always the authenticated user — never
                            // trust a client-supplied user_id (it would let one
                            // user impersonate another on stop/disable paths).
                            obj.insert("user_id".to_string(), serde_json::json!(user_id));
                        }
                        voice_broadcast(state, &room_id, &parsed).await;
                    }
                }
            } else {
                // Server voice: relay to the server voice room
                // Use channel_id to find the exact room (a server can have multiple voice channels)
                let sid = parsed.get("server_id").and_then(|s| s.as_str()).unwrap_or("");
                let ch_id = parsed.get("channel_id").and_then(|s| s.as_str()).unwrap_or("");
                if !sid.is_empty() {
                    let target_room: Option<String> = {
                        let rooms_lock = state.voice_rooms.read().unwrap();
                        rooms_lock.iter()
                            .find(|(_, rm)| {
                                rm.room_type == "server"
                                    && rm.server_id.as_deref() == Some(sid)
                                    && (ch_id.is_empty() || rm.channel_id.as_deref() == Some(ch_id))
                            })
                            .map(|(rid, _)| rid.clone())
                    };
                    if let Some(room_id) = target_room {
                        // Check if this user's soundboard is disabled by the server owner
                        let sender_disabled = state.db.is_soundboard_user_disabled(sid, user_id).unwrap_or(false);
                        if !sender_disabled {
                            // Store current playback state for late-join sync.
                            // The server's clock stamps the start so late joiners
                            // compute the offset against one authoritative clock.
                            let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
                            let duration_ms = parsed.get("duration_ms").and_then(|v| v.as_i64()).unwrap_or(0);
                            let looping = parsed.get("loop").and_then(|v| v.as_bool()).unwrap_or(false);
                            let replaced_token = {
                                let mut rooms = state.voice_rooms.write().unwrap();
                                if let Some(room) = rooms.get_mut(&room_id) {
                                    room.current_soundboards.insert(user_id.to_string(), SoundboardPlayback {
                                        user_id: user_id.to_string(),
                                        clip_id: parsed.get("clip_id").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                                        temp_token: parsed.get("temp_token").and_then(|s| s.as_str()).unwrap_or("").to_string(),
                                        started_at_ms: now_ms,
                                        duration_ms: duration_ms,
                                        r#loop: parsed.get("loop").and_then(|v| v.as_bool()).unwrap_or(false),
                                    }).map(|old| old.temp_token)
                                } else {
                                    None
                                }
                            };
                            // Free the previous clip's temp audio (re-play leak).
                            if let Some(tok) = replaced_token {
                                if !tok.is_empty() {
                                    crate::handlers::remove_sb_temp_play(state, &tok);
                                }
                            }
                        // Stamp the authoritative start time + duration into the
                        // relayed message so every receiver computes the same offset.
                        // server_now_ms is the SAME clock as play_start_ms: the
                        // skew-free elapsed math on clients needs both.
                        if let Some(obj) = parsed.as_object_mut() {
                            obj.insert("play_start_ms".to_string(), serde_json::json!(now_ms));
                            obj.insert("server_now_ms".to_string(), serde_json::json!(now_ms));
                            obj.insert("duration_ms".to_string(), serde_json::json!(duration_ms));
                            obj.insert("loop".to_string(), serde_json::json!(looping));
                            // Force the authenticated sender (see the DM branch).
                            obj.insert("user_id".to_string(), serde_json::json!(user_id));
                        }
                        voice_broadcast(state, &room_id, &parsed).await;
                        }
                    }
                }
            }
        }
        "soundboard_stop" => {
            // Relay soundboard stop to all voice room participants
            let room_type = parsed.get("room_type").and_then(|s| s.as_str()).unwrap_or("server");
            if room_type == "dm" {
                let dm_ch = parsed.get("dm_channel_id").and_then(|s| s.as_str()).unwrap_or("").to_string();
                if !dm_ch.is_empty() {
                    let target_room: Option<String> = {
                        let rooms_lock = state.voice_rooms.read().unwrap();
                        rooms_lock.iter()
                            .find(|(_, rm)| rm.room_type == "dm" && rm.dm_channel_id.as_deref() == Some(dm_ch.as_str()))
                            .map(|(rid, _)| rid.clone())
                    };
                    if let Some(room_id) = target_room {
                        // Only the clip's OWNER can stop it: never clear another
                        // user's playback state (late joiners would then sync to
                        // a silent room for a clip that is actually playing).
                        let stopped_token = {
                            let mut rooms = state.voice_rooms.write().unwrap();
                            let mut tok = String::new();
                            if let Some(room) = rooms.get_mut(&room_id) {
                                // Keyed by the sender, so this only ever removes
                                // the sender's OWN slot (never another user's).
                                if let Some(sb) = room.current_soundboards.remove(user_id) {
                                    tok = sb.temp_token;
                                }
                            }
                            tok
                        };
                        if !stopped_token.is_empty() {
                            crate::handlers::remove_sb_temp_play(state, &stopped_token);
                        }
                        // Stamp the authenticated sender so listeners only ever
                        // stop the sender's own clip.
                        if let Some(obj) = parsed.as_object_mut() {
                            obj.insert("user_id".to_string(), serde_json::json!(user_id));
                        }
                        voice_broadcast(state, &room_id, &parsed).await;
                    }
                }
            } else {
                let sid = parsed.get("server_id").and_then(|s| s.as_str()).unwrap_or("");
                let ch_id = parsed.get("channel_id").and_then(|s| s.as_str()).unwrap_or("");
                if !sid.is_empty() {
                    let target_room: Option<String> = {
                        let rooms_lock = state.voice_rooms.read().unwrap();
                        rooms_lock.iter()
                            .find(|(_, rm)| {
                                rm.room_type == "server"
                                    && rm.server_id.as_deref() == Some(sid)
                                    && (ch_id.is_empty() || rm.channel_id.as_deref() == Some(ch_id))
                            })
                            .map(|(rid, _)| rid.clone())
                    };
                        if let Some(room_id) = target_room {
                            // Clear the room's current playback state AND free the
                            // temp audio — but ONLY when the sender is the clip's
                            // actual player. A listener's (or stale) stop must
                            // never wipe the room state, or late joiners would
                            // sync to silence for a clip that is still playing.
                            let stopped_token = {
                                let mut rooms = state.voice_rooms.write().unwrap();
                                let mut tok = String::new();
                                if let Some(room) = rooms.get_mut(&room_id) {
                                    // Only the sender's own slot is removed.
                                    if let Some(sb) = room.current_soundboards.remove(user_id) {
                                        tok = sb.temp_token;
                                    }
                                }
                                tok
                            };
                            if !stopped_token.is_empty() {
                                crate::handlers::remove_sb_temp_play(state, &stopped_token);
                            }
                            // Force the authenticated sender: listeners match the
                            // stop by user_id, so this only stops OUR OWN clip.
                            if let Some(obj) = parsed.as_object_mut() {
                                obj.insert("user_id".to_string(), serde_json::json!(user_id));
                            }
                            voice_broadcast(state, &room_id, &parsed).await;
                        }
                }
            }
        }
        "message_pin" | "message_unpin" => {
            let channel_id = match parsed.get("channel_id").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => return,
            };
            let message_id = match parsed.get("message_id").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => return,
            };
            let server_id = match state.db.get_server_id_for_channel(&channel_id) {
                Ok(id) => id,
                Err(_) => return,
            };
            if !state.db.is_member_of_server(user_id, &server_id).unwrap_or(false) {
                return;
            }
            // Server channels: pinning needs PIN_MESSAGES (the owner always has
            // it; the owner can now hand it to a role instead of moderating
            // every pin themselves).
            if !state.db.member_has_permission(&server_id, user_id, crate::db::PERM_PIN_MESSAGES, Some(&channel_id)) {
                return;
            }
            if msg_type == "message_pin" {
                if state.db.pin_message(&channel_id, &message_id, user_id).is_err() {
                    return;
                }
            } else if state.db.unpin_message(&channel_id, &message_id).is_err() {
                return;
            }
            let outgoing = serde_json::json!({
                "type": if msg_type == "message_pin" { "message_pinned" } else { "message_unpinned" },
                "channel_id": channel_id,
                "message_id": message_id,
                "user_id": user_id,
            });
            match state.db.get_server_members(&server_id) {
                Ok(members) => {
                    state.ws_manager.broadcast_to_users(&members, &outgoing.to_string()).await;
                }
                Err(_) => {}
            }
        }
        "dm_pin" | "dm_unpin" => {
            let dm_channel_id = match parsed.get("dm_channel_id").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => return,
            };
            let message_id = match parsed.get("message_id").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => return,
            };
            if !state.db.is_dm_member(&dm_channel_id, user_id).unwrap_or(false) {
                return;
            }
            if msg_type == "dm_pin" {
                if state.db.pin_dm_message(&dm_channel_id, &message_id, user_id).is_err() {
                    return;
                }
            } else if state.db.unpin_dm_message(&dm_channel_id, &message_id).is_err() {
                return;
            }
            let outgoing = serde_json::json!({
                "type": if msg_type == "dm_pin" { "dm_pinned" } else { "dm_unpinned" },
                "dm_channel_id": dm_channel_id,
                "message_id": message_id,
                "user_id": user_id,
            });
            match state.db.get_dm_members(&dm_channel_id) {
                Ok(members) => {
                    state.ws_manager.broadcast_to_users(&members, &outgoing.to_string()).await;
                }
                Err(_) => {}
            }
        }
        "message_reaction" | "dm_reaction" => {
            // E2E-encrypted reaction toggle. The emoji payload arrives encrypted
            // with the channel/DM key (the server never sees it); emoji_token is
            // a blind HMAC used only to dedupe + toggle. Reacting again with the
            // same emoji removes it. Reactor is always the authed user.
            let message_id = match parsed.get("message_id").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => return,
            };
            let emoji_token = match parsed.get("emoji_token").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => return,
            };
            let encrypted_emoji = match parsed.get("encrypted_emoji").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => return,
            };
            let emoji_nonce = match parsed.get("emoji_nonce").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => return,
            };
            if msg_type == "message_reaction" {
                let channel_id = match parsed.get("channel_id").and_then(|c| c.as_str()) {
                    Some(c) => c.to_string(),
                    None => return,
                };
                let server_id = match state.db.get_server_id_for_channel(&channel_id) {
                    Ok(id) => id,
                    Err(_) => return,
                };
                if !state.db.is_member_of_server(user_id, &server_id).unwrap_or(false) {
                    return;
                }
                if !state.db.member_has_permission(&server_id, user_id, crate::db::PERM_ADD_REACTIONS, Some(&channel_id)) {
                    return;
                }
                if state.db.get_message_channel_id(&message_id).ok().as_deref() != Some(channel_id.as_str()) {
                    return;
                }
                let added = match state.db.add_reaction(&message_id, user_id, &emoji_token, &encrypted_emoji, &emoji_nonce) {
                    Ok(a) => a,
                    Err(_) => false,
                };
                if !added {
                    // Already reacted with this emoji → toggle it off.
                    let _ = state.db.remove_reaction(&message_id, user_id, &emoji_token);
                }
                let outgoing = serde_json::json!({
                    "type": if added { "reaction_added" } else { "reaction_removed" },
                    "channel_id": channel_id,
                    "message_id": message_id,
                    "user_id": user_id,
                    "emoji_token": emoji_token,
                    "encrypted_emoji": encrypted_emoji,
                    "emoji_nonce": emoji_nonce,
                });
                match state.db.get_server_members(&server_id) {
                    Ok(members) => { state.ws_manager.broadcast_to_users(&members, &outgoing.to_string()).await; }
                    Err(_) => {}
                }
            } else {
                let dm_channel_id = match parsed.get("dm_channel_id").and_then(|c| c.as_str()) {
                    Some(c) => c.to_string(),
                    None => return,
                };
                if !state.db.is_dm_member(&dm_channel_id, user_id).unwrap_or(false) {
                    return;
                }
                if state.db.get_dm_message_channel_id(&message_id).ok().as_deref() != Some(dm_channel_id.as_str()) {
                    return;
                }
                let added = match state.db.add_dm_reaction(&message_id, user_id, &emoji_token, &encrypted_emoji, &emoji_nonce) {
                    Ok(a) => a,
                    Err(_) => false,
                };
                if !added {
                    let _ = state.db.remove_dm_reaction(&message_id, user_id, &emoji_token);
                }
                let outgoing = serde_json::json!({
                    "type": if added { "dm_reaction_added" } else { "dm_reaction_removed" },
                    "dm_channel_id": dm_channel_id,
                    "message_id": message_id,
                    "user_id": user_id,
                    "emoji_token": emoji_token,
                    "encrypted_emoji": encrypted_emoji,
                    "emoji_nonce": emoji_nonce,
                });
                match state.db.get_dm_members(&dm_channel_id) {
                    Ok(members) => { state.ws_manager.broadcast_to_users(&members, &outgoing.to_string()).await; }
                    Err(_) => {}
                }
            }
        }
        "poll_vote" | "dm_poll_vote" => {
            // E2E-encrypted poll vote. The poll question/options live inside the
            // message's encrypted content; each vote arrives as ONLY a blind
            // HMAC option token (keyed by the conversation key, never seen by
            // the server) plus the voter. Sending the same token again toggles
            // the vote off; `remove_option_tokens` (single-choice switch) drops
            // the voter's existing votes on other options in the same request.
            // The server relays the token and voter id to members for live
            // tally updates; clients match tokens to option ids themselves.
            let message_id = match parsed.get("message_id").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => return,
            };
            let option_token = match parsed.get("option_token").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => return,
            };
            let remove_tokens: Vec<String> = parsed
                .get("remove_option_tokens")
                .and_then(|t| t.as_array())
                .map(|arr| arr.iter().filter_map(|v| v.as_str().map(|s| s.to_string())).take(50).collect())
                .unwrap_or_default();

            if msg_type == "poll_vote" {
                let channel_id = match parsed.get("channel_id").and_then(|c| c.as_str()) {
                    Some(c) => c.to_string(),
                    None => return,
                };
                let server_id = match state.db.get_server_id_for_channel(&channel_id) {
                    Ok(id) => id,
                    Err(_) => return,
                };
                if !state.db.is_member_of_server(user_id, &server_id).unwrap_or(false) {
                    return;
                }
                if !state.db.member_has_permission(&server_id, user_id, crate::db::PERM_VIEW_CHANNEL, Some(&channel_id)) {
                    return;
                }
                if state.db.get_message_channel_id(&message_id).ok().as_deref() != Some(channel_id.as_str()) {
                    return;
                }
                // Single-choice switch: remove the voter's votes on the other
                // options first (each removal is broadcast below).
                let _ = state.db.remove_poll_votes(&message_id, user_id, &remove_tokens);
                let added = match state.db.add_poll_vote(&message_id, user_id, &option_token) {
                    Ok(a) => a,
                    Err(_) => false,
                };
                if !added {
                    // Already voted this option → toggle it off.
                    let _ = state.db.remove_poll_vote(&message_id, user_id, &option_token);
                }
                let outgoing = serde_json::json!({
                    "type": if added { "poll_vote_added" } else { "poll_vote_removed" },
                    "channel_id": channel_id,
                    "message_id": message_id,
                    "user_id": user_id,
                    "option_token": option_token,
                });
                let members = match state.db.get_server_members(&server_id) {
                    Ok(m) => m,
                    Err(_) => Vec::new(),
                };
                // Broadcast the removals (single-choice switch) first.
                for rt in &remove_tokens {
                    let rm_msg = serde_json::json!({
                        "type": "poll_vote_removed",
                        "channel_id": channel_id,
                        "message_id": message_id,
                        "user_id": user_id,
                        "option_token": rt,
                    });
                    state.ws_manager.broadcast_to_users(&members, &rm_msg.to_string()).await;
                }
                state.ws_manager.broadcast_to_users(&members, &outgoing.to_string()).await;
            } else {
                let dm_channel_id = match parsed.get("dm_channel_id").and_then(|c| c.as_str()) {
                    Some(c) => c.to_string(),
                    None => return,
                };
                if !state.db.is_dm_member(&dm_channel_id, user_id).unwrap_or(false) {
                    return;
                }
                if state.db.get_dm_message_channel_id(&message_id).ok().as_deref() != Some(dm_channel_id.as_str()) {
                    return;
                }
                let _ = state.db.remove_dm_poll_votes(&message_id, user_id, &remove_tokens);
                let added = match state.db.add_dm_poll_vote(&message_id, user_id, &option_token) {
                    Ok(a) => a,
                    Err(_) => false,
                };
                if !added {
                    let _ = state.db.remove_dm_poll_vote(&message_id, user_id, &option_token);
                }
                let outgoing = serde_json::json!({
                    "type": if added { "dm_poll_vote_added" } else { "dm_poll_vote_removed" },
                    "dm_channel_id": dm_channel_id,
                    "message_id": message_id,
                    "user_id": user_id,
                    "option_token": option_token,
                });
                let members = match state.db.get_dm_members(&dm_channel_id) {
                    Ok(m) => m,
                    Err(_) => Vec::new(),
                };
                for rt in &remove_tokens {
                    let rm_msg = serde_json::json!({
                        "type": "dm_poll_vote_removed",
                        "dm_channel_id": dm_channel_id,
                        "message_id": message_id,
                        "user_id": user_id,
                        "option_token": rt,
                    });
                    state.ws_manager.broadcast_to_users(&members, &rm_msg.to_string()).await;
                }
                state.ws_manager.broadcast_to_users(&members, &outgoing.to_string()).await;
            }
        }
        "message_ack" | "dm_message_ack" => {
            // E2E per-message delivery/read receipt. The ack carries a blind
            // HMAC token (HMAC-SHA256(conversationKey, "ack-v1:" + message_id))
            // proving the acker can decrypt the conversation — the host never
            // holds the key, so it can never forge a receipt for ciphertext it
            // can't read. `status` ('delivered' | 'read') is plaintext metadata
            // the server must record; re-acking upgrades delivered -> read and
            // never downgrades. The event is broadcast so the author's client
            // (and the acker's own other devices) update the checkmark live;
            // clients only render status on messages they sent.
            let message_id = match parsed.get("message_id").and_then(|c| c.as_str()) {
                Some(c) => c.to_string(),
                None => return,
            };
            let status = match parsed.get("status").and_then(|c| c.as_str()) {
                Some("delivered") => "delivered",
                Some("read") => "read",
                _ => return,
            };
            let ack_token = match parsed.get("ack_token").and_then(|c| c.as_str()) {
                Some(t) if t.len() == 64 && t.chars().all(|ch| ch.is_ascii_hexdigit()) => t.to_string(),
                _ => return,
            };

            if msg_type == "message_ack" {
                let channel_id = match parsed.get("channel_id").and_then(|c| c.as_str()) {
                    Some(c) => c.to_string(),
                    None => return,
                };
                let server_id = match state.db.get_server_id_for_channel(&channel_id) {
                    Ok(id) => id,
                    Err(_) => return,
                };
                if !state.db.is_member_of_server(user_id, &server_id).unwrap_or(false) {
                    return;
                }
                if state.db.get_message_channel_id(&message_id).ok().as_deref() != Some(channel_id.as_str()) {
                    return;
                }
                let _ = state.db.record_message_ack(&message_id, user_id, status, &ack_token);
                let outgoing = serde_json::json!({
                    "type": "message_ack",
                    "channel_id": channel_id,
                    "message_id": message_id,
                    "acker_id": user_id,
                    "status": status,
                });
                match state.db.get_server_members(&server_id) {
                    Ok(members) => { state.ws_manager.broadcast_to_users(&members, &outgoing.to_string()).await; }
                    Err(_) => {}
                }
            } else {
                let dm_channel_id = match parsed.get("dm_channel_id").and_then(|c| c.as_str()) {
                    Some(c) => c.to_string(),
                    None => return,
                };
                if !state.db.is_dm_member(&dm_channel_id, user_id).unwrap_or(false) {
                    return;
                }
                if state.db.get_dm_message_channel_id(&message_id).ok().as_deref() != Some(dm_channel_id.as_str()) {
                    return;
                }
                let _ = state.db.record_dm_message_ack(&message_id, user_id, status, &ack_token);
                let outgoing = serde_json::json!({
                    "type": "dm_message_ack",
                    "dm_channel_id": dm_channel_id,
                    "message_id": message_id,
                    "acker_id": user_id,
                    "status": status,
                });
                match state.db.get_dm_members(&dm_channel_id) {
                    Ok(members) => { state.ws_manager.broadcast_to_users(&members, &outgoing.to_string()).await; }
                    Err(_) => {}
                }
            }
        }
        "key_heartbeat" => {
            // Periodic heartbeat: check all servers the user is a member of and
            // re-broadcast key_needed for servers where the user has no key entries
            // but other members do. This ensures recovery even if the initial
            // key_needed WS event was missed (e.g. the responding member was offline).
            if let Ok(servers) = state.db.list_user_servers(user_id) {
                for sv in &servers {
                    if let Ok(keys) = state.db.get_all_server_keys(&sv.id) {
                        let user_has_keys = keys.iter().any(|(uid, _, _, _, _)| uid == user_id);
                        if !user_has_keys && !keys.is_empty() {
                            if let Ok(members) = state.db.get_server_members(&sv.id) {
                                let need_msg = serde_json::json!({
                                    "type": "key_needed",
                                    "server_id": sv.id,
                                    "user_id": user_id,
                                });
                                let _ = state.ws_manager.broadcast_to_users(&members, &need_msg.to_string()).await;

                                // Save pending events for offline members
                                for mid in &members {
                                    if !state.ws_manager.is_user_connected(mid).await {
                                        let _ = state.db.save_pending_event(mid, &sv.id, "key_needed", user_id);
                                    }
                                }
                            }
                        }
                    }
                }
            }
        }
        "ping" => {
            let pong = serde_json::json!({
                "type": "pong"
            });
            state
                .ws_manager
                .broadcast_to_users(&[user_id.to_string()], &pong.to_string())
                .await;
        }
        "groups_changed" => {
            // Relay to all OTHER connections of this user (cross-device sync)
            let device_id = parsed.get("device_id").and_then(|s| s.as_str()).unwrap_or("").to_string();
            let msg = serde_json::json!({
                "type": "groups_changed",
                "device_id": device_id,
            });
            state
                .ws_manager
                .broadcast_to_users_except_device(&[user_id.to_string()], &device_id, &msg.to_string())
                .await;
        }
        "blob_updated" => {
            // Relay to all OTHER connections of this user so they re-fetch the
            // updated key blob (server keys, DM keys, file keys, profiles, etc.)
            let device_id = parsed.get("device_id").and_then(|s| s.as_str()).unwrap_or("").to_string();
            let msg = serde_json::json!({
                "type": "blob_updated",
                "device_id": device_id,
            });
            state
                .ws_manager
                .broadcast_to_users_except_device(&[user_id.to_string()], &device_id, &msg.to_string())
                .await;
        }
        "voice_join" => {
            handle_voice_join(parsed, state, user_id).await;
        }
        "voice_leave" => {
            handle_voice_leave(parsed, state, user_id).await;
        }
        "voice_leave_all" => {
            // Page-load fallback: a fresh page sends this to make sure the user
            // is dropped from every voice room (in case the previous connection's
            // disconnect cleanup never ran — crash, stale socket, server restart).
            // Uses clear_waiting_on_empty=false so persisted DM waiting state
            // survives (the waiting room stays joinable across refreshes).
            // Scoped to THIS device: a kicked/replaced device's page load must
            // never evict the device that replaced it from the room.
            let device_id = parsed.get("device_id").and_then(|d| d.as_str()).unwrap_or("").to_string();
            voice_remove_user_all_for_device(state, user_id, &device_id).await;
        }
        "voice_state" => {
            handle_voice_state(parsed, state, user_id).await;
        }
        "voice_presence_request" => {
            // Client opened a server's channel list — send it the current voice snapshot
            let server_id = parsed.get("server_id").and_then(|s| s.as_str()).unwrap_or("").to_string();
            if !server_id.is_empty()
                && state.db.is_member_of_server(user_id, &server_id).unwrap_or(false)
            {
                let msg = voice_presence_json(state, &server_id);
                send_to_user(state, user_id, &msg).await;
            }
        }
        "voice_signal" => {
            handle_voice_signal(parsed, state, user_id).await;
        }
        "voice_control" => {
            handle_voice_control(parsed, state, user_id).await;
        }
        "voice_media_relay" => {
            handle_voice_media_relay(parsed, state, user_id).await;
        }
        "dm_call_ring" => {
            handle_dm_call_ring(parsed, state, user_id).await;
        }
        "dm_call_waiting" => {
            handle_dm_call_waiting(parsed, state, user_id).await;
        }
        "dm_call_end" => {
            handle_dm_call_end(parsed, state, user_id).await;
        }
        _ => {}
    }
}

async fn handle_voice_join(
    parsed: serde_json::Value,
    state: &Arc<AppState>,
    user_id: &str,
) {
    let room_type = match parsed.get("room_type").and_then(|t| t.as_str()) {
        Some(t) if t == "server" || t == "dm" => t.to_string(),
        _ => return,
    };
    let channel_id = parsed.get("channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let server_id = parsed.get("server_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let dm_channel_id = parsed.get("dm_channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    // Device id of the connection that is joining (from the client's
    // e2e_device_key). Used to kick the user's OLD devices and to scope the
    // join confirmation + later leave/disconnect cleanup to this device.
    let device_id = parsed.get("device_id").and_then(|d| d.as_str()).unwrap_or("").to_string();

    // Validate membership / channel type
    if room_type == "server" {
        if channel_id.is_empty() || server_id.is_empty() {
            return;
        }
        if !state.db.is_member_of_server(user_id, &server_id).unwrap_or(false) {
            return;
        }
        // Verify the channel belongs to this server and is a voice channel
        if let Ok(cid) = state.db.get_server_id_for_channel(&channel_id) {
            if cid != server_id {
                return;
            }
        } else {
            return;
        }
        if let Ok(ctype) = state.db.get_channel_type(&channel_id) {
            if ctype != "voice" {
                return;
            }
        } else {
            return;
        }
        // Roles can deny CONNECT_VOICE per voice channel/category.
        if !state.db.member_has_permission(&server_id, user_id, crate::db::PERM_CONNECT_VOICE, Some(&channel_id)) {
            return;
        }
    } else {
        if dm_channel_id.is_empty() {
            return;
        }
        if !state.db.is_dm_member(&dm_channel_id, user_id).unwrap_or(false) {
            return;
        }
    }

    let room_id = voice_room_id(&room_type, &channel_id, &dm_channel_id);
    let username = state
        .db
        .get_user_by_id(user_id)
        .map(|u| u.username)
        .unwrap_or_else(|_| "?".to_string());
    let is_owner = room_type == "server"
        && state.db.is_server_owner(user_id, &server_id).unwrap_or(false);
    let role_position = if room_type == "server" {
        state.db.member_role_position(&server_id, user_id).unwrap_or(0)
    } else {
        0
    };
    let (force_muted, force_deafened) = if room_type == "server" {
        state.db.get_voice_sanction(&server_id, user_id).unwrap_or((false, false))
    } else {
        (false, false)
    };

    let member = VoiceMember {
        user_id: user_id.to_string(),
        username: username.clone(),
        muted: force_muted || force_deafened,
        deafened: force_deafened,
        camera: false,
        screen: false,
        speaking: false,
        force_muted,
        force_deafened,
        is_owner,
        role_position,
        camera_track_id: None,
        screen_track_id: None,
        recv_camera_res: 0,
        recv_screen_res: 0,
        manual_video_load: false,
        loaded_feeds: Vec::new(),
        unloaded_feeds: Vec::new(),
        audio_mode: "auto".to_string(),
        video_mode: "auto".to_string(),
        recv_audio_quality: "medium".to_string(),
        send_audio_quality: "medium".to_string(),
        recv_screen_audio_quality: "medium".to_string(),
        send_screen_audio_quality: "medium".to_string(),
        camera_mode: "auto".to_string(),
        screen_mode: "auto".to_string(),
    };

    // All room mutation happens inside a scope so the write guard (and its &mut
    // borrow) drop before any .await below — the guard is not Send.
    let (joined, replaced) = {
        let mut rooms = match state.voice_rooms.write() {
            Ok(r) => r,
            Err(_) => return,
        };

        let create_session = !rooms.contains_key(&room_id);
        let room = rooms.entry(room_id.clone()).or_insert_with(|| VoiceRoom {
            room_type: room_type.clone(),
            server_id: if server_id.is_empty() { None } else { Some(server_id.clone()) },
            channel_id: if channel_id.is_empty() { None } else { Some(channel_id.clone()) },
            dm_channel_id: if dm_channel_id.is_empty() { None } else { Some(dm_channel_id.clone()) },
            session_id: None,
            members: HashMap::new(),
            device_map: HashMap::new(),
            current_soundboards: HashMap::new(),
        });
        // If this user is already in the room from ANOTHER device, the old
        // device(s) must be kicked before the new device is admitted — "last
        // device wins" (like Discord killing the other session).
        let replaced = room.members.contains_key(user_id);
        room.device_map.insert(user_id.to_string(), device_id.clone());
        room.members.insert(user_id.to_string(), member);
        if create_session {
            if let Ok(sid) = state.db.create_voice_session(&channel_id) {
                room.session_id = Some(sid);
            }
        }
        if let Some(sid) = room.session_id.clone() {
            let _ = state.db.add_voice_participant(&sid, user_id);
        }

        let members_json: Vec<serde_json::Value> = room
            .members
            .values()
            .map(voice_member_json)
            .collect();
        // Include currently playing soundboard clip for late-join sync.
        // server_now_ms is stamped NOW (same clock as play_start_ms) so the
        // joiner computes a skew-free elapsed time: mixing the server's clock
        // with the client's made skewed clients skip still-playing clips.
        let now_ms = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_millis() as i64;
        let current_sbs_json: Vec<serde_json::Value> = room.current_soundboards.values().map(|sb| {
            serde_json::json!({
                "user_id": sb.user_id,
                "clip_id": sb.clip_id,
                "temp_token": sb.temp_token,
                "play_start_ms": sb.started_at_ms,
                "server_now_ms": now_ms,
                "duration_ms": sb.duration_ms,
                "loop": sb.r#loop,
            })
        }).collect();
        // Kept for any older cached client that only understands ONE clip.
        let singular_sb_fallback = current_sbs_json.last().cloned();
        let joined = serde_json::json!({
            "type": "voice_joined",
            "room_type": room_type,
            "server_id": if server_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(server_id.clone()) },
            "channel_id": if channel_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(channel_id.clone()) },
            "dm_channel_id": if dm_channel_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(dm_channel_id.clone()) },
            "members": members_json,
            "is_owner": is_owner,
            "force_muted": force_muted,
            "force_deafened": force_deafened,
            // New clients sync EVERY still-playing clip; the singular field is
            // the backward-compatible fallback for older cached clients.
            "current_soundboards": current_sbs_json,
            "current_soundboard": singular_sb_fallback,
        });
        (joined, replaced)
    };

    // The user's OLD device(s) are still connected and in the room — kick them
    // BEFORE any join broadcast so they tear down first. The new device (this
    // one) is excluded by device_id. (An empty device_id — a client without a
    // device key, which shouldn't happen since e2e_device_key is created at
    // login — can't be excluded, so skip the kick rather than kicking self.)
    if replaced && !device_id.is_empty() {
        let kick_msg = serde_json::json!({
            "type": "voice_kicked",
            "reason": "replaced",
            "room_type": room_type,
            "channel_id": channel_id,
            "dm_channel_id": dm_channel_id,
        });
        state
            .ws_manager
            .broadcast_to_users_except_device(&[user_id.to_string()], &device_id, &kick_msg.to_string())
            .await;
        // Tell the OTHER members to drop their stale peer for this user (the
        // old device is being torn down). Without this they keep the old peer
        // and the new device's signals land on a dead connection.
        let other_member_ids: Vec<String> = {
            match state.voice_rooms.read() {
                Ok(r) => r.get(&room_id)
                    .map(|rm| rm.members.keys().filter(|u| **u != user_id).cloned().collect())
                    .unwrap_or_default(),
                Err(_) => Vec::new(),
            }
        };
        if !other_member_ids.is_empty() {
            let replaced_msg = serde_json::json!({
                "type": "voice_member_replaced",
                "user_id": user_id,
                "room_type": room_type,
                "channel_id": channel_id,
                "dm_channel_id": dm_channel_id,
            });
            state
                .ws_manager
                .broadcast_to_users(&other_member_ids, &replaced_msg.to_string())
                .await;
        }
    }

    // Notify everyone already in the room about the new member list (including self)
    let members_vec: Vec<serde_json::Value> = {
        match state.voice_rooms.read() {
            Ok(r) => r.get(&room_id).map(|rm| rm.members.values().map(voice_member_json).collect::<Vec<_>>()).unwrap_or_default(),
            Err(_) => Vec::new(),
        }
    };
    // A DM call is now connected when both members are in the room — clear any
    // persisted waiting state so the banner disappears and the call is live.
    if room_type == "dm" && members_vec.len() >= 2 {
        let _ = state.db.clear_dm_call_waiting(&dm_channel_id);
    }
    // A user ALONE in a DM room IS the waiting state (they called and are
    // waiting, or they came back to the waiting room after a refresh). Persist
    // it so the indicator survives page refreshes. Silent on purpose: when a
    // caller first joins, the callee must keep ringing (the 30s dm_call_waiting
    // broadcast is what flips their bar), so we never broadcast from here —
    // the other side picks the state up via the conversation list.
    if room_type == "dm" && members_vec.len() == 1 {
        let _ = state.db.set_dm_call_waiting(&dm_channel_id, user_id);
    }
    let members_msg = serde_json::json!({
        "type": "voice_members",
        "members": members_vec,
    });
    // Drop the write lock before awaiting sends (lock guard isn't Send).
    voice_broadcast(state, &room_id, &members_msg).await;

    // The join confirmation goes ONLY to the device that joined. A kicked old
    // device of the same user must never see it (it would re-join with stale
    // state).
    if !device_id.is_empty() {
        state
            .ws_manager
            .broadcast_to_device(user_id, &device_id, &joined.to_string())
            .await;
    } else {
        send_to_user(state, user_id, &joined).await;
    }

    // Tell every server member who is now in each voice channel (so the channel
    // list shows members/activity even for users who aren't in the room).
    if room_type == "server" && !server_id.is_empty() {
        voice_broadcast_server_presence(state, &server_id).await;
    }
}

async fn handle_voice_leave(
    parsed: serde_json::Value,
    state: &Arc<AppState>,
    user_id: &str,
) {
    let room_type = parsed.get("room_type").and_then(|t| t.as_str()).unwrap_or("server").to_string();
    let channel_id = parsed.get("channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let dm_channel_id = parsed.get("dm_channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let device_id = parsed.get("device_id").and_then(|d| d.as_str()).unwrap_or("").to_string();
    let room_id = voice_room_id(&room_type, &channel_id, &dm_channel_id);
    // Only the device that CURRENTLY occupies the room may leave it. A stale
    // (kicked/replaced) device's explicit leave must not evict the device that
    // replaced it.
    let is_occupant = {
        let rooms = match state.voice_rooms.read() {
            Ok(r) => r,
            Err(_) => return,
        };
        match rooms.get(&room_id) {
            Some(room) => match room.device_map.get(user_id) {
                Some(d) => *d == device_id,
                None => device_id.is_empty(),
            },
            None => true, // room absent — nothing to remove anyway
        }
    };
    if is_occupant {
        voice_remove_from_room(state, &room_id, user_id, true).await;
    }
}

/// Remove a user from a voice room. `clear_waiting_on_empty` is true for an
/// explicit `voice_leave` (an empty room means the call is abandoned) and false
/// for a WS disconnect (a page refresh must keep the persisted waiting state).
async fn voice_remove_from_room(state: &Arc<AppState>, room_id: &str, user_id: &str, clear_waiting_on_empty: bool) {
    let (empty, is_dm, dm_channel_id, server_id, remaining_members) = {
        let mut rooms = match state.voice_rooms.write() {
            Ok(r) => r,
            Err(_) => return,
        };
        let mut empty = false;
        let mut is_dm = false;
        let mut dm_channel_id = String::new();
        let mut server_id = String::new();
        let mut remaining_members = Vec::new();
        if let Some(room) = rooms.get_mut(room_id) {
            room.members.remove(user_id);
            room.device_map.remove(user_id);
            if let Some(sid) = room.session_id.clone() {
                let _ = state.db.remove_voice_participant(&sid, user_id);
            }
            is_dm = room.room_type == "dm";
            dm_channel_id = room.dm_channel_id.clone().unwrap_or_default();
            server_id = room.server_id.clone().unwrap_or_default();
            empty = room.members.is_empty();
            if empty {
                if let Some(sid) = room.session_id.clone() {
                    let _ = state.db.end_voice_session(&sid);
                }
                rooms.remove(room_id);
            } else {
                remaining_members = room.members.values().map(voice_member_json).collect::<Vec<_>>();
            }
        }
        (empty, is_dm, dm_channel_id, server_id, remaining_members)
    };

    // Channel-list presence must update even when the room empties (member list clears)
    if !is_dm && !server_id.is_empty() {
        voice_broadcast_server_presence(state, &server_id).await;
    }

    if empty {
        if !is_dm {
            return;
        }
        if clear_waiting_on_empty {
            // Explicit leave: the call is abandoned — clear persisted waiting
            // and notify any remaining online members that the call ended.
            let _ = state.db.clear_dm_call_waiting(&dm_channel_id);
            if let Ok(members) = state.db.get_dm_members(&dm_channel_id) {
                let others: Vec<String> = members.into_iter().filter(|m| m != user_id).collect();
                let msg = serde_json::json!({
                    "type": "dm_call_end",
                    "dm_channel_id": dm_channel_id,
                });
                state.ws_manager.broadcast_to_users(&others, &msg.to_string()).await;
            }
        } else {
            // Connection drop (page refresh, tab close, network blip). A
            // refresh re-joins the waiting room within seconds, so give it a
            // grace window before concluding nobody is waiting anymore. If the
            // room is STILL empty after the window (the tab really closed, or
            // the connection died for good), clear the persisted marker so the
            // other side's waiting indicator disappears instead of lingering.
            let state2 = state.clone();
            let dm2 = dm_channel_id.to_string();
            let room2 = room_id.to_string();
            let leaver = user_id.to_string();
            let grace_secs = state.config.voice_wait_grace_secs;
            tokio::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(grace_secs)).await;
                let still_empty = match state2.voice_rooms.read() {
                    Ok(r) => !r.contains_key(&room2),
                    Err(_) => true,
                };
                if still_empty {
                    let _ = state2.db.clear_dm_call_waiting(&dm2);
                    if let Ok(members) = state2.db.get_dm_members(&dm2) {
                        let others: Vec<String> = members.into_iter().filter(|m| m != &leaver).collect();
                        let msg = serde_json::json!({
                            "type": "dm_waiting_cleared",
                            "dm_channel_id": dm2,
                        });
                        state2.ws_manager.broadcast_to_users(&others, &msg.to_string()).await;
                    }
                }
            });
        }
        return;
    }

    // If the user who is leaving was playing a soundboard clip, clear the
    // room's current playback state AND tell the remaining members to stop
    // it. Per spec: "if someone leaves it stops just for them and the sound
    // keeps playing to all others" — that only applies to LISTENERS leaving.
    // When the PLAYER leaves, nobody keeps playing it, so everyone stops.
    let leaver_sb_token = {
        let mut rooms = match state.voice_rooms.write() {
            Ok(r) => r,
            Err(_) => return,
        };
        match rooms.get_mut(room_id) {
            // Only the leaver's OWN playback slot is dropped; everyone else's
            // keeps playing for the members who stay.
            Some(room) => room.current_soundboards.remove(user_id).map(|sb| sb.temp_token),
            None => None,
        }
    };
    let leaver_was_playing = leaver_sb_token.is_some();
    if let Some(tok) = leaver_sb_token {
        if !tok.is_empty() {
            crate::handlers::remove_sb_temp_play(state, &tok);
        }
    }

    // Broadcast leave + updated member list to remaining members (lock already dropped)
    let leave_msg = serde_json::json!({
        "type": "voice_member_leave",
        "user_id": user_id,
    });
    voice_broadcast(state, room_id, &leave_msg).await;
    if leaver_was_playing {
        // The player themselves left — their sound dies for everyone else too.
        let stop_msg = serde_json::json!({
            "type": "soundboard_stop",
            "user_id": user_id,
            "reason": "player_left",
        });
        voice_broadcast(state, room_id, &stop_msg).await;
        // Also broadcast to ALL connections of this user (all devices).
        // This stops the sound on other devices of the same account that
        // are NOT in the voice room — without this they keep playing.
        state
            .ws_manager
            .broadcast_to_users(&[user_id.to_string()], &stop_msg.to_string())
            .await;
    }
    let members_msg = serde_json::json!({
        "type": "voice_members",
        "members": remaining_members,
    });
    voice_broadcast(state, room_id, &members_msg).await;
    // DM calls: if the room_type is dm and one side leaves, the call does NOT
    // close — the remaining participant is flipped to the waiting state so the
    // leaver can rejoin (mirrors the 30s-unanswered flow). The room stays alive
    // until the remaining side leaves too. The remaining participant is ALSO
    // persisted as the waiting user so the state survives page refreshes.
    if is_dm {
        if let Some(rem) = remaining_members.first().and_then(|m| m.get("user_id")).and_then(|v| v.as_str()) {
            let _ = state.db.set_dm_call_waiting(&dm_channel_id, rem);
        }
        let wait_msg = serde_json::json!({
            "type": "dm_call_waiting",
            "partner_id": user_id,
            "dm_channel_id": dm_channel_id,
        });
        voice_broadcast(state, room_id, &wait_msg).await;
    }
}

/// Periodic safety net: clear DM-call waiting markers whose owner is gone for
/// longer than the grace window — covers crashes / network loss where no WS
/// disconnect event ever fired (the per-disconnect grace task is the primary
/// path; this sweep backstops it). Only touches rows OLDER than the grace
/// period, so a mid-grace refresh (which re-joins and refreshes the marker)
/// is never cleared.
pub async fn sweep_stale_waiting(state: &Arc<AppState>) {
    let grace = state.config.voice_wait_grace_secs;
    let stale = match state.db.list_stale_dm_call_waiting(grace as i64) {
        Ok(s) => s,
        Err(_) => return,
    };
    for (dm_id, waiting_uid) in stale {
        // If the waiting user is still connected AND still in the room, they
        // are genuinely waiting — leave the marker alone (even if it has been
        // sitting there for hours).
        if state.ws_manager.is_user_connected(&waiting_uid).await {
            let room_id = voice_room_id("dm", "", &dm_id);
            let in_room = match state.voice_rooms.read() {
                Ok(r) => r
                    .get(&room_id)
                    .map(|rm| rm.members.contains_key(&waiting_uid))
                    .unwrap_or(false),
                Err(_) => false,
            };
            if in_room {
                continue;
            }
        }
        // The waiter is gone — clear the marker and tell the other member so
        // their indicator disappears without a reload.
        let _ = state.db.clear_dm_call_waiting(&dm_id);
        if let Ok(members) = state.db.get_dm_members(&dm_id) {
            let others: Vec<String> = members.into_iter().filter(|m| *m != waiting_uid).collect();
            let msg = serde_json::json!({
                "type": "dm_waiting_cleared",
                "dm_channel_id": dm_id,
            });
            state.ws_manager.broadcast_to_users(&others, &msg.to_string()).await;
        }
    }
}

/// Disappearing-message sweeper: shred every message whose `expires_at` has
/// passed and tell the conversation members so clients remove it live. The
/// delete cascades to search tokens, reactions, poll votes, acks, and pins
/// (message_id FKs) and shreds any attached file record + chunks — after this
/// runs, neither the ciphertext nor the file exists on the host.
pub async fn sweep_expired_messages(state: &Arc<AppState>) {
    let now = Utc::now().format("%Y-%m-%dT%H:%M:%S%.6fZ").to_string();
    // Channel messages.
    match state.db.list_expired_messages(&now) {
        Ok(expired) => {
            for (message_id, channel_id, _file) in expired {
                if state.db.shred_message(&message_id).is_err() {
                    continue;
                }
                if let Ok(server_id) = state.db.get_server_id_for_channel(&channel_id) {
                    let msg = serde_json::json!({
                        "type": "message_expired",
                        "channel_id": channel_id,
                        "message_id": message_id,
                    });
                    if let Ok(members) = state.db.get_server_members(&server_id) {
                        state.ws_manager.broadcast_to_users(&members, &msg.to_string()).await;
                    }
                }
            }
        }
        Err(e) => tracing::warn!("Expired-message sweep (channel) failed: {}", e),
    }
    // DM messages.
    match state.db.list_expired_dm_messages(&now) {
        Ok(expired) => {
            for (message_id, dm_channel_id, _file) in expired {
                if state.db.shred_dm_message(&message_id).is_err() {
                    continue;
                }
                let msg = serde_json::json!({
                    "type": "dm_message_expired",
                    "dm_channel_id": dm_channel_id,
                    "message_id": message_id,
                });
                if let Ok(members) = state.db.get_dm_members(&dm_channel_id) {
                    state.ws_manager.broadcast_to_users(&members, &msg.to_string()).await;
                }
            }
        }
        Err(e) => tracing::warn!("Expired-message sweep (dm) failed: {}", e),
    }
}

/// End a DM call unconditionally (used when two users unfriend each other):
/// drop the voice room, clear the persisted waiting state, and tell both DM
/// members so their clients tear down the call UI (the DM itself is gone, so
/// the call must not linger — nobody can ever join it again). `members` must
/// be captured BEFORE the DM rows are deleted (remove_friend deletes
/// dm_members, which would make get_dm_members return nobody to notify).
pub async fn end_dm_call_between(state: &Arc<AppState>, dm_channel_id: &str, members: &[String]) {
    let room_id = voice_room_id("dm", "", dm_channel_id);
    {
        let mut rooms = match state.voice_rooms.write() {
            Ok(r) => r,
            Err(_) => return,
        };
        if let Some(room) = rooms.remove(&room_id) {
            if let Some(sid) = room.session_id {
                let _ = state.db.end_voice_session(&sid);
            }
        }
    }
    let _ = state.db.clear_dm_call_waiting(dm_channel_id);
    if !members.is_empty() {
        let msg = serde_json::json!({
            "type": "dm_call_end",
            "dm_channel_id": dm_channel_id,
            "reason": "ended",
        });
        state.ws_manager.broadcast_to_users(members, &msg.to_string()).await;
    }
}

async fn handle_voice_state(
    parsed: serde_json::Value,
    state: &Arc<AppState>,
    user_id: &str,
) {
    let room_type = parsed.get("room_type").and_then(|t| t.as_str()).unwrap_or("server").to_string();
    let channel_id = parsed.get("channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let dm_channel_id = parsed.get("dm_channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let room_id = voice_room_id(&room_type, &channel_id, &dm_channel_id);

    let muted = parsed.get("muted").and_then(|m| m.as_bool()).unwrap_or(false);
    let deafened = parsed.get("deafened").and_then(|m| m.as_bool()).unwrap_or(false);
    let camera = parsed.get("camera").and_then(|m| m.as_bool()).unwrap_or(false);
    let screen = parsed.get("screen").and_then(|m| m.as_bool()).unwrap_or(false);
    let speaking = parsed.get("speaking").and_then(|m| m.as_bool()).unwrap_or(false);
    // Track ids travel with the state so receivers can match tracks to slots.
    let camera_track_id = parsed
        .get("camera_track_id")
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    let screen_track_id = parsed
        .get("screen_track_id")
        .and_then(|s| s.as_str())
        .filter(|s| !s.is_empty())
        .map(|s| s.to_string());
    // Receive-resolution preferences (0 when the client doesn't declare them).
    let recv_camera_res = parsed.get("recv_camera_res").and_then(|v| v.as_i64()).unwrap_or(0);
    let recv_screen_res = parsed.get("recv_screen_res").and_then(|v| v.as_i64()).unwrap_or(0);
    // Manual video-load state (which feeds this viewer has loaded/unloaded).
    let manual_video_load = parsed.get("manual_video_load").and_then(|v| v.as_bool()).unwrap_or(false);
    let loaded_feeds: Vec<String> = parsed
        .get("loaded_feeds")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let unloaded_feeds: Vec<String> = parsed
        .get("unloaded_feeds")
        .and_then(|v| v.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|x| x.as_str().map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    let audio_mode = parsed
        .get("audio_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .to_string();
    let video_mode = parsed
        .get("video_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .to_string();
    let recv_audio_quality = parsed
        .get("recv_audio_quality")
        .and_then(|v| v.as_str())
        .unwrap_or("medium")
        .to_string();
    let send_audio_quality = parsed
        .get("send_audio_quality")
        .and_then(|v| v.as_str())
        .unwrap_or("medium")
        .to_string();
    let recv_screen_audio_quality = parsed
        .get("recv_screen_audio_quality")
        .and_then(|v| v.as_str())
        .unwrap_or("medium")
        .to_string();
    let send_screen_audio_quality = parsed
        .get("send_screen_audio_quality")
        .and_then(|v| v.as_str())
        .unwrap_or("medium")
        .to_string();
    let camera_mode = parsed
        .get("camera_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .to_string();
    let screen_mode = parsed
        .get("screen_mode")
        .and_then(|v| v.as_str())
        .unwrap_or("auto")
        .to_string();

    let (member, server_id) = {
        let mut rooms = match state.voice_rooms.write() {
            Ok(r) => r,
            Err(_) => return,
        };
        let room = match rooms.get_mut(&room_id) {
            Some(r) => r,
            None => return,
        };
        let m = match room.members.get_mut(user_id) {
            Some(m) => m,
            None => return,
        };
        // Sanctions override local state
        m.muted = muted || m.force_muted || m.force_deafened;
        m.deafened = deafened || m.force_deafened;
        m.camera = camera;
        m.screen = screen;
        m.speaking = speaking;
        m.camera_track_id = camera_track_id.clone();
        m.screen_track_id = screen_track_id.clone();
        m.recv_camera_res = recv_camera_res;
        m.recv_screen_res = recv_screen_res;
        m.manual_video_load = manual_video_load;
        m.loaded_feeds = loaded_feeds;
        m.unloaded_feeds = unloaded_feeds;
        m.audio_mode = audio_mode;
        m.video_mode = video_mode;
        m.recv_audio_quality = recv_audio_quality;
        m.send_audio_quality = send_audio_quality;
        m.recv_screen_audio_quality = recv_screen_audio_quality;
        m.send_screen_audio_quality = send_screen_audio_quality;
        m.camera_mode = camera_mode;
        m.screen_mode = screen_mode;
        let server_id = room.server_id.clone().unwrap_or_default();
        (m.clone(), server_id)
    };

    let msg = serde_json::json!({
        "type": "voice_member_update",
        "member": voice_member_json(&member),
    });
    // Lock dropped before awaiting the broadcast
    voice_broadcast(state, &room_id, &msg).await;

    // Keep the channel list's member rows + speaking indicator fresh for
    // every server member, not just the people in the room.
    if room_type == "server" && !server_id.is_empty() {
        voice_broadcast_server_presence(state, &server_id).await;
    }
}

async fn handle_voice_signal(
    parsed: serde_json::Value,
    state: &Arc<AppState>,
    user_id: &str,
) {
    let to_user_id = match parsed.get("to_user_id").and_then(|t| t.as_str()) {
        Some(t) => t.to_string(),
        None => return,
    };
    let signal = match parsed.get("signal") {
        Some(s) => s.clone(),
        None => return,
    };
    let room_type = parsed.get("room_type").and_then(|t| t.as_str()).unwrap_or("server").to_string();
    let channel_id = parsed.get("channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let dm_channel_id = parsed.get("dm_channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let room_id = voice_room_id(&room_type, &channel_id, &dm_channel_id);

    // Rate limit signaling per user (burst of ICE candidates is normal, cap it)
    if !VOICE_SIGNAL_LIMITER.check_and_increment(&format!("voice_signal:{}", user_id), 300, Duration::from_secs(10)) {
        return;
    }

    // Both users must be in the same room
    let allowed = {
        let rooms = match state.voice_rooms.read() {
            Ok(r) => r,
            Err(_) => return,
        };
        match rooms.get(&room_id) {
            Some(room) => room.members.contains_key(user_id) && room.members.contains_key(&to_user_id),
            None => false,
        }
    };
    if !allowed {
        return;
    }

    let relay = serde_json::json!({
        "type": "voice_signal",
        "from_user_id": user_id,
        "signal": signal,
        "room_type": room_type,
        "channel_id": if channel_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(channel_id) },
        "dm_channel_id": if dm_channel_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(dm_channel_id) },
    });
    send_to_user(state, &to_user_id, &relay).await;
}

/// Relay an encrypted video/audio frame from one room member to all others.
/// The frame is opaque ciphertext — the server never decrypts it.
async fn handle_voice_media_relay(
    parsed: serde_json::Value,
    state: &Arc<AppState>,
    user_id: &str,
) {
    let room_type = parsed.get("room_type").and_then(|t| t.as_str()).unwrap_or("server").to_string();
    let channel_id = parsed.get("channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let dm_channel_id = parsed.get("dm_channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let room_id = voice_room_id(&room_type, &channel_id, &dm_channel_id);
    let kind = parsed.get("kind").and_then(|k| k.as_str()).unwrap_or("video").to_string();
    let frame = match parsed.get("frame") {
        Some(f) => f.clone(),
        None => return,
    };

    // Rate limit: 60 frames/sec per user (generous for 5 fps video + audio)
    if !VOICE_SIGNAL_LIMITER.check_and_increment(
        &format!("voice_media:{}", user_id),
        3000,
        Duration::from_secs(10),
    ) {
        return;
    }

    // Sender must be in the room
    let is_member = {
        let rooms = match state.voice_rooms.read() {
            Ok(r) => r,
            Err(_) => return,
        };
        match rooms.get(&room_id) {
            Some(room) => room.members.contains_key(user_id),
            None => false,
        }
    };
    if !is_member {
        return;
    }

    // Drop frames from force-muted users (audio) — video is always relayed
    // so screen shares / cameras are visible regardless of mute state.
    if kind == "audio" {
        let muted = {
            let rooms = match state.voice_rooms.read() {
                Ok(r) => r,
                Err(_) => return,
            };
            rooms.get(&room_id)
                .and_then(|room| room.members.get(user_id))
                .map(|m| m.force_muted || m.muted)
                .unwrap_or(true)
        };
        if muted {
            return;
        }
    }

    let relay = serde_json::json!({
        "type": "voice_media_relay",
        "from_user_id": user_id,
        "kind": kind,
        "frame": frame,
        "room_type": room_type,
        "channel_id": if channel_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(channel_id) },
        "dm_channel_id": if dm_channel_id.is_empty() { serde_json::Value::Null } else { serde_json::Value::String(dm_channel_id) },
    });

    // Collect member IDs (excluding sender) under read lock, then broadcast
    let ids: Vec<String> = {
        let rooms = match state.voice_rooms.read() {
            Ok(r) => r,
            Err(_) => return,
        };
        match rooms.get(&room_id) {
            Some(room) => room.members.keys().filter(|id| id.as_str() != user_id).cloned().collect(),
            None => return,
        }
    };
    state.ws_manager.broadcast_to_users(&ids, &relay.to_string()).await;
}

async fn handle_voice_control(
    parsed: serde_json::Value,
    state: &Arc<AppState>,
    user_id: &str,
) {
    let room_type = parsed.get("room_type").and_then(|t| t.as_str()).unwrap_or("server").to_string();
    let channel_id = parsed.get("channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let server_id = parsed.get("server_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let dm_channel_id = parsed.get("dm_channel_id").and_then(|c| c.as_str()).unwrap_or("").to_string();
    let action = parsed.get("action").and_then(|a| a.as_str()).unwrap_or("").to_string();
    let target_user_id = match parsed.get("target_user_id").and_then(|t| t.as_str()) {
        Some(t) => t.to_string(),
        None => return,
    };
    let room_id = voice_room_id(&room_type, &channel_id, &dm_channel_id);

    // Only server rooms have forceful controls. Moderation actions come from
    // the role permission system: mute/deafen needs MUTE_MEMBERS, kicking
    // someone out of voice needs MOVE_MEMBERS. The server owner always has
    // both, and can now delegate them to a role.
    if room_type != "server" {
        return;
    }
    if server_id.is_empty() {
        return;
    }
    let needed = if action == "kick" { crate::db::PERM_MOVE_MEMBERS } else { crate::db::PERM_MUTE_MEMBERS };
    if !state.db.member_has_permission(&server_id, user_id, needed, None) {
        return;
    }
    // Nobody can voice-moderate the owner, and a moderator cannot target a
    // member whose role is at or above their own.
    if state.db.is_server_owner(&target_user_id, &server_id).unwrap_or(false) {
        return;
    }
    if state.db.member_role_position(&server_id, user_id).unwrap_or(0)
        <= state.db.member_role_position(&server_id, &target_user_id).unwrap_or(0)
    {
        return;
    }

    // Update sanctions in DB
    let (mut fm, mut fd) = state.db.get_voice_sanction(&server_id, &target_user_id).unwrap_or((false, false));
    match action.as_str() {
        "mute" => fm = true,
        "unmute" => fm = false,
        "deafen" => {
            fm = true;
            fd = true;
        }
        "undeafen" => {
            fd = false;
        }
        "kick" => {}
        _ => return,
    }
    if action != "kick" {
        let _ = state.db.set_voice_sanction(&server_id, &target_user_id, fm, fd);
        if !fm && !fd {
            let _ = state.db.clear_voice_sanction(&server_id, &target_user_id);
        }
    }

    // Confirm the room exists and contains the target (lock dropped before awaits)
    let target_in_room = {
        let rooms = match state.voice_rooms.read() {
            Ok(r) => r,
            Err(_) => return,
        };
        match rooms.get(&room_id) {
            Some(r) => r.members.contains_key(&target_user_id),
            None => false,
        }
    };
    if !target_in_room {
        return;
    }

    if action == "kick" {
        let kicked = serde_json::json!({
            "type": "voice_kicked",
            "channel_id": channel_id,
        });
        send_to_user(state, &target_user_id, &kicked).await;
        voice_remove_from_room(state, &room_id, &target_user_id, true).await;
        return;
    }

    // Update in-memory member + broadcast
    let member = {
        let mut rooms_w = match state.voice_rooms.write() {
            Ok(r) => r,
            Err(_) => return,
        };
        let r = match rooms_w.get_mut(&room_id) {
            Some(r) => r,
            None => return,
        };
        let m = match r.members.get_mut(&target_user_id) {
            Some(m) => m,
            None => return,
        };
        m.force_muted = fm;
        m.force_deafened = fd;
        m.muted = fm || fd;
        m.deafened = fd;
        m.clone()
    };

    let update_msg = serde_json::json!({
        "type": "voice_member_update",
        "member": voice_member_json(&member),
    });
    // Lock dropped before awaiting the broadcast
    voice_broadcast(state, &room_id, &update_msg).await;

    let control_received = serde_json::json!({
        "type": "voice_control_received",
        "action": action,
        "muted": fm,
        "deafened": fd,
        "by_user": user_id,
    });
    send_to_user(state, &target_user_id, &control_received).await;

    // Owner sanctions change what the channel list shows for that member
    if !server_id.is_empty() {
        voice_broadcast_server_presence(state, &server_id).await;
    }
}

async fn handle_dm_call_ring(
    parsed: serde_json::Value,
    state: &Arc<AppState>,
    user_id: &str,
) {
    let dm_channel_id = match parsed.get("dm_channel_id").and_then(|c| c.as_str()) {
        Some(c) => c.to_string(),
        None => return,
    };
    if !state.db.is_dm_member(&dm_channel_id, user_id).unwrap_or(false) {
        return;
    }
    let members = match state.db.get_dm_members(&dm_channel_id) {
        Ok(m) => m,
        Err(_) => return,
    };
    let username = state
        .db
        .get_user_by_id(user_id)
        .map(|u| u.username)
        .unwrap_or_else(|_| "?".to_string());
    let ring = serde_json::json!({
        "type": "dm_call_ring",
        "caller_id": user_id,
        "caller_username": username,
        "dm_channel_id": dm_channel_id,
    });
    let others: Vec<String> = members.into_iter().filter(|m| m != user_id).collect();
    state.ws_manager.broadcast_to_users(&others, &ring.to_string()).await;
    // Push the ring to devices of callees whose app is closed (no websocket).
    crate::handlers::spawn_push_to_users(
        state,
        others,
        format!("Incoming call from {username}"),
        "Tap to open E2E Chat".to_string(),
        format!("call:{dm_channel_id}"),
        format!("/?dm={dm_channel_id}"),
    );
}

/// The caller has stopped ringing (30s unanswered). Tells the callee to stop
/// the ringtone and show the waiting state — the call stays joinable until
/// someone manually joins or the caller hangs up. The waiting state is ALSO
/// persisted so it survives page refreshes and shows in the DM chat.
async fn handle_dm_call_waiting(
    parsed: serde_json::Value,
    state: &Arc<AppState>,
    user_id: &str,
) {
    let dm_channel_id = match parsed.get("dm_channel_id").and_then(|c| c.as_str()) {
        Some(c) => c.to_string(),
        None => return,
    };
    if !state.db.is_dm_member(&dm_channel_id, user_id).unwrap_or(false) {
        return;
    }
    // Persist only if the sender is still actually in the voice room (the
    // 30s-unanswered caller is; someone who already left is not — in that case
    // voice_remove_from_room already set the waiting user to the remaining side).
    let in_room = {
        let rooms = match state.voice_rooms.read() {
            Ok(r) => r,
            Err(_) => return,
        };
        let room_id = voice_room_id("dm", "", &dm_channel_id);
        rooms.get(&room_id).map(|rm| rm.members.contains_key(user_id)).unwrap_or(false)
    };
    if in_room {
        let _ = state.db.set_dm_call_waiting(&dm_channel_id, user_id);
    }
    let members = match state.db.get_dm_members(&dm_channel_id) {
        Ok(m) => m,
        Err(_) => return,
    };
    let msg = serde_json::json!({
        "type": "dm_call_waiting",
        "caller_id": user_id,
        "dm_channel_id": dm_channel_id,
    });
    let others: Vec<String> = members.into_iter().filter(|m| m != user_id).collect();
    state.ws_manager.broadcast_to_users(&others, &msg.to_string()).await;
}

async fn handle_dm_call_end(
    parsed: serde_json::Value,
    state: &Arc<AppState>,
    user_id: &str,
) {
    let dm_channel_id = match parsed.get("dm_channel_id").and_then(|c| c.as_str()) {
        Some(c) => c.to_string(),
        None => return,
    };
    if !state.db.is_dm_member(&dm_channel_id, user_id).unwrap_or(false) {
        return;
    }
    let members = match state.db.get_dm_members(&dm_channel_id) {
        Ok(m) => m,
        Err(_) => return,
    };
    let reason = parsed.get("reason").and_then(|r| r.as_str()).unwrap_or("ended").to_string();
    let end = serde_json::json!({
        "type": "dm_call_end",
        "dm_channel_id": dm_channel_id,
        "reason": reason,
    });
    let others: Vec<String> = members.into_iter().filter(|m| m != user_id).collect();
    state.ws_manager.broadcast_to_users(&others, &end.to_string()).await;

    // When the callee declines, place the caller in the persisted waiting state
    // so the waiting indicator survives refreshes and the caller can re-initiate.
    // Also broadcast dm_call_waiting to the CALLEE so their sidebar shows the
    // caller is waiting.
    if reason == "declined" {
        if let Some(caller_id) = others.first() {
            let _ = state.db.set_dm_call_waiting(&dm_channel_id, caller_id);
            let wait_msg = serde_json::json!({
                "type": "dm_call_waiting",
                "caller_id": caller_id,
                "dm_channel_id": dm_channel_id,
            });
            send_to_user(state, user_id, &wait_msg).await;
        }
    }
}

/// Remove a user from every voice room (called on WS disconnect).
/// Remove a user from every voice room their device currently occupies.
/// `device_id` is the connection's device key — rooms where a DIFFERENT device
/// of the same user is the current occupant are left untouched (the replaced
/// device must not evict the replacement). An empty device_id matches rooms
/// whose occupant has no device key (legacy clients).
pub async fn voice_remove_user_all_for_device(state: &Arc<AppState>, user_id: &str, device_id: &str) {
    let room_ids: Vec<String> = {
        let rooms = match state.voice_rooms.read() {
            Ok(r) => r,
            Err(_) => return,
        };
        rooms
            .iter()
            .filter(|(_, r)| {
                r.members.contains_key(user_id)
                    && match r.device_map.get(user_id) {
                        Some(d) => d == device_id,
                        None => device_id.is_empty(),
                    }
            })
            .map(|(id, _)| id.clone())
            .collect()
    };
    for rid in room_ids {
        voice_remove_from_room(state, &rid, user_id, false).await;
    }
}
