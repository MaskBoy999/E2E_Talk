# Manual testing guide — what shipped, and how to see it with your own eyes

Companion to `FEATURE_PLAN.md` (§5 lists what is built and which automated spec
covers it). The Playwright suite proves the leaks don't come back; this file is
for testing the **behaviour** on a real device, the way a user meets it.

Every item ends with **Try to break it** — the check that actually matters. A
feature that only works when you are being nice to it isn't finished.

---

## 0. Getting a test rig

```bash
# Server + web app (its own terminal). Serves https://localhost:3443
cargo run --manifest-path server/Cargo.toml --release

# Desktop app (native window, tray, real notifications)
cargo tauri dev
```

* **Browser** — just open `https://localhost:3443` (accept the self-signed cert).
* **Android box** — install the APK from the release / a *Build Android APK*
  Actions run (Android 10+). Needed for biometrics, captions, audio routes,
  tiles and the native notifications.
* **Two accounts** — for anything with a peer. Two browser *profiles* is the
  quickest way (`--user-data-dir`), or one desktop + one browser.

Two console tools you will use constantly (DevTools → Console, or `adb logcat`
+ the same calls via the page):

| Call | What it tells you |
|---|---|
| `_secVaultStatus()` | `{locked, vault, passwordBootstrap, hasKey}` for the current tab |
| `_kvTicketRead()` | the session ticket's password, or `null` while locked |
| `loadDecryptedPassword()` | the password a live session can recover (what the app uses) |
| `_secGetRaw('e2e_key_vault')` | the sealed vault blob as it sits on disk |

### The one trick that makes the vault testable

A **cold start** is a *new tab*. `sessionStorage` (which holds the live storage
key) dies with the tab, so opening `https://localhost:3443/index.html` in a
brand-new tab is the desktop equivalent of relaunching the phone app. A plain
reload is *not* a cold start — it keeps the session.

### Fast automated confirmation

```bash
npx playwright test tests/key-vault.spec.ts tests/biometric-unlock.spec.ts \
  tests/captions.spec.ts tests/local-search.spec.ts tests/encrypted-export.spec.ts \
  tests/device-verify.spec.ts tests/panic-wipe.spec.ts tests/network-awareness.spec.ts \
  tests/notification-privacy.spec.ts tests/batch-b.spec.ts tests/drag-out.spec.ts \
  tests/blob-recovery.spec.ts tests/auth-flow-full.spec.ts tests/secure-storage.spec.ts \
  tests/session-persistence.spec.ts tests/multidevice-sessions.spec.ts
```

---

## 1. The vault and the session (5.6) — start here

This is the feature that changed how everything else boots, so test it first.

**Do**

1. Register a normal account in a browser.
2. DevTools → Application → Local Storage → `https://localhost:3443`:
   * `e2e_key_vault` **is present** (starts with `{`),
   * `e2e_encrypted_password` **is absent** — the old bootstrap is deleted,
   * `e2e_vault_ticket` is present and starts with `~v2.` (ciphertext),
   * `e2e_device_key` is still readable plaintext (it identifies the device).
3. Console: `_secVaultStatus()` → `{locked: false, vault: true, passwordBootstrap: false, hasKey: true}`.
4. **New tab** to the app → you get the *"Unlock your key vault"* overlay
   (it is a lock screen, **not** a redirect to the login page and **not** a
   session wipe).
5. Enter a **wrong** password → error, still locked, no navigation.
6. Enter the **right** password → the app comes back exactly as you left it.

**Try to break it**

* In the new (locked) tab, run `loadDecryptedPassword()` and `_kvTicketRead()`:
  both must be `null`. If either returns your password, the vault is decorative.
* Add `?debug`-free check: while locked, `localStorage.getItem('e2e_key_vault')`
  is the only thing on disk that could open anything — grep your disk copy of
  Local Storage for your password in clear text. It must not be there.
* Unlock, close the tab, open a new one, **Forget this device and sign in
  again** on the lock screen → you land on the login page and the vault is gone
  (DevTools: `e2e_key_vault` absent). That is the "vault dies with the device"
  path.

---

## 2. Biometric unlock (5.1) — Android box

**Do**

1. Settings → *Unlock with fingerprint* → toggle on → accept the Android
   biometric prompt.
2. Sign out. On the login page a fingerprint button appears → tap it → you are
   signed in without typing anything.
3. Cold start the app (swipe it away, reopen) → the vault lock screen offers the
   fingerprint button as well as the password field.

**Try to break it**

* Cancel the biometric prompt during *enable* → the toggle must fall back to
  off and say so; nothing may be sealed (the status line never reads "enabled").
* Fail the prompt 3× on purpose → you get the password field, not an unlocked
  app.
* The password path must always remain: after any biometric failure you can
  still type the password and get in.

---

