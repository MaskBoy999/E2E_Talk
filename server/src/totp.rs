//! Two-factor authentication: RFC 6238 TOTP (HMAC-SHA1, 6 digits, 30s step —
//! universally supported by authenticator apps) + one-time recovery codes.
//!
//! The TOTP secret is encrypted at rest with ChaCha20-Poly1305 using a key
//! derived from the server's JWT secret (SHA-256), so a DB dump never exposes
//! raw secrets. Recovery codes are stored as SHA-256(salt || code) hashes.

use chacha20poly1305::aead::{Aead, KeyInit};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::Rng;
use sha1::{Digest, Sha1};
use sha2::Sha256;

const TOTP_STEP_SECS: u64 = 30;
const TOTP_DIGITS: u32 = 6;

// --- Base32 (RFC 4648, no padding) ---

const B32_ALPHABET: &[u8; 32] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

pub fn base32_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() * 8 + 4) / 5);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for &b in data {
        buffer = (buffer << 8) | b as u32;
        bits += 8;
        while bits >= 5 {
            bits -= 5;
            out.push(B32_ALPHABET[((buffer >> bits) & 0x1f) as usize] as char);
        }
    }
    if bits > 0 {
        out.push(B32_ALPHABET[((buffer << (5 - bits)) & 0x1f) as usize] as char);
    }
    out
}

pub fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(s.len() * 5 / 8);
    let mut buffer: u32 = 0;
    let mut bits: u32 = 0;
    for c in s.trim().chars() {
        let v = match B32_ALPHABET.iter().position(|&x| x as char == c.to_ascii_uppercase()) {
            Some(i) => i as u32,
            None => return None,
        };
        buffer = (buffer << 5) | v;
        bits += 5;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Some(out)
}

// --- TOTP (RFC 6238) ---

pub fn generate_secret() -> String {
    let bytes: [u8; 20] = rand::thread_rng().gen();
    base32_encode(&bytes)
}

fn hmac_sha1(key: &[u8], data: &[u8]) -> [u8; 20] {
    const BLOCK: usize = 64;
    let mut k = [0u8; BLOCK];
    if key.len() > BLOCK {
        let h = Sha1::digest(key);
        k[..h.len()].copy_from_slice(&h);
    } else {
        k[..key.len()].copy_from_slice(key);
    }
    for b in k.iter_mut() {
        *b ^= 0x36;
    }
    let mut inner = Sha1::new();
    inner.update(k);
    inner.update(data);
    let inner_hash = inner.finalize();
    for b in k.iter_mut() {
        *b ^= 0x36 ^ 0x5c;
    }
    let mut outer = Sha1::new();
    outer.update(k);
    outer.update(inner_hash);
    let out = outer.finalize();
    let mut result = [0u8; 20];
    result.copy_from_slice(&out);
    result
}

fn hotp(secret: &[u8], counter: u64) -> String {
    let msg = counter.to_be_bytes();
    let mac = hmac_sha1(secret, &msg);
    let offset = (mac[19] & 0x0f) as usize;
    let bin = ((mac[offset] & 0x7f) as u64) << 24
        | ((mac[offset + 1] as u64) << 16)
        | ((mac[offset + 2] as u64) << 8)
        | (mac[offset + 3] as u64);
    let code = bin % 10u64.pow(TOTP_DIGITS);
    format!("{:0width$}", code, width = TOTP_DIGITS as usize)
}

pub fn totp_at(secret_b32: &str, unix_secs: u64) -> String {
    let bytes = match base32_decode(secret_b32) {
        Some(b) => b,
        None => return String::new(),
    };
    hotp(&bytes, unix_secs / TOTP_STEP_SECS)
}

