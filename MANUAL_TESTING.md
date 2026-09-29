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

## 3. On-device captions (1.7) — desktop and the Android box

**Do**

1. Settings → *Live captions* → toggle on. A panel appears with a mode badge and
   a status line that says what the engine is doing (loading, listening, which
   model, which language, CPU or GPU, how many wasm threads).
2. Talk (or play speech near the mic) → a line appears within a few seconds, is
   **replaced** by a better version as more of the sentence arrives, and becomes
   final when you pause. Nothing is stacked or duplicated across the update.
3. Confirm the badge says **"this device only"**. There is no publish path any
   more: nothing derived from a call ever reaches the other participants.
4. Settings → *Speech model* → **whisper-base**, and say the same sentence
   again: fewer wrong words, and slower. Switch back to **whisper-tiny**.
5. *Spoken language* on **Detect automatically** → the badge shows `auto (ro)`
   (say) once the first decode has worked the language out, and does not flip
   afterwards. Setting a wrong language by hand turns speech into nonsense.
6. *Benchmark this machine* → a readout with ms per 30 s window on the CPU and,
   where this webview has WebGPU, on the GPU, plus the ratio between them. It
   says which audio it measured and whether it was captured or generated.
7. Stop captions → the panel closes and the lines are gone.

**Try to break it**

* **Airplane mode** → captions still work. The model is bundled in the app and
  served by your own server; any request to a third party is a bug, not a
  fallback.
* A sentence that straddles the 30-second window boundary must not lose words
  and must not appear twice: the windows overlap by 5 s and the overlap is
  de-duplicated against what is already on screen.
* A speaker who keeps talking while their own window is still decoding must not
  lose the sentence — the audio is held and decoded when the worker is free.
* *Use the GPU* on a machine where the benchmark says the GPU is **slower**: the
  status line must report the engine it actually got, and the readout must not
  claim a speed-up that is not there.
* Search your local storage / `adb logcat` for the sentence you just spoke — it
  must appear in **neither** (captions live in memory and the DOM only).
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

## 10. Media: snip (3.3 — **removed**), share-into-app (3.4), audio routes (1.3)

**Do**

1. **Snip** — no longer exists: the attach menu offers drag-and-drop, paste, the
   file picker, take photo and record video, and nothing else. If you see a
   *Snip region* entry anywhere (menu, tray, hotkey, docs) it is a regression.
2. **Share-into-app** — from Gallery, *Share* → E2E Chat → the item arrives
   staged in the composer, then is consumed (a second open shows nothing).
3. **Audio route** — in a call, pick earpiece / speaker / Bluetooth; the audio
   actually moves, and the picker lists the OS output devices.

**Try to break it**

* Share the **same** file twice quickly → the FIFO must not double-post, and an
  empty FIFO must be a no-op (no toast, no discard).
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

---

## 20. Copying any file type to the clipboard (0.2.30)

What changed: *Copy file* on an attachment of any type now really puts that file
on your computer's clipboard (before, anything that was not an image was refused —
"this browser only allows images"). Nothing to turn on.

**Do:** send or open a message with a file that is **not** an image (an `.exe`,
`.zip`, `.pdf`, anything).
Right-click the attachment → **Copy file**.
**Expect:** a toast: `"<name>" copied to clipboard — paste it anywhere`.

**Do:** now paste somewhere that accepts a file — a folder in Explorer/Files, the
attach field of an email, a chat app's attach field.
**Expect:** the actual file appears, under its real name and with the same size.

**Do:** the same with an **image** attachment → **Copy image**.
**Expect:** `Image "<name>" copied to clipboard`, and pasting into an image editor
inserts the *picture* (a copy of an image is still a picture, not a file path).

**Do:** copy file **A**, then copy file **B**, then paste.
**Expect:** only **B** pastes. A clipboard entry is a pointer at a real file, so
only the newest copy exists on disk at any time.

**Do:** open the same address in a normal browser (no app) and *Copy file* on a
non-image.
**Expect:** an honest toast that names the file, says copying a file needs the app,
and points at **Save a copy**. Nothing is silently ignored.

