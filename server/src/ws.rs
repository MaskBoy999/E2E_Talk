use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};

use axum::{
    extract::{
        ws::{Message, WebSocket, WebSocketUpgrade},
        State,
    },
    response::IntoResponse,
};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;

use base64::Engine;
use crate::auth;
use crate::AppState;

static CONN_COUNTER: AtomicU64 = AtomicU64::new(1);

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
    sender_username: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender_display_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender_profile_pic: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender_username_color: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    sender_username_border_color: Option<String>,
    encrypted_content: String,
    nonce: String,
    timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    edited_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted_profile_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_key_nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted_banner_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    banner_key_nonce: Option<String>,
    // Streamlined E2E fields
    #[serde(skip_serializing_if = "Option::is_none")]
    key_version: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted_profile_snapshot: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    profile_snapshot_nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted_file_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_key_nonce: Option<String>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();

    let (user_id, device_id, last_seen_timestamp) = loop {
        match receiver.next().await {
            Some(Ok(Message::Text(text))) => {
                match serde_json::from_str::<WsAuthMessage>(text.as_str()) {
                    Ok(auth_msg) if auth_msg.msg_type == "auth" => {
                        match auth::validate_token(&auth_msg.token, &state.config.jwt_secret) {
                            Ok(claims) => break (claims.sub, auth_msg.device_id, auth_msg.last_seen_timestamp),
                            Err(_) => {
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

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let conn_id = state.ws_manager.add_connection(user_id.clone(), device_id, tx).await;

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
            let message_nonce = parsed.get("message_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());

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

            let encrypted_profile_key = parsed.get("encrypted_profile_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_key_nonce = parsed.get("profile_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let encrypted_banner_key = parsed.get("encrypted_banner_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let banner_key_nonce = parsed.get("banner_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let encrypted_profile_snapshot = parsed.get("encrypted_profile_snapshot").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
            let profile_snapshot_nonce = parsed.get("profile_snapshot_nonce").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
            let encrypted_file_key_parsed = parsed.get("encrypted_file_key").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
            let file_key_nonce_parsed = parsed.get("file_key_nonce").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

            let message = match state.db.save_encrypted_message(channel_id, user_id, &encrypted_content, &nonce, message_nonce.as_deref(), None, encrypted_profile_key.as_deref(), profile_key_nonce.as_deref(), encrypted_banner_key.as_deref(), banner_key_nonce.as_deref(), encrypted_profile_snapshot.as_deref(), profile_snapshot_nonce.as_deref(), encrypted_file_key_parsed.as_deref(), file_key_nonce_parsed.as_deref()) {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("Failed to save message: {}", e);
                    return;
                }
            };

            let server_id_clone = server_id.clone();
            let msg_id = message.id.clone();
            let msg_sender_username = message.sender_username.clone();
            // Fetch sender's profile data for display name, profile pic, username color, and border color
            let (sender_display_name, sender_profile_pic, sender_color, sender_border_color) = match state.db.get_user_profile(user_id) {
                Ok((_, _, dn, pp, _fk, uc, bc, _, _)) => (dn, pp, uc, bc),
                Err(_) => (None, None, None, None),
            };
            let outgoing = OutgoingMessage {
                msg_type: "message_new".to_string(),
                channel_id: Some(message.channel_id.clone()),
                server_id: Some(server_id_clone),
                dm_channel_id: None,
                message: Some(OutgoingChatMessage {
                    id: message.id,
                    channel_id: message.channel_id,
                    dm_channel_id: None,
                    sender_id: message.sender_id,
                    sender_username: message.sender_username,
                    sender_display_name,
                    sender_profile_pic: sender_profile_pic.clone(),
                    sender_username_color: sender_color,
                    sender_username_border_color: sender_border_color,
                    encrypted_content: encrypted_content_b64.to_string(),
                    nonce: nonce_b64.to_string(),
                    timestamp: message.timestamp,
                    message_nonce: message.message_nonce,
                    edited_at: None,
                    encrypted_profile_key: encrypted_profile_key.clone(),
                    profile_key_nonce: profile_key_nonce.clone(),
                    encrypted_banner_key: encrypted_banner_key.clone(),
                    banner_key_nonce: banner_key_nonce.clone(),
                    key_version: None,
                    encrypted_profile_snapshot: encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    profile_snapshot_nonce: profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    encrypted_file_key: encrypted_file_key_parsed.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    file_key_nonce: file_key_nonce_parsed.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
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
                    let channel_name = state.db.get_channel_name(channel_id).unwrap_or_default();
                    let server_name = state.db.get_server_name(&server_id).unwrap_or_default();
                    let mention_notification = serde_json::json!({
                        "type": "mention_notification",
                        "channel_id": channel_id,
                        "server_id": server_id,
                        "channel_name": channel_name,
                        "server_name": server_name,
                        "sender_username": msg_sender_username,
                        "sender_id": user_id,
                        "sender_profile_pic": sender_profile_pic,
                        "message_id": msg_id
                    });
                    state.ws_manager.broadcast_to_users(&mentioned_ids, &mention_notification.to_string()).await;
                }
            }

            // Notify replied user
            if let Some(reply_to_user_id) = parsed.get("reply_to_user_id").and_then(|r| r.as_str()) {
                if reply_to_user_id != user_id {
                    let channel_name = state.db.get_channel_name(channel_id).unwrap_or_default();
                    let server_name = state.db.get_server_name(&server_id).unwrap_or_default();
                    let reply_notification = serde_json::json!({
                        "type": "reply_notification",
                        "channel_id": channel_id,
                        "server_id": server_id,
                        "channel_name": channel_name,
                        "server_name": server_name,
                        "sender_username": msg_sender_username,
                        "sender_id": user_id,
                        "sender_profile_pic": sender_profile_pic,
                        "message_id": msg_id
                    });
                    state.ws_manager.broadcast_to_users(&[reply_to_user_id.to_string()], &reply_notification.to_string()).await;
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
        "profile_key_sync" => {
            let dm_channel_id = match parsed.get("dm_channel_id").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };

            // Must be a member of this DM channel.
            if !state.db.is_dm_member(dm_channel_id, user_id).unwrap_or(false) {
                return;
            }

            let encrypted_profile_key = parsed.get("encrypted_profile_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_key_nonce = parsed.get("profile_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_key_message_nonce = parsed.get("profile_key_message_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_picture_file_id = parsed.get("profile_picture_file_id").and_then(|c| c.as_str()).map(|s| s.to_string());
            let encrypted_banner_key = parsed.get("encrypted_banner_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let banner_key_nonce = parsed.get("banner_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let banner_key_message_nonce = parsed.get("banner_key_message_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_banner_file_id = parsed.get("profile_banner_file_id").and_then(|c| c.as_str()).map(|s| s.to_string());
            let encrypted_profile_data_key = parsed.get("encrypted_profile_data_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_data_key_nonce = parsed.get("profile_data_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());

            let sync_msg = serde_json::json!({
                "type": "profile_key_sync",
                "user_id": user_id,
                "dm_channel_id": dm_channel_id,
                "profile_picture_file_id": profile_picture_file_id,
                "encrypted_profile_key": encrypted_profile_key,
                "profile_key_nonce": profile_key_nonce,
                "profile_key_message_nonce": profile_key_message_nonce,
                "profile_banner_file_id": profile_banner_file_id,
                "encrypted_banner_key": encrypted_banner_key,
                "banner_key_nonce": banner_key_nonce,
                "banner_key_message_nonce": banner_key_message_nonce,
                "encrypted_profile_data_key": encrypted_profile_data_key,
                "profile_data_key_nonce": profile_data_key_nonce,
            });

            // Broadcast to both DM members
            match state.db.get_dm_members(dm_channel_id) {
                Ok(members) => {
                    state.ws_manager.broadcast_to_users(&members, &sync_msg.to_string()).await;
                }
                Err(e) => {
                    tracing::error!("Failed to get DM members: {}", e);
                }
            }
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
            let message_nonce = parsed.get("message_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());

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

            let encrypted_profile_key = parsed.get("encrypted_profile_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_key_nonce = parsed.get("profile_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let encrypted_banner_key = parsed.get("encrypted_banner_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let banner_key_nonce = parsed.get("banner_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let encrypted_profile_snapshot = parsed.get("encrypted_profile_snapshot").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
            let profile_snapshot_nonce = parsed.get("profile_snapshot_nonce").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
            let encrypted_file_key_parsed = parsed.get("encrypted_file_key").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
            let file_key_nonce_parsed = parsed.get("file_key_nonce").and_then(|c| c.as_str()).and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());

            let message = match state.db.save_dm_message(dm_channel_id, user_id, &encrypted_content, &nonce, message_nonce.as_deref(), None, encrypted_profile_key.as_deref(), profile_key_nonce.as_deref(), encrypted_banner_key.as_deref(), banner_key_nonce.as_deref(), encrypted_profile_snapshot.as_deref(), profile_snapshot_nonce.as_deref(), encrypted_file_key_parsed.as_deref(), file_key_nonce_parsed.as_deref()) {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("Failed to save DM message: {}", e);
                    return;
                }
            };

            let msg_id = message.id.clone();
            let msg_sender_username = message.sender_username.clone();
            // Fetch sender's profile data for display name, profile pic, username color, and border color
            let (sender_display_name, sender_profile_pic, sender_color, sender_border_color) = match state.db.get_user_profile(user_id) {
                Ok((_, _, dn, pp, _fk, uc, bc, _, _)) => (dn, pp, uc, bc),
                Err(_) => (None, None, None, None),
            };
            let outgoing = OutgoingMessage {
                msg_type: "dm_new".to_string(),
                channel_id: None,
                server_id: None,
                dm_channel_id: Some(message.dm_channel_id.clone()),
                message: Some(OutgoingChatMessage {
                    id: message.id,
                    channel_id: String::new(),
                    dm_channel_id: Some(message.dm_channel_id.clone()),
                    sender_id: message.sender_id,
                    sender_username: message.sender_username,
                    sender_display_name,
                    sender_profile_pic: sender_profile_pic.clone(),
                    sender_username_color: sender_color,
                    sender_username_border_color: sender_border_color,
                    encrypted_content: encrypted_content_b64.to_string(),
                    nonce: nonce_b64.to_string(),
                    timestamp: message.timestamp,
                    message_nonce: message.message_nonce,
                    edited_at: None,
                    encrypted_profile_key: encrypted_profile_key.clone(),
                    profile_key_nonce: profile_key_nonce.clone(),
                    encrypted_banner_key: encrypted_banner_key.clone(),
                    banner_key_nonce: banner_key_nonce.clone(),
                    key_version: None,
                    encrypted_profile_snapshot: encrypted_profile_snapshot.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    profile_snapshot_nonce: profile_snapshot_nonce.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    encrypted_file_key: encrypted_file_key_parsed.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
                    file_key_nonce: file_key_nonce_parsed.as_ref().map(|v| base64::engine::general_purpose::STANDARD.encode(v)),
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
                        "sender_username": msg_sender_username,
                        "sender_id": user_id,
                        "sender_profile_pic": sender_profile_pic,
                        "message_id": msg_id
                    });
                    state.ws_manager.broadcast_to_users(&mentioned_ids, &mention_notification.to_string()).await;
                }
            }

            // Notify replied user in DM
            if let Some(reply_to_user_id) = parsed.get("reply_to_user_id").and_then(|r| r.as_str()) {
                if reply_to_user_id != user_id {
                    let reply_notification = serde_json::json!({
                        "type": "reply_notification",
                        "dm_channel_id": dm_channel_id,
                        "sender_username": msg_sender_username,
                        "sender_id": user_id,
                        "sender_profile_pic": sender_profile_pic,
                        "message_id": msg_id
                    });
                    state.ws_manager.broadcast_to_users(&[reply_to_user_id.to_string()], &reply_notification.to_string()).await;
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
            let message_nonce = parsed.get("message_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());

            let encrypted_content = match base64::engine::general_purpose::STANDARD.decode(encrypted_content_b64) {
                Ok(b) => b,
                Err(_) => return,
            };
            let nonce = match base64::engine::general_purpose::STANDARD.decode(nonce_b64) {
                Ok(b) => b,
                Err(_) => return,
            };

            let encrypted_profile_key = parsed.get("encrypted_profile_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_key_nonce = parsed.get("profile_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let encrypted_banner_key = parsed.get("encrypted_banner_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let banner_key_nonce = parsed.get("banner_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());

            let message = match state.db.edit_encrypted_message(message_id, user_id, &encrypted_content, &nonce, message_nonce.as_deref(), None, encrypted_profile_key.as_deref(), profile_key_nonce.as_deref(), encrypted_banner_key.as_deref(), banner_key_nonce.as_deref()) {
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
            // Fetch sender's profile data for display name, profile pic, username color, and border color
            let (sender_display_name, sender_profile_pic, sender_color, sender_border_color) = match state.db.get_user_profile(user_id) {
                Ok((_, _, dn, pp, _fk, uc, bc, _, _)) => (dn, pp, uc, bc),
                Err(_) => (None, None, None, None),
            };
            let outgoing = OutgoingMessage {                    msg_type: "message_edited".to_string(),
                channel_id: Some(message.channel_id.clone()),
                server_id: None,
                dm_channel_id: None,
                message: Some(OutgoingChatMessage {
                    id: message.id,
                    channel_id: message.channel_id,
                    dm_channel_id: None,
                    sender_id: message.sender_id,
                    sender_username: message.sender_username,
                    sender_display_name,
                    sender_profile_pic: sender_profile_pic.clone(),
                    sender_username_color: sender_color,
                    sender_username_border_color: sender_border_color,
                    encrypted_content: encrypted_content_b64.to_string(),
                    nonce: nonce_b64.to_string(),
                    timestamp: message.timestamp,
                    message_nonce: message.message_nonce,
                    edited_at: message.edited_at,
                    encrypted_profile_key: encrypted_profile_key.clone(),
                    profile_key_nonce: profile_key_nonce.clone(),
                    encrypted_banner_key: encrypted_banner_key.clone(),
                    banner_key_nonce: banner_key_nonce.clone(),
                    key_version: None,
                    encrypted_profile_snapshot: None,
                    profile_snapshot_nonce: None,
                    encrypted_file_key: None,
                    file_key_nonce: None,
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
            let message_nonce = parsed.get("message_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());

            let encrypted_content = match base64::engine::general_purpose::STANDARD.decode(encrypted_content_b64) {
                Ok(b) => b,
                Err(_) => return,
            };
            let nonce = match base64::engine::general_purpose::STANDARD.decode(nonce_b64) {
                Ok(b) => b,
                Err(_) => return,
            };

            let encrypted_profile_key = parsed.get("encrypted_profile_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_key_nonce = parsed.get("profile_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let encrypted_banner_key = parsed.get("encrypted_banner_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let banner_key_nonce = parsed.get("banner_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());

            let message = match state.db.edit_dm_message(message_id, user_id, &encrypted_content, &nonce, message_nonce.as_deref(), None, encrypted_profile_key.as_deref(), profile_key_nonce.as_deref(), encrypted_banner_key.as_deref(), banner_key_nonce.as_deref()) {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("Failed to edit DM message: {}", e);
                    return;
                }
            };
            // Fetch sender's profile data for display name, profile pic, username color, and border color
            let (sender_display_name, sender_profile_pic, sender_color, sender_border_color) = match state.db.get_user_profile(user_id) {
                Ok((_, _, dn, pp, _fk, uc, bc, _, _)) => (dn, pp, uc, bc),
                Err(_) => (None, None, None, None),
            };
            let outgoing = OutgoingMessage {                    msg_type: "dm_edited".to_string(),
                channel_id: None,
                server_id: None,
                dm_channel_id: Some(message.dm_channel_id.clone()),
                message: Some(OutgoingChatMessage {
                    id: message.id,
                    channel_id: String::new(),
                    dm_channel_id: Some(message.dm_channel_id.clone()),
                    sender_id: message.sender_id,
                    sender_username: message.sender_username,
                    sender_display_name,
                    sender_profile_pic: sender_profile_pic.clone(),
                    sender_username_color: sender_color,
                    sender_username_border_color: sender_border_color,
                    encrypted_content: encrypted_content_b64.to_string(),
                    nonce: nonce_b64.to_string(),
                    timestamp: message.timestamp,
                    message_nonce: message.message_nonce,
                    edited_at: message.edited_at,
                    encrypted_profile_key: encrypted_profile_key.clone(),
                    profile_key_nonce: profile_key_nonce.clone(),
                    encrypted_banner_key: encrypted_banner_key.clone(),
                    banner_key_nonce: banner_key_nonce.clone(),
                    key_version: None,
                    encrypted_profile_snapshot: None,
                    profile_snapshot_nonce: None,
                    encrypted_file_key: None,
                    file_key_nonce: None,
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
        "profile_key_server_sync" => {
            let server_id = match parsed.get("server_id").and_then(|c| c.as_str()) {
                Some(c) => c,
                None => return,
            };

            // Must be a member of this server
            if !state.db.is_member_of_server(user_id, server_id).unwrap_or(false) {
                return;
            }

            let encrypted_profile_key = parsed.get("encrypted_profile_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_key_nonce = parsed.get("profile_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_picture_file_id = parsed.get("profile_picture_file_id").and_then(|c| c.as_str()).map(|s| s.to_string());
            let encrypted_banner_key = parsed.get("encrypted_banner_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let banner_key_nonce = parsed.get("banner_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_banner_file_id = parsed.get("profile_banner_file_id").and_then(|c| c.as_str()).map(|s| s.to_string());
            let encrypted_profile_data_key = parsed.get("encrypted_profile_data_key").and_then(|c| c.as_str()).map(|s| s.to_string());
            let profile_data_key_nonce = parsed.get("profile_data_key_nonce").and_then(|c| c.as_str()).map(|s| s.to_string());

            let sync_msg = serde_json::json!({
                "type": "profile_key_server_sync",
                "user_id": user_id,
                "server_id": server_id,
                "profile_picture_file_id": profile_picture_file_id,
                "encrypted_profile_key": encrypted_profile_key,
                "profile_key_nonce": profile_key_nonce,
                "profile_banner_file_id": profile_banner_file_id,
                "encrypted_banner_key": encrypted_banner_key,
                "banner_key_nonce": banner_key_nonce,
                "encrypted_profile_data_key": encrypted_profile_data_key,
                "profile_data_key_nonce": profile_data_key_nonce,
            });

            // Broadcast to all server members
            match state.db.get_server_members(server_id) {
                Ok(members) => {
                    state.ws_manager.broadcast_to_users(&members, &sync_msg.to_string()).await;
                }
                Err(e) => {
                    tracing::error!("Failed to get server members for key sync: {}", e);
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
