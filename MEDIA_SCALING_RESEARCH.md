# MEDIA SCALING RESEARCH — per-member video control + resolution selection (Option 1)

Research date: 2026-08-06. Status: RESEARCH ONLY — no code changed.
Scope: camera + screen share at user-selectable quality (144p…4K), Discord-style
on-demand per-member video (turn on/off camera vs screen separately), per-viewer
resolution that also changes what the SENDER transmits, and full compatibility
with the existing Insertable-Streams E2EE (static/e2ee-worker.js).

---

## 1. Current state of the code (baseline)

- Camera: `getUserMedia({ video: { width: { ideal: 1280 }, height: { ideal: 720 } } })` — fixed ~720p ideal.
- Screen: `getDisplayMedia({ video: { cursor: 'always' } })` — no resolution constraint.
- Tracks added with plain `pc.addTrack(track, new MediaStream([track]))` — NO
  `sendEncodings`, NO simulcast, NO per-recipient encodings.
- Every member receives ALL remote streams (full mesh, nothing culled).

So every capability described below is new and must be added on top of the
current `addTrack` path.

---

## 2. Can each recipient get a DIFFERENT resolution? YES — three mechanisms

### 2a. Per-recipient encodings (per-PC `RTCRtpSender.setParameters`) — the direct answer
Each `RTCPeerConnection` owns its OWN `RTCRtpSender` for your camera track.
`sender.getParameters().encodings[i]` supports:
- `scaleResolutionDownBy` — encode at a fraction of the capture resolution
- `maxBitrate` — cap bandwidth per stream
- `active` — true/false to start/stop sending that stream
- `rid` — simulcast layer id (see 2b)

So you can configure PC-A to send 144p and PC-B to send 1080p **from the same
captured camera**, independently, with NO SDP renegotiation (getParameters →
modify → setParameters applies on the fly). This is exactly the user's
"not only changing what they render but what the user sends to that person".

Cost: **each distinct resolution on a PC is a separate encoder session.**
Modern GPUs handle ~3–8 simultaneous hardware encodes (NVENC/AMF/QuickSync/
VideoToolbox) before falling back to CPU. Encoding 20 viewers at 20 different
resolutions = 20 encoder sessions → exhausts hardware fast. Mitigation:
quantize to a small menu (144/240/360/480/720/1080/4K) — but same-resolution
viewers still each consume a session on most browsers. **This caps pure
per-recipient encoding to ~3–8 concurrent viewers.**

### 2b. Simulcast (one encode → 2–3 layers, recipients get a layer) — the scalable answer
`pc.addTransceiver(track, { sendEncodings: [{ rid:'h', scaleResolutionDownBy:1 },
{ rid:'m', scaleResolutionDownBy:2 }, { rid:'l', scaleResolutionDownBy:7.5 }] })`
= ONE encoder producing up to **3 layers** (Chrome/Firefox limit is 3; Safari
camera 2–3). Every recipient's PC receives the same 3 layers; the sender then
**disables layers per-PC** via `setParameters` (e.g. viewer at 144p → keep only
rid 'l' active on their PC). Disabling a layer is cheap — the layer is already
encoded; you only stop packetizing it for that PC.

- Encoder load: **constant** (1 encode, 3 layers) regardless of viewer count —
  this is why Discord/Jitsi/Meet use simulcast.
- Resolution menu = the layers you chose (e.g. 1080p / 360p / 144p, or
  4K / 1080p / 360p). A viewer picking "240p" gets the nearest layer (360p)
  unless you add SVC (see 2c) or a per-PC override for outliers.
- **Screen share caveat**: Chrome supports simulcast for `getDisplayMedia`;
  **Firefox and Safari do NOT** → screen share falls back to 2a (single
  per-PC encoding) on those browsers.

### 2c. SVC (VP9/AV1 spatial scalability) — the "more layers" option
VP9/AV1 spatial layers can give finer granularity than simulcast, but Chrome's
SVC support is limited (typically up to 3 spatial layers, Firefox similar), and
it interacts with the E2EE transform the same way simulcast does (per-layer
streams). Not worth more than simulcast for a mesh today.

