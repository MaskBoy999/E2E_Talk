//! Push notifications — deliver a small, content-free metadata payload to a
//! user's devices when a message arrives while the app is closed.
//!
//! Two transports:
//! - **Web Push (VAPID, RFC 8291 + RFC 8292)** — browsers/PWA via the service
//!   worker (`static/sw.js` already implements the `push` + `notificationclick`
//!   handlers). Fully self-hosted: the server bootstraps its own VAPID keypair.
//! - **FCM HTTP v1** — the Android box app. Needs a Firebase *service account*
//!   JSON (`FCM_SERVICE_ACCOUNT_JSON`); until the host adds one, FCM
//!   registrations are stored but sends are skipped.
//!
//! Content policy: the payload carries ONLY the metadata the service worker
//! needs to render a banner (title/body/tag/url) — never message plaintext,
//! which stays end-to-end encrypted between clients. Web Push payloads are
//! additionally encrypted to the subscriber's key (so the push service itself
//! cannot read the title/body).

use base64::Engine as _;
use hmac::{Hmac, Mac};
use p256::elliptic_curve::sec1::ToEncodedPoint;
use serde::Deserialize;
use std::time::Duration;

/// The payload contract shared with `static/sw.js`'s `push` handler.
#[derive(Clone, Debug, Deserialize)]
pub struct PushPayload {
    pub title: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub tag: String,
    #[serde(default)]
    pub url: String,
}

impl PushPayload {
    pub fn to_json(&self) -> String {
        serde_json::json!({
            "title": self.title,
            "body": self.body,
            "tag": self.tag,
            "url": self.url,
        })
        .to_string()
    }
}

// ── HKDF-SHA256 primitives (RFC 5869) ────────────────────────────────────
//
// RFC 8291 interleaves Extract and Expand in a specific order (Extract with
// the auth secret, Expand the key info, Extract with the record salt, then two
// Expands), so the two halves are exposed separately instead of as one helper.

fn hmac_sha256(key: &[u8], msg: &[u8]) -> [u8; 32] {
    let mut mac = <Hmac<sha2::Sha256> as Mac>::new_from_slice(key).expect("hmac key");
    mac.update(msg);
    mac.finalize().into_bytes().into()
}

/// HKDF-Expand (RFC 5869 §2.3) from an already-extracted PRK.
fn hkdf_expand(prk: &[u8], info: &[u8], out_len: usize) -> Vec<u8> {
    let mut out = Vec::with_capacity(out_len);
    let mut t: Vec<u8> = Vec::new();
    let mut counter: u8 = 1;
    while out.len() < out_len {
        let mut msg = t.clone();
        msg.extend_from_slice(info);
        msg.push(counter);
        t = hmac_sha256(prk, &msg).to_vec();
        out.extend_from_slice(&t);
        counter += 1;
    }
    out.truncate(out_len);
    out
}

// ── VAPID key management ─────────────────────────────────────────────────

/// Load the VAPID keypair from `vapid_private.pem` (next to the database, or
/// the path in `E2E_VAPID_KEY`). If it doesn't exist yet, generate a fresh
/// P-256 keypair and persist it — a self-hosted server bootstraps itself, the
/// way `certs/` already does.
///
/// The public key (base64url, uncompressed point) is served by
/// `GET /api/push/vapid-public-key` and is what clients subscribe with via
/// `pushManager.subscribe({ applicationServerKey })`.
pub fn load_or_create_vapid(db_path: &std::path::Path) -> Result<VapidKeys, String> {
    use p256::pkcs8::{DecodePrivateKey, EncodePrivateKey};

    let key_path = std::env::var("E2E_VAPID_KEY")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|_| {
            db_path
                .parent()
                .unwrap_or(std::path::Path::new("."))
                .join("vapid_private.pem")
        });

    if let Ok(pem) = std::fs::read_to_string(&key_path) {
        let secret = p256::SecretKey::from_pkcs8_pem(&pem)
            .map_err(|e| format!("push: {} is not a valid PKCS#8 P-256 key: {e}", key_path.display()))?;
        return Ok(VapidKeys::from_secret(secret));
    }

    let secret = p256::SecretKey::random(&mut rand::thread_rng());
    let pem = secret
        .to_pkcs8_pem(p256::pkcs8::LineEnding::LF)
        .map_err(|e| e.to_string())?;
    if let Some(dir) = key_path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    std::fs::write(&key_path, pem.as_bytes()).map_err(|e| e.to_string())?;
    tracing::info!("push: generated new VAPID keypair at {}", key_path.display());
    Ok(VapidKeys::from_secret(secret))
}