**Do (Android):** *Copy file* on a non-image attachment, then paste into another
app (or Files by Google).
**Expect:** the file itself is pasted; Android hands it over as a read-only
provider URI, so the receiving app may ask for access once. Files over 25 MB are
refused with a message that says so (a clipboard copy is a paste, not a transfer).

**Worth knowing:** to make a paste work, the decrypted file has to exist on disk
for as long as the clipboard holds it. It goes in the app's own cache folder,
only one at a time, and is deleted on the next copy or the next launch. There is
deliberately no *paste a file from the clipboard* feature — reading the host's
clipboard would let any page in the app window see whatever you copied there.

**Do (desktop, in the app, non-image):** the same copy, in the app window rather
than a browser.
**Expect:** the same toast as in a browser — the copy works. Seeing the
"Copying a file … needs the app" toast *inside the app* is the bug this release
fixed: the os-level request the desktop half used to send was blocked by the
page's own security policy, so the copy must travel as base64 inside a normal IPC
call on both platforms.

---

## 21. File viewing on a phone, the PDF editor, and copied text (0.2.32)

What changed: every document view reflows on a phone, editing a PDF does what the
button says, and copied text is just the text.

**Do:** on a phone, open a message with a **.docx** attachment.
**Expect:** the page fills the screen, text wraps to the device width (a Word page
is 794px wide — it must not be cropped on the right or need horizontal panning),
scrolling is smooth, and the *Loading document…* placeholder disappears once the
document renders. Repeat for **.pdf**, **.xlsx**, **.csv**, **.zip** and **.pptx**:
no view may be cropped, and none may sit on a placeholder forever.

**Do:** on the same phone, rotate and open the doc again.
**Expect:** the view re-fits the new width.

**Do:** open a PDF → tap **Duplicate page** → then edit, draw on, delete or
reorder the copy.
**Expect:** the copy is a real page you can edit **on its own** (changing the
copy alone; the original keeps its rotation/annotations). *Error rendering page:
Cannot read properties of undefined (reading 'node')* — or a tool silently
editing the *original* instead of the page you are looking at — is the bug this
release fixed. Tools that used to do nothing (draw-on-page, white-out, add text,
crop, merge) must change exactly the page you are viewing.

**Do:** right-click a message → **Copy Text** → paste into an editor.
**Expect:** the message text only. The time and the *(edited)* marker are not
included — they sit inside the same element in the DOM but are display-only.

**Do:** copy text from a message you have *edited* and one with a hover timestamp.
**Expect:** neither leaves a `14:32` or an `(edited)` at the end of the paste.

**Do:** send yourself a `.tar` and a `.tar.gz` (any `tar` tool makes one) and tap
**Preview** on each.
**Expect:** the file list (names + sizes), not *Failed to render document*. A
plain `.gz` of one file lists that one file, and tapping it previews it if it is
text or an image. `.zip` behaves as before.

**Do:** send a legacy Word 97-2003 `.doc` (the kind Word saves as *Word 97-2003
Document*), then an RTF file saved as `.doc`.
**Expect:** the OLE2 one shows a card saying it is a Word 97-2003 file and to
re-save it as `.docx` (never *Failed to render document*, never a blank view);
the RTF one shows its text with a one-line note. **Save a copy** works for both.

**Do:** send an `.rar` and a `.7z`.
**Expect:** no Preview button at all — they are downloads. (`.rar`/`.7z` need
codecs the app does not ship, so it does not pretend to open them.)

**Do (PDF):** open a PDF → **Crop Page** → remove 1 inch from every edge.
**Expect:** the page really is smaller by an inch on each side after the render —
before this release the crop box was built from the wrong numbers, so nothing
visibly happened. Margins larger than the page are refused with a message that
names the page size.

