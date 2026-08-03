# Voice Calls & Voice Channels — Complete Implementation Specification

## Table of Contents
1. [Architecture Overview](#1-architecture-overview)
2. [Database Schema](#2-database-schema)
3. [Server-Side: mediasoup Integration](#3-server-side-mediasoup-integration)
4. [Server-Side: Signaling WebSocket Messages](#4-server-side-signaling-websocket-messages)
5. [Server-Side: Voice Sanctions & Permissions](#5-server-side-voice-sanctions--permissions)
6. [Client-Side: Voice Module Architecture](#6-client-side-voice-module-architecture)
7. [Feature: Server Voice Channels](#7-feature-server-voice-channels)
8. [Feature: DM Calls](#8-feature-dm-calls)
9. [Feature: Audio (Microphone)](#9-feature-audio-microphone)
10. [Feature: Video (Camera)](#10-feature-video-camera)
11. [Feature: Screen Sharing / Go Live](#11-feature-screen-sharing--go-live)
12. [Feature: Speaking Detection & Indicator](#12-feature-speaking-detection--indicator)
13. [Feature: Mute / Deafen](#13-feature-mute--deafen)
14. [Feature: Push to Talk](#14-feature-push-to-talk)
15. [Feature: Noise Suppression](#15-feature-noise-suppression)
16. [Feature: Per-User Volume Control](#16-feature-per-user-volume-control)
17. [Feature: Owner Controls (Server Mute/Deafen/Kick)](#17-feature-owner-controls)
18. [Feature: End-to-End Encryption (E2EE)](#18-feature-end-to-end-encryption)
19. [Feature: AFK Timeout](#19-feature-afk-timeout)
20. [Feature: Voice Channel Settings](#20-feature-voice-channel-settings)
21. [UI/UX Specification](#21-uiux-specification)
22. [Notification Sounds](#22-notification-sounds)
23. [Edge Cases & Error Handling](#23-edge-cases--error-handling)

---

## 1. Architecture Overview

### Current (Broken) Approach
Our previous implementation used WebSocket to relay encrypted audio/video frames. This is fundamentally wrong because:
- WebSocket adds 50-100ms+ latency per hop
- No congestion control, no jitter buffer, no packet loss recovery
- No ICE/STUN/TURN for NAT traversal
- Manually reimplements what WebRTC does natively

### Correct Approach: WebRTC + SFU
```
                    ┌─────────────────────────────────────┐
                    │          mediasoup SFU               │
                    │  (Selective Forwarding Unit)         │
                    │                                      │
Client A ──WebRTC──►│  Forwards RTP packets between all    │◄──WebRTC── Client B
  (audio+video)     │  participants. Never decodes or      │     (audio+video)
                    │  re-encrypts media content.          │
Client C ──WebRTC──►│  Handles congestion control, RTCP,   │◄──WebRTC── Client D
  (audio+video)     │  and bandwidth estimation.           │     (audio+video)
                    └─────────────────────────────────────┘
                              ▲
                              │ Signaling (WebSocket)
                              │ (join, leave, mute, etc.)
                              ▼
                    ┌─────────────────────┐
                    │   Our Rust Server    │
                    │  (auth, permissions, │
                    │   room management)   │
                    └─────────────────────┘
```

### Key Principles
1. **Server NEVER touches media** — only signaling and room management
2. **WebRTC handles transport** — ICE, DTLS-SRTP, congestion control, jitter buffer
3. **mediasoup handles routing** — SFU forwards RTP packets between participants
4. **E2EE happens on client** — WebRTC EncodedTransform encrypts frames before they hit the wire
5. **Our server handles auth** — who can join, permissions, sanctions, call management

### Why This Works
- **Browser-native**: WebRTC is built into all modern browsers
- **Low latency**: UDP-based, <50ms typically
- **NAT traversal**: ICE/STUN/TURN handles firewalls
- **Scalable**: SFU just forwards packets, O(N) not O(N²)
- **Secure**: DTLS-SRTP for transport, E2EE for content
- **Battle-tested**: Powers Discord, Google Meet, Zoom, Jitsi

---

## 2. Database Schema

### Migration 050: Voice Calls

```sql
-- Voice rooms (active call sessions)
CREATE TABLE IF NOT EXISTS voice_rooms (
    id TEXT PRIMARY KEY,                        -- UUID
    room_type TEXT NOT NULL CHECK (room_type IN ('server', 'dm')),
    server_id TEXT REFERENCES servers(id),       -- for server voice channels
    channel_id TEXT,                             -- voice channel ID (server rooms)
    dm_channel_id TEXT,                          -- DM channel ID (DM calls)
    sfu_room_id TEXT NOT NULL,                   -- mediasoup router room ID
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    ended_at DATETIME,
    created_by TEXT NOT NULL                     -- user who started the room
);

-- Active voice participants
CREATE TABLE IF NOT EXISTS voice_participants (
    room_id TEXT NOT NULL REFERENCES voice_rooms(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME,
    PRIMARY KEY (room_id, user_id)
);

-- Voice sanctions (server owner controls)
CREATE TABLE IF NOT EXISTS voice_sanctions (
    server_id TEXT NOT NULL,
    user_id TEXT NOT NULL,
    force_muted BOOLEAN DEFAULT FALSE,
    force_deafened BOOLEAN DEFAULT FALSE,
    PRIMARY KEY (server_id, user_id)
);

-- Voice session logs (for admin panel analytics)
CREATE TABLE IF NOT EXISTS voice_session_logs (
    id TEXT PRIMARY KEY,
    room_id TEXT NOT NULL REFERENCES voice_rooms(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN (
        'join', 'leave', 'mute', 'unmute', 'deafen', 'undeafen',
        'camera_on', 'camera_off', 'screen_share_start', 'screen_share_stop',
        'server_mute', 'server_unmute', 'server_deafen', 'server_undeafen',
        'kicked', 'moved', 'ptt_activate', 'ptt_deactivate',
        'ring', 'ring_accepted', 'ring_declined'
    )),
    metadata TEXT,                               -- JSON for additional data
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Voice channel settings (per-server per-channel)
CREATE TABLE IF NOT EXISTS voice_channel_settings (
    server_id TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    bitrate INTEGER DEFAULT 64,                  -- kbps (8-384)
    user_limit INTEGER,                          -- NULL = unlimited
    region TEXT,                                 -- voice region override
    afk_channel BOOLEAN DEFAULT FALSE,           -- is this the AFK channel?
    afk_timeout_seconds INTEGER DEFAULT 300,     -- 5 minutes default
    PRIMARY KEY (server_id, channel_id)
);

CREATE INDEX idx_voice_participants_user ON voice_participants(user_id);
CREATE INDEX idx_voice_participants_room ON voice_participants(room_id);
CREATE INDEX idx_voice_rooms_server ON voice_rooms(server_id);
CREATE INDEX idx_voice_rooms_dm ON voice_rooms(dm_channel_id);
CREATE INDEX idx_voice_session_logs_room ON voice_session_logs(room_id);
CREATE INDEX idx_voice_session_logs_user ON voice_session_logs(user_id);
```

---

## 3. Server-Side: mediasoup Integration

### 3.1 mediasoup Worker & Router

Each server voice channel and DM call gets its own mediasoup Router.

```javascript
// server/voice/mediasoup-server.js
const mediasoup = require('mediasoup');

class VoiceServer {
    constructor() {
        this.workers = [];      // 1 worker per CPU core
        this.rooms = new Map(); // roomId -> { router, transports, producers, consumers }
    }

    async init(numWorkers = require('os').cpus().length) {
        for (let i = 0; i < numWorkers; i++) {
            const worker = await mediasoup.createWorker({
                rtcMinPort: 20000,
                rtcMaxPort: 40000,
                logLevel: 'warn',
                logTags: ['info', 'ice', 'dtls', 'srtp', 'rtp']
            });
            worker.on('died', () => {
                console.error(`mediasoup worker ${worker.pid} died`);
                setTimeout(() => process.exit(1), 2000);
            });
            this.workers.push(worker);
        }
    }

    async createRoom(roomId) {
        const worker = this.workers[0]; // round-robin
        const mediaCodecs = [
            { kind: 'audio', mimeType: 'audio/opus', clockRate: 48000, channels: 2 },
            { kind: 'video', mimeType: 'video/VP8', clockRate: 90000, parameters: {
                'x-google-start-bitrate': 1000
            }},
            { kind: 'video', mimeType: 'video/H264', clockRate: 90000, parameters: {
                'packetization-mode': 1,
                'profile-level-id': '42e01f',
                'level-asymmetry-allowed': 1
            }},
            { kind: 'video', mimeType: 'video/rtx', clockRate: 90000, parameters: {
                'apt': 102
            }}
        ];
        const router = await worker.createRouter({ mediaCodecs });
        this.rooms.set(roomId, {
            router,
            transports: new Map(),   // userId -> { sendTransport, recvTransport }
            producers: new Map(),    // producerId -> { userId, kind, producer }
            consumers: new Map(),    // consumerId -> { userId, producerId, consumer }
        });
        return router;
    }

    getRoom(roomId) {
        return this.rooms.get(roomId);
    }

    deleteRoom(roomId) {
        const room = this.rooms.get(roomId);
        if (!room) return;
        room.router.close();
        this.rooms.delete(roomId);
    }
}
```

### 3.2 Transport Creation

Each client creates 2 transports: one for sending, one for receiving.

```javascript
async function createTransport(room, userId, iceServers) {
    const transport = await room.router.createWebRtcTransport({
        listenInfos: [{
            protocol: 'udp',
            ip: '0.0.0.0',
            announcedIp: process.env.PUBLIC_IP,
            portRange: { min: 20000, max: 40000 }
        }],
        enableUdp: true,
        enableTcp: true,
        preferUdp: true,
        iceServers: iceServers || [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
        ],
        enableSctp: true,
        numSctpStreams: { OS: 1024, MIS: 1024 }
    });

    return {
        id: transport.id,
        iceParameters: transport.iceParameters,
        iceCandidates: transport.iceCandidates,
        dtlsParameters: transport.dtlsParameters,
        sctpParameters: transport.sctpParameters
    };
}
```

### 3.3 Producer Creation

When a client starts sending audio/video:

```javascript
async function handleProduce(room, userId, { kind, rtpParameters, appData }) {
    const producer = await room.transport.produce({
        kind,
        rtpParameters,
        appData: { userId, ...appData }
    });

    room.producers.set(producer.id, { userId, kind, producer });

    // Notify all other participants
    for (const [uid, transports] of room.transports) {
        if (uid !== userId && transports.recvTransport) {
            await createConsumer(room, uid, producer);
        }
    }

    return producer.id;
}
```

### 3.4 Consumer Creation

When a participant joins and needs to receive existing producers:

```javascript
async function createConsumer(room, consumerUserId, producer) {
    const consumerRoom = room;
    const consumerUserTransport = room.transports.get(consumerUserId);
    if (!consumerUserTransport?.recvTransport) return null;

    if (!room.router.canConsume({
        producerId: producer.id,
        rtpCapabilities: consumerUserTransport.rtpCapabilities
    })) {
        return null;
    }

    const consumer = await consumerUserTransport.recvTransport.consume({
        producerId: producer.id,
        rtpCapabilities: consumerUserTransport.rtpCapabilities,
        paused: true,  // start paused, resume after client confirms
        appData: { producerUserId: producer.userId }
    });

    room.consumers.set(consumer.id, {
        userId: consumerUserId,
        producerId: producer.id,
        consumer
    });

    return {
        id: consumer.id,
        producerId: producer.id,
        kind: producer.kind,
        rtpParameters: consumer.rtpParameters,
        producerUserId: producer.userId
    };
}
```

### 3.5 Room Cleanup

```javascript
function cleanupRoom(roomId) {
    const room = voiceServer.getRoom(roomId);
    if (!room) return;

    // Close all transports (closes all producers/consumers)
    for (const [userId, transports] of room.transports) {
        if (transports.sendTransport) transports.sendTransport.close();
        if (transports.recvTransport) transports.recvTransport.close();
    }

    voiceServer.deleteRoom(roomId);
}
```

---

## 4. Server-Side: Signaling WebSocket Messages

### 4.1 Client → Server Messages

#### voice_join
```json
{
    "type": "voice_join",
    "room_type": "server",        // "server" or "dm"
    "server_id": "abc123",        // for server voice channels
    "channel_id": "def456",       // for server voice channels
    "dm_channel_id": "ghi789"     // for DM calls
}
```

#### voice_leave
```json
{
    "type": "voice_leave"
}
```

#### voice_produce
```json
{
    "type": "voice_produce",
    "kind": "audio",              // "audio" or "video"
    "rtpParameters": { ... },     // WebRTC RTP parameters
    "appData": {
        "mediaType": "camera"     // "camera" or "screen"
    }
}
```

#### voice_consume
```json
{
    "type": "voice_consume",
    "producerId": "abc123"
}
```

#### voice_consumer_resume
```json
{
    "type": "voice_consumer_resume",
    "consumerId": "abc123"
}
```

#### voice_state
```json
{
    "type": "voice_state",
    "muted": false,
    "deafened": false,
    "camera": false,
    "screen": false,
    "speaking": false
}
```

#### voice_control
```json
{
    "type": "voice_control",
    "action": "mute",             // "mute", "unmute", "deafen", "undeafen", "kick", "move"
    "target_user_id": "xyz789",   // user to control
    "channel_id": "new_channel"   // only for "move" action
}
```

### 4.2 Server → Client Messages

#### voice_joined
```json
{
    "type": "voice_joined",
    "room_type": "server",
    "sfu_url": "https://sfu.example.com",
    "room_id": "room_abc123",
    "rtpCapabilities": { ... },     // mediasoup router RTP capabilities
    "iceServers": [
        { "urls": "stun:stun.l.google.com:19302" }
    ],
    "participants": [
        {
            "user_id": "user1",
            "username": "Alice",
            "muted": false,
            "deafened": false,
            "camera": false,
            "screen": false,
            "speaking": false,
            "force_muted": false,
            "force_deafened": false,
            "producers": ["prod1", "prod2"]
        }
    ]
}
```

#### voice_producer_created
```json
{
    "type": "voice_producer_created",
    "producerId": "prod_abc123"
}
```

#### voice_new_producer
```json
{
    "type": "voice_new_producer",
    "producerId": "prod_abc123",
    "userId": "user1",
    "kind": "audio",
    "appData": { "mediaType": "camera" }
}
```

#### voice_consumer_created
```json
{
    "type": "voice_consumer_created",
    "consumerId": "cons_abc123",
    "producerId": "prod_abc123",
    "producerUserId": "user1",
    "kind": "audio",
    "rtpParameters": { ... }
}
```

#### voice_member_update
```json
{
    "type": "voice_member_update",
    "user_id": "user1",
    "username": "Alice",
    "muted": false,
    "deafened": false,
    "camera": false,
    "screen": false,
    "speaking": false,
    "force_muted": false,
    "force_deafened": false
}
```

#### voice_member_leave
```json
{
    "type": "voice_member_leave",
    "user_id": "user1"
}
```

#### voice_room_empty
```json
{
    "type": "voice_room_empty"
}
```

#### voice_control_received
```json
{
    "type": "voice_control_received",
    "action": "server_mute",
    "by_user": "owner_user_id",
    "muted": true
}
```

#### voice_dm_call_ring
```json
{
    "type": "voice_dm_call_ring",
    "caller_id": "user1",
    "caller_username": "Alice",
    "dm_channel_id": "dm_abc123",
    "call_type": "voice"           // "voice" or "video"
}
```

#### voice_dm_call_end
```json
{
    "type": "voice_dm_call_end",
    "dm_channel_id": "dm_abc123",
    "reason": "ended"              // "ended", "declined", "missed"
}
```

#### voice_dm_call_accept
```json
{
    "type": "voice_dm_call_accept",
    "caller_id": "user1"
}
```

#### voice_transport_ready
```json
{
    "type": "voice_transport_ready",
    "transportId": "trans_abc123",
    "transportType": "send",       // "send" or "recv"
    "params": {
        "id": "...",
        "iceParameters": { ... },
        "iceCandidates": [ ... ],
        "dtlsParameters": { ... }
    }
}
```

#### voice_error
```json
{
    "type": "voice_error",
    "error": "room_full",          // error code
    "message": "Voice channel is full"
}
```

---

## 5. Server-Side: Voice Sanctions & Permissions

### 5.1 Permission Checks

```
CONNECT        → Can join voice channel
SPEAK          → Can transmit audio (requires CONNECT)
STREAM         → Can share screen/game (requires CONNECT)
MOVE_MEMBERS   → Can move users between channels (bypasses user limit)
MUTE_MEMBERS   → Can server mute users
DEAFEN_MEMBERS → Can server deafen users
```

### 5.2 Owner Control Actions

| Action | Permission Required | Server Behavior | Client Behavior |
|--------|-------------------|-----------------|-----------------|
| Server Mute | MUTE_MEMBERS | Sets force_muted=true in DB, broadcasts member update | User cannot unmute self |
| Server Unmute | MUTE_MEMBERS | Sets force_muted=false, broadcasts member update | User can unmute self |
| Server Deafen | DEAFEN_MEMBERS | Sets force_deafened=true, force_muted=true, broadcasts | User cannot undeafen self |
| Server Undeafen | DEAFEN_MEMBERS | Sets force_deafened=false, broadcasts | User can undeafen self |
| Kick | MOVE_MEMBERS | Removes from room, ends their producers | Shows "kicked" message, disconnects |
| Move | MOVE_MEMBERS | Removes from current room, joins target | Seamless transition |

### 5.3 Sanction Enforcement on Server

When a user is force_muted:
- Their `voice_produce` for audio is rejected (producer paused server-side)
- Their audio producers are paused until unmuted

When a user is force_deafened:
- Their audio AND video producers are paused
- Their consumers for all others are paused (they can't hear/see anyone)

---

## 6. Client-Side: Voice Module Architecture

### 6.1 Module Structure

```
static/voice/
├── voice-main.js          # Entry point, VoiceManager API
├── voice-connection.js    # mediasoup Device, Transport management
├── voice-producer.js      # Audio/Video/Screen producer management
├── voice-consumer.js      # Remote stream consumer management
├── voice-ui.js            # All UI rendering (bars, popups, panels)
├── voice-vad.js           # Voice Activity Detection
├── voice-ptt.js           # Push to Talk
├── voice-e2ee.js          # End-to-end encryption transforms
├── voice-settings.js      # User preferences (mic volume, etc.)
└── voice-sounds.js        # Notification sounds
```

### 6.2 State Machine

```
IDLE
  │
  ├── voice_join (server channel) ──► JOINING_SERVER_CHANNEL
  │   └── voice_joined received ──► CONNECTED_SERVER
  │
  ├── voice_join (DM call) ──► JOINING_DM_CALL
  │   ├── ring received ──► RINGING (callee)
  │   └── voice_joined received ──► CONNECTED_DM
  │
  ├── dm_call_start ──► CALLING_DM
  │   ├── call accepted ──► CONNECTED_DM
  │   ├── call declined ──► IDLE
  │   └── no answer (30s) ──► IDLE
  │
  └── voice_leave / disconnect ──► IDLE
```

### 6.3 Core State Variables

```javascript
var VoiceState = {
    // Connection
    status: 'idle',         // idle, joining, connected, reconnecting
    roomType: null,         // 'server' or 'dm'
    roomId: null,           // mediasoup room ID
    sfuUrl: null,           // SFU endpoint URL

    // mediasoup
    device: null,           // mediasoupClient.Device
    sendTransport: null,    // mediasoupClient.Transport
    recvTransport: null,    // mediasoupClient.Transport
    producers: {
        audio: null,        // audio producer
        video: null,        // camera producer
        screen: null        // screen share producer
    },
    consumers: new Map(),   // consumerId -> consumer

    // User state
    selfUserId: null,
    selfUsername: null,
    muted: false,
    deafened: false,
    cameraOn: false,
    screenOn: false,
    speaking: false,
    forceMuted: false,
    forceDeafened: false,

    // Remote participants
    participants: new Map(), // userId -> { username, muted, deafened, camera, screen, speaking, producers }

    // DM call
    dmCallState: null,       // null | 'ringing' | 'calling' | 'connected'
    dmCallOtherUser: null,   // { id, username }
    dmCallChannelId: null,

    // UI
    voiceBarVisible: false,
    popupOpen: false,
    miniBarVisible: false,

    // Settings
    micVolume: 100,
    speakerVolume: 100,
    noiseSuppression: true,
    pushToTalk: false,
    pttKey: null,
    pttDelay: 200,

    // Media streams
    micStream: null,
    cameraStream: null,
    screenStream: null,
    audioContext: null
};
```

---

## 7. Feature: Server Voice Channels

### 7.1 Joining a Voice Channel

**User Flow:**
1. User clicks a voice channel in the channel list
2. Voice bar appears at bottom-left showing "Voice Connected" + channel name
3. Mic auto-starts (if not deafened)
4. Other participants' audio streams begin playing
5. Participant list updates in right sidebar

**Implementation:**
```
User clicks channel →
  Client sends: { type: "voice_join", room_type: "server", server_id, channel_id } →
  Server checks: CONNECT permission, user_limit not exceeded →
  Server creates/gets mediasoup room →
  Server creates voice_rooms + voice_participants records →
  Server sends: { type: "voice_joined", room_id, rtpCapabilities, participants[] } →
  Client creates mediasoup Device, loads router capabilities →
  Client creates sendTransport →
  Client creates recvTransport →
  Client produces audio track →
  Client consumes all existing producers →
  Client starts mic capture →
  Client starts speaking detection →
  Server broadcasts voice_member_update to others
```

### 7.2 Leaving a Voice Channel

**User Flow:**
1. User clicks disconnect button (red phone icon) in voice bar
2. Voice bar disappears
3. All audio/video stops
4. Participant list updates
5. If room is empty, room is destroyed

**Implementation:**
```
User clicks disconnect →
  Client: stop all producers, close transports →
  Client sends: { type: "voice_leave" } →
  Server: remove from voice_participants →
  Server: close all producers/consumers for this user →
  Server broadcasts: voice_member_leave to others →
  Server checks if room empty →
  If empty: voice_room_empty to remaining (none), cleanup room →
  Client: clear state, hide UI
```

### 7.3 Channel List Facepile

When a voice channel has participants, show overlapping avatars in the channel list:

```css
.voice-facepile {
    display: flex;
    flex-direction: row-reverse;  /* newest at right */
    margin-left: 8px;
}
.voice-facepile-avatar {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    border: 2px solid var(--background-primary);
    margin-left: -8px;  /* overlap */
}
.voice-facepile-avatar.speaking {
    border-color: #23a55a;  /* green */
    box-shadow: 0 0 0 2px #23a55a;
}
.voice-facepile-overflow {
    width: 28px;
    height: 28px;
    border-radius: 50%;
    background: var(--background-secondary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 10px;
    color: var(--text-muted);
}
```

### 7.4 User Limit

- Channel shows "X/Y" when limit is set (e.g., "5/10")
- When full: "Join" button shows "Full" instead
- Users with MOVE_MEMBERS permission can bypass the limit
- Users already in channel remain when limit is lowered

---

## 8. Feature: DM Calls

### 8.1 Starting a DM Call

**User Flow:**
1. In DM header, two icons: 📞 (voice) and 📹 (video)
2. Click either to start a call
3. Other user receives incoming call UI
4. Other user can Accept or Decline
5. If accepted: both enter the call
6. If declined: caller sees "Call Declined"
7. If no answer after 30 seconds: "No Answer"

**Implementation:**
```
Caller clicks phone icon →
  Client sends: { type: "voice_join", room_type: "dm", dm_channel_id } →
  Server creates DM voice room →
  Server sends voice_dm_call_ring to other user →
  Callee sees incoming call UI →
  Callee clicks Accept →
    Client sends: { type: "voice_join", room_type: "dm", dm_channel_id } →
    Server adds callee to room →
    Server sends voice_dm_call_accept to caller →
    Both proceed with mediasoup connection →
  Callee clicks Decline →
    Client sends: { type: "voice_dm_call_decline", dm_channel_id } →
    Server sends voice_dm_call_end to caller →
  30 seconds pass →
    Server sends voice_dm_call_end to caller (reason: "missed")
```

### 8.2 Incoming Call UI

```
┌──────────────────────────────────────┐
│  📞 Incoming call from Alice         │
│                                      │
│  ┌────────┐                          │
│  │ Avatar │  Voice Call              │
│  └────────┘                          │
│                                      │
│  [ Accept ]        [ Decline ]       │
└──────────────────────────────────────┘
```

- Shows at the top of the DM conversation
- Ringing sound plays every 3 seconds
- Vibrates on mobile
- Auto-declines after 30 seconds
- Shows "Call Ended" if caller hangs up

### 8.3 DM Call Panel (Active Call)

When in a DM call, the chat area shows the call panel:

```
┌──────────────────────────────────────┐
│  📞 In call with Alice    05:23      │
│                                      │
│  ┌──────────────┐ ┌──────────────┐   │
│  │              │ │              │   │
│  │   Alice      │ │    You       │   │
│  │  (avatar)    │ │  (avatar)    │   │
│  │              │ │              │   │
│  └──────────────┘ └──────────────┘   │
│                                      │
│  [🎤] [🔇] [📷] [🖥️] [📞]          │
│   Mic  Deaf  Cam  Screen  End       │
└──────────────────────────────────────┘
```

- Each participant gets a tile (grid adapts to count)
- Camera/screen share shows video feed in tile
- Speaking shows green ring around avatar
- Muted shows mic-slash icon
- Controls at bottom: Mic, Deafen, Camera, Screen Share, End Call
- End Call button is red

### 8.4 Mini Bar (Switching Away from DM Call)

When in a DM call and user switches to another chat:
- Voice bar stays visible at bottom
- Shows "📞 In call with Alice"
- Clicking the bar returns to DM chat
- Audio continues playing
- Camera/screen continue streaming

---

## 9. Feature: Audio (Microphone)

### 9.1 Microphone Capture

```javascript
async function startMicCapture() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
                echoCancellation: true,
                noiseSuppression: VoiceState.noiseSuppression,
                autoGainControl: true,
                sampleRate: 48000,
                channelCount: 2
            },
            video: false
        });
        VoiceState.micStream = stream;
        const audioTrack = stream.getAudioTracks()[0];

        // Apply mic volume
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(stream);
        const gainNode = audioContext.createGain();
        gainNode.gain.value = VoiceState.micVolume / 100;
        source.connect(gainNode);
        // Note: for mediasoup, we need the raw track, not processed
        // Volume is applied on receiver side

        // Produce audio
        VoiceState.producers.audio = await VoiceState.sendTransport.produce({
            track: audioTrack,
            codecOptions: {
                opusStereo: false,
                opusDtx: true,       // Discontinuous Transmission (silence detection)
                opusFec: true,       // Forward Error Correction
                opusPtime: 20        // 20ms frames
            },
            appData: { mediaType: 'audio' }
        });

        VoiceState.micStream = stream;
    } catch (err) {
        console.warn('Mic access denied:', err);
        VoiceState.muted = true;
        toast('Microphone access denied. You are muted.');
    }
}
```

### 9.2 Mute Audio (Simple)

```javascript
function muteMic() {
    if (VoiceState.producers.audio) {
        // Option 1: Pause producer (no bandwidth used)
        VoiceState.producers.audio.pause();

        // Option 2: Disable track (sends silence, still uses bandwidth)
        // VoiceState.producers.audio.track.enabled = false;

        VoiceState.muted = true;
        sendVoiceState();
    }
}

function unmuteMic() {
    if (VoiceState.forceMuted) {
        toast('You are server-muted and cannot unmute.');
        return;
    }
    if (VoiceState.producers.audio) {
        VoiceState.producers.audio.resume();
        VoiceState.muted = false;
        sendVoiceState();
    }
}
```

### 9.3 Replace Audio Track (Device Switch)

```javascript
async function switchMicDevice(deviceId) {
    const stream = await navigator.mediaDevices.getUserMedia({
        audio: { deviceId: { exact: deviceId } }
    });
    const newTrack = stream.getAudioTracks()[0];
    if (VoiceState.producers.audio) {
        await VoiceState.producers.audio.replaceTrack({ track: newTrack });
    }
}
```

---

## 10. Feature: Video (Camera)

### 10.1 Camera Capture

```javascript
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            video: {
                width: { ideal: 1280 },
                height: { ideal: 720 },
                frameRate: { ideal: 30 },
                facingMode: 'user'
            },
            audio: false
        });
        VoiceState.cameraStream = stream;
        const videoTrack = stream.getVideoTracks()[0];

        VoiceState.producers.video = await VoiceState.sendTransport.produce({
            track: videoTrack,
            encodings: [
                { rid: 'h', maxBitrate: 1200000, scaleResolutionDownBy: 1 },
                { rid: 'm', maxBitrate: 600000, scaleResolutionDownBy: 2 },
                { rid: 'l', maxBitrate: 300000, scaleResolutionDownBy: 4 }
            ],
            codecOptions: {
                videoGoogleStartBitrate: 1000
            },
            appData: { mediaType: 'camera' }
        });

        VoiceState.cameraOn = true;
        sendVoiceState();
        renderSelfVideo();
    } catch (err) {
        console.warn('Camera access denied:', err);
        toast('Camera access denied.');
    }
}

function stopCamera() {
    if (VoiceState.producers.video) {
        VoiceState.producers.video.close();
        delete VoiceState.producers.video;
    }
    if (VoiceState.cameraStream) {
        VoiceState.cameraStream.getTracks().forEach(t => t.stop());
        VoiceState.cameraStream = null;
    }
    VoiceState.cameraOn = false;
    sendVoiceState();
    renderMembers();
}
```

### 10.2 Camera Off Behavior

When camera is off:
- No video producer exists
- Tile shows avatar with username
- Other participants see the avatar, not a black screen

---

## 11. Feature: Screen Sharing / Go Live

### 11.1 Start Screen Share

```javascript
async function startScreenShare() {
    try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                cursor: 'always',
                width: { ideal: 1920 },
                height: { ideal: 1080 },
                frameRate: { ideal: 30, max: 60 }
            },
            audio: {
                echoCancellation: false,
                noiseSuppression: false,
                autoGainControl: false
            }
        });

        VoiceState.screenStream = stream;
        const videoTrack = stream.getVideoTracks()[0];

        // Handle user stopping share via browser UI
        videoTrack.onended = () => stopScreenShare();

        // Simulcast for screen share
        VoiceState.producers.screen = await VoiceState.sendTransport.produce({
            track: videoTrack,
            encodings: [
                { rid: 'h', maxBitrate: 2500000, scaleResolutionDownBy: 1 },
                { rid: 'm', maxBitrate: 1000000, scaleResolutionDownBy: 2 },
                { rid: 'l', maxBitrate: 500000, scaleResolutionDownBy: 4 }
            ],
            codecOptions: {
                videoGoogleStartBitrate: 2000
            },
            appData: { mediaType: 'screen' }
        });

        VoiceState.screenOn = true;
        sendVoiceState();
    } catch (err) {
        console.warn('Screen share denied:', err);
        toast('Screen sharing was denied.');
    }
}
```

### 11.2 Screen Share vs Camera Differences

| Aspect | Camera | Screen Share |
|--------|--------|-------------|
| Resolution | 720p ideal | 1080p ideal |
| Frame Rate | 30 fps | 15-30 fps |
| Simulcast Layers | 3 (h/m/l) | 3 (h/m/l) |
| Bitrate | 300-1200 kbps | 500-2500 kbps |
| facingMode | 'user' | N/A |
| cursor | N/A | 'always' |
| E2EE | Yes | Yes |
| Hero slot | No | Yes (when watched) |

### 11.3 Screen Share Hero Slot

When someone is sharing their screen and others watch:
- Screen share gets the largest tile (hero slot)
- Other participants shown as smaller tiles below
- Clicking a participant thumbnail switches focus

---

## 12. Feature: Speaking Detection & Indicator

### 12.1 Voice Activity Detection

```javascript
function startSpeakingDetection() {
    if (!VoiceState.micStream) return;

    const audioContext = new AudioContext();
    const source = audioContext.createMediaStreamSource(VoiceState.micStream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    source.connect(analyser);

    const buf = new Uint8Array(analyser.fftSize);
    let lastSpeakSent = 0;

    setInterval(() => {
        analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
            const v = (buf[i] - 128) / 128;
            sum += v * v;
        }
        const rms = Math.sqrt(sum / buf.length);

        // Threshold: speaking if RMS > 0.02 and not muted/deafened
        const speaking = rms > 0.02 && !VoiceState.muted && !VoiceState.deafened;

        // Debounce: don't send state changes too frequently
        const now = Date.now();
        if (speaking !== VoiceState.speaking && now - lastSpeakSent > 120) {
            VoiceState.speaking = speaking;
            lastSpeakSent = now;
            sendVoiceState();
            updateSelfSpeakingUI();
        }
    }, 120);
}
```

### 12.2 Speaking Indicator Visual

```
┌─────────────────────────────────────┐
│  Normal state:                      │
│  ┌──────┐                           │
│  │  😊  │  ← Circular avatar       │
│  └──────┘    No ring                │
│                                     │
│  Speaking state:                    │
│  ╔══════╗                           │
│  ║  😊  ║  ← Green ring (3px)      │
│  ╚════╝      Animated/pulsing       │
│              Based on volume level  │
│                                     │
│  Muted state:                       │
│  ┌──────┐                           │
│  │  😊  │🎤  ← Mic-slash badge    │
│  └──────┘   Dimmed avatar           │
│                                     │
│  Deafened state:                    │
│  ┌──────┐                           │
│  │  😊  │🔇  ← Headphone-slash    │
│  └────══╝   Also muted             │
└─────────────────────────────────────┘
```

**CSS:**
```css
.voice-member-avatar {
    width: 40px;
    height: 40px;
    border-radius: 50%;
    border: 3px solid transparent;
    transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.voice-member-avatar.speaking {
    border-color: #23a55a;
    box-shadow: 0 0 0 2px #23a55a40;
    animation: speaking-pulse 1.5s ease-in-out infinite;
}
@keyframes speaking-pulse {
    0%, 100% { box-shadow: 0 0 0 2px #23a55a40; }
    50% { box-shadow: 0 0 0 6px #23a55a20; }
}
.voice-member-avatar.muted {
    opacity: 0.5;
}
```

### 12.3 Speaking State Flow

```
1. Client mic captures audio → ScriptProcessorNode
2. VAD analyzes RMS level every 120ms
3. If RMS > threshold and not muted/deafened:
   a. Set speaking = true locally
   b. Send: { type: "voice_state", speaking: true, ... }
   c. Update UI (green ring on self)
4. Server receives voice_state
5. Server broadcasts voice_member_update to ALL participants
6. Each client receives update, renders green ring on that user's avatar
7. When RMS drops below threshold for 200ms:
   a. Set speaking = false locally
   b. Send: { type: "voice_state", speaking: false, ... }
   c. Remove green ring from self
8. Server broadcasts voice_member_update
9. Each client removes green ring from that user's avatar
```

---

## 13. Feature: Mute / Deafen

### 13.1 Self-Mute

| Action | What Happens |
|--------|-------------|
| User clicks mic icon | Mic producer paused, `muted=true`, UI shows red mic icon |
| User clicks again | Mic producer resumed, `muted=false`, UI normal |
| Force muted by owner | Mic producer paused, cannot unmute, toast shows message |

### 13.2 Self-Deafen

| Action | What Happens |
|--------|-------------|
| User clicks headphone icon | Mic paused + all consumers paused, `deafened=true` |
| User clicks again | Mic resumed + consumers resumed, `deafened=false` |
| Force deafened by owner | Mic paused + consumers paused, cannot undeafen |

### 13.3 Mute States Matrix

| State | Mic | Hearing | Can Unmute | Can Undeafen |
|-------|-----|---------|-----------|-------------|
| Normal | On | Yes | Yes | Yes |
| Self-Muted | Off | Yes | Yes | N/A |
| Self-Deafened | Off | No | N/A | Yes |
| Server-Muted | Off | Yes | No | N/A |
| Server-Deafened | Off | No | N/A | No |

---

## 14. Feature: Push to Talk

### 14.1 PTT Implementation

```javascript
function initPushToTalk(keybind) {
    document.addEventListener('keydown', (e) => {
        if (e.code === keybind && !e.repeat) {
            if (VoiceState.pushToTalk && !VoiceState.muted) {
                unmuteMic();
                sendPTTEvent('activate');
            }
        }
    });

    document.addEventListener('keyup', (e) => {
        if (e.code === keybind) {
            if (VoiceState.pushToTalk && !VoiceState.muted) {
                // Apply release delay
                setTimeout(() => {
                    muteMic();
                    sendPTTEvent('deactivate');
                }, VoiceState.pttDelay);
            }
        }
    });
}
```

### 14.2 PTT UI

In Voice & Video settings:
- Input Mode toggle: Voice Activity / Push to Talk
- When PTT selected: "Edit Keybind" button
- PTT Release Delay slider (50ms - 2000ms, default 200ms)
- Visual indicator when PTT is active (green mic icon while holding key)

### 14.3 PTT Limitations

- Only works when browser window is in focus (browser security)
- Desktop app can do system-wide PTT
- Cannot PTT while deafened (no mic to activate)

---

## 15. Feature: Noise Suppression

### 15.1 Browser Noise Suppression

```javascript
const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
        noiseSuppression: VoiceState.noiseSuppression,  // true/false
        echoCancellation: true,
        autoGainControl: true
    }
});
```

### 15.2 Toggle in Settings

- Voice & Video settings → Noise Suppression toggle
- Default: ON
- When toggled: restart mic with new constraints
- Visual: Shows "Krisp" badge when active (browser uses built-in, not Krisp)

---

## 16. Feature: Per-User Volume Control

### 16.1 Implementation

```javascript
function setMemberVolume(userId, volume) {
    // volume: 0-200 (100 = normal, 200 = 2x loud)
    const consumer = VoiceState.consumers.get(userId);
    if (consumer) {
        // Use WebRTC GainNode for volume control
        const audioContext = new AudioContext();
        const source = audioContext.createMediaStreamSource(
            new MediaStream([consumer.track])
        );
        const gainNode = audioContext.createGain();
        gainNode.gain.value = volume / 100;
        source.connect(gainNode);
        gainNode.connect(audioContext.destination);
    }
}
```

### 16.2 Volume Menu

Right-click on a participant → Volume slider appears:
```
┌─────────────────────┐
│ Alice               │
│ 🔊 ──●─────── 100% │
│                     │
│ [Mute] [Deafen]    │
└─────────────────────┘
```

- Slider range: 0% - 200%
- Default: 100%
- Persisted in localStorage per-user
- Applied to audio playback gain node

---

## 17. Feature: Owner Controls

### 17.1 Server Mute

**Visual:**
- Owner right-clicks user in member list
- Context menu shows: "Server Mute" / "Server Unmute"
- When muted: red mic-slash icon next to user (locked style)
- User cannot unmute themselves

**Server flow:**
```
Owner clicks "Server Mute" →
  Client sends: { type: "voice_control", action: "mute", target_user_id: "..." } →
  Server checks: MUTE_MEMBERS permission →
  Server: UPDATE voice_sanctions SET force_muted = true →
  Server: pause user's audio producer →
  Server broadcasts: voice_member_update to all →
  Target client receives: voice_control_received { action: "server_mute" } →
  Target client shows: toast "You have been server-muted by the owner"
```

### 17.2 Server Deafen

Same as mute but also:
- Pauses all user's consumers (can't hear anyone)
- Sets force_muted=true AND force_deafened=true
- User sees headphone-slash icon (locked)

### 17.3 Kick

```
Owner clicks "Kick" →
  Client sends: { type: "voice_control", action: "kick", target_user_id: "..." } →
  Server checks: MOVE_MEMBERS permission →
  Server: remove from voice_participants →
  Server: close all user's producers/consumers →
  Server: send voice_kicked to target user →
  Target: receives kicked message, auto-disconnects →
  Server broadcasts: voice_member_leave to others
```

### 17.4 Move Between Channels

```
Owner drags user to different channel →
  Client sends: { type: "voice_control", action: "move", target_user_id: "...", channel_id: "..." } →
  Server checks: MOVE_MEMBERS permission →
  Server: remove from current room →
  Server: add to target room →
  Server: seamless transition for user (new room, new producers)
```

---

## 18. Feature: End-to-End Encryption

### 18.1 Architecture

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ Client A │     │   SFU    │     │ Client B │
│          │     │          │     │          │
│ plaintext│────►│ encrypted│────►│ plaintext│
│ → encrypt│     │ (opaque) │     │ → decrypt│
│ ← decrypt│◄────│          │◄────│ → encrypt│
└──────────┘     └──────────┘     └──────────┘
```

**Key principle:** SFU never sees plaintext. It only forwards opaque encrypted frames.

### 18.2 WebRTC EncodedTransform (Insertable Streams)

```javascript
// On sender:
const sender = peerConnection.addTrack(track, stream);
const worker = new Worker('e2ee-worker.js');
sender.transform = new RTCRtpScriptTransform(worker, {
    name: 'senderTransform',
    key: encryptionKey
});

// On receiver:
peerConnection.ontrack = (event) => {
    const worker = new Worker('e2ee-worker.js');
    event.receiver.transform = new RTCRtpScriptTransform(worker, {
        name: 'receiverTransform',
        key: decryptionKey
    });
};
```

### 18.3 E2EE Worker

```javascript
// e2ee-worker.js
addEventListener('rtctransform', (event) => {
    const { name, key } = event.transformer.options;

    const transform = new TransformStream({
        async transform(encodedFrame, controller) {
            if (name === 'senderTransform') {
                const data = new Uint8Array(encodedFrame.data);
                const nonce = crypto.getRandomValues(new Uint8Array(12));
                const encrypted = await crypto.subtle.encrypt(
                    { name: 'AES-GCM', iv: nonce },
                    key,
                    data
                );
                // Prepend nonce to encrypted data
                const result = new Uint8Array(nonce.length + encrypted.byteLength);
                result.set(nonce);
                result.set(new Uint8Array(encrypted), nonce.length);
                encodedFrame.data = result.buffer;
            } else {
                const data = new Uint8Array(encodedFrame.data);
                const nonce = data.slice(0, 12);
                const ciphertext = data.slice(12);
                const decrypted = await crypto.subtle.decrypt(
                    { name: 'AES-GCM', iv: nonce },
                    key,
                    ciphertext
                );
                encodedFrame.data = decrypted;
            }
            controller.enqueue(encodedFrame);
        }
    });

    event.transformer.readable
        .pipeThrough(transform)
        .pipeTo(event.transformer.writable);
});
```

### 18.4 Key Exchange

**For DM calls:**
- Both users already have X25519 key exchange (from existing E2E encryption)
- Room key derived from shared secret
- Shared via existing encrypted channel

**For Server voice channels:**
- Server distributes room key to all participants
- Key encrypted with each user's identity key
- When participant joins: server sends encrypted key
- When participant leaves: room key rotated (new key derived)
- Forward secrecy: old key discarded after rotation

### 18.5 Key Rotation

```
Trigger: participant joins or leaves
  1. Server generates new random key
  2. Server encrypts new key for each remaining participant
  3. Server sends key_update to each participant
  4. Each participant switches to new key
  5. Old key discarded after 10 second grace period
  6. In-flight frames using old key still decryptable
```

### 18.6 Encryption Status Indicator

- Show lock icon 🔒 when E2EE is active
- Show "E2EE" badge in call UI
- Show epoch authenticator for verification (optional)

---

## 19. Feature: AFK Timeout

### 19.1 Configuration

- Server Settings → Overview → AFK Channel dropdown
- AFK Timeout: 1 min, 5 min, 15 min, 30 min, 1 hour
- Default: 5 minutes

### 19.2 Implementation

```javascript
// Server-side AFK check
async function checkAFKTimeout(serverId) {
    const settings = await db.getVoiceChannelSettings(serverId);
    if (!settings.afk_channel || !settings.afk_timeout_seconds) return;

    const timeoutMs = settings.afk_timeout_seconds * 1000;
    const now = Date.now();

    // Find users who haven't spoken/moved mic in timeout period
    const inactiveUsers = await db.getInactiveVoiceUsers(serverId, timeoutMs);

    for (const user of inactiveUsers) {
        // Move to AFK channel
        await moveVoiceUser(user.id, settings.afk_channel);
        await logVoiceEvent(user.room_id, user.id, 'moved', { reason: 'afk' });
    }
}
```

### 19.3 Inactivity Detection

User is considered inactive when:
- No voice activity detected (mic not picking up speech)
- No screen share active
- No camera active
- Not pushing PTT key

User becomes active again when:
- Speaks into mic
- Turns on camera
- Starts screen share
- Presses PTT key

---

## 20. Feature: Voice Channel Settings

### 20.1 Bitrate

- Location: Edit Channel → Overview → Bitrate
- Slider: 8 kbps to 384 kbps
- Default: 64 kbps
- Boost-gated:
  - No boost: 8-96 kbps
  - Level 1: up to 128 kbps
  - Level 2: up to 256 kbps
  - Level 3: up to 384 kbps

### 20.2 User Limit

- Location: Edit Channel → Overview → User Limit
- Toggle + number input
- Range: 1-99, or unlimited
- Default: Unlimited
- Shows "Full" when limit reached

### 20.3 Region Override

- Location: Edit Channel → Overview → Region
- Options: Automatic, US East, US West, Europe, Japan, etc.
- Default: Automatic (first user determines region)

---

## 21. UI/UX Specification

### 21.1 Voice Bar (Bottom Panel - Server Channels)

```
┌──────────────────────────────────────────┐
│ 🔊 General Voice        Voice Connected  │
│                                          │
│  [🎤] [🔇] [🖥️] [📷] [🚀] [🎵] [📞]   │
│  Mic  Deaf  Share Cam  Act  Board Leave  │
└──────────────────────────────────────────┘
```

- Position: Fixed bottom-left, below channel list
- Width: Matches channel sidebar width (~240px)
- Background: Dark (#2B2D31)
- Mic icon: Gray when unmuted, Red with slash when muted
- Deafen icon: Gray when undeafened, Red with slash when deafened
- Disconnect button: Red phone icon, always red
- Green dot: Shows when connected
- Duration timer: Shows call length

### 21.2 Voice Bar (DM Calls)

```
┌──────────────────────────────────────────┐
│ 📞 In call with Alice          05:23     │
│                                          │
│  [🎤] [🔇] [📷] [🖥️] [📞]              │
│  Mic  Deaf  Cam  Screen  End             │
└──────────────────────────────────────────┘
```

- Same position as server voice bar
- Shows other user's name
- Shows call duration
- End call button is red

### 21.3 Voice Popup (Member List)

```
┌──────────────────────────────────────────┐
│  Voice Connected — General Voice         │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │  😊 You          🎤 🔇            │  │
│  ├────────────────────────────────────┤  │
│  │  😊 Alice    [speaking]  🎤       │  │
│  ├────────────────────────────────────┤  │
│  │  😊 Bob                 🎤         │  │
│  ├────────────────────────────────────┤  │
│  │  😊 Charlie           🔇          │  │
│  └────────────────────────────────────┘  │
│                                          │
│  [⚙️ Settings]                           │
└──────────────────────────────────────────┘
```

- Position: Above voice bar, absolutely positioned
- Shows all participants
- Speaking users have green ring
- Muted users have red mic-slash icon
- Deafened users have red headphone-slash icon
- Each row: avatar | username | icons
- Click row → context menu (volume, kick, mute, deafen)

### 21.4 DM Call Panel (Full)

```
┌──────────────────────────────────────────────┐
│  📞 In call with Alice               05:23  │
│                                              │
│  ┌─────────────────────┐ ┌─────────────────┐ │
│  │                     │ │                 │ │
│  │     Alice           │ │      You        │ │
│  │   (avatar/cam)      │ │  (avatar/cam)   │ │
│  │                     │ │                 │ │
│  │   🔊 100%           │ │                 │ │
│  └─────────────────────┘ └─────────────────┘ │
│                                              │
│  ┌──────────────────────────────────────┐    │
│  │ [🎤] [🔇] [📷] [🖥️] [📞]           │    │
│  └──────────────────────────────────────┘    │
└──────────────────────────────────────────────┘
```

- Covers the DM chat area (bottom half)
- Grid adapts: 2 users = split, 3-4 = quarter, etc.
- Screen share takes hero slot (largest tile)
- Video shows in tile, avatar when camera off
- Speaking shows green ring

### 21.5 Video Tile Layout

```
2 users:  [  Tile 1  ] [  Tile 2  ]     (50/50)

3 users:  [  Tile 1  ] [  Tile 2  ]
          [      Tile 3      ]           (1/3, 1/3, 2/3 bottom)

4 users:  [  Tile 1  ] [  Tile 2  ]
          [  Tile 3  ] [  Tile 4  ]     (25% each)

5+ users: [T1][T2][T3]
          [T4][T5][T6]...               (grid, floor at min size)

Screen share active:
          [   Screen Share (Hero)   ]
          [T1][T2][T3][T4]            (thumbnails below)
```

### 21.6 Facepile (Channel List)

```
Without facepile:
  🔊 General Voice

With facepile:
  🔊 General Voice  [😊][😊][😊]+2
                     ↑ overlapping avatars
```

- Max visible: 4 avatars
- Overflow: "+N" chip
- Speaking users highlighted with green border

### 21.7 Member Row States

```
Normal:       [😊] Alice
Speaking:     [🟢😊🟢] Alice     (green ring)
Muted:        [😊] Alice 🎤      (red mic-slash, dimmed)
Deafened:     [😊] Alice 🔇      (red headphone-slash)
Streaming:    [😊] Alice LIVE    (green "LIVE" badge)
Force Muted:  [😊] Alice 🔒🎤   (locked red mic)
```

---

## 22. Notification Sounds

### 22.1 Sound List

| Event | Sound | Default |
|-------|-------|---------|
| User joins voice | Short chime (high) | ON |
| User leaves voice | Short chime (low) | ON |
| User moved | Quick blip | ON |
| You mute yourself | Soft click | ON |
| You unmute yourself | Soft click | ON |
| You deafen | Soft click | ON |
| You undeafen | Soft click | ON |
| PTT activate | Short beep | ON |
| PTT deactivate | Short beep | ON |
| Incoming DM call | Ring tone (repeating) | ON |
| Outgoing DM call | Ring tone | ON |
| Call ended | Low beep | ON |
| Stream started | Notification tone | ON |

### 22.2 Sound Implementation

```javascript
const sounds = {
    join: new Audio('/sounds/voice-join.mp3'),
    leave: new Audio('/sounds/voice-leave.mp3'),
    mute: new Audio('/sounds/voice-mute.mp3'),
    unmute: new Audio('/sounds/voice-unmute.mp3'),
    deafen: new Audio('/sounds/voice-deafen.mp3'),
    undeafen: new Audio('/sounds/voice-undeafen.mp3'),
    ptt_on: new Audio('/sounds/voice-ptt-on.mp3'),
    ptt_off: new Audio('/sounds/voice-ptt-off.mp3'),
    ring: new Audio('/sounds/voice-ring.mp3'),
    call_end: new Audio('/sounds/voice-call-end.mp3'),
};

function playSound(name) {
    if (!sounds[name]) return;
    sounds[name].currentTime = 0;
    sounds[name].volume = 0.5;
    sounds[name].play().catch(() => {});
}
```

---

## 23. Edge Cases & Error Handling

### 23.1 Connection Loss

| Scenario | Behavior |
|----------|----------|
| WebSocket disconnect | Client attempts reconnect (exponential backoff) |
| SFU crash | Server reassigns new SFU, clients reconnect |
| Network switch (WiFi→cellular) | WebRTC ICE restart, auto-reconnect |
| Browser tab background | Audio continues, video may pause (browser optimization) |
| User closes tab | voice_leave sent, room cleaned up |

### 23.2 Permission Changes

| Scenario | Behavior |
|----------|----------|
| User loses CONNECT permission | Kicked from voice with message |
| User gains SPEAK permission | Can now unmute |
| Channel deleted | All users kicked from channel |
| User banned | Immediately removed from all voice rooms |
| User kicked from server | Immediately removed from all voice rooms |

### 23.3 Concurrent Actions

| Scenario | Behavior |
|----------|----------|
| Two users click same channel | Both join (if limit allows) |
| Owner mutes + user unmutes simultaneously | Owner's mute wins (server truth) |
| User leaves + owner kicks same moment | Leave processed first, kick is no-op |
| DM call start + decline same time | Call ends, both see "Call Ended" |
| Screen share + camera same time | Both work, camera becomes secondary |

### 23.4 Resource Cleanup

```javascript
// On page unload
window.addEventListener('beforeunload', () => {
    if (VoiceState.status === 'connected') {
        // Send synchronous leave
        navigator.sendBeacon('/api/voice/leave', JSON.stringify({
            room_id: VoiceState.roomId
        }));
    }
});

// On WS disconnect
ws.onclose = () => {
    // Don't cleanup voice state yet — WS will reconnect
    // After 30 seconds without reconnect, cleanup
    setTimeout(() => {
        if (VoiceState.status !== 'idle' && !ws.connected) {
            cleanupVoiceState();
            toast('Voice disconnected due to connection loss.');
        }
    }, 30000);
};
```

### 23.5 Browser Compatibility

| Feature | Chrome | Firefox | Safari | Edge |
|---------|--------|---------|--------|------|
| WebRTC | ✅ | ✅ | ✅ | ✅ |
| EncodedTransform | ✅ 86+ | ✅ 117+ | ❌ | ✅ 86+ |
| getDisplayMedia | ✅ | ✅ | ✅ | ✅ |
| Noise Suppression | ✅ | ✅ | ✅ | ✅ |
| Opus codec | ✅ | ✅ | ✅ | ✅ |
| Simulcast | ✅ | ✅ | Limited | ✅ |

**Safari note:** EncodedTransform not supported → E2EE disabled for Safari users. Transport encryption (DTLS-SRTP) still active.

### 23.6 Performance Considerations

- **Max participants per room:** 25 (video), 99 (audio only)
- **Simulcast layers:** 3 (high/medium/low)
- **Audio bitrate:** 64-384 kbps per speaker
- **Video bitrate:** 300-2500 kbps per sender
- **CPU per participant:** ~2-5% (SFU forwarding only)
- **Memory per participant:** ~1-2 MB (SFU state)

---

## 24. Implementation Order

### Phase 1: Basic Voice (Server Channels)
1. mediasoup server setup (worker, router, transport)
2. WebSocket signaling (join, leave, produce, consume)
3. Client: mic capture + audio playback
4. Client: voice bar UI (connect, mute, deafen, disconnect)
5. Client: member list with speaking indicators
6. Server: room management + participant tracking
7. Server: permission checks

### Phase 2: DM Calls
1. DM call UI (ring, accept, decline)
2. DM call panel (full UI)
3. Mini bar (when switching chats)
4. Call duration timer
5. Missed call notification

### Phase 3: Video & Screen Share
1. Camera capture + produce
2. Screen share capture + produce
3. Video tiles (grid layout)
4. Screen share hero slot
5. Simulcast configuration

### Phase 4: Controls & Settings
1. Per-user volume control
2. Owner controls (server mute/deafen/kick)
3. Push to talk
4. Noise suppression toggle
5. Voice channel settings (bitrate, user limit)

### Phase 5: E2EE
1. WebRTC EncodedTransform setup
2. Key exchange (DM: X25519, Server: distributed key)
3. Key rotation on participant change
4. Encryption status indicator

### Phase 6: Polish
1. Notification sounds
2. AFK timeout
3. Facepile in channel list
4. Video pop-out
5. Full screen mode
6. Admin panel analytics