## 3. On-device captions (1.7) — Android box

**Do**

1. Settings → *Live captions* → toggle on. A panel appears with a mode badge.
2. Talk (or play speech near the mic) → interim text becomes one line that is
   **replaced** by the final version, not stacked.
3. Confirm the badge says **"this device only"**.
4. Flip the second, separate *Publish to the call* toggle → badge becomes
   **"published to the call"**.
5. Stop captions → the panel closes and the lines are gone.

**Try to break it**

* **Airplane mode** (or a device with no offline recogniser) → the toggle
  refuses to start and the status line says the engine is offline/unavailable.
  Captions must **never** silently fall back to a network recogniser. On a
  desktop browser (no engine at all) this is what you should see.
* In a call, publish captions, then have the peer look at their own screen with
  *their* captions off: only your **final** lines arrive, never the interim ones.
* Search your local storage / `adb logcat` for the sentence you just spoke — it
  must appear in **neither** (captions are display-only).
* Pull down the notification shade mid-caption: no caption text anywhere.

---

## 4. Local search (5.7)

**Do**

1. Send yourself some distinctive text (`zzyzx unicorn`).
2. Press **Ctrl+K** → type `zzyzx` → the message is found.
3. Settings → *Search this device only* → toggle it and repeat: still found.
4. DevTools → Application → the search index is stored as **ciphertext**
  (no plaintext of your message).
5. Send a **disappearing message** with the same magic word → it is never
   returned by search.
6. Panic wipe (§7) then search again → nothing (the DB went with the wipe).

**Try to break it**

* After searching, check DevTools → **Network**: no request carries your query
  string. The server cannot search what it cannot read, and must not learn the
  query either.
* Add 200+ distinct messages, then search an old one: the index is bounded, so
  the *oldest* rotate out — recent things must always be findable.

---

## 5. Encrypted local export (5.5)

**Do**

1. Settings → export controls → choose a passphrase
   (`#export-passphrase`, `#export-passphrase-confirm`) → **Export**.
2. Open the produced file with the right passphrase → you get your data back.
3. Open it with a wrong passphrase → it fails, and it does not half-succeed.

**Try to break it**

* Open the exported file in a text editor: message text, usernames and the
  passphrase must not be greppable in the raw bytes.
* Check the file name and the save dialog: the **name must not describe
  content** (`messages-decrypted.json` is a fail).
* Export while signed in, then look at the payload for your session token —
  credentials must never be in it.

---

## 6. Device verification (5.4)

**Do**

1. Sign the same account in on two devices.
2. On device A: open the profile/device row and open verification
   (`#device-verify-modal`). Note the emoji + digit string.
3. On device B: the same string must be shown for device A (compare them — this
   is the whole point).
4. Mark it verified → the "verified" state sticks.
5. Rotate the key (sign out + in on the same device with a new key, or use the
   key-rotation path) → device A now **warns** that the key changed.

**Try to break it**

* The verification string must live **in-app only**: never in a notification,
  never on the lock screen, never in the title bar. Put device B in the
  background and make device A "verify" while B's screen is locked — nothing
  about the string may appear on B's lock screen.
* Verify, then clear only the verification state and re-open: it must not
  silently claim "verified".

---

## 7. Panic wipe and auto-lock (5.3)

**Do**

1. Settings → auto-lock → try `0`, `5`, `999`: the value clamps, and **the
   default is OFF** (a surprise wipe is data loss).
2. Set a short limit, leave the app idle → past the limit the app wipes and
   returns to the login state.
3. Set a longer limit and keep *using* the app → it must not fire early.
4. Press the hidden chord **Alt+Shift+W** → instant wipe, no confirmation.

**Try to break it**

* Wipe, then inspect Local Storage: the token, keys, key blob, the search index
  and cached names are **all** gone. A wipe that leaves the search index behind
  is worse than no wipe.
* After the chord, `localStorage` should be effectively empty and the app must
  not be recoverable without the password.

---

## 8. Notifications (F1 / F2 / F3)

**Do**

1. Trigger a message and a call while the app is backgrounded.
2. **Android**: the ongoing call card's text comes from the room *type*
   ("In a call"), never a channel name.
3. Turn on *hide message content in notifications* → the sender is blanked too,
   not just the body; the native ring obeys the same setting, in both states.
4. **Desktop**: a toast appears and *expires* (Rust-side expiring toast, not a
   lingering Action Center entry).
5. **Android**: every posted card is cancelled by id once its time is up.

**Try to break it**

* Rename a server/channel/category to something unique and trigger all of
  those: the unique string must appear in **no** notification (Android and
  desktop), including the call card and the native ring.
* With hide-preview on, the notification must contain no display name either.

---

## 9. Desktop shell (4.2), deep links (4.4), drag-out (3.5)

**Do**

