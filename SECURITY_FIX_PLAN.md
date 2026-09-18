# Security fix plan (verified against the live codebase)

Written 2026-09-18. Every claim below was verified by reading the source **and** by running
real browser probes (`tests/_probe-security-storage.spec.ts`,
`tests/_probe-security-storage2.spec.ts`) against the running server plus a raw byte scan of
the live SQLite file. Where a claim is inference rather than measurement it says so.

Read this whole file before editing: §1 (findings) changes what "fix #2" even means, and §3
(fix #1) has an **ordering trap** that destroys data if you do it in the wrong order.

---

## 0. TL;DR

| # | Claim in the audit | Verdict | What to actually do |
|---|---|---|---|
| 1 | Role names stored in plaintext | **TRUE, confirmed on disk** | Wipe/ignore the `name` column, ship encrypted names in the members API, 3 ordered phases (§3) |
| 2 | Identity private keys raw in localStorage | **FALSE today** — they are XOR-wrapped | Add a regression test that locks the invariant, then fix the *real* problem (§4) |
| 3 | XOR storage cipher is weak | **TRUE, and worse than stated** | Swap the cipher to XChaCha20-Poly1305 via libsodium (already loaded), keep XOR read-only for legacy values (§5) |

Cheapest order: **§3 phase A → §3 phase B → §3 phase C → §5 → §4 (test only)**.

---

## 1. Verified findings

### 1.1 Role names are genuinely in the database in plaintext (HIGH, real)

Probe: created a server + role through real client crypto, then scanned the live DB bytes.

```
server/e2e_chat.db-wal  "Top Secret Role" : 1      <-- role name, plaintext on disk
server/e2e_chat.db-wal  "Secret Lab"      : 0      <-- server name, encrypted (control)
server/e2e_chat.db-wal  "General Voice"   : 0      <-- voice channel name, encrypted (control)
```

The API also returns it in cleartext:

```
GET /api/servers/{sid}/roles
  "name": "Top Secret Role",          <-- plaintext
  "encrypted_name": "2lmElKDVxFK6htQMJvcrQ9muhlDzmB111z6DTkk6iU...",
  "name_nonce": "AaJ6nwHNgDO+5GlSktNkx0/6MGM1g2bV"
```

The controls prove the scanner works and that the rest of the app really is E2EE — role names
are the one exception.

Every place `server_roles.name` is touched:

| File | Line | What it does |
|---|---|---|
| `server/src/db.rs` | 8449 | `ensure_everyone_role_c` inserts `'@everyone'` as plaintext |
| `server/src/db.rs` | 8469 | `list_server_roles` selects `name` **and sorts by it** (`ORDER BY position DESC, name ASC`) |
| `server/src/db.rs` | 8497 | `get_role` selects `name` |
| `server/src/db.rs` | 8510 | `create_role` inserts `name` |
| `server/src/db.rs` | 8546 / 8554 | `update_role` writes `name` on every update (incl. pure reorders) |
| `server/src/db.rs` | 8805 | `get_server_members_with_roles` left-joins `r.name` → `role_name` |
| `server/src/handlers.rs` | 3365 | `role_json` emits `"name": role.name` |
| `server/src/handlers.rs` | 3320 | members endpoint emits `"role_name": m.role_name` |
| `static/roles.js` | 863–871 | `decryptRoleName()` falls back to `role.name` |
| `static/roles.js` | 143 | `roleCircleHtml()` shows `member.role_name` as the tooltip |

`ws.rs` never relays role names (only `role_position`) — no leak there.

### 1.2 Identity private keys are already encrypted at rest (audit claim FALSE)

Measured after a real registration, reading raw storage with the app's own bypass helper:

```
e2e_identity_private_<uid>  raw = "~3bb7e094073b1aa8.1C..."   encrypted: true
e2e_identity_public_<uid>   raw = "~..."                       encrypted: true
token                       raw = "~..."                       encrypted: true
e2e_hmac_key                raw = "~..."                       encrypted: true
```

Why: `crypto.js` writes them with plain `localStorage.setItem` (lines 535–536), and
`secure-storage.js` intercepts `Storage.prototype` for every key starting with `e2e_`
(`SENSITIVE_PREFIXES`, line ~55). `e2e_identity_private_*` matches that prefix, so it is
wrapped exactly like the JWT. No raw-storage bypass exists anywhere in `static/*.js`
(`grep -rn "Storage.prototype.setItem\|_secGetRaw" static/*.js` → only `secure-storage.js`
and the test pages).

**So do not "move identity keys into the wrapper" — they are already inside it.** The real
defect is §1.3: the wrapper itself is trivially defeatable.

### 1.3 The XOR layer is beaten by the same localStorage dump it defends against (HIGH, real)

Measured in the probe (`tests/_probe-security-storage2.spec.ts`):

```
e2e_device_key            plaintext, 44 chars   (bootstrap, by design)
e2e_encrypted_password    plaintext, 73 chars   (bootstrap, by design)
e2e_local_storage_key     ABSENT after login   (good)
sessionStorage._ssk       present              (the XOR key, in memory/tab storage)
passwordRecoverable       TRUE   <-- recovered the real password from those two values
```

`_tryDeriveFromEncryptedPassword()` (secure-storage.js) decrypts `e2e_encrypted_password`
with `e2e_device_key`, then `_deriveKeyFromPassword(password)` with a **fixed public salt**
(`'e2e-local-storage-v1'`) and a **non-cryptographic** mixing function (`_mixHash`). So anyone
holding a localStorage dump gets: password → 32-byte storage key → decrypt every `~` value.

Additionally the cipher itself is a repeating-key XOR, and `_mixHash` is not a hash (it is a
custom rotate/xor mixer) — a deliberately weakened KDF. Both are fixed by §5.

Also relevant: `Object.keys(sessionStorage)`-style XSS on the origin can just call
`window._secGet(key)` — no cracking needed. The only real mitigations are (a) real AEAD so a
*ciphertext-only* leak is useless, and (b) tightening CSP (see §7).

### 1.4 CSP does not currently stop XSS

`server/src/main.rs:110` and `:321` both set:

```
script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval' https://cdn.jsdelivr.net
```

`'unsafe-inline'` means injected inline `<script>` runs, so the "XSS protection" framing of
`secure-storage.js` is aspirational. Note also that two **third-party CDN scripts** (jsQR,
qrcode-generator, both with `integrity=` SRI) execute in the origin — they are still needed by
the QR/invite features (`chat.js:9740`, `chat.js:6658`, `admin.js:293`), so don't remove them.

---

## 2. Ground rules for the implementer

1. **Bump the asset version** for every changed static file (`static/index.html` and
   `static/login.html` both hardcode `?v=` query strings). Currently
   `secure-storage.js?v=2` in `index.html` but `secure-storage.js?v=1` in `login.html` — bump
   both, they must match.
2. **Never** write a value to localStorage with `Storage.prototype.setItem.call(...)` unless
   you are deliberately bypassing encryption (only `secure-storage.js` may do that).
3. Keep the request/response shapes backwards-compatible for one release wherever the note says
   "phase" — the ordering matters.
4. After changes: `cd static && node --check <file>.js` for JS, `cd server && cargo check` for
   Rust, then rebuild with `cargo build --release` and restart **from the `server/` directory**
   (`serve_static` resolves `../static`, so a wrong CWD 404s every asset).
5. `PROGRESS.md` is the changelog — append an entry per fix (next number is **126**).

---

## 3. Fix #1 — role names are plaintext in the DB and API

### 3.1 The ordering trap (read this first)

The plaintext column is the **only** copy of the name for roles created before migration 087
(those rows have `encrypted_name IS NULL`). If you wipe the column or stop serving `name`
before the client has re-encrypted those rows, **those role names are gone forever** — the
server has no key and cannot rebuild them.

Therefore three phases, in this order:

| Phase | Ships | Safe because |
|---|---|---|
| **A** | Server stops *writing* plaintext; keeps *serving* it | Old roles stay readable by old and new clients |
| **B** | Client re-encrypts legacy rows on load; renders via `encrypted_name` with fallbacks | Legacy plaintext is still available to read while it is being migrated |
| **C** | Server stops serving `name`; wipes rows that already have `encrypted_name` | Any row still holding plaintext at this point was migrated in B |

If you must ship everything at once (single user, single build), do A+B+C together but accept
that a role created before 087 whose server is never opened by anyone with the key will render
as `Role` — flag it in the commit message.

### 3.2 Phase A — server: stop writing the plaintext column

**New file `server/migrations/088_role_name_wipe.sql`** (phrase it so it is safe to re-run):

```sql
-- Roles whose name is already stored encrypted no longer need the plaintext mirror.
-- Rows with encrypted_name IS NULL are deliberately left alone: the client still needs
-- their plaintext to produce the encrypted form (see SECURITY_FIX_PLAN.md §3.1).
UPDATE server_roles SET name = '' WHERE encrypted_name IS NOT NULL AND name <> '';
```

Register it next to the others in `server/src/db.rs` (the block that ends at line 1358):

```rust
let _ = conn.execute_batch(include_str!("../migrations/088_role_name_wipe.sql"));
```

**`server/src/db.rs`**

- `ensure_everyone_role_c` (line ~8449): insert `''` instead of `'@everyone'`. The client
  renders the `@everyone` label from `is_everyone`, so no information is lost.
- `create_role` (line ~8505): drop the `name: &str` parameter; always store `''`.

```rust
pub fn create_role(&self, server_id: &str, color: Option<&str>, permissions: i64, position: i32,
                  encrypted_name: Option<&[u8]>, name_nonce: Option<&[u8]>) -> Result<ServerRole, String> {
    ...
    conn.execute(
        "INSERT INTO server_roles (id, server_id, name, color, position, is_everyone, permissions, encrypted_name, name_nonce)
         VALUES (?1, ?2, '', ?3, ?4, 0, ?5, ?6, ?7)",
        params![id, server_id, color, position, perms, encrypted_name, name_nonce],
    )
```

- `update_role` (line ~8530): drop `name: &str`; both arms set `name = ''` **unconditionally**
  (do *not* use `COALESCE` here — the whole point is that the column is dead). The existing
  `COALESCE` on `encrypted_name`/`name_nonce` must stay: pure reorders pass `None` and must not
  wipe the encrypted name (that was a real bug fixed in PROGRESS #124).
- `list_server_roles` (line ~8469): `name` is now always `''`, so the tiebreaker is
  meaningless — replace with a deterministic one:

```sql
SELECT id, server_id, name, color, position, is_everyone, permissions, encrypted_name, name_nonce
FROM server_roles WHERE server_id = ?1 ORDER BY position DESC, created_at ASC, id ASC
```

**`server/src/handlers.rs`**

- `CreateRoleRequest.name` is currently `pub name: String` (**required** — a client that stops
  sending it gets a 422). Change to:

```rust
#[derive(Deserialize)]
pub struct CreateRoleRequest {
    #[serde(default)]
    pub name: Option<String>,
    ...
}
```

- `create_server_role` (line ~3485): drop the `let name = ...` validation of plaintext; instead
  require the encrypted payload and cap its size:

```rust
let enc_name = req.encrypted_name.as_deref()
    .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
let name_nonce = req.name_nonce.as_deref()
    .and_then(|s| base64::engine::general_purpose::STANDARD.decode(s).ok());
if enc_name.is_none() || name_nonce.is_none() {
    return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Encrypted role name required"}))).into_response();
}
if enc_name.as_ref().map_or(0, |e| e.len()) > 512 || name_nonce.as_ref().map_or(0, |n| n.len()) != 24 {
    return (StatusCode::BAD_REQUEST, Json(serde_json::json!({"error": "Invalid role name payload"}))).into_response();
}
```

  (The old 64-char limit on the plaintext is gone by design — the server cannot see the name.
  The length caps replace it so a role cannot be used to stuff the DB.)

- `update_server_role` (line ~3543): delete
  `let name = req.name.unwrap_or_else(|| role.name.clone());` and the
  `if name.trim().is_empty() || name.len() > 64` block; call the new `update_role` signature.
  Keep the identical base64 + length validation for the optional `encrypted_name`.
- **Keep** `"name": role.name` in `role_json` for phase A (it is `''` for already-encrypted
  rows, plaintext for legacy ones — exactly what phase B needs to read).

### 3.3 Phase B — client: migrate legacy rows and render from the ciphertext

**`static/roles.js`**

```js
// Phase B: a role created before role-name encryption has no encrypted_name yet, and the
// plaintext column is the only copy left. Re-encrypt it once, then the server drops the
// plaintext mirror on the write (see §3.2 db.rs update_role).
async function migrateLegacyRoleNames() {
    var serverId = state.serverId;
    if (!serverId) return;
    var legacy = state.roles.filter(function (r) {
        return !r.is_everyone && r.name && !r.encrypted_name && !r.name_nonce;
    });
    if (!legacy.length) return;
    for (var i = 0; i < legacy.length; i++) {
        var enc = encryptRoleName(legacy[i].name, serverId);
        if (!enc.encrypted_name) return;           // no server key yet — try again next load
        await api('/api/servers/' + serverId + '/roles/' + legacy[i].id, {
            method: 'PUT',
            body: JSON.stringify(enc)              // note: no plaintext `name` field
        });
    }
    await load(serverId);
}
```

Call it at the end of `load()` (after `renderRoleList()`), guarded by a per-server `Set` so it
cannot loop, and never let it throw into `load()`.

Rendering fallbacks — `decryptRoleName` (line ~863) must cope with every state:

```js
function decryptRoleName(role, serverId) {
    if (!role) return '';
    if (role.encrypted_name && role.name_nonce) {
        try {
            var key = window.E2ECrypto && window.E2ECrypto.getServerKey(serverId || state.serverId);
            if (key) {
                var dec = window.E2ECrypto.decryptMessage(role.encrypted_name, role.name_nonce, key);
                if (dec) return dec;
            }
        } catch (_) { /* fall through */ }
    }
    if (role.is_everyone) return '@everyone';
    if (role.name) return role.name;      // phase B: legacy plaintext still readable
    return 'Role';                        // phase C fallback for an unmigratable row
}
```

`saveRole()` / `createRole()` keep sending `name:` for now (phase A ignores it, and it keeps
old cached clients working); remove the field in phase C.

### 3.4 Phase C — server: stop serving the plaintext, encrypt the member tooltip

**`server/src/handlers.rs`**

- `role_json` (line ~3365): delete the `"name": role.name,` line entirely.
- Members endpoint (line ~3320): replace `"role_name": m.role_name` with the ciphertext:

```rust
"role_encrypted_name": m.role_encrypted_name.as_ref()
    .map(|e| base64::engine::general_purpose::STANDARD.encode(e)),
"role_name_nonce": m.role_name_nonce.as_ref()
    .map(|e| base64::engine::general_purpose::STANDARD.encode(e)),
```

**`server/src/db.rs`**

- `ServerMemberInfo` (line ~237): replace `pub role_name: Option<String>` with
  `pub role_encrypted_name: Option<Vec<u8>>, pub role_name_nonce: Option<Vec<u8>>`.
- `get_server_members_with_roles` (line ~8800): select `r.encrypted_name, r.name_nonce`
  instead of `r.name`, and map them in the closure.

**`static/roles.js`**

- `roleCircleHtml(member)` (line ~141): decrypt the tooltip with the current server key:

```js
function roleCircleHtml(member) {
    var color = member.role_color;
    var name = '';
    if (member.role_encrypted_name && member.role_name_nonce) {
        try {
            var key = window.E2ECrypto && window.E2ECrypto.getServerKey(currentServerId);
            if (key) name = window.E2ECrypto.decryptMessage(
                member.role_encrypted_name, member.role_name_nonce, key) || '';
        } catch (_) {}
    }
    if (!name) {
        if (member.role === 'owner') { name = 'Owner'; color = 'var(--accent)'; }
        else { name = '@everyone'; color = color || '#99aab5'; }
    }
    if (!color) color = '#99aab5';
    return '<span class="role-circle" data-role-name="' + escapeAttr(name) +
           '" title="' + escapeAttr(name) + '" style="background:' + escapeAttr(color) + '"></span>';
}
```

  The decrypted name is user-controlled content — keep `escapeAttr` (it is already there).
- `decryptRoleName()` loses the `role.name` branch and `saveRole`/`createRole` stop sending
  `name`.

Finally, a cleanup migration for stragglers (run only after B has been live):

```sql
-- 089_role_name_purge.sql — run once every client is on the phase-B build.
UPDATE server_roles SET name = '' WHERE name <> '';
```

### 3.5 Tests for fix #1

New `tests/role-name-encryption.spec.ts`. The assertion that actually matters is **the on-disk
scan** — API-only assertions are what let the original bug ship.

```ts
// 1. Create a role through the UI with a unique, greppable name.
const probe = 'ZzzLeakProbe' + Date.now();
// ... open server settings, click "create role", rename to `probe`, save ...

// 2. API must not carry the plaintext.
const roles = (await api(page, `/api/servers/${sid}/roles`)).body.roles;
const role  = roles.find((r: any) => r.encrypted_name);
expect(role.name, 'plaintext role name must not be served').toBeFalsy();
expect(role.encrypted_name).toBeTruthy();
expect(role.name_nonce).toBeTruthy();

// 3. Decryption still works in the UI (name is visible and equals the probe).
await page.reload(); /* reopen settings */ 
await expect(page.locator('.role-row-name', { hasText: probe })).toBeVisible();

// 4. Members list tooltip carries the ciphertext, not the name.
const members = (await api(page, `/api/servers/${sid}/members`)).body;
expect(JSON.stringify(members)).not.toContain(probe);
expect(members[0].role_encrypted_name ?? null).not.toBeUndefined();
```

Then the disk scan (Node, from inside the spec via `child_process` — no `strings` binary on
this machine, so scan the bytes directly):

```ts
import { readFileSync, existsSync } from 'fs';
const hits = ['server/e2e_chat.db', 'server/e2e_chat.db-wal']
    .filter(existsSync)
    .map((f) => readFileSync(f).toString('latin1'))
    .reduce((n, buf) => n + (buf.split(probe).length - 1), 0);
expect(hits, 'role name must not appear in the DB bytes').toBe(0);
// control: a plaintext string that IS expected to exist must be found, proving the scan works
```

Keep the control string in the test (e.g. assert the scan finds the owning username, which is
legitimately plaintext in `users.username`). Without a positive control the test silently
becomes vacuous if the file path changes.

Before/after proof: run the spec, then
`git stash push -m repro -- server/src/db.rs server/src/handlers.rs static/roles.js`, rebuild,
run again → assertion 2 and the disk scan must **fail** at HEAD.

---

## 4. Fix #2 — identity private keys

### 4.1 What to actually change

Nothing functional: the keys are already XOR-wrapped (§1.2). Add a regression test so nobody
"optimises" the write path later, and fix the real problem (§5).

`tests/secure-storage.spec.ts`:

```ts
const state = await page.evaluate(() => {
    const uid = JSON.parse(localStorage.getItem('user') || '{}').id;
    const raw = (window as any)._secGetRaw('e2e_identity_private_' + uid);
    const kp  = (window as any).E2ECrypto.getIdentityKeyPair();
    return {
        rawPrefix: raw && raw.slice(0, 3),
        encryptedAtRest: !!raw && raw.charAt(0) === '~',
        roundTrip: !!kp && (window as any)._secGet('e2e_identity_private_' + uid)
                             === (window as any).E2ECrypto.arrayBufferToBase64(kp.privateKey),
    };
});
expect(state.encryptedAtRest, 'identity private key must be encrypted at rest').toBe(true);
expect(state.roundTrip, 'interceptor must decrypt it transparently').toBe(true);
```

Repeat the assertion **after a page reload** and after a fresh login on a second context
(the key is written on the post-login `saveIdentityKeyPair` path, `auth.js:658`).

### 4.2 Optional hardening (only if there is time)

The bootstrap material is the real hole. Ranked by value/effort:

1. **Do not persist `e2e_encrypted_password`** — derive the storage key from the login-time
   password and keep it only in `sessionStorage`; on reload the app must ask for the password
   again to decrypt. Cost: a password prompt on every full reload. This is the only change
   that actually removes the §1.3 attack.
2. **Envelope the stored password with a WebCrypto non-extractable key** (`crypto.subtle`,
   AES-GCM, `extractable: false`, key in IndexedDB). Blocks offline dump attacks; does **not**
   block in-page XSS (which can just call the wrapper). Medium effort, partial value.
3. **Leave as-is** and document the residual risk in `PROGRESS.md`. Defensible, because the
   device key is only as exposed as the browser profile it lives in and any local attacker
   already owns the session.

---

## 5. Fix #3 — replace the XOR cipher with XChaCha20-Poly1305

### 5.1 Why this is feasible without touching call sites

libsodium is already loaded on every page and every libsodium AEAD call is **synchronous once
`sodium.ready` has resolved** — which is exactly what the current XOR exists for (see the
"WHY XOR INSTEAD OF AES-GCM?" comment at the top of `secure-storage.js`; WebCrypto is async,
libsodium is not). `static/crypto.js` already relies on this for `_aeadEncryptRaw`.

Also keep the same 32-byte key (`_deriveKeyFromPassword`), so no re-keying and no cross-device
migration is needed.

### 5.2 Versioned format (never break old values)

```
current :  ~<16 hex tag>.<base64(xor(utf8))>            legacy, read-only after this change
new     :  ~v2.<base64(nonce24 || XChaCha20-Poly1305(utf8))>
```

Dispatch on the inner string: `startsWith('v2.')` → AEAD; char at index 16 is `.` → legacy
tagged XOR; otherwise → legacy bare-base64 XOR (the pre-tag format already handled today).

### 5.3 Exact code (`static/secure-storage.js`)

```js
// ─── v2: authenticated encryption (libsodium, synchronous once ready) ──────
var V2_PREFIX = 'v2.';
var AEAD_NONCE_LEN = 24;

function _aeadReady() {
    return typeof sodium !== 'undefined'
        && typeof sodium.crypto_aead_xchacha20poly1305_ietf_encrypt === 'function'
        && typeof sodium.crypto_aead_xchacha20poly1305_ietf_decrypt === 'function';
}

function _aeadEncryptWithKey(plaintext, key) {
    var nonce = sodium.randombytes_buf(AEAD_NONCE_LEN);
    var msg = new TextEncoder().encode(plaintext);
    var ct = sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(msg, null, null, nonce, key);
    var combined = new Uint8Array(nonce.length + ct.length);
    combined.set(nonce);
    combined.set(ct, nonce.length);
    return V2_PREFIX + _bytesToBase64(combined);
}

/** Returns undefined when `inner` is not v2, a string on success, null when v2 fails to open. */
function _aeadDecryptWithKey(inner, key) {
    if (inner.indexOf(V2_PREFIX) !== 0) return undefined;
    if (!_aeadReady()) return null;
    try {
        var combined = _base64ToBytes(inner.substring(V2_PREFIX.length));
        if (combined.length <= AEAD_NONCE_LEN) return null;
        var nonce = combined.subarray(0, AEAD_NONCE_LEN);
        var ct = combined.subarray(AEAD_NONCE_LEN);
        var pt = sodium.crypto_aead_xchacha20poly1305_ietf_decrypt(null, ct, null, nonce, key);
        return new TextDecoder().decode(pt);
    } catch (_) { return null; }   // wrong key or tampered — authenticated, so this is safe
}

function _encryptInner(plaintext) {
    var key = _ensureKey();
    // Only produce v2 once libsodium is up. Before that, XOR keeps the app working and the
    // value stays readable forever (legacy path); _secUpgradeToAead() re-writes it after ready.
    if (_aeadReady()) return _aeadEncryptWithKey(String(plaintext), key);
    return _xorEncrypt(String(plaintext));
}

function _decryptInnerWithKey(inner, key) {
    var v2 = _aeadDecryptWithKey(inner, key);
    if (v2 !== undefined) return v2;
    return _decryptWithKey(inner, key);      // legacy tag.b64 / bare b64
}
```

Wire it into the four existing call sites:

| Where | Now | Change |
|---|---|---|
| `_intercept().setItem` / `_encryptForStore` | `MAGIC + _xorEncrypt(String(value))` | `MAGIC + _encryptInner(value)` |
| `_intercept().getItem` / `_decryptStored` | `_xorDecrypt(val.substring(1))` | `_decryptInnerWithKey(val.substring(1), _ensureKey())` |
| `_secInit()` migration loop | `_xorEncrypt` | `_encryptInner` (and move the loop into `_afterSodium(...)`, below) |
| `_secReKey` / `_secRekeyToPassword` | `_decryptWithKey(...)` + `_xorEncrypt(...)` | `_decryptInnerWithKey(raw.substring(1), oldKey)` + `_aeadEncryptWithKey(plain, newKey)` |

Add the upgrade pass and its trigger at the bottom of the module, next to the existing
`_secInit();` auto-call:

```js
/**
 * Re-encrypt every legacy XOR value under the v2 AEAD using the SAME key.
 * Idempotent; safe to call after every _secReKey/_secRekeyToPassword.
 */
window._secUpgradeToAead = function () {
    if (!_aeadReady()) return false;
    var key = _currentKeyRaw();
    if (!key) return false;
    var changed = 0;
    for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (!k || !isSensitive(k)) continue;
        var raw = _realOrigGet.call(localStorage, k);
        if (raw === null || !_isEncrypted(raw)) continue;
        var inner = raw.substring(1);
        if (inner.indexOf(V2_PREFIX) === 0) continue;
        var plain = _decryptWithKey(inner, key);      // legacy formats only
        if (plain === null) continue;                 // stale key — leave it alone
        _realOrigSet.call(localStorage, k, MAGIC + _aeadEncryptWithKey(plain, key));
        changed++;
    }
    return changed > 0;
};

function _afterSodium(fn) {
    if (typeof sodium !== 'undefined' && sodium.ready && typeof sodium.ready.then === 'function') {
        sodium.ready.then(function () { try { fn(); } catch (_) {} });
    }
}
// Deferred so the first pass uses AEAD instead of XOR (sodium is not ready at parse time).
_afterSodium(function () {
    if (typeof window._secUpgradeToAead === 'function') window._secUpgradeToAead();
    if (typeof window._secInit === 'function') window._secInit();
});
```

Sodium-readiness rule of thumb: **`_secInit()` runs at script-parse time, before
`sodium.ready` resolves** — that is exactly why the migration loop must be deferred. Writes
from event handlers (login, save, message send) happen long after ready, so they will be v2.

Update the module header comment: it currently justifies XOR at length ("WHY XOR INSTEAD OF
AES-GCM?") — replace that section with the v2 description, otherwise the next reader will
re-introduce the problem.

Storage-size note: base64 grows by 33% and v2 adds a 24-byte nonce + 16-byte tag; the `fkc_*`
file-key cache and `user_display_name_cache` are the big values. If `QuotaExceededError`
appears, that is the cause — the `catch` in `setItem` currently falls back to plaintext, which
would be a silent regression; make it `console.warn` at minimum.

### 5.4 Tests for fix #3

New `tests/secure-storage.spec.ts` (or extend the existing in-browser page
`static/test-secure-storage.html` + `static/test-secure-runner.js`, which already asserts the
prefix rules).

The decisive test is a **working attacker that must stop working**:

```ts
const attack = await page.evaluate((rawKey) => {
    // Reproduce _mixHash + _deriveKeyFromPassword from the pre-fix source, then try to
    // strip the XOR layer off the raw stored value using ONLY the password.
    var raw = (window as any)._secGetRaw(rawKey);            // e.g. 'e2e_identity_private_<uid>'
    var inner = raw.substring(1);
    // (replicated old _mixHash / _deriveKeyFromPassword / _base64ToBytes here)
    var key = deriveKeyFromPassword('testpass1234');
    var b64 = inner.charAt(16) === '.' ? inner.substring(17) : inner;
    var bytes = base64ToBytes(b64);
    var out = new Uint8Array(bytes.length);
    for (var i = 0; i < bytes.length; i++) out[i] = bytes[i] ^ key[i % key.length];
    return new TextDecoder().decode(out);
}, key);

// Pre-fix (HEAD) this contains readable base64 of the private key.
// Post-fix the value is '~v2....' so this reconstruction yields garbage.
expect(attack).not.toMatch(/^[A-Za-z0-9+/=]{40,}$/);
expect(attack).not.toBe(realPrivateKeyB64);
```

Plus:

1. **Round trip**: `localStorage.setItem('token_probe', 'x')` → `getItem` returns `'x'` and
   `_secGetRaw` starts with `~v2.`.
2. **Legacy read**: construct a legacy value with the test's own XOR implementation
   (`MAGIC + tag + '.' + b64`), assert `getItem` still returns the plaintext, then call
   `_secUpgradeToAead()` and assert the raw form becomes `~v2.` and still decrypts.
3. **Cross-device**: second browser context, same account → `sessionStorage._ssk` fingerprints
   and `E2ECrypto.getIdentityKeyPair()` private key are identical (the AEAD key must remain
   password-derived, not random).
4. **Re-key path**: change the password (the `_secRekeyToPassword` flow in `chat.js:6380`),
   reload, assert every `~` value is still readable — this is the path most likely to break
   when the cipher changes.
5. `static/test-secure-storage.html` should gain a "Bootstrap material is derivable" red test so
   the §1.3 weakness stays visible (see §4.2 before deciding to fix it).

Before/after proof: `git stash push -m repro -- static/secure-storage.js` → the attacker test
(0) must **pass** (i.e. recover the plaintext); `git stash pop` → it must fail. That is the
evidence the user asked for: the old cipher is provably broken and the new one is not.

---

## 6. Commands cheat sheet

```bash
# JS syntax (fast, per file)
cd static && node --check secure-storage.js && node --check roles.js && node --check chat.js

# Rust
cd server && cargo check 2>&1 | tail -5
cd server && cargo build --release 2>&1 | tail -3

# restart the server (MUST be from server/ — static paths are ../static)
taskkill //f //im e2e-chat.exe 2>/dev/null; sleep 2
cd server && nohup target/release/e2e-chat.exe > /dev/null 2>&1 &

# run one spec
npx playwright test tests/role-name-encryption.spec.ts --workers 1 --reporter=line
npx playwright test tests/secure-storage.spec.ts --workers 1 --reporter=line

# scan the live DB for a plaintext probe string (no `strings` binary on this box)
node -e "const fs=require('fs');const hits=['server/e2e_chat.db','server/e2e_chat.db-wal']\
.filter(f=>fs.existsSync(f)).map(f=>fs.readFileSync(f).toString('latin1'));\
console.log(hits.reduce((n,b)=>n+(b.split(process.argv[1]).length-1),0))" 'MyRoleName'
```

Screenshots go to `test-results/…` which is already gitignored (`.gitignore` line 14).

---

## 7. Out of scope but worth noting

1. **Tighten CSP** (`server/src/main.rs:110`, `:321`): `'unsafe-inline'` on `script-src` means
   any HTML-injection XSS still executes, which defeats the local-storage encryption regardless
   of §5. Moving the inline scripts in `index.html`/`login.html` to files (or adding nonces)
   and dropping `'unsafe-inline'` is the single highest-value follow-up to this whole audit.
   Keep `'wasm-unsafe-eval'` (libsodium) but try removing `'unsafe-eval'`.
2. `secure-storage.js?v=1` (login.html) vs `?v=2` (index.html) — make them match.
3. The two CDN scripts keep running third-party code in the origin; they have SRI, which is
   good — if the QR features are ever dropped, delete the tags and the `cdn.jsdelivr.net`
   entry from CSP.
4. `_mixHash` is a hand-rolled mixer used for tag/derivation; once v2 lands it only survives
   for legacy reads, which is fine — but consider `crypto_generichash` for the tag if the
   legacy path is ever touched again.
