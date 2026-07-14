#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub jwt_secret: String,
}

impl Config {
    pub fn from_env() -> Self {
        let jwt_secret = match std::env::var("JWT_SECRET") {
            Ok(secret) if !secret.is_empty() => secret,
            _ => {
                use rand::Rng;
                let mut rng = rand::thread_rng();
                let secret: String = (0..64)
                    .map(|_| {
                        let idx = rng.gen_range(0..62);
                        b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[idx] as char
                    })
                    .collect();
                eprintln!("WARNING: JWT_SECRET not set. Generated random secret. Set JWT_SECRET env var for production use.");
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
        }
    }
}
