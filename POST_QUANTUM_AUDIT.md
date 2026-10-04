# Post-quantum audit — every hidden thing, and what protects it

**Date:** 2026-10-04 · **Scope:** E2E_Talk server, web client, desktop/mobile shell,
push, voice, TURN, backups · **Decision stage:** pre-release, so migrations can be
breaking.

This document answers two questions for every piece of data the app hides:

1. Is it safe against a future quantum computer that records traffic (and the
   database) **today** and decrypts later — *harvest now, decrypt later* (HNDL)?
2. Is its **authentication** forgeable once such a machine exists?

Where the answer is no, the fix and the exact integration point are below.
`SECURITY_REVIEW_FIXES.md` §6.5 carries the ratchet/MLS half of the plan; this is
the algorithm-and-asset inventory that plan hangs off.

---

## 0. Executive summary

| # | What it protects | Primitive today | PQ-safe? | Action |
|---|---|---|---|---|
| 1 | Transport web/box ↔ server | TLS 1.3 via rustls 0.23.42 + aws-lc-rs 1.17.1 | **Yes — already hybrid** | None; keep a test that proves it |
| 2 | Server TLS certificate | Self-signed ECDSA P-256 (rcgen) | No (forgery), mitigated by pinning | Pin everywhere; adopt ML-DSA certs when rustls/webpki ship them |
| 3 | Message/key envelopes, per-server keys, key bundles, file keys | X25519 + HKDF-SHA256 + XChaCha20-Poly1305 | **No (HNDL)** | Hybrid X25519 + ML-KEM-768 with an envelope version byte |
| 4 | Offline notification escrow | X25519 + SHA-256 + XChaCha20-Poly1305 | **No (HNDL)** | Same hybrid KEM, Rust side |
| 5 | Login authentication | Ed25519 signature over a nonce | No (forgery → impersonation) | Hybrid Ed25519 + ML-DSA-65, verify both, store both |
| 6 | Voice/video media | WebRTC DTLS-SRTP + app-layer XChaCha20-Poly1305 frames | Transport: browser-dependent; key agreement: **No** | Hybridize the call-key envelopes; wait for DTLS 1.3 + ML-KEM for the transport leg |
| 7 | Web Push | P-256 ECDH + AES-128-GCM (RFC 8291), VAPID ES256 | No (HNDL of the transport layer) | Payload is already app-encrypted; hybridize that inner layer (item 4), track the spec |
| 8 | Symmetric at rest: messages, files, vault, backups | XChaCha20-Poly1305 / AES-256-GCM / Argon2id | **Yes** | None (256-bit keys keep 128-bit security under Grover) |
| 9 | Hashes/MACs: HMAC-SHA-256, HKDF, friend codes, search index, JWT HS256, TOTP | SHA-256 family | **Yes** | None |
| 10 | Metadata (who talks to whom, when, sizes) | no padding | Not a PQ problem | §6.4 padding/jitter work; unchanged |

The one item that is already done is also the biggest net win in practice:
**the TLS transport is post-quantum today** on every stack that ships
`X25519MLKEM768` — verified live against our server:

```
$ openssl s_client -connect 127.0.0.1:3443 -groups X25519MLKEM768 -brief
Protocol version: TLSv1.3
Ciphersuite: TLS_AES_256_GCM_SHA384
Negotiated TLS1.3 group: X25519MLKEM768
```

Everything from item 3 down is application-layer E2EE, which TLS does not
protect from an adversary who stores the database or recorded envelopes —
those need the migration below.

---

## 1. Inventory: what is hidden, and by what

### 1.1 Transport (web client, desktop box, Android WebView)

- Server: `server/src/main.rs` serves TLS with `axum-server` + rustls 0.23.42;
  `Cargo.lock` pins **aws-lc-rs 1.17.1**. rustls's `prefer-post-quantum`
  feature is enabled by default for the aws-lc-rs provider and prioritizes
  `X25519MLKEM768`. Proven with the OpenSSL probe above.
