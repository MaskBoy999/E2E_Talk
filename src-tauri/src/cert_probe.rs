//! TOFU certificate probing (plan §A3.11).
//!
//! The server presents a **self-signed** certificate (it lives behind
//! Tailscale), so we cannot use the WebPKI trust stores. Instead we pin the
//! certificate's SHA-256 fingerprint on first trust ("Trust On First Use")
//! and refuse any future certificate whose fingerprint differs — a swapped or
//! MITM certificate is refused instead of silently accepted.
//!
//! Everything here is deliberately dependency-light: `reqwest` already ships
//! rustls (via its `rustls-tls` feature), so we reuse the *same* rustls version
//! for the hand-rolled probe and for the custom verifier handed back to
//! `reqwest`.

use std::sync::Arc;
use std::time::Duration;

use sha2::{Digest, Sha256};

/// The rustls crypto provider used for the probe. `reqwest`'s `rustls-tls`
/// feature enables `ring`, so this never adds a second provider to the build.
fn provider() -> Arc<rustls::crypto::CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hasher
        .finalize()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Why a probe could not come back with a certificate.
///
/// The distinction exists for the launch path, not for this module: on mobile a
/// saved address is probed before the app window is opened, and the two failure
/// kinds want opposite responses. An address that **refuses** the connection is
/// genuinely "there is no page at this IP/port", so the setup screen is the
/// right screen. An address that cannot be *reached* yet (Tailscale still coming
/// up, a slow first handshake, DNS not ready) is just a slow start — sending the
/// user to re-type an address that is perfectly correct is the box's oldest
/// complaint.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProbeFailure {
    /// The address answered and refused: nothing is listening on that port.
    Refused,
    /// Could not tell — timeout, DNS, a TLS failure, no certificate.
    Unknown(String),
}

impl std::fmt::Display for ProbeFailure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeFailure::Refused => {
                write!(f, "Connection refused — nothing is listening on that port")
            }
            ProbeFailure::Unknown(detail) => write!(f, "{detail}"),
        }
    }
}

/// SHA-256 over the host's leaf certificate (DER), lowercase hex.
///
/// Blocking (raw TCP + TLS handshake) — call it from
/// `tauri::async_runtime::spawn_blocking`, never directly on the UI thread.
pub fn fingerprint_of(url: &str) -> Result<String, String> {
    fingerprint_of_classified(url).map_err(|e| e.to_string())
}

/// [`fingerprint_of`], but telling "nothing is listening" apart from "could not
/// reach it yet" — see [`ProbeFailure`].
pub fn fingerprint_of_classified(url: &str) -> Result<String, ProbeFailure> {
    let url = url::Url::parse(url)
        .map_err(|e| ProbeFailure::Unknown(format!("Invalid address: {e}")))?;
    let host = url
        .host_str()
        .ok_or_else(|| ProbeFailure::Unknown("Address has no host".to_string()))?
        .to_string();
    let port = url.port().unwrap_or(443);

    Ok(sha256_hex(&tls_leaf_der(&host, port)?))
}

/// First and last few characters of a fingerprint, for log lines: enough to
/// compare against what the setup screen shows, without printing 64 hex digits.
pub fn short_fingerprint(hex: &str) -> String {
    if hex.len() <= 24 {
        return hex.to_string();
    }
    format!("{}…{}", &hex[..8], &hex[hex.len() - 8..])
}

/// The message shown when the live certificate does not match the pin.
pub fn mismatch_message() -> String {
    "The server's certificate changed since you trusted it. If you rotated \
     the certificate yourself, re-run setup and tick \"Trust this server\" \
     again — otherwise DO NOT connect: this can indicate a man-in-the-middle."
        .to_string()
}

/// A `reqwest` client that verifies the server certificate against the given
/// TOFU fingerprint (when present) instead of the WebPKI trust stores.
///
/// With no pin yet (first contact) any certificate is accepted — that is the
/// "trust on first use" moment the setup screen makes explicit.
pub fn pinned_client(pinned_hex: Option<&str>, _url: &str) -> Result<reqwest::Client, String> {
    let builder = reqwest::Client::builder().timeout(Duration::from_secs(8));
    let builder = match pinned_hex {
        Some(expected) => {
            let verifier = FingerprintVerifier {
                expected: expected.to_ascii_lowercase(),
            };
            let config = rustls::ClientConfig::builder_with_provider(provider())
                .with_safe_default_protocol_versions()
                .map_err(|e| e.to_string())?
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(verifier))
                .with_no_client_auth();
            builder
                .use_rustls_tls()
                .use_preconfigured_tls(config)
        }
        None => builder.danger_accept_invalid_certs(true),
    };
    builder.build().map_err(|e| e.to_string())
}

// ── rustls plumbing ──────────────────────────────────────────────────────

/// Verifies a certificate by comparing its SHA-256 to the pinned fingerprint.
/// Hostname verification is intentionally skipped — the fingerprint is the
/// trust anchor (that is what makes this work with a self-signed cert).
#[derive(Debug)]
struct FingerprintVerifier {
    expected: String,
}

