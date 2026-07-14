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
    connections: tokio::sync::RwLock<std::collections::HashMap<u64, (String, mpsc::UnboundedSender<String>)>>,
}

impl WsManager {
    pub fn new() -> Self {
        Self {
            connections: tokio::sync::RwLock::new(std::collections::HashMap::new()),
        }
    }

    pub async fn add_connection(&self, user_id: String, sender: mpsc::UnboundedSender<String>) -> u64 {
        let id = CONN_COUNTER.fetch_add(1, Ordering::Relaxed);
        self.connections.write().await.insert(id, (user_id, sender));
        id
    }

    pub async fn remove_connection(&self, conn_id: u64) {
        self.connections.write().await.remove(&conn_id);
    }

    pub async fn broadcast_to_users(&self, user_ids: &[String], message: &str) {
        let conns = self.connections.read().await;
        for (uid, sender) in conns.values() {
            if user_ids.contains(uid) {
                let _ = sender.send(message.to_string());
            }
        }
    }

    pub async fn broadcast_to_server(&self, _server_id: &str, message: &str) {
        let conns = self.connections.read().await;
        for (_conn_id, sender) in conns.values() {
            let _ = sender.send(message.to_string());
        }
    }
}

#[derive(Deserialize)]
struct WsAuthMessage {
    #[serde(rename = "type")]
    msg_type: String,
    token: String,
}

#[derive(Serialize)]
struct OutgoingMessage {
    #[serde(rename = "type")]
    msg_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    channel_id: Option<String>,
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
    encrypted_content: String,
    nonce: String,
    timestamp: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    message_nonce: Option<String>,
}

pub async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<Arc<AppState>>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_socket(socket, state))
}

async fn handle_socket(socket: WebSocket, state: Arc<AppState>) {
    let (mut sender, mut receiver) = socket.split();

    let user_id = loop {
        match receiver.next().await {
            Some(Ok(Message::Text(text))) => {
                match serde_json::from_str::<WsAuthMessage>(text.as_str()) {
                    Ok(auth_msg) if auth_msg.msg_type == "auth" => {
                        match auth::validate_token(&auth_msg.token, &state.config.jwt_secret) {
                            Ok(claims) => break claims.sub,
                            Err(_) => {
                                let err = OutgoingMessage {
                                    msg_type: "auth_error".to_string(),
                                    channel_id: None,
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
        dm_channel_id: None,
        message: None,
        user_id: Some(user.id.clone()),
        username: Some(user.username.clone()),
        error: None,
    };
    let _ = sender
        .send(Message::Text(serde_json::to_string(&auth_ok).unwrap().into()))
        .await;

    let (tx, mut rx) = mpsc::unbounded_channel::<String>();

    let conn_id = state.ws_manager.add_connection(user_id.clone(), tx).await;

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

            let message = match state.db.save_encrypted_message(channel_id, user_id, &encrypted_content, &nonce, message_nonce.as_deref()) {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("Failed to save message: {}", e);
                    return;
                }
            };

            let outgoing = OutgoingMessage {
                msg_type: "message_new".to_string(),
                channel_id: Some(message.channel_id.clone()),
                dm_channel_id: None,
                message: Some(OutgoingChatMessage {
                    id: message.id,
                    channel_id: message.channel_id,
                    dm_channel_id: None,
                    sender_id: message.sender_id,
                    sender_username: message.sender_username,
                    encrypted_content: encrypted_content_b64.to_string(),
                    nonce: nonce_b64.to_string(),
                    timestamp: message.timestamp,
                    message_nonce: message.message_nonce,
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
        }
        "upload_key_bundle" => {
            let identity_key_public = match parsed.get("identity_key_public").and_then(|v| v.as_str()) {
                Some(k) => k,
                None => return,
            };
            let signed_prekey_public = match parsed.get("signed_prekey_public").and_then(|v| v.as_str()) {
                Some(k) => k,
                None => return,
            };
            let signed_prekey_signature = match parsed.get("signed_prekey_signature").and_then(|v| v.as_str()) {
                Some(k) => k,
                None => return,
            };
            let one_time_prekey_public = parsed.get("one_time_prekey_public").and_then(|v| v.as_str());
            let one_time_prekey_id = parsed.get("one_time_prekey_id").and_then(|v| v.as_i64()).map(|v| v as i32);

            let ik = match base64::engine::general_purpose::STANDARD.decode(identity_key_public) {
                Ok(b) => b,
                Err(_) => return,
            };
            let spk = match base64::engine::general_purpose::STANDARD.decode(signed_prekey_public) {
                Ok(b) => b,
                Err(_) => return,
            };
            let sig = match base64::engine::general_purpose::STANDARD.decode(signed_prekey_signature) {
                Ok(b) => b,
                Err(_) => return,
            };
            let otp = one_time_prekey_public.and_then(|k| base64::engine::general_purpose::STANDARD.decode(k).ok());

            match state.db.save_prekey_bundle(user_id, &ik, &spk, &sig, otp.as_deref(), one_time_prekey_id) {
                Ok(()) => {
                    let resp = serde_json::json!({
                        "type": "key_bundle_uploaded",
                        "ok": true,
                    });
                    state.ws_manager.broadcast_to_users(&[user_id.to_string()], &resp.to_string()).await;
                }
                Err(e) => {
                    tracing::error!("Failed to save key bundle: {}", e);
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

            let message = match state.db.save_dm_message(dm_channel_id, user_id, &encrypted_content, &nonce, message_nonce.as_deref()) {
                Ok(m) => m,
                Err(e) => {
                    tracing::error!("Failed to save DM message: {}", e);
                    return;
                }
            };

            let outgoing = OutgoingMessage {
                msg_type: "dm_new".to_string(),
                channel_id: None,
                dm_channel_id: Some(message.dm_channel_id.clone()),
                message: Some(OutgoingChatMessage {
                    id: message.id,
                    channel_id: String::new(),
                    dm_channel_id: Some(message.dm_channel_id.clone()),
                    sender_id: message.sender_id,
                    sender_username: message.sender_username,
                    encrypted_content: encrypted_content_b64.to_string(),
                    nonce: nonce_b64.to_string(),
                    timestamp: message.timestamp,
                    message_nonce: message.message_nonce,
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