- Clients: Chrome/Edge/Firefox/Safari have sent the hybrid key share by default
  since late 2024/2025; Chromium-based WebView (Android, WebView2 on Windows)
  follows the bundled Chromium. WebKitGTK follows the distro's build.
- Because the group is *offered* and *preferred*, a passive recorder cannot
  decrypt a session later even if X25519 falls: the ML-KEM secret has to break
  too.

### 1.2 Server certificate (`server/src/main.rs` ~1090–1145)

`rcgen::KeyPair::generate()` produces an **ECDSA P-256** key; the certificate
is self-signed with a SAN list of local addresses. Two exposures:

- Signature forgery (ECDSA → Shor). A CRQC could mint a certificate for any
  host; whether it can impersonate *our* server depends on pinning.
- The box pins the server certificate after first contact (see the box shell
  and `SECURITY_REVIEW_FIXES.md`); browsers see a self-signed warning unless
  the operator installed it, so the pin is the real control. Pinning checks
  the exact certificate, so a forged chain is rejected — but any flow that
  re-TOFUs (a fresh install, or a user accepting a new cert) is exposed.

**Fix:** pinning stays mandatory (and should be asserted by tests), and we
adopt ML-DSA-65 certificates (`draft-ietf-lamps-dilithium-certificates` family)
when rustls/webpki and rcgen support them — not yet the case as of this date.
Until then, doubling down on pinning (and short-lived certs where practical) is
the available mitigation. Note: a PQ certificate signs the *key exchange* wider,
but the exchange itself is already hybrid.

### 1.3 Message and key envelopes (`static/crypto.js`)

The core E2EE primitive is static X25519 ECDH:

```js
function envelopeEncrypt(plaintext, recipientPublicKey, senderPrivateKey) {
    const shared = x25519SharedSecret(senderPrivateKey, recipientPublicKey);
    const key = hkdf(shared, shared, 'e2e-envelope-v1', 32);
    return _aeadEncryptRaw(plaintext, key, null, null);   // XChaCha20-Poly1305
}
```

Used for messages, per-server keys (`server_keys`), file keys, key bundles,
soundboard pairing and anything else wrapped to an identity key — 38 call
sites across `static/{crypto,chat,soundboard-pairing}.js`. Exposure: an
adversary who records envelopes **today** can derive the static private keys
from the public keys once a CRQC exists and decrypt every recorded
conversation — the classic HNDL case. Symmetric parts (HKDF-SHA-256,
XChaCha20-Poly1305) are fine; the X25519 agreement is the weak link.

**Fix (the single highest-value change):** version the envelope, then hybridize
it. Add a scheme marker (the HKDF label is already versioned, so a `v2` label
plus a marker byte in the JSON is enough):

```
ss = ML-KEM-768_ss || X25519_ss          // concatenate, order fixed
key = HKDF(ss, salt=handshake transcript, info="e2e-envelope-v2", 32)
```

`X-Wing` (CFRG, X25519+ML-KEM-768) is the standard combiner to follow. Both
public keys travel in the envelope; decryption tries v2 then v1. Security holds
unless *both* X25519 and ML-KEM break, and old clients keep reading v1 while
they upgrade.

Library choice on the web side: **libsodium has no ML-KEM** (its roadmap says
"eventually", with no timeline), so PQ comes from a second vendored library.
`@noble/post-quantum` implements FIPS 203/204/205 in auditable TypeScript and
is the pragmatic choice for this no-bundler, vendored-script codebase; vendor
it like the other libs and extend `tools/vendor-checksums.mjs` (its primitives
have survived two public review rounds; it is self-audited rather than
formally certified — acceptable for hybrid, since X25519 still gates security).
When the Web Crypto API gains ML-KEM
(chromestatus: "Add post-quantum cryptography … to Web Crypto"), migrate to
it. `libcrux`/formal-methods wasm builds are the conservative alternative.

### 1.4 Offline notification escrow (`server/src/db.rs` ~1867–1900)

