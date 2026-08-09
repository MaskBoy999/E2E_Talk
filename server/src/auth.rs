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