1. Append **`?mini=1`** to the app URL (or use the mini-window control) → only
   the call controls render; the main window's buttons drive it.
2. From a browser, open `e2e-chat://channel/<a real channel id>` → the app lands
   in that channel.
3. Drag a file attachment card **out** of the message list onto the desktop →
   the file lands as a real file (the card is "warmed" on press, so the first
   drag works; a cold drag refuses with a message and works next time).

**Try to break it**

* Deep link with rubbish: `e2e-chat://channel/../../etc/passwd`,
  `e2e-chat://https://evil.example` and a random id → all must be refused
  (ids only, in-scope only). The shell must never navigate anywhere remote.
* Drag out, then check whether the app left a stale blob URL around: warmed URLs
  are revoked with the others (open a new attachment and confirm the previous
  one is dead).

---

## 10. Media: snip (3.3), share-into-app (3.4), audio routes (1.3)

**Do**

1. **Snip** — attach menu → *Snip region* → drag a region → the crop lands in
   the composer's upload queue; cancelling adds nothing.
2. **Share-into-app** — from Gallery, *Share* → E2E Chat → the item arrives
   staged in the composer, then is consumed (a second open shows nothing).
3. **Audio route** — in a call, pick earpiece / speaker / Bluetooth; the audio
   actually moves, and the picker lists the OS output devices.

**Try to break it**

* Share the **same** file twice quickly → the FIFO must not double-post, and an
  empty FIFO must be a no-op (no toast, no discard).
* Snip a region containing a password / chat text → the snip is only in app
  memory until you send it; nothing lands in the shared MediaStore.
* Route change mid-call must not drop the call or leak the room name to the OS
  media panel (title stays generic).

---

## 11. Network awareness (6.5)

**Do**