The server encrypts queued notifications to the recipient's X25519 identity
key (ephemeral X25519 → SHA-256 → XChaCha20-Poly1305). Payloads are
content-free metadata, but the same HNDL math applies to whatever is inside.

**Fix:** same hybrid KEM as §1.3, in Rust. `aws-lc-rs` is already in the
dependency tree (via rustls) and supports ML-KEM; alternatively the pure-Rust
`ml-kem` crate (RustCrypto). The payload format gains a scheme byte, the
server keeps decryption compatible per version, and the client unwraps with
its hybrid private key.

### 1.5 Login authentication (`server/src/auth.rs`, `static/crypto.js`)

Today: Ed25519 keypair derived from `HMAC(hash_key, password)`; the server
stores the public half and accepts a nonce-bound signature. A CRQC forges
Ed25519 signatures, i.e. can log in as any account and mint sessions. This is
forgery, not decryption, so there is no HNDL race — but migration must happen
before CRQCs exist.

**Fix:** hybrid signatures. The client generates ML-DSA-65 alongside Ed25519
(deriving it from the same `hash_key`/password material is fine and keeps the
"password is the root" property), sends both public keys, and signs the same
challenge with both. The server verifies **both** signatures and only accepts
an account when the stored key set is complete. `login_public_key` becomes a
small JSON blob with a version field; old Ed25519-only accounts keep working
until password change / registration re-keys them. Server-side
`ml-dsa` (RustCrypto) or aws-lc-rs. Registration and password change already
require a key, so there is one code path to extend.

### 1.6 Voice/video (`static/voice.js`, `static/crypto.js`)

Two layers:

- **DTLS-SRTP** between peers (browser-managed). PQ for this leg depends on
  DTLS 1.3 + ML-KEM in browsers; the W3C WebRTC PQ issue is still open, so a
  recorder with a CRQC could eventually decrypt recorded SRTP. Nothing
  app-side can change this leg today; track it.
- **App-layer frame encryption** (`encryptMediaFrame`, XChaCha20-Poly1305 with
  a per-call symmetric key). The cipher is PQ-safe; the *key agreement* for it
  is X25519 via §1.3, which is HNDL-vulnerable.

**Fix:** hybridize the call-key envelopes (they ride the same envelope version
byte), so recorded call keys are safe. The SRTP leg remains the residual risk.

### 1.7 Web Push / FCM (`server/src/push.rs`)

Web Push payloads are encrypted with the subscriber's P-256 key per RFC 8291
and signed with VAPID ES256; FCM is a bearer transport. The payload contract is
already content-free (title/body/tag/url), and the title/body are themselves
derived from the app's E2EE layer. So the practical risk is limited to
metadata, but the RFC 8291 layer is P-256 (HNDL) and cannot be fixed app-side.

**Fix:** make sure the inner payload remains app-encrypted with the hybrid
envelope (§1.4) so a push service or CRQC breaking P-256 still gets only
metadata; track the Web Push PQ work. VAPID is signature-only — no secrecy
impact.

### 1.8 Symmetric and hash-layer (already fine)

- XChaCha20-Poly1305, AES-256-GCM: Grover gives at most a square-root speedup;
  256-bit keys retain ~128-bit security. No change.
- HKDF-SHA-256, HMAC-SHA-256 (friend codes, search blind index, TURN creds,
  notification privacy hashes), JWT HS256: MAC/KDF uses of SHA-256 are not
  broken by Shor and remain ≥128-bit under Grover. No change.
- Argon2id (vault, escrow, password wrapping, backups): PQ-safe.
- TOTP (HMAC-SHA1): PQ-safe.
- Admin backup v2 (Argon2id + AES-GCM): PQ-safe; the v1 importer
  (`tests/admin-backup.spec.ts`) is password-based too. No ECDH involved.

### 1.9 Metadata and traffic analysis

Not a PQ problem (§6.4): padding, jitter, size buckets. A CRQC does not make
metadata more readable — it is already visible. The E2EE migrations above do
not change it.

---

## 2. Migration plan

