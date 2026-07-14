#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub jwt_secret: String,
    pub tls_cert_path: Option<String>,
    pub tls_key_path: Option<String>,
}

impl Config {
    pub fn from_env() -> Self {
        let jwt_secret = match std::env::var("JWT_SECRET") {
            Ok(secret) if !secret.is_empty() => secret,
            _ => {
                // Try loading from .env file in the server directory
                let env_path = std::path::Path::new(".env");
                if let Ok(contents) = std::fs::read_to_string(env_path) {
                    for line in contents.lines() {
                        let line = line.trim();
                        if let Some(val) = line.strip_prefix("JWT_SECRET=") {
                            let val = val.trim().trim_matches('"').trim_matches('\'');
                            if !val.is_empty() {
                                return Self {
                                    port: std::env::var("PORT")
                                        .unwrap_or_else(|_| "3000".to_string())
                                        .parse()
                                        .unwrap_or(3000),
                                    database_url: std::env::var("DATABASE_URL")
                                        .unwrap_or_else(|_| "e2e_chat.db".to_string()),
                                    jwt_secret: val.to_string(),
                                    tls_cert_path: std::env::var("TLS_CERT_PATH").ok(),
                                    tls_key_path: std::env::var("TLS_KEY_PATH").ok(),
                                };
                            }
                        }
                    }
                }

                // Generate a new secret and persist it
                use rand::Rng;
                let mut rng = rand::thread_rng();
                let secret: String = (0..64)
                    .map(|_| {
                        let idx = rng.gen_range(0..62);
                        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[idx]
                            as char
                    })
                    .collect();

                // Write to .env file for persistence across restarts
                let env_line = format!("JWT_SECRET={}\n", secret);
                if let Err(e) = std::fs::write(env_path, &env_line) {
                    eprintln!("WARNING: Could not write .env file: {}. Tokens will not persist across restarts.", e);
                } else {
                    eprintln!("Generated and saved JWT_SECRET to .env");
                }

                secret
            }
        };

        Self {
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "3000".to_string())
                .parse()
                .unwrap_or(3000),
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "e2e_chat.db".to_string()),
            jwt_secret,
            tls_cert_path: std::env::var("TLS_CERT_PATH").ok(),
            tls_key_path: std::env::var("TLS_KEY_PATH").ok(),
        }
    }
}