pub struct VapidKeys {
    pub secret: p256::SecretKey,
    /// Base64url uncompressed public key — the `applicationServerKey`, and the
    /// `k` parameter of the VAPID `Authorization` header.
    pub public_b64: String,
}

impl VapidKeys {
    fn from_secret(secret: p256::SecretKey) -> Self {
        let public_b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(secret.public_key().to_encoded_point(false).as_bytes());
        Self { secret, public_b64 }
    }
}

// ── VAPID JWT (ES256) ────────────────────────────────────────────────────

/// RFC 8292 §2: an ES256 JWT, `aud` = the push resource's origin, `sub` a
/// contact (`mailto:` / `https:`), valid for at most 24h.
fn vapid_jwt(keys: &VapidKeys, audience: &str, subject: &str) -> Result<String, String> {
    use p256::ecdsa::signature::Signer;
    const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

    let header = B64.encode(br#"{"typ":"JWT","alg":"ES256"}"#);
    let now = chrono::Utc::now().timestamp();
    let claims_json = format!(
        r#"{{"aud":"{audience}","exp":{},"sub":"{subject}"}}"#,
        now + 24 * 3600
    );
    let claims = B64.encode(claims_json.as_bytes());
    let signing_input = format!("{header}.{claims}");

    let signing_key = p256::ecdsa::SigningKey::from(&keys.secret);
    let sig: p256::ecdsa::Signature = signing_key.sign(signing_input.as_bytes());
    // JWT ES256 wants raw r||s (64 bytes), not DER.
    let sig_b64 = B64.encode(sig.to_bytes());
    Ok(format!("{signing_input}.{sig_b64}"))
}

/// The `Authorization` header value (RFC 8292 §3, `t=`/`k=` form).
fn vapid_authorization(keys: &VapidKeys, audience: &str, subject: &str) -> Result<String, String> {
    let jwt = vapid_jwt(keys, audience, subject)?;
    // `k` is the base64url public key itself — NOT a re-encoding of the string.
    Ok(format!("vapid t={jwt}, k={}", keys.public_b64))
}

/// The VAPID contact subject. Push services reject an empty/garbage `sub`, so
/// let the host override it; the default is a syntactically valid mailto.
fn vapid_subject() -> String {
    std::env::var("VAPID_SUBJECT")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "mailto:host@e2e-chat.local".to_string())
}

// ── Web Push message encryption (RFC 8291, aes128gcm) ────────────────────

