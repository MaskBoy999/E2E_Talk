use argon2::{
    password_hash::{PasswordHasher, SaltString},
    Argon2, PasswordHash, PasswordVerifier,
};
use jsonwebtoken::{decode, encode, DecodingKey, EncodingKey, Header, Validation};
use rand::rngs::OsRng;
use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct Claims {
    pub sub: String,
    pub username: String,
    pub exp: usize,
    /// Server-side session id (auth_sessions.id). Required: tokens minted
    /// before this field existed fail to decode and the user re-logs in once.
    pub sid: String,
    /// Optional token purpose. Set to Some("2fa_pending") on the short-lived
    /// token minted after a successful password check when the account has 2FA
    /// enabled — the holder must still present a TOTP/recovery code.
    #[serde(default)]
    pub purpose: Option<String>,
    /// Requested session duration (seconds), carried on the 2FA pending token so
    /// the client's Settings choice survives the two-step login.
    #[serde(default)]
    pub duration_secs: Option<u64>,
}

pub fn hash_password(password: &str) -> Result<String, String> {
    let salt = SaltString::generate(&mut OsRng);
    let argon2 = Argon2::default();
    let hash = argon2
        .hash_password(password.as_bytes(), &salt)
        .map_err(|e| e.to_string())?;
    Ok(hash.to_string())
}

pub fn verify_password(password: &str, hash: &str) -> Result<bool, String> {
    let parsed_hash =
        PasswordHash::new(hash).map_err(|e| format!("Invalid password hash: {}", e))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

// --- H3: server-side password verifier (kills pass-the-hash) ---
// The client sends a deterministic credential (HMAC-SHA256(hash_key, password)
// for new accounts, the raw password for legacy ones). Storing that value
// verbatim made the DB row a replayable password-equivalent — anyone with a
// dump could log in without knowing the password. The server now stores a
// slow Argon2id hash of the credential (`$e2e$` prefix) instead, so a dump is
// never directly replayable at /api/login. Format detection:
//   `$e2e$<argon2id>`   – Argon2id of the client credential (current scheme)
//   `$argon2id$...`     – legacy server hash of the RAW password (pre-hash era)
//   anything else       – insecure bare client credential; upgraded in place on
//                         the first successful verification.
pub const E2E_VERIFIER_PREFIX: &str = "$e2e$";

pub fn hash_user_verifier(credential: &str) -> Result<String, String> {
    // The credential is a 256-bit client HMAC (high entropy), so pass-the-hash
    // is defeated by ANY one-way hash. We use 64 MiB / 3 iterations for a
    // stronger security margin against offline brute-force if the DB is leaked.
    let params = argon2::Params::new(65536, 3, 1, None).map_err(|e| e.to_string())?;
    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let salt = SaltString::generate(&mut OsRng);
    let hash = argon2
        .hash_password(credential.as_bytes(), &salt)
        .map_err(|e| e.to_string())?;
    Ok(format!("{}{}", E2E_VERIFIER_PREFIX, hash))
}

pub fn verify_user_verifier(credential: &str, stored: &str) -> Result<bool, String> {
    if let Some(inner) = stored.strip_prefix(E2E_VERIFIER_PREFIX) {
        verify_password(credential, inner)
    } else if stored.starts_with("$argon2") {
        // Legacy account: stored value is a server-side Argon2id hash of the
        // raw password (the legacy client fallback sends the raw password).
        verify_password(credential, stored)
    } else {
        // Insecure legacy-client-hash scheme: constant-time compare; the caller
        // upgrades the stored value on success.
        use subtle::ConstantTimeEq;
        Ok(credential.as_bytes().ct_eq(stored.as_bytes()).into())
    }
}

pub fn verifier_needs_upgrade(stored: &str) -> bool {
    !stored.starts_with(E2E_VERIFIER_PREFIX) && !stored.starts_with("$argon2")
}

/// Issue a token with a caller-chosen lifetime. Callers (login/register/reauth)
/// pass a duration chosen in Settings (clamped server-side to 30 days max);
/// missing duration falls back to the 30-day default.
pub fn create_token_with_duration(
    user_id: &str,
    username: &str,
    session_id: &str,
    secret: &str,
    duration: chrono::Duration,
) -> Result<String, String> {
    let claims = Claims {
        sub: user_id.to_string(),
        username: username.to_string(),
        sid: session_id.to_string(),
        purpose: None,
        duration_secs: None,
        exp: chrono::Utc::now()
            .checked_add_signed(duration)
            .unwrap()
            .timestamp() as usize,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| e.to_string())
}

/// Short-lived token proving the password step passed; the 2FA code is still
/// required before a real session is minted. No session row is created here.
/// `purpose` is "2fa_pending" for a normal login or "kill_switch_pending" for
/// a Kill Switch login (code verified -> account deleted, shown as a failure).
pub fn create_pending_2fa_token(
    user_id: &str,
    username: &str,
    secret: &str,
    duration: chrono::Duration,
    duration_secs: u64,
    purpose: &str,
) -> Result<String, String> {
    let claims = Claims {
        sub: user_id.to_string(),
        username: username.to_string(),
        sid: String::new(),
        purpose: Some(purpose.to_string()),
        duration_secs: Some(duration_secs),
        exp: chrono::Utc::now()
            .checked_add_signed(duration)
            .unwrap()
            .timestamp() as usize,
    };
    encode(
        &Header::default(),
        &claims,
        &EncodingKey::from_secret(secret.as_bytes()),
    )
    .map_err(|e| e.to_string())
}

pub fn validate_token(token: &str, secret: &str) -> Result<Claims, String> {
    decode::<Claims>(
        token,
        &DecodingKey::from_secret(secret.as_bytes()),
        &Validation::default(),
    )
    .map(|data| data.claims)
    .map_err(|e| e.to_string())
}