impl rustls::client::danger::ServerCertVerifier for FingerprintVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if sha256_hex(end_entity.as_ref()) == self.expected {
            Ok(rustls::client::danger::ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(mismatch_message()))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &provider().signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &rustls::pki_types::CertificateDer<'_>,
        dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &provider().signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

/// Accepts any certificate. Used **only** for the TOFU *capture* handshake
/// (`fingerprint_of`), which then records what the user saw first.
#[derive(Debug)]
struct AnyCertVerifier;

impl rustls::client::danger::ServerCertVerifier for AnyCertVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        provider()
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The distinction the mobile launch rule rests on.
    ///
    /// A port with nothing listening must come back as `Refused` ("there is no
    /// page at this IP/port" → the address screen), never as `Unknown` ("could
    /// not tell yet" → open the app anyway). Localhost with a port in the
    /// reserved range refuses immediately, so this needs no network and no
    /// fixture server.
    #[test]
    fn a_refused_port_is_refused_not_unknown() {
        assert_eq!(
            fingerprint_of_classified("https://127.0.0.1:1").unwrap_err(),
            ProbeFailure::Refused
        );
    }

    /// Anything that never reaches the network is `Unknown`, i.e. "could not
    /// tell" — it must not be treated as evidence that the host is gone.
    #[test]
    fn an_unusable_address_is_unknown_not_refused() {
        assert!(matches!(
            fingerprint_of_classified("not an address").unwrap_err(),
            ProbeFailure::Unknown(_)
        ));
        assert!(matches!(
            fingerprint_of_classified("https:///no-host").unwrap_err(),
            ProbeFailure::Unknown(_)
        ));
    }

    /// The setup screen and the log lines show this verbatim, so the refused case
    /// must say what a user can act on.
    #[test]
    fn the_refused_message_names_the_problem() {
        let msg = ProbeFailure::Refused.to_string();
        assert!(msg.contains("refused"), "{msg}");
    }
}

/// Blocking TLS handshake used by `fingerprint_of` — connects, completes the
/// handshake, and returns the peer leaf certificate (DER).
fn tls_leaf_der(host: &str, port: u16) -> Result<Vec<u8>, ProbeFailure> {
    use std::io::{ErrorKind, Read, Write};
    use std::net::{TcpStream, ToSocketAddrs};

    // Resolve and bound the connect: an unreachable host (Tailscale down, wrong
    // IP) otherwise holds the OS SYN retries for ~20s, and this runs on the
    // launch path — a slow probe must not look like a hung app.
    let addr = format!("{host}:{port}");
    let candidates = (host, port)
        .to_socket_addrs()
        .map_err(|e| ProbeFailure::Unknown(format!("Cannot resolve {addr}: {e}")))?;
    let mut sock = None;
    let mut last_err = String::new();
    // `Refused` is claimed only when *every* resolved address refused: a hostname
    // that resolves to an IPv4 and an IPv6 address where only the last one is
    // refused is "could not reach", not "nothing is listening".
    let mut attempted = 0usize;
    let mut all_refused = true;
    for candidate in candidates {
        attempted += 1;
        match TcpStream::connect_timeout(&candidate, Duration::from_secs(5)) {
            Ok(s) => {
                sock = Some(s);
                break;
            }
            Err(e) => {
                if e.kind() != ErrorKind::ConnectionRefused {
                    all_refused = false;
                }
                last_err = e.to_string();
            }
        }
    }
    let sock = match sock {
        Some(s) => s,
        // Nothing is listening on that port — a definitive answer.
        None if attempted > 0 && all_refused => return Err(ProbeFailure::Refused),
        // A timeout, an unreachable network, an empty resolution: no answer.
        None => {
            return Err(ProbeFailure::Unknown(format!(
                "TCP connect to {addr} failed: {last_err}"
            )))
        }
    };
    sock.set_read_timeout(Some(Duration::from_secs(8))).ok();
    sock.set_write_timeout(Some(Duration::from_secs(8))).ok();

    let config = rustls::ClientConfig::builder_with_provider(provider())
        .with_safe_default_protocol_versions()
        .map_err(|e| ProbeFailure::Unknown(e.to_string()))?
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AnyCertVerifier))
        .with_no_client_auth();

    let server_name = rustls::pki_types::ServerName::try_from(host.to_string())
        .map_err(|_| ProbeFailure::Unknown(format!("Invalid host name: {host}")))?;

    let conn = rustls::ClientConnection::new(Arc::new(config), server_name)
        .map_err(|e| ProbeFailure::Unknown(e.to_string()))?;
    let mut tls = rustls::StreamOwned::new(conn, sock);

    // Send a minimal HTTP request; the handshake completes on the first read.
    let _ = tls.write_all(b"GET / HTTP/1.1\r\nConnection: close\r\n\r\n");
    let mut buf = [0u8; 512];
    let _ = tls.read(&mut buf);

    tls.conn
        .peer_certificates()
        .and_then(|certs| certs.first())
        .map(|c| c.as_ref().to_vec())
        .ok_or_else(|| ProbeFailure::Unknown("Server presented no certificate".to_string()))
}