/// Derive the content encryption key + nonce for one record (RFC 8291 §3.4),
/// with explicit inputs so the spec's test vector can drive it.
///
/// Returns `(cek, nonce, as_public)`.
fn derive_webpush_keys(
    as_secret: &p256::SecretKey,
    salt: &[u8; 16],
    ua_pub_bytes: &[u8],
    auth_secret: &[u8],
) -> Result<(Vec<u8>, Vec<u8>, Vec<u8>), String> {
    // as_public must be the *ephemeral* key: the browser reads it back out of
    // the header's "keyid" and mixes the same value into key_info, so using the
    // long-term VAPID key here (or there) makes every payload undecryptable.
    let as_pub_bytes = as_secret.public_key().to_encoded_point(false);

    let ua_point = p256::EncodedPoint::from_bytes(ua_pub_bytes)
        .map_err(|_| "push: bad p256dh key".to_string())?;
    let ua_public = p256::PublicKey::from_sec1_bytes(ua_point.as_bytes())
        .map_err(|_| "push: bad p256dh point".to_string())?;

    // ecdh_secret = ECDH(as_private, ua_public) — 32-byte X coordinate.
    let ecdh_secret = p256::elliptic_curve::ecdh::diffie_hellman(
        as_secret.to_nonzero_scalar(),
        ua_public.as_affine(),
    )
    .raw_secret_bytes()
    .to_vec();

    // -- For both:
    // PRK_key = HMAC-SHA-256(auth_secret, ecdh_secret)
    let prk_key = hmac_sha256(auth_secret, &ecdh_secret);
    // key_info = "WebPush: info" || 0x00 || ua_public || as_public
    let mut key_info = b"WebPush: info\x00".to_vec();
    key_info.extend_from_slice(ua_pub_bytes);
    key_info.extend_from_slice(as_pub_bytes.as_bytes());
    // IKM = HMAC-SHA-256(PRK_key, key_info || 0x01)
    let ikm = hkdf_expand(&prk_key, &key_info, 32);

    // -- HKDF calculations from RFC 8188
    // PRK = HMAC-SHA-256(salt, IKM)
    let prk = hmac_sha256(salt, &ikm);
    // cek_info = "Content-Encoding: aes128gcm" || 0x00   (no curve name)
    let cek = hkdf_expand(&prk, b"Content-Encoding: aes128gcm\x00", 16);
    // nonce_info = "Content-Encoding: nonce" || 0x00
    let nonce = hkdf_expand(&prk, b"Content-Encoding: nonce\x00", 12);

    Ok((cek, nonce, as_pub_bytes.as_bytes().to_vec()))
}

/// Build one `aes128gcm` body: `salt(16) | rs(4) | idlen(1) | as_pub(65) | ciphertext`.
fn encrypt_record(
    as_secret: &p256::SecretKey,
    salt: &[u8; 16],
    ua_pub_bytes: &[u8],
    auth_secret: &[u8],
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    let (cek, nonce, as_pub_bytes) =
        derive_webpush_keys(as_secret, salt, ua_pub_bytes, auth_secret)?;

    // Single record: payload || 0x02 padding delimiter (RFC 8188 §2.1).
    let mut record = payload.to_vec();
    record.push(0x02);

    use aes_gcm::aead::{Aead, KeyInit};
    let cipher = aes_gcm::Aes128Gcm::new_from_slice(&cek).map_err(|e| e.to_string())?;
    let nonce_arr: [u8; 12] = nonce.try_into().map_err(|_| "push: nonce len".to_string())?;
    let ct = cipher
        .encrypt(aes_gcm::Nonce::from_slice(&nonce_arr), record.as_ref())
        .map_err(|_| "push: webpush encrypt failed".to_string())?;

    let mut out = Vec::with_capacity(86 + ct.len());
    out.extend_from_slice(salt);
    // rs must exceed plaintext + delimiter + tag; 4096 is the push-service cap.
    out.extend_from_slice(&4096u32.to_be_bytes());
    out.push(65u8);
    out.extend_from_slice(&as_pub_bytes);
    out.extend_from_slice(&ct);
    Ok(out)
}