**Do (Android or a touchscreen):** PDF → **Draw** → drag with your **finger**
(not a mouse) → **Apply**.
**Expect:** the strokes follow your finger and land on the page. Before, the
overlay only listened for mouse events, so touching it drew nothing. Also check
that the stroke lands on the page you started drawing on if you switch pages
before pressing Apply.

---

## 22. Cancelling an upload, deleted things staying deleted, icon packs, on-device captions, Arch (0.2.33)

What changed: Cancel really cancels, every "delete" takes everything with it,
you can replace the app's icons, captions are transcribed on your own device,
and the Arch package no longer opens a grey window.

**Do:** attach a large file (say 40 MB) and press **Cancel** while it is
uploading.
**Expect:** the dialog closes at once, the message is **not** sent, and no
half-uploaded attachment is left behind — the server deletes the file record and
every chunk written so far. Reload and confirm nothing appears in the channel.
(If a file was already sent as a message, Cancel cannot touch it: that one
belongs to the message.)

**Do:** send a message with an attachment, then right-click it → **Delete**, in
both a channel and a DM.
**Expect:** the message disappears **immediately** and the app stays responsive.
Before this release this deadlocked the whole server on an attachment message
(the thread was waiting on a database lock it already held), so the message
stayed and *everything else* stopped working until a restart.

**Do:** create a server, put a message with an attachment in each of two
channels, then delete one channel.
**Expect:** only that channel's message and attachment go; the server, the other
channel and its attachment are untouched.

**Do:** as the server owner, leave the server (**Leave Server**), then look at the
admin panel's server list.
**Expect:** the server is gone entirely — channels, categories, roles and their
overwrites, voice sessions and participants, per-channel profiles, the server
picture and **every attachment in it**. Repeat with the admin panel's own
**Delete** for a server and for a channel: the result must be identical (the
three paths now share one implementation).

**Do:** delete a user account that owned a server and had a DM with attachments
(table the other person sent).
**Expect:** the server and the DM are gone, the partner's account still works,
and none of the attachments remain on the server (including the ones the deleted
user did not upload).

**Do (desktop or Android box):** open Settings.
**Expect:** there is now an **Icons** tab beside **Connection**. Open it: the
two slots and the current icon set are shown, and switching to a slot that holds
a pack changes the app's icons. A plain browser never shows either tab.

**Do:** start a voice channel or DM call, then turn **captions** on in the
audio settings.
**Expect:** the first time, the status line says it is loading the offline
speech model (from the app itself — nothing is downloaded from the internet),
then lines appear labelled with **who spoke**, for *everyone* on the call, not
just you. Turn on **Also caption my own voice** to include yourself. Nothing is
sent to the other participants and nothing is saved. Turning captions off drops
the lines at once.

**Do (Arch):** install the published `pkg.tar.zst`, launch it, and open a server.
**Expect:** the window paints the chat UI. Before this release it opened grey —
WebKitGTK's DMA-BUF renderer fails on many drivers; the app now turns it off
before creating the window. If you *want* the DMA-BUF path,
`E2E_CHAT_WEBKIT_DMABUF=1` re-enables it (and `WEBKIT_DISABLE_DMABUF_RENDERER=0`
is respected too).

**Do (any platform, on a phone or a narrow window):** send a file whose name is
one long unbroken string, or with a very long mime type.
**Expect:** the card stays inside the message column and the chat does **not**
gain a horizontal scrollbar; the name and the size/mime line wrap.

---

## 23. Captions that actually caption, a swappable DM icon, a real icon crop (0.2.34)

What changed: in a real call captions attached nobody, so they produced nothing
at all; the DM-conversation button could not be re-iconed from the Icons tab; a
picture used as an icon got stretched into a fixed 24x24 box instead of being
cropped; "Reset speaker volume" saved the setting but left the slider alone; and
v0.2.33 published two release objects for one tag, the empty one being what
`/releases/latest` pointed at.

### Captions — the one to test first

You need **two accounts in a call** (two browser profiles, or a browser + the
desktop box) and speech to transcribe. Captions transcribe the *other*
participants' audio; your own voice only if you turn that on separately.

