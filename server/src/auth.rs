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
pub fn create_pending_2fa_token(
    user_id: &str,
    username: &str,
    secret: &str,
    duration: chrono::Duration,
    duration_secs: u64,
) -> Result<String, String> {
    let claims = Claims {
        sub: user_id.to_string(),
        username: username.to_string(),
        sid: String::new(),
        purpose: Some("2fa_pending".to_string()),
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