/// Encrypt a Web Push payload for one subscription (RFC 8291 + RFC 8188).
/// Generates the per-message ephemeral keypair and salt.
fn encrypt_webpush_message(
    p256dh_b64: &str,
    auth_b64: &str,
    payload: &[u8],
) -> Result<Vec<u8>, String> {
    const B64: base64::engine::GeneralPurpose = base64::engine::general_purpose::URL_SAFE_NO_PAD;

    // Keys may arrive padded or unpadded — accept both.
    let decode_forgiving = |s: &str| -> Result<Vec<u8>, String> {
        B64.decode(s.trim_end_matches('=')).map_err(|e| e.to_string())
    };
    let ua_pub_bytes = decode_forgiving(p256dh_b64)?;
    let auth_secret = decode_forgiving(auth_b64)?;
    if auth_secret.len() != 16 {
        return Err("push: auth secret must be 16 octets".to_string());
    }

    let as_secret = p256::SecretKey::random(&mut rand::thread_rng());
    let salt: [u8; 16] = rand::random();
    encrypt_record(&as_secret, &salt, &ua_pub_bytes, &auth_secret, payload)
}

// ── Senders ──────────────────────────────────────────────────────────────

/// Send to one Web Push subscription. Returns Ok(false) if the subscription is
/// dead (404/410 → caller prunes the row).
pub async fn send_webpush(
    keys: &VapidKeys,
    http: &reqwest::Client,
    endpoint: &str,
    p256dh: &str,
    auth: &str,
    payload: &PushPayload,
) -> Result<bool, String> {
    let body = encrypt_webpush_message(p256dh, auth, payload.to_json().as_bytes())?;
    let audience = reqwest::Url::parse(endpoint)
        .map_err(|e| e.to_string())?
        .origin()
        .ascii_serialization();

    let auth_header = vapid_authorization(keys, &audience, &vapid_subject())?;

    let resp = http
        .post(endpoint)
        .header("Authorization", auth_header)
        .header("Content-Encoding", "aes128gcm")
        .header("TTL", "86400")
        .header("Content-Type", "application/octet-stream")
        .body(body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status().as_u16();
    if status == 404 || status == 410 {
        return Ok(false); // subscription expired → prune
    }
    if (200..300).contains(&status) {
        return Ok(true);
    }
    Err(format!("push endpoint answered HTTP {status}"))
}

// ── FCM (HTTP v1) ────────────────────────────────────────────────────────

fn default_token_uri() -> String {
    "https://oauth2.googleapis.com/token".to_string()
}

/// A Firebase *service account* key (Project settings → Service accounts →
/// Generate new private key). `FCM_SERVICE_ACCOUNT_JSON` holds either the raw
/// JSON or a path to the downloaded file.
///
/// The older `/fcm/send` server-key API was retired by Google, so push now goes
/// through the v1 endpoint, which authenticates with a short-lived OAuth2 token
/// minted from this key.
#[derive(Clone, Debug, Deserialize)]
pub struct FcmCredentials {
    pub project_id: String,
    pub client_email: String,
    pub private_key: String,
    #[serde(default = "default_token_uri")]
    pub token_uri: String,
}

pub fn load_fcm_credentials() -> Option<FcmCredentials> {
    let raw = std::env::var("FCM_SERVICE_ACCOUNT_JSON").ok()?;
    let raw = raw.trim().to_string();
    if raw.is_empty() {
        return None;
    }
    let text = if raw.starts_with('{') {
        raw
    } else {
        match std::fs::read_to_string(&raw) {
            Ok(t) => t,
            Err(e) => {
                tracing::warn!("push: cannot read FCM_SERVICE_ACCOUNT_JSON at {raw}: {e}");
                return None;
            }
        }
    };
    match serde_json::from_str::<FcmCredentials>(&text) {
        Ok(c) => Some(c),
        Err(e) => {
            tracing::warn!("push: FCM_SERVICE_ACCOUNT_JSON is not a service-account key: {e}");
            None
        }
    }
}

/// Cached OAuth2 access token + the unix time it expires at.
pub type FcmTokenCache = tokio::sync::Mutex<Option<(String, i64)>>;

/// Exchange the service account for a short-lived access token, reusing the
/// cached one until it is within 60s of expiry.
async fn fcm_access_token(
    http: &reqwest::Client,
    cache: &FcmTokenCache,
    creds: &FcmCredentials,
) -> Result<String, String> {
    {
        let guard = cache.lock().await;
        if let Some((token, exp)) = guard.as_ref() {
            if chrono::Utc::now().timestamp() < exp - 60 {
                return Ok(token.clone());
            }
        }
    }

    #[derive(serde::Serialize)]
    struct Claims<'a> {
        iss: &'a str,
        scope: &'a str,
        aud: &'a str,
        iat: i64,
        exp: i64,
    }
    #[derive(serde::Deserialize)]
    struct TokenResponse {
        access_token: String,
        #[serde(default)]
        expires_in: i64,
    }

    let now = chrono::Utc::now().timestamp();
    let claims = Claims {
        iss: &creds.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: &creds.token_uri,
        iat: now,
        exp: now + 3600,
    };
    let key = jsonwebtoken::EncodingKey::from_rsa_pem(creds.private_key.as_bytes())
        .map_err(|e| format!("push: FCM private key is not RSA PEM: {e}"))?;
    let assertion = jsonwebtoken::encode(
        &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::RS256),
        &claims,
        &key,
    )
    .map_err(|e| e.to_string())?;

    let resp = http
        .post(&creds.token_uri)
        .form(&[
            ("grant_type", "urn:ietf:params:oauth:grant-type:jwt-bearer"),
            ("assertion", &assertion),
        ])
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    if !(200..300).contains(&status) {
        return Err(format!("FCM token endpoint answered HTTP {status}"));
    }
    let tok: TokenResponse = resp.json().await.map_err(|e| e.to_string())?;
    let expires_in = if tok.expires_in > 0 { tok.expires_in } else { 3600 };
    *cache.lock().await = Some((tok.access_token.clone(), now + expires_in));
    Ok(tok.access_token)
}