**Do:** with both accounts signed in, start a **DM call** (or join a voice
channel) and accept it. Then on **one** side open Settings → the voice/audio
section → turn **captions** on.
**Expect:** the captions panel appears straight away and its status line is not
blank — `Loading the on-device speech model (…)…` the very first time (the model
ships with the app and is served by *your own server*; nothing is fetched from
the internet), then `Listening — no call audio yet. Captions appear when someone
speaks.`, then `Listening to 1 participant · waiting for speech`.

**Do:** speak a full sentence on the *other* account — normal volume, your
ordinary microphone.
**Expect:** within a few seconds a line appears, labelled with **who spoke**
(their display name), showing what they said. Before this release this was the
broken case: the panel stayed empty no matter how long anybody talked, because
the call attached the audio to the engine and immediately detached it again.

**Do:** turn captions on *while* someone is already mid-sentence.
**Expect:** the sentence is not thrown away — the window captured while the model
finishes loading is transcribed as soon as it is ready (it used to be dropped).

**Do:** leave the call, come back, and have a third person join mid-call.
**Expect:** every participant still gets captioned, including the one who joined
last. Turn on **Also caption my own voice** to include yourself.

**Do:** turn captions off.
**Expect:** the panel closes at once and the lines are gone from the page and from
memory (`window.__captions.lines()` is empty).

**Try to break it:** reload mid-call with captions on; switch tabs away and back;
mute and unmute the speaker. Captions must resume on their own — nobody should
have to toggle the setting off and on to make lines appear. Then watch the
network tab: no audio, no text and no third-party request may leave the machine
(the model files all come from your server), and DevTools' Application →
Local/Session Storage must not contain a single transcribed word.

### The other four

**Do (desktop or Android box):** Settings → **Icons**. Look at the grid.
**Expect:** the **Direct Messages** button (the round chat bubble at the top of
the far-left strip) is now in the list — it is the button that opens your DM
conversations, and it used to be the one control whose glyph was hard-coded, so
no pack could change it.

**Do:** in that tab, click any icon and pick a **PNG/JPEG/WebP that is not
square**.
**Expect:** a crop dialog appears with your picture and a draggable square. Drag
the square around, drag its bottom-right corner to resize it (it stays square),
then press **Use this square**.
**Expect:** the preview shows exactly that square, not the whole picture letter-
boxed and not squashed into a 24x24 box.