**Phase 0 — now (no wire changes)**
1. Keep the TLS hybrid claim honest: add a test that fails if the negotiated
   TLS group ever stops being hybrid (OpenSSL in CI, or a rustls assertion
   that `X25519MLKEM768` is in the provider's default group list).
2. Vendor `@noble/post-quantum` (ML-KEM, ML-DSA) with the usual checksum
   pinning, behind `static/libs/`, and add it to the vendor-integrity test.
3. Add Rust `ml-kem` (+ `ml-dsa` when the server starts verifying signatures)
   and a small `pq.rs` module with KATs from the NIST ACVP vectors.

**Phase 1 — envelopes (the big win)**
4. Envelope v2: hybrid KEM as §1.3, decryption falls back to v1; old peers keep
   reading v1. Roll out client-first, server-side escrow next (§1.4).
5. Capability flag via `/api/client-config` so peers know when everyone is v2;
   never strip a v2 marker silently — the marker is inside the AEAD, so
   downgrade requires breaking the label, not just deleting a field.

**Phase 2 — signatures**
6. Login key v2 (Ed25519 + ML-DSA-65), verify both, re-key on password change
   and registration; a later phase drops Ed25519-only acceptance — which is
   safe here precisely because legacy fallbacks were removed (see
   `SECURITY_REVIEW_FIXES.md` §6.3): there is exactly one signing path.

**Phase 3 — protocol**
7. Double ratchet for 1:1 and MLS for groups (§6.5), with PQ ciphersuites
   (ML-KEM-based) selected by the same version byte. This is also what makes
   *future* keys safe, not just recorded ones.

**Phase 4 — dependencies**
8. Re-check each external leg when it ships: DTLS 1.3 ML-KEM (voice),
   Web Push PQ, ML-DSA X.509 in rustls/webpki (server cert), browser WebCrypto
   ML-KEM (replaces the vendored JS).

---

## 3. What cannot be fixed app-side (residual)

- **WebRTC DTLS-SRTP**: browser-managed; no PQ key exchange shipped yet. The
  app-layer frame encryption narrows the window but recorded SRTP plus a CRQC
  remains a risk.
- **Web Push RFC 8291**: P-256 fixed by the spec; only the inner payload can
  be made PQ-safe.
- **Certificate PKI**: ML-DSA certificate validation is standards-track but
  not in rustls/webpki today; pinning is the interim control.
- **Anything a client device leaks** (compromised endpoint) is out of scope for
  every scheme here.

## 4. Verification

- TLS: `echo | openssl s_client -connect 127.0.0.1:3443 -groups X25519MLKEM768 -brief`
  must print `Negotiated TLS1.3 group: X25519MLKEM768` (run it in CI against
  the built server; today's result is in §0).
- Envelopes: KATs for ML-KEM-768 from the ACVP vectors plus round-trip tests
  for v2/v1 fallback in `tests/` (Playwright, in-page `E2ECrypto`).
- Signatures: cross-verify Ed25519+ML-DSA-65 with a Rust implementation in CI
  so client and server never drift.
- Rollout: `tests/` gains a "v2 envelope is produced for a peer that advertises
  v2" test, mirroring the existing sandbox/isolation patterns.

## 5. References

- NIST FIPS 203 (ML-KEM), FIPS 204 (ML-DSA), FIPS 205 (SLH-DSA); NIST IR 8547
  (transition: deprecate classical public-key crypto by 2030, disallow by 2035).
- rustls `prefer-post-quantum` (docs.rs/rustls) — X25519MLKEM768 default with
  aws-lc-rs; verified locally against OpenSSL 3.5.6.
- Signal PQXDH (X25519 + ML-KEM-768) — the design precedent for §1.3/1.5.
- `@noble/post-quantum` (FIPS 203/204/205, browser-friendly) — vendored
  alternative while libsodium has no ML-KEM (libsodium discussion #1275:
  roadmap, no timeline).
- WebRTC PQ issue (w3c/webrtc-extensions#207): DTLS 1.3 first; unresolved.
- Web Crypto PQ proposal (chromestatus): ML-KEM/ML-DSA in the platform API.
