# COTURN — calls that survive mobile data (FEATURE_PLAN 7.1 / 7.2)

STUN-only WebRTC fails for a large share of phones on cellular/hotel/corporate
NATs: the call simply never connects. The server already plumbs TURN
(`server/src/config.rs` → `GET /api/voice/turn-config`); this is the other
half — a relay, with **time-limited credentials** instead of one static shared
password.

## 1. Run coturn with `use-auth-secret`

`/etc/turnserver.conf`:

```ini
listening-port=3478
tls-listening-port=5349
fingerprint
lt-cred-mech                # authenticate with HMAC, not a user db
use-auth-secret             # ← the shared-secret mode this app mints for
static-auth-secret=CHANGE_ME_LONG_RANDOM
realm=e2e-chat.example.com

# Relay ports — open these on the firewall/UDP as well as TCP 3478/5349:
min-port=49152
max-port=65535

# Hardening: the relay only ever carries THIS app's media
no-multicast-peers
no-cli
# Real deployments: certbot cert for TLS (turns:)
#cert=/etc/letsencrypt/live/example.com/fullchain.pem
#pkey=/etc/letsencrypt/live/example.com/privkey.pem
```

Generate the secret once: `openssl rand -base64 32`.

Docker:

```bash
docker run -d --name coturn --network=host \
  -e STATIC_AUTH_SECRET="$(openssl rand -base64 32)" \
  -e REALM=e2e-chat.example.com \
  coturn/coturn -n --use-auth-secret --fingerprint \
  --realm=e2e-chat.example.com
```

Firewall: UDP **and** TCP 3478, 5349, and UDP 49152–65535 (the relay range —
without the range, allocations fail and calls fall back to "connects on Wi-Fi,
dies on mobile data", the exact symptom this fixes).

## 2. Point the server at it

`.env` next to the server binary:

```bash
TURN_URLS=turn:turn.example.com:3478,turns:turn.example.com:5349
# MUST be byte-identical to coturn's static-auth-secret:
TURN_SECRET=CHANGE_ME_LONG_RANDOM
# Optional (seconds, default 3600):
# TURN_TTL=3600
```

With `TURN_SECRET` set, every `/api/voice/turn-config` response mints:

- `username` = `<expiry-unix>:<user-id>`
- `credential` = `base64(HMAC-SHA1(TURN_SECRET, username))`

— exactly what coturn's `use-auth-secret` computes on every Allocate. The
credential stops working when its expiry passes; nothing has to be rotated by
hand, and a credential captured from one client relays only that client's
traffic until it expires.

**Legacy:** without `TURN_SECRET`, the static `TURN_USERNAME`/`TURN_PASSWORD`
pair is served unchanged (fine for a home lab; a leaked one works until you
rotate it).

## 3. Verify

```bash
# The endpoint must return a username shaped like 1760000000:<uuid>:
curl -sk -H "Authorization: Bearer $TOKEN" https://your-box:3443/api/voice/turn-config

# The relay itself (from a phone network, not just your LAN):
turnutils_uclient -u <username> -w <credential> turn.example.com
# …or in the app: join a call on cellular — audio connects, and
# chrome://webrtc-internals (desktop) shows `relay` candidate pairs.
```

Unit tests pin the HMAC to RFC 2202: `cd server && cargo test turn_credential`.
