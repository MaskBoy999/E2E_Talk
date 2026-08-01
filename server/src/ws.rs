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
    http::HeaderMap,
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use base64::Engine;
use crate::auth;
use crate::AppState;

static CONN_COUNTER: AtomicU64 = AtomicU64::new(1);

struct WsRateLimiter {
    attempts: Mutex<HashMap<String, (u32, Instant)>>,
}

impl WsRateLimiter {
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

pub struct WsManager {
    connections: tokio::sync::RwLock<std::collections::HashMap<u64, (String, Option<String>, mpsc::UnboundedSender<String>)>>,
}

impl WsManager {
    pub fn new() -> Self {
        Self {
            connections: tokio::sync::RwLock::new(std::collections::HashMap::new()),
        }
    }

    pub async fn add_connection(&self, user_id: String, device_id: Option<String>, sender: mpsc::UnboundedSender<String>) -> u64 {
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

    pub async fn is_user_connected(&self, user_id: &str) -> bool {
        let conns = self.connections.read().await;
        conns.values().any(|(uid, _, _)| uid == user_id)
    }

    pub async fn broadcast_to_device(&self, user_id: &str, device_id: &str, message: &str) {
        let conns = self.connections.read().await;
        for (uid, did, sender) in conns.values() {
            if uid == user_id && did.as_deref() == Some(device_id) {
                let _ = sender.send(message.to_string());
            }
        }
    }

    pub async fn broadcast_to_users(&self, user_ids: &[String], message: &str) {
        let conns = self.connections.read().await;
        for (uid, _did, sender) in conns.values() {
            if user_ids.contains(uid) {
                let _ = sender.send(message.to_string());
            }
        }
    }

    pub async fn broadcast_to_server(&self, _server_id: &str, message: &str) {
        let conns = self.connections.read().await;
        for (_conn_id, _did, sender) in conns.values() {
            let _ = sender.send(message.to_string());
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
            let _ = sender.send(message.to_string());
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
}

pub async fn ws_handler(
    headers: HeaderMap,
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
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
                            Ok(claims) => break (claims.sub, auth_msg.device_id, auth_msg.last_seen_timestamp),
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

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let conn_id = state.ws_manager.add_connection(user_id.clone(), device_id, tx).await;

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
            if sender.send(Message::Text(msg.into())).await.is_err() {
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

async fn handle_ws_message(
    text: &str,
    state: &Arc<AppState>,
    user_id: &str,
) {
    let parsed: serde_json::Value = match serde_json::from_str(text) {
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

            let message = match state.db.save_encrypted_message(channel_id, user_id, &encrypted_content, &nonce, encrypted_profile_snapshot.as_deref(), profile_snapshot_nonce.as_deref(), encrypted_sender_username.as_deref(), sender_username_nonce.as_deref(), file_id_hash.as_deref()) {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("Failed to save message: {}", e);
                    return;
                }
            };

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
                    state.ws_manager.broadcast_to_users(&mentioned_ids, &mention_notification.to_string()).await;
                    // Save for offline mentioned users
                    let notif_str = mention_notification.to_string();
                    for mid in &mentioned_ids {
                        if !state.ws_manager.is_user_connected(mid).await {
                            let _ = state.db.save_pending_notification(mid, "mention_notification", &notif_str);
                        }
                    }
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
                    state.ws_manager.broadcast_to_users(&[reply_to_user_id.to_string()], &reply_notification.to_string()).await;
                    if !state.ws_manager.is_user_connected(reply_to_user_id).await {
                        let _ = state.db.save_pending_notification(reply_to_user_id, "reply_notification", &reply_notification.to_string());
                    }
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

            let message = match state.db.save_dm_message(dm_channel_id, user_id, &encrypted_content, &nonce, encrypted_profile_snapshot.as_deref(), profile_snapshot_nonce.as_deref(), encrypted_sender_username.as_deref(), sender_username_nonce.as_deref(), file_id_hash.as_deref()) {
                            Ok(m) => m,
                            Err(e) => {
                                tracing::error!("Failed to save DM message: {}", e);
                    return;
                }
            };

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
                    // Save notification for offline members
                    let outgoing_str = serde_json::to_string(&outgoing).unwrap();
                    for member_id in &members {
                        if member_id != user_id && !state.ws_manager.is_user_connected(member_id).await {
                            let _ = state.db.save_pending_notification(member_id, "dm_new", &outgoing_str);
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
                    state.ws_manager.broadcast_to_users(&mentioned_ids, &mention_notification.to_string()).await;
                    let notif_str = mention_notification.to_string();
                    for mid in &mentioned_ids {
                        if !state.ws_manager.is_user_connected(mid).await {
                            let _ = state.db.save_pending_notification(mid, "mention_notification", &notif_str);
                        }
                    }
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
                    state.ws_manager.broadcast_to_users(&[reply_to_user_id.to_string()], &reply_notification.to_string()).await;
                    if !state.ws_manager.is_user_connected(reply_to_user_id).await {
                        let _ = state.db.save_pending_notification(reply_to_user_id, "reply_notification", &reply_notification.to_string());
                    }
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

            match state.db.delete_message(message_id, user_id) {
                Ok(()) => {}
                Err(e) => {
                    tracing::error!("Failed to delete message: {}", e);
                    return;
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
        _ => {}
    }
}