1. Call Diagnostics → the **Network** line reports local facts ("same Wi-Fi as
   the box" or not).
2. DevTools → Network → *Offline*: a socket drop schedules **no** retry storm.
3. Back online → it reconnects **at once**.

**Try to break it**

* The Network line must not print your SSID/BSSID verbatim (a diagnostics copy
  could carry it off-device). Facts and booleans only.

---

## 12. Multi-device key blob (the vault ↔ 5.1 seam)

**Do**

1. Sign the same account in on two devices.
2. On device A: create a server, change a preference (theme, a soundboard mute).
3. On device B: the change converges on its own (the blob mirror pushes, the
   server announces, B pulls). No button to press.
4. Sign out on both, delete everything on B, sign in again with the password →
   identity keys, server keys and the shared settings all come back.
5. Console on B: `loadDecryptedPassword()` returns your password (this is the
   session ticket doing its job — without it, background blob saves silently
   stop after a reload).

**Try to break it**

* After a plain **reload** on B, change another preference → it must still reach
  the server. (This is exactly the bug the ticket fixes: the password is not in
  page memory after a reload, so the save used to no-op silently.)
* While the vault is **locked** (new tab), blob saves must not happen and must
  not leak: `_kvTicketRead()` is `null`.
* Make the two devices write at the same moment → the stale write is rejected
  and merged, not last-write-wins (neither device loses its own keys).

### Settings → Security: the backup buttons (fixed after the migrate)

These two buttons read the password straight out of the old bootstrap, so the
vault migration left them throwing **"Not logged in"** even for a live session.
Both now go through `loadDecryptedPassword()` (i.e. the session ticket), and the
status line uses the same `icon()` helper as the rest of Settings (the old
`✅`/`❌` characters are gone — automated tests were updated to match).

**Do**

1. Register, open **Settings → Security**.
2. The status line reads *"Key backup exists on server (last saved just now)"*.
3. Click **Save Backup Now** → *"Backup saved! (N keys encrypted)"*, and the
   button re-enables itself.
4. Reload the page and click it again → it must still succeed (this is the case
   that used to say "Not logged in").
5. **Restore from Server Backup** → enter a wrong password → *"Wrong password or
   corrupted backup."*; enter the right one → *"Keys restored successfully! …"*.
6. On a second device, save a backup on A and watch B converge (step 3 above) —
   the `blob_updated` socket path also used the deleted bootstrap and now reads
   the ticket, so cross-device restore works again.

---

## 13. Quick Settings tile (2.3) + call notification buttons (1.1) — Android

**Do**

1. In a call → pull the shade down → edit (pencil) → add the **E2E Chat** tile.
2. In a call the tile reads **Mute**; tap → it flips to **Unmute**, and the
   app's own mic button follows.
3. While ringing the tile reads **Answer** — tap answers and foregrounds the
   app. Idle it reads **E2E Chat**; tap opens the app.
4. The ongoing call notification carries **Mute / Deafen / Hang up** — act
   from the shade with the app backgrounded; the card shows a ticking duration.

**Try to break it**

* Tile labels are compile-time literals: even if a channel is *named* "Mute",
  the tile never shows a channel/caller name — SystemUI renders those strings,
  so they are an OS surface.
* Hang up from the shade must end the call **for the peer too**, and the tile
  returns to idle on the next refresh.
* Mute from the tile, then look at the app: states agree in both directions.

## 14. Call comfort: audio focus (1.4), battery exemption (6.1), keep-screen-on (6.2)

**Do**

1. Music playing → join a call → playback pauses/ducks; leave → it resumes.
2. First call start: the battery prompt appears **once** → accept → Android's
   own "let this app run in the background" dialog opens. Already-exempt phones
   never see the prompt; after declining, the next call asks again (30-day
   memory only after *accepting*).
3. Screen stays awake for the whole call, and sleeps normally again after the
   last leave (try a 30-second screen timeout).

**Try to break it**

* Background the app 10 minutes into a call with the exemption granted — Doze
  must not end it (this used to look like an app bug).
* Join/leave repeatedly — no stuck wake lock: the screen must release.

## 15. Desktop: push-to-talk hotkey (4.1) + tray parity (4.6)

**Do**

1. Desktop box → Settings → Voice → PTT shortcut (default **Ctrl+Shift+Space**)
   — it registers *globally*: focus another app, hold it, and the mic opens
   only while held (with hold-to-talk enabled), releasing closes the gate.
2. Hover the tray icon: the tooltip reports state and counts only
   (in call / muted / deafened / unread).
3. Minimize the box, receive unread DMs → the count moves; click the tray →
   the window opens.

**Try to break it**

* Set a nonsense accelerator → it must be rejected with a message, never crash
  the shell (the parse test pins this, but feel it).
* Hold PTT while a server-side mute is on → the server mute wins.
* The tray tooltip/status must never contain a username or channel name.

## 16. Quiet hours (2.6), voice activation (1.6), connection quality (1.8)

**Do**

1. Phone on silent/vibrate/DND → message arrives while backgrounded → **no
   chime** (silent: no buzz either); a normal phone chimes. Settings →
   notification **Test sound** deliberately still plays on a silenced phone.
2. Settings → Voice → *only transmit while you speak*: stop talking → the
   gate closes and nothing goes out; it rides the existing RNNoise chain and
   never rewrites a mode that has no worklet.
3. Hold-to-talk: the outgoing mic track stays disabled until the mic button is
   held — a gate, not a mute (muting must not "fire" on press).
4. In a call → the diagnostics panel → per-peer **ping / rtt / jitter**, plus
   send/recv frames, packet loss and E2EE transform counts; refresh updates it.

**Try to break it**

* Flip the phone to silent **while** a ring is playing → the *next* ring is
  silent (ringer state is re-read at ring start, not cached at boot).
* Copy anything out of the diagnostics panel: ids and numbers only — no names.

## 17. Capture: system audio (3.1) + per-app capture (3.2)

**Do**

1. Android → Share screen → the sheet asks **how** first; switch audio on →
   **Start streaming** → the peer hears the app's sound (Settings' resolution
   and frame rate govern the capture; the sheet has no resolution picker).
2. Android 14+ → in the *system* projection picker choose a *single app* →
   only that window is shared.
3. Diagnostics names the audio state (on / refused / off) without adb.

**Try to break it**

* Refuse audio capture → the video share keeps running.
* Toggle the audio switch off → the stream has no audio track at all.
* DRM video (streaming services) is excluded by platform rule — expect
  silence for its audio, not a crash.

## 18. TURN credentials (7.1) + coturn recipe (7.2)

**Do**

1. `GET /api/voice/turn-config` without a session → rejected (auth required).
2. With a session → per-session HMAC credentials (minted per session, not one
   static standing password; the static pair still works when configured).
3. Two clients that cannot meet P2P (different networks) → the call still
   connects, relayed. `COTURN.md` is the recipe for running your own coturn.

**Try to break it**

* Compare turn-config output across two logins — the secret must differ per
  session, so one leaked credential is not a standing key to the relay.
* Media must still be E2EE end to end: the relay forwards ciphertext.

## 19. Removed by request: FLAG_SECURE (5.2)

The per-channel screenshot block is **gone** (JS + Kotlin + ACL stripped, the
`setSecureMode` command deleted, its spec removed — `batch-b` asserts the
command's absence).

* Take a screenshot during a call in any channel → it captures, on every
  channel. If a screenshot ever comes back black, the removal regressed.

---

## Known red (pre-existing, not from this work)

`tests/profile-sharing.spec.ts` — `SV1`, `SV2`, `SV3` fail on a plain checkout of
`HEAD` as well (verified by stashing the working-tree changes and re-running).
They are about display-name propagation after a server join, not about keys or
the vault. Everything else listed in `FEATURE_PLAN.md` §5 is green.