**Do:** do the same with an **animated GIF** (e.g. a small looping spinner).
**Expect:** the dialog shows it moving, and after **Use this square** and
**Save**, the actual app icon animates in place — the file is kept as-is (the
crop is the icon's coordinate square, not a re-encoded PNG), so animation
survives.
**Try to break it:** crop a very wide GIF from one edge; crop a 12x12 image (it
is allowed to upscale modestly so you can still aim); cancel the dialog — the
previous icon must be untouched.

**Do:** Settings → the voice/audio section, drag the speaker volume slider to
something other than 100, then click the **↺** reset beside it.
**Expect:** the slider jumps back to 100 and the number label follows. Before
this release the stored value went to 100 while the slider stayed where you left
it, because the reset threw an error halfway through.

**Do (release page):** open the repository's **Releases** and the v0.2.34 entry.
**Expect:** exactly **one** release for the tag, with all the assets — `.msi`,
`.exe` (NSIS), `.AppImage`, `.deb`, `.rpm`, the Arch `.pkg.tar.zst`, the Android
`.apk` and the `SHA256SUMS-*.txt` files. The v0.2.33 tag had two release objects
for the one tag and the *empty* one was what "latest" resolved to, so the page
listed no downloads at all.

---

## 24. Selecting text, the message menu button, other apps' audio, and a measured accuracy claim (0.2.35)

### Selecting text

**Do (desktop):** drag the mouse across the words of a message.
**Expect:** the words highlight, and you can copy them. This is the *only*
place in the app that selects: drag across a channel name, a server rail item, a
display name, an avatar's initial or a member row and nothing highlights (the
browser's own copy/select menu must not appear over those).

**Do (desktop):** click the invite code (Invite modal), a friend code, or the
identity key in Settings → Security.
**Expect:** the whole value selects in one click (`user-select: all`) — those
exist to be copied, and they still work.

**Do (phone or a touch screen):** press and hold a message.
**Expect:** no text selection appears. A phone keeps the app-wide rule; the
long-press is how the message menu is reached.

**Try to break it:** drag from a message out into the channel list and back —
the selection should stay inside the message, and dropping on a rail item must
still reorder it rather than highlight text.

### The ⋯ button on a message

**Do:** hover a message and click **⋯**.
**Expect:** the same menu a right-click opens — Reply, Reply in Thread,
Forwards, Pin, Copy Text, Copy Message Link, Block User. Right-click the same
message and compare: it must be the identical list (one builder draws both).

**Do (touch screen):** look at a message without hovering.
**Expect:** with the default **Display → Message Actions = Show on hover**, the
whole row (pin, react, edit, delete, ⋯) is hidden until you hover (a tap usually
counts as a hover on a phone). Switch it to **Always on** and the row stays up
on every message — ⋯ *alongside* pin/react/edit/delete, not ⋯ alone — exactly
like desktop.

**Try to break it:** click ⋯, then click a menu item. It should act on *that*
message and close. Then click ⋯ twice in a row — one menu, not two stacked.

### Other apps' audio (1.4)

**Do (Android):** start music, then join a voice channel with Settings → Voice →
**Other Apps' Audio** on (the default).
**Expect:** the music pauses while you are in the call and resumes on hang-up.
Turn the toggle **off** *during* the call: the music should start again without
waiting for the next call.

**Try to break it:** leave the toggle off, leave the call, start a call again —
the music must keep playing throughout.

### Animated wallpaper speed

**Do:** Settings → Display → App Background, choose an animated GIF or a video,
then move the **Speed** slider away from 1×.
**Expect:** the wallpaper re-times as you drag, with no restart and no reload —
including the preview box. At exactly 1× the still `<img>` comes back (no
decoder running). Reload: the rate is still the one you set.

**Try to break it:** set 0.25×, reload, and set 3× — the number under the slider
and the animation must agree on both, and a rate must never snap back to 1× on
its own (that was the bug in the first version: the bounds were declared below
the settings loader, so everything clamped against `undefined`).

### Captions: the model, the benchmark, and the accuracy number

**Do:** Settings → Live Captions → **Benchmark this machine**.
**Expect:** a readout with the CPU figure (seconds per 30-second window and how
far ahead of real time that is) and, on a machine with no WebGPU, an honest
"not usable here" for the GPU rather than a fast zero. Nothing is uploaded.

**Do:** speak a sentence with the model set to *whisper-tiny*, then switch to
*whisper-base* and watch the status line.
**Expect:** the status names the model it actually loaded and the 30-second
window. Both models must be on disk (`static/vendor/asr/whisper-tiny`,
`.../whisper-base`) — a release that quietly ships without one shows a model in
the list that can never load.

**Try to break it:** run with no network at all. Captions must still work: both
models, the wasm runtime and the QR scanner are served by your own server, and
the page's CSP names no external origin.

### Release page

**Do:** open the repository's **Releases** and the v0.2.35 entry.
**Expect:** one release for the tag carrying `.msi`, `.exe` (NSIS), `.AppImage`,
`.deb`, `.rpm`, the Arch `.pkg.tar.zst`, the Android `.apk` and
`SHA256SUMS-*.txt`. The Windows installer is noticeably larger than 0.2.34
(~100 MB): the second speech model is bundled inside it, which is the price of
captions that work offline.

---

## 23. Message-action modes, live icon packs, kick/ban purge, notch (0.2.37)

What changed: the per-message action row is one row on desktop and touch with a
Display setting; icon packs save to the server as you edit them (no Save &
apply) and every icon has its own reset; kick and ban wipe the member's data
like leaving does; the browser no longer draws the wipe button; the vault lock
screen has a show/hide password control; message text is selectable on a
fine-pointer device again; the top chrome clears a camera notch; and you can no
longer block yourself.

### Message action modes

**Do:** Settings → Display → **Message Actions**, choose **Always on**.
**Expect:** every message shows the full row — pin, react, edit, delete, ⋯ —
with no hover on desktop, and the same on a phone. Choose **On hover** and the
row only appears when you hover a message. **Off** hides it everywhere; the
right-click menu (desktop) and the ⋯ menu still carry every action.
**Try to break it:** with the row off, right-click a message and confirm Reply,
Edit, Delete, Pin and Block are all still there.

### Icon packs save as you edit

**Do:** Settings → Icons → pick **Slot 1**, click an icon, upload a picture and
crop it, or upload an .svg pack.
**Expect:** the change appears at once and the status line says it is saving to
your server, then confirms the encrypted size. There is **no Save & apply**
button. Reload the app: the pack is still there (it lives encrypted on the
server, not in localStorage).
**Do:** click the small **reset** control under a customized icon.
**Expect:** only that icon returns to the built-in artwork; the rest of the pack
is untouched, and the change saves automatically. A built-in icon's reset
control is dimmed and does nothing.
**Try to break it:** upload a pack big enough to exceed 4 MB once encrypted.
**Expect:** an honest "Auto-save failed: … the limit is 4096 KiB" message while
you are still editing — not a silent loss on reload.

### Kick and ban purge the member's data

**Do:** as the owner, have another account post messages and react to a few in
your server, then **Kick** (or **Ban**) them.
**Expect:** their messages disappear for everyone, their reactions/votes/pins on
other people's messages go, and their per-server profile snapshot and voice
state are gone — the same clean slate **Leave** produces. Reload a second
account to confirm nothing of theirs is left.
**Try to break it:** ban a user, unban them, and have them rejoin — the old
messages must not come back (the rows were deleted, not hidden).

### The wipe button and the vault password

**Do:** open the server's address in an ordinary **browser**.
**Expect:** no floating "clear all app data" button anywhere — that control is
native-app only. Settings → Clear All Local Data and `Alt+Shift+W` still work.
**Do:** open the **desktop or Android app** and look at the same page.
**Expect:** the floating button is there.
**Do:** restart into the locked **Unlock your key vault** screen and type a
password.
**Expect:** the same show/hide (eye) control every other password field has lets
you check what you typed before unlocking.

### Notch and blocking yourself

**Do (phone with a camera notch):** open the app in portrait.
**Expect:** the server name, channel name and rail icons sit **below** the notch,
not under it.
**Do:** open your own message's context menu (right-click) and your own profile.
**Expect:** no **Block User** entry for yourself, and blocking your own id by
hand does nothing (the server refuses it and the app no longer hides your own
messages as "blocked").

---

## 25. Large PDFs, touch drag, the GPU toggle, and whole-blob media (0.2.38)

### A 10 MB PDF must not take the app down

**Do:** in a text channel, post a PDF with a lot of pages (a 10 MB scan is the
real case) and click it to open.
**Expect:** the editor opens; the thumbnail strip fills in as you scroll it; the
window never blanks, freezes or closes. Scroll to the last page and back — every
page still renders (released pages re-render when they come back into view).
**Do:** press Undo fifteen times.
**Expect:** it stays responsive; the app never grows to hold fifteen copies of
the file (the undo stack is capped by bytes as well as by count).
**Do (the plain preview, e.g. from a file card's Preview):** open the same PDF.
**Expect:** the page count is shown and only the pages near the viewport are
drawn; scrolling fills the rest in.

**Try to break it:** open the PDF, scroll to the bottom fast, close the editor,
and reopen it. Memory should come back down, not climb with each open.

### Long-press a little too shaky

**Do:** Settings → Display → **Touch Drag** → *Very loose* (28 px). On a touch
screen, long-press a server icon (or a channel, DM or role) and let your finger
wobble a few pixels before the pick-up fires.
**Expect:** it still picks up and reorders. Now set it to *Tight* (6 px) and make
the same small movement — the list scrolls instead, which is the intent.

**Try to break it:** with *Tight*, hold perfectly still for the full press; it
must still pick up (the threshold is about movement, not the press length).

### Turning the GPU off on a machine that needs it

**Do (desktop app):** Settings → Display → **Hardware Acceleration** → turn it
off, then fully close and reopen the app.
**Expect:** the toggle is remembered (the shell persists it, not just the
browser profile), the window opens and renders normally — with software
rendering. Turn it back on and reopen to confirm the GPU returns.
**Do (plain browser):** open the settings.
**Expect:** the Hardware Acceleration section is not shown at all (it is a shell
launch flag; a browser tab has no such thing).

**Try to break it:** flip the toggle on, close the app *without* restarting, and
reopen — the setting must reflect the last choice, and the app must still open.

### An image downloads in one piece, not chunk-by-chunk

**Do:** with **auto-load previews** on, open a channel containing an image or GIF
and watch the Network tab.
**Expect:** exactly one `/api/files/…/download` request, and **no**
`/api/files/…/chunk/…` GETs. The blob is fetched whole and then decrypted.
**Do:** turn auto-load previews off, reopen the channel. Click **Load preview**.
**Expect:** nothing is downloaded until the click, and the click makes the same
single full download.

**Try to break it:** load a gallery of several images at once — each is one
download, still no per-chunk GETs, and avatars/profile pictures keep rendering
(they take the same rewritten decrypt path).

### No plaintext in the console

**Do:** make an audio preview fail (a stale key) and run **Download all** over a
message whose file key is missing, with the DevTools console open.
**Expect:** the warnings name the failure and nothing else — **no decrypted
filename** appears in the console.

## 26. Big spreadsheets, big archives, big decks (0.2.39)

The PDF work in §25 bounded one renderer; the other three that turn a file into
DOM nodes had the same unbounded shape. These checks confirm each is bounded and
that closing the view releases what it allocated.

### A spreadsheet with thousands of rows

**Do:** in a text channel, post an `.xlsx` whose first sheet has well over 500
rows and open its **Preview**.
**Expect:** the table shows the first 500 rows and the sheet label says so (`—
showing the first 500 rows × 100 columns`). The modal opens quickly and the tab
stays responsive. Switch to a second sheet and back — the label and the range
are correct for each sheet, and the untouched sheets are not truncated in the
workbook (exporting/opening the original elsewhere still has every row).

**Try to break it:** open a workbook with a single very wide sheet (>100
columns). It must render, not hang, and say it truncated the columns too.

### An archive with tens of thousands of entries

**Do:** post a `.zip` with tens of thousands of entries and open **Preview**.
**Expect:** the header shows the true file count and total size, and only the
first 300 rows are in the list, with **Scroll for more — N more** at the bottom.
Scrolling adds rows in chunks (the counter counts down). Clicking a small text
file inside still opens its inline preview.

**Try to break it:** scroll to the very bottom of a huge archive as fast as you
can — the list must keep filling without the window blanking or closing. Close
the modal; reopening the same archive must start from a low memory mark again
(nothing accumulates across opens).

### A presentation with many slides

**Do:** post a `.pptx` with a few dozen slides and open **Preview**.
**Expect:** every slide has its slot reserved immediately (the scrollbar is the
right length from the start), and only the slides near the viewport are actually
drawn — scroll and the rest fill in, in order. The counter shows the true slide
count.

**Try to break it:** scroll to the bottom fast, then close while it is still
filling. The modal closes at once and nothing keeps loading in the background
(reopen and the memory mark is not higher than the first open).

### Closing any of these releases its observers

**Do:** open the spreadsheet, the archive and the deck in turn, each time
closing with **Esc** and with the **backdrop click**.
**Expect:** every close is immediate, and repeating open → scroll → close ten
times leaves the process's memory roughly flat rather than growing each cycle.
