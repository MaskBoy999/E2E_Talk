use std::path::Path;

#[derive(Clone, Debug)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub jwt_secret: String,
    pub hmac_key: String,
    pub tls_cert_path: Option<String>,
    pub tls_key_path: Option<String>,
}

fn load_or_generate_key(env_var: &str, prefix: &str) -> String {
    if let Ok(val) = std::env::var(env_var) {
        if !val.is_empty() {
            return val;
        }
    }
    // Try loading from .env file
    let env_path = Path::new(".env");
    if let Ok(contents) = std::fs::read_to_string(env_path) {
        for line in contents.lines() {
            let line = line.trim();
            let eq_pos = match line.find('=') {
                Some(pos) => pos,
                None => continue,
            };
            let key_part = &line[..eq_pos];
            let val_part = &line[eq_pos+1..];
            if key_part.trim() == prefix {
                let val = val_part.trim().trim_matches('"').trim_matches('\'');
                if !val.is_empty() {
                    return val.to_string();
                }
            }
        }
    }
    // Generate a new key
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let key: String = (0..64)
        .map(|_| {
            let idx = rng.gen_range(0..62);
            b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"[idx] as char
        })
        .collect();
    // Persist to .env
    if let Ok(mut contents) = std::fs::read_to_string(env_path) {
        contents.push_str(&format!("{} = {}\n", prefix, key));
        if let Err(e) = std::fs::write(env_path, &contents) {
            eprintln!("WARNING: Could not write {} to .env: {}", prefix, e);
        }
    } else {
        let new_line = format!("{} = {}\n", prefix, key);
        if let Err(e) = std::fs::write(env_path, &new_line) {
            eprintln!("WARNING: Could not write .env file: {}", e);
        }
    }
    key
}

impl Config {
    pub fn from_env() -> Self {
        // Ensure .env exists before loading keys
        let _ = std::fs::write(Path::new(".env"), "").ok();
        
        let jwt_secret = load_or_generate_key("JWT_SECRET", "JWT_SECRET");
        let hmac_key = load_or_generate_key("HMAC_KEY", "HMAC_KEY");

        Self {
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "3000".to_string())
                .parse()
                .unwrap_or(3000),
            database_url: std::env::var("DATABASE_URL")
                .unwrap_or_else(|_| "e2e_chat.db".to_string()),
            jwt_secret,
            hmac_key,
            tls_cert_path: std::env::var("TLS_CERT_PATH").ok(),
            tls_key_path: std::env::var("TLS_KEY_PATH").ok(),
        }
    }
}