/// Verify a 6-digit code within the given step window (default ±1).
pub fn verify_totp(secret_b32: &str, code: &str, window: u64) -> bool {
    let code = code.trim().to_string();
    if code.len() != TOTP_DIGITS as usize || !code.chars().all(|c| c.is_ascii_digit()) {
        return false;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let step = now / TOTP_STEP_SECS;
    for w in 0..=window {
        for &sign in &[1i64, -1i64] {
            let s = if w == 0 {
                step
            } else {
                let delta = (w as i64) * sign;
                if delta >= 0 {
                    step.saturating_add(delta as u64)
                } else {
                    step.saturating_sub(delta.unsigned_abs())
                }
            };
            if totp_at(secret_b32, s * TOTP_STEP_SECS) == code {
                return true;
            }
        }
    }
    false
}

/// Standard otpauth URI for QR enrollment.
pub fn otpauth_uri(issuer: &str, account: &str, secret_b32: &str) -> String {
    format!(
        "otpauth://totp/{}:{}?secret={}&issuer={}&algorithm=SHA1&digits={}&period={}",
        issuer,
        account,
        secret_b32,
        issuer,
        TOTP_DIGITS,
        TOTP_STEP_SECS
    )
}

// --- Recovery codes ---

pub fn generate_recovery_codes(count: usize) -> Vec<String> {
    const CHARS: &[u8] = b"ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    (0..count)
        .map(|_| {
            let mut code = String::with_capacity(10);
            let mut rng = rand::thread_rng();
            for _ in 0..10 {
                code.push(CHARS[rng.gen_range(0..CHARS.len())] as char);
            }
            code
        })
        .collect()
}

pub fn sha256_hex(data: &[u8]) -> String {
    let h = Sha256::digest(data);
    h.iter().map(|b| format!("{:02x}", b)).collect()
}

/// Hash a recovery code with the per-user salt (codes are case-insensitive).
pub fn hash_recovery_code(salt: &str, code: &str) -> String {
    sha256_hex(format!("{}{}", salt, code.trim().to_uppercase()).as_bytes())
}

// --- At-rest secret encryption (ChaCha20-Poly1305, key from JWT secret) ---

pub fn encrypt_secret(plaintext: &str, jwt_secret: &str) -> Result<(String, String), String> {
    let key = Sha256::digest(jwt_secret.as_bytes());
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let nonce_bytes: [u8; 12] = rand::thread_rng().gen();
    let ct = cipher
        .encrypt(Nonce::from_slice(&nonce_bytes), plaintext.as_bytes())
        .map_err(|e| format!("encrypt failed: {}", e))?;
    use base64::Engine;
    Ok((
        base64::engine::general_purpose::STANDARD.encode(ct),
        base64::engine::general_purpose::STANDARD.encode(nonce_bytes),
    ))
}

pub fn decrypt_secret(ct_b64: &str, nonce_b64: &str, jwt_secret: &str) -> Result<String, String> {
    use base64::Engine;
    let ct = base64::engine::general_purpose::STANDARD
        .decode(ct_b64)
        .map_err(|e| format!("bad ciphertext: {}", e))?;
    let nonce = base64::engine::general_purpose::STANDARD
        .decode(nonce_b64)
        .map_err(|e| format!("bad nonce: {}", e))?;
    if nonce.len() != 12 {
        return Err("bad nonce length".to_string());
    }
    let key = Sha256::digest(jwt_secret.as_bytes());
    let cipher = ChaCha20Poly1305::new(Key::from_slice(&key));
    let pt = cipher
        .decrypt(Nonce::from_slice(&nonce), ct.as_ref())
        .map_err(|_| "decrypt failed (wrong key or corrupted data)".to_string())?;
    String::from_utf8(pt).map_err(|_| "decrypted data not utf8".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base32_roundtrip() {
        let data = b"hello world 12345";
        let enc = base32_encode(data);
        assert_eq!(base32_decode(&enc).unwrap(), data);
    }

    #[test]
    fn known_otpauth_secret_roundtrip() {
        // RFC 4226 Appendix D vectors (HMAC-SHA1, 20 zero bytes = base32
        // "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"): counter 0 → 755224, 1 → 287082.
        let secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        let bytes = base32_decode(secret).unwrap();
        assert_eq!(hotp(&bytes, 0), "755224");
        assert_eq!(hotp(&bytes, 1), "287082");
        assert_eq!(hotp(&bytes, 2), "359152");
    }

    #[test]
    fn code_shape_and_window() {
        let secret = generate_secret();
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_secs();
        let code = totp_at(&secret, now);
        assert_eq!(code.len(), 6);
        assert!(code.chars().all(|c| c.is_ascii_digit()));
        assert!(verify_totp(&secret, &code, 1));
        assert!(!verify_totp(&secret, &format!("{:06}", (code.parse::<u32>().unwrap() + 1) % 1_000_000), 0));
        assert!(!verify_totp(&secret, "abc123", 1));
        assert!(!verify_totp(&secret, "12345", 1)); // too short
    }

    #[test]
    fn secret_encrypt_roundtrip() {
        let (ct, nonce) = encrypt_secret("ABCDEFGHIJKLMNOP", "test-jwt-secret").unwrap();
        assert_eq!(decrypt_secret(&ct, &nonce, "test-jwt-secret").unwrap(), "ABCDEFGHIJKLMNOP");
        assert!(decrypt_secret(&ct, &nonce, "wrong-secret").is_err());
    }

    #[test]
    fn recovery_code_hash_is_deterministic_and_case_insensitive() {
        let salt = "deadbeef";
        let a = hash_recovery_code(salt, "AbCdE12345");
        let b = hash_recovery_code(salt, "abcde12345");
        assert_eq!(a, b);
        assert_ne!(a, hash_recovery_code("other-salt", "abcde12345"));
    }
}