### 2d. Receiver-side layer selection — does NOT work in P2P
`RTCRtpReceiver.setParameters` for layer picking is effectively an SFU-side
feature; browsers pick layers automatically from bandwidth estimation (REMB/
TWCC) in P2P. So **per-viewer resolution must be enforced on the sender side**
(2a/2b), which conveniently matches the requirement ("what the user sends to
that person").

---

## 3. Discord-style on-demand per-member video (the "don't load everything" part)

Discord's model (with an SFU + their DAVE E2EE protocol):
- You receive a member's **audio** always (they're talking to you).
- Their **video/screen is NOT forwarded to you** until you click "watch" —
  the SFU simply doesn't forward that member's video stream to you. The sender
  encodes once; the SFU only egresses to opted-in viewers. (Discord's own
  DAVE announcement: SFrame media encryption + MLS keys; the SFU forwards
  ciphertext and sees metadata only.)

In OUR mesh, the same UX is achieved with **two complementary controls**:

1. **Receiver side (stop rendering/downloading):** don't attach the member's
   video track / don't render the tile until the user enables it. Pure JS.
2. **Sender side (stop transmitting — the real bandwidth win):**
   - Set that PC's video `encoding.active = false` via `setParameters`
     (no renegotiation) → you stop sending your video to that member entirely.
   - OR renegotiate `recvonly` (heavier, only for long-term disable).
   - **Camera and screen share are separate tracks/senders** → independent
     toggles, exactly as requested ("separate turning on and off camera and
     sharescreen").
   - A viewer can also set "receive at 144p" instead of off — sender keeps
     sending only the low layer (2b) or a low encoding (2a).

Flow: viewer clicks a member's tile → client sends a small signaling message
(existing `voice_signal` channel — still E2EE-encrypted) → sender applies
`setParameters` on that PC. When re-enabled, a PLI/keyframe request makes the
new stream appear in <1s.

---

## 4. Resolution capture (144p → 4K)

- `getUserMedia` constraints per preset:
  144p `{width:{ideal:256},height:{ideal:144}}`, 240p `{426,240}`,
  480p `{854,480}`, 720p `{1280,720}`, 1080p `{1920,1080}`, 4K `{3840,2160}`.
- Live change: `track.applyConstraints(...)` on the running track (no restart).
- `getDisplayMedia` accepts the same constraints (4K@60 capture is possible;
  actual max = monitor resolution + OS/encoder limits).
- **Design decision:** capture at the sender's configured maximum and use
  per-PC encodings/simulcast layers to serve lower resolutions — one capture,
  many output sizes. "4K only for the person who asked for 4K" = per-PC
  encoding (2a), which is why 4K is the most expensive option (1 viewer ≈ 1
  full 4K encoder session; cap it at 1–2 concurrent 4K viewers).
- Sender should be able to cap what they offer (e.g. camera max 1080p,
  screen max 4K) and the viewer can never exceed the sender's capture
  resolution (request min(requested, available)).

---

## 5. E2EE compatibility — VERDICT: fully preserved

Ground rules from the W3C WebRTC Encoded Transform spec:
- The transform is attached **per RTCRtpSender / RTCRtpReceiver** — each PC's
  sender and each incoming stream gets its OWN transform instance.
- Simulcast layers are separate RTP streams → each layer gets its own
  transform instance (the worker's existing per-transform key import already
  handles this; the keyCache is keyed by key material, so all layers share the
  same cached room key — no change needed).
- `setParameters` (layer disable, `active:false`, `scaleResolutionDownBy`,
  `maxBitrate`) happens AFTER the transform — it never touches the encryption
  layer.
- RTX retransmissions re-send the already-transformed payload (no re-encrypt);
  the transform is not applied to RTX/FEC packets by design, which is correct.

Therefore:
- **Per-PC different resolutions (2a):** each PC's sender transform encrypts
  with the same room key. E2EE intact.
- **Simulcast (2b):** each layer encrypted with the same room key. E2EE intact.
  (Google's E2EE sample and medooze's E2EE both ship simulcast + Insertable
  Streams.)
- **Per-member pause/resume (3):** `active:false` just stops sending the
  (already encrypted) stream. E2EE intact.
- **Receiver-side "not downloading":** the viewer simply never attaches the
  stream; the sender's transform is unaffected.
- Key rotation (room change / leave) already handled by the existing
  per-transform key logic.

The one structural change needed: currently one track is added to ALL PCs via
the same `addTrack` call. Per-recipient control requires **per-PC senders with
their own encoding config** — i.e. move from "addTrack once per PC" to
"addTransceiver per PC with sendEncodings (+ per-PC setParameters on demand)".
The transform attach logic stays identical.

---

## 6. Browser support matrix (what works where)

| Capability | Chrome | Firefox | Safari |
|---|---|---|---|
| RTCRtpScriptTransform (E2EE) | ✓ | ✓ (135+) | ✓ (15.4+) |
| Simulcast — camera (3 layers) | ✓ | ✓ | ✓ (2–3) |
| Simulcast — screen share | ✓ | ✗ | ✗ |
| Per-PC setParameters (scale/maxBitrate/active) | ✓ | ✓ | ✓ (partial) |
| applyConstraints live | ✓ | ✓ | ✓ |
| 4K capture | ✓ | ✓ | ✓ (HW-dependent) |

Fallback strategy: if `addTransceiver`/simulcast unsupported → single-encoding
per-PC `setParameters` (2a). If `setParameters` partial (Safari quirks) →
renegotiation path (heavier but correct). The E2EE toast/fallback logic already
exists for non-transform browsers.

---

## 7. Realistic cost model for the mesh (N members, per user)

With simulcast (2b) + per-member toggles (3):
- Your upload: audio (all N) + your camera layers to viewers who enabled it
  (only the enabled layer per PC) + screen layer to screen-viewers. Disabled
  members: audio-only → your upload stays small.
- Your download: audio (all N) + only the members' video/screen you enabled,
  at the layer you picked.
- Your decode: N audio + (enabled video streams only, ~few) → the 100-member
  audio problem reduces to the feasible case from the mesh analysis.
- Encoder: 1 camera encode (3 layers) + 1 screen encode (3 layers) —
  constant, Discord-style.

Pure per-recipient encoding (2a) remains available for exact 144p…4K menus but
is capped at ~3–8 concurrent distinct encodes (hardware limit) — use it for
outliers (e.g. "give me real 4K") on top of a simulcast baseline.

---

## 8. Recommendation (implementation order)

1. **Phase 1 — per-member toggles (biggest win, simplest):** receiver-side
   "don't render until I click" + sender-side per-PC `active:false` on the
   video/screen senders, camera and screen independent. E2EE untouched. This
   alone makes 20–100-member calls usable (audio-always, video-on-demand).
2. **Phase 2 — simulcast baseline:** switch video/screen send to
   `addTransceiver` + 3 layers (1080p/360p/144p camera; screen 1080p/540p/240p
   on Chrome, per-PC encoding fallback elsewhere). Viewer's "watch" picks a
   layer; sender enables only that layer per PC.
3. **Phase 3 — resolution menu (144p…4K):** map viewer choice to nearest layer;
   add per-PC encoding override for exact/4K requests (capped to 1–2 4K
   viewers). Sender caps what it offers.
4. All through the existing `voice_signal` (E2EE) channel for the
   enable/disable/resolution messages.

E2EE is preserved at every phase — the encryption layer is orthogonal to
routing/encoding decisions (same room key, per-stream transforms).

---

## 9. Sources

- W3C WebRTC Encoded Transform spec (w3.org/TR/webrtc-encoded-transform):
  transform is per RTCRtpSender/RTCRtpReceiver; SFrame + Script transform
  definitions; backpressure disabled (low-latency pipeline).
- MDN / W3C webrtc-pc: sendEncodings, scaleResolutionDownBy, maxBitrate,
  active, degradationPreference, applyConstraints; setParameters applies
  without renegotiation; encoding.active=false pauses per-PC sending.
- RFC 9605 (SFrame): E2EE for conference media with SFUs that see metadata
  only — the model Discord's DAVE follows.
- Discord engineering blog: "Every Voice and Video Call on Discord Is Now
  End-to-End Encrypted" (DAVE = SFrame + MLS); "Bringing DAVE to All Discord
  Platforms".
- Google E2EE sample + medooze E2EE: simulcast with Insertable Streams ships
  in production-grade E2EE WebRTC.