/// Send to one FCM registration token via the v1 API. Returns Ok(false) when
/// the token is dead (404 / UNREGISTERED) so the caller can prune the row.
pub async fn send_fcm(
    http: &reqwest::Client,
    cache: &FcmTokenCache,
    creds: &FcmCredentials,
    token: &str,
    payload: &PushPayload,
) -> Result<bool, String> {
    let access_token = fcm_access_token(http, cache, creds).await?;

    let body = serde_json::json!({
        "message": {
            "token": token,
            // `notification` renders even when the WebView is dead; `data`
            // carries the deep-link for the tap handler.
            "notification": {
                "title": payload.title,
                "body": payload.body,
            },
            "data": { "url": payload.url, "tag": payload.tag },
            "android": { "priority": "high" },
        }
    });

    let resp = http
        .post(format!(
            "https://fcm.googleapis.com/v1/projects/{}/messages:send",
            creds.project_id
        ))
        .bearer_auth(access_token)
        .json(&body)
        .timeout(Duration::from_secs(10))
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let status = resp.status().as_u16();
    if status == 404 {
        return Ok(false); // token no longer registered → prune
    }
    if (200..300).contains(&status) {
        return Ok(true);
    }
    Err(format!("FCM answered HTTP {status}"))
}

// ── Tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;

    /// RFC 8291 §5 + Appendix A: the example message, its intermediate key
    /// values, and the full 145-octet body. This pins the whole derivation
    /// (including the order of Extract/Expand and the key_info contents) to the
    /// specification, which is the only way to know a browser will decrypt it.
    #[test]
    fn matches_rfc8291_test_vector() {
        let ua_public = "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4";
        let as_private = "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw";
        let auth_secret = "BTBZMqHH6r4Tts7J_aSIgg";
        let salt_b64 = "DGv6ra1nlYgDCS1FRnbzlw";
        let plaintext = b"When I grow up, I want to be a watermelon";
        let expected_body = "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN";

        let as_secret =
            p256::SecretKey::from_slice(&B64.decode(as_private).unwrap()).expect("as_private");
        let salt: [u8; 16] = B64.decode(salt_b64).unwrap().try_into().unwrap();
        let ua_pub = B64.decode(ua_public).unwrap();
        let auth = B64.decode(auth_secret).unwrap();

        // Intermediate values from Appendix A.
        let (cek, nonce, as_pub) =
            derive_webpush_keys(&as_secret, &salt, &ua_pub, &auth).expect("derive");
        assert_eq!(B64.encode(&cek), "oIhVW04MRdy2XN9CiKLxTg", "CEK mismatch");
        assert_eq!(B64.encode(&nonce), "4h_95klXJ5E_qnoN", "NONCE mismatch");
        assert_eq!(
            B64.encode(&as_pub),
            "BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8",
            "as_public mismatch"
        );

        // …and the whole encrypted body.
        let body = encrypt_record(&as_secret, &salt, &ua_pub, &auth, plaintext).expect("encrypt");
        // 86-octet header + 41-octet plaintext + 1 delimiter + 16 tag = 144.
        // (The RFC's example HTTP header says 145, which disagrees with its own
        // base64 body — the body below is 192 base64 chars = 144 octets.)
        assert_eq!(body.len(), 144);
        assert_eq!(B64.encode(&body), expected_body);
    }

    /// A freshly generated message must be decryptable by the *receiver's*
    /// side of the protocol: parse the header, ECDH with the UA private key,
    /// re-derive the keys, and check the padding delimiter. This also pins the
    /// empty-AAD choice for `aes128gcm` (a header AAD would fail to decrypt).
    #[test]
    fn round_trips_as_the_browser_would() {
        use aes_gcm::aead::{Aead, KeyInit};

        // Subscription key material (the "user agent").
        let ua_secret = p256::SecretKey::random(&mut rand::thread_rng());
        let ua_pub = ua_secret.public_key().to_encoded_point(false);
        let auth: [u8; 16] = rand::random();
        let payload = b"{\"title\":\"hi\"}";

        let body = encrypt_webpush_message(
            &B64.encode(ua_pub.as_bytes()),
            &B64.encode(auth),
            payload,
        )
        .expect("encrypt");

        let salt: [u8; 16] = body[0..16].try_into().unwrap();
        assert_eq!(u32::from_be_bytes(body[16..20].try_into().unwrap()), 4096);
        assert_eq!(body[20], 65);
        let as_pub_bytes = &body[21..86];
        let ct = &body[86..];
        assert_eq!(as_pub_bytes[0], 0x04, "keyid is an uncompressed P-256 point");

        // Receiver side: ECDH(ua_private, as_public) + the same derivation.
        let as_point = p256::EncodedPoint::from_bytes(as_pub_bytes).unwrap();
        let as_public = p256::PublicKey::from_sec1_bytes(as_point.as_bytes()).unwrap();
        let ecdh = p256::elliptic_curve::ecdh::diffie_hellman(
            ua_secret.to_nonzero_scalar(),
            as_public.as_affine(),
        )
        .raw_secret_bytes()
        .to_vec();

        let prk_key = hmac_sha256(&auth, &ecdh);
        let mut key_info = b"WebPush: info\x00".to_vec();
        key_info.extend_from_slice(ua_pub.as_bytes());
        key_info.extend_from_slice(as_pub_bytes);
        let ikm = hkdf_expand(&prk_key, &key_info, 32);
        let prk = hmac_sha256(&salt, &ikm);
        let cek = hkdf_expand(&prk, b"Content-Encoding: aes128gcm\x00", 16);
        let nonce = hkdf_expand(&prk, b"Content-Encoding: nonce\x00", 12);

        let cipher = aes_gcm::Aes128Gcm::new_from_slice(&cek).unwrap();
        let mut plain = cipher
            .decrypt(aes_gcm::Nonce::from_slice(&nonce), ct)
            .expect("decrypt");
        // The padding delimiter must be present and be 0x02.
        assert_eq!(plain.pop(), Some(0x02));
        assert_eq!(plain, payload);
    }
}
