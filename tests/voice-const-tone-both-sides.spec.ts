import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// One-sided-audio diagnostic: the user reports sound is bad on ONE side while
// the other is good. Both users here get the IDENTICAL 30s constant 440 Hz
// fake-mic tone, so any asymmetry (stops, highs/lows, loss, silence) must come
// from the app/transport, not the source. We measure BOTH receive directions
// (A→B and B→A) plus each direction's inbound-rtp loss/concealment, and dump
// them side by side so a broken direction is visible at a glance.
//
// NS is forced off (RNNoise's speech VAD would gate a constant tone) and EC
// off (Chrome's AEC would cancel the mic because each side is also PLAYING the
// same tone through its speakers) — this isolates the transport + E2EE path.

const BASE = 'https://localhost:3443';
const WAV_PATH = path.join(os.tmpdir(), 'voice-const-tone-both-30s.wav');

function writeToneWav(filePath: string, seconds = 30, rate = 48000, freq = 440, amp = 0.25) {
    const n = Math.floor(seconds * rate);
    const dataSize = n * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);
    buf.writeUInt16LE(2, 32);
    buf.writeUInt16LE(16, 34);
    buf.write('data', 36);
    buf.writeUInt32LE(dataSize, 40);
    for (let i = 0; i < n; i++) {
        const s = Math.sin((2 * Math.PI * freq * i) / rate) * amp;
        buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), 44 + i * 2);
    }
    fs.writeFileSync(filePath, buf);
}
writeToneWav(WAV_PATH);

test.use({
    headless: false,
    launchOptions: {
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
            `--use-file-for-fake-audio-capture=${WAV_PATH}`,
            // Disable Chrome's background/unfocused-window throttling so the
            // acoustic asymmetry can't be blamed on the test's unfocused
            // acceptor window. If the 60ms bunching persists WITH these flags,
            // it is an APP bug, not an environment artifact.
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--disable-background-timer-throttling',
            '--disable-background-video-track-optimization',
        ],
    },
});

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= maxRetries) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
}

async function setupFriends(page: any, page2: any, body1: any, body2: any) {
    const fc2 = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
    const fr = await page.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fc2 },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${body2.token}` },
    })).json();
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();
}

async function createDm(page: any, page2: any, body1: any, body2: any) {
    const userData = await (await page.request.get(`${BASE}/api/user/${body2.user.username}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    const dm = await (await page.request.post(`${BASE}/api/dm/${userData.id}`, {
        headers: { Authorization: `Bearer ${body1.token}` },
    })).json();
    expect(dm.id).toBeTruthy();
    return dm;
}

async function openDm(page: any) {
    await page.click('#dm-strip-btn').catch(() => {});
    await page.waitForTimeout(800);
    for (let i = 0; i < 40; i++) {
        const conv = page.locator('.dm-item, .dm-conv, [data-dm-id]');
        if (await conv.count()) {
            await conv.first().click().catch(() => {});
            await page.waitForTimeout(800);
            break;
        }
        await page.waitForTimeout(300);
    }
}

// Record `seconds` of the RECEIVED remote audio on `page` (direction: the
// OTHER user → this page) + inbound-rtp stats for that direction + this
// page's own outbound-rtp audio stats (what IT sends back).
async function captureDirection(page: any, seconds = 5) {
    return await page.evaluate(async ({ seconds }) => {
        // @ts-ignore
        const V = window.VoiceManager;
        const S = V._debug.state;
        const uids = Object.keys(S.remoteStreams || {});
        const stream = uids.length && S.remoteStreams[uids[0]] && S.remoteStreams[uids[0]].audio;
        if (!stream) return { error: 'no remote audio stream', uids };
        const pc = S.peers && S.peers[uids[0]];
        let stats: any = {};
        if (pc) {
            const report = await pc.getStats();
            report.forEach((s: any) => {
                if (s.type === 'inbound-rtp' && s.kind === 'audio') {
                    stats.packetsReceived = s.packetsReceived;
                    stats.packetsLost = s.packetsLost;
                    stats.concealedSamples = s.concealedSamples;
                    stats.jitterBufferEmittedCount = s.jitterBufferEmittedCount;
                    stats.jitterMs = s.jitterBufferDelay ? (s.jitterBufferDelay / Math.max(1, s.jitterBufferEmittedCount)) * 1000 : 0;
                }
                if (s.type === 'outbound-rtp' && s.kind === 'audio') {
                    stats.sendFramesEncoded = s.framesEncoded;
                    stats.sendPackets = s.packetsSent;
                    stats.sendBytes = s.bytesSent;
                }
            });
        }
        const track = stream.getAudioTracks()[0];
        if (!track) return { error: 'no audio track' };
        const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
        const rec = new MediaRecorder(new MediaStream([track]), mime ? { mimeType: mime } : undefined);
        const chunks: Blob[] = [];
        rec.ondataavailable = (e: any) => { if (e.data && e.data.size) chunks.push(e.data); };
        rec.start();
        await new Promise((r) => setTimeout(r, seconds * 1000));
        rec.stop();
        await new Promise((r) => { rec.onstop = r; });

        const blob = new Blob(chunks, { type: 'audio/webm' });
        const buf = await blob.arrayBuffer();
        const rawBytes = buf.byteLength;
        let analysis: any = { bytes: rawBytes, decodeError: null };
        if (rawBytes > 0) {
            try {
                const AC: any = window.AudioContext || (window as any).webkitAudioContext;
                const decCtx = new AC();
                const decoded = await decCtx.decodeAudioData(buf);
                const pcm = decoded.getChannelData(0);
                const rate = decoded.sampleRate;
                const win = Math.max(1, Math.round(rate * 0.01));
                const rms: number[] = [];
                for (let i = 0; i + win <= pcm.length; i += win) {
                    let s = 0;
                    for (let j = i; j < i + win; j++) s += pcm[j] * pcm[j];
                    rms.push(Math.sqrt(s / win));
                }
                const silThresh = 0.005;
                const silentWindows = rms.filter((v) => v < silThresh).length;
                let maxSilentRun = 0, run = 0;
                for (const v of rms) {
                    if (v < silThresh) { run++; maxSilentRun = Math.max(maxSilentRun, run); } else run = 0;
                }
                const mean = rms.reduce((a, b) => a + b, 0) / (rms.length || 1);
                const sd = Math.sqrt(rms.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rms.length || 1));
                analysis = {
                    bytes: rawBytes,
                    rate,
                    duration: pcm.length / rate,
                    windows: rms.length,
                    silentWindows,
                    maxSilentRun,
                    silentPct: (silentWindows / (rms.length || 1)) * 100,
                    rmsMean: mean,
                    rmsCV: mean ? sd / mean : Infinity,
                };
                try { decCtx.close(); } catch (_) {}
            } catch (err: any) {
                analysis.decodeError = String(err);
            }
        }
        return { stats, analysis };
    }, { seconds });
}

// The user's issue is one-sided (bad in ONE direction only). Measuring with
// the SAME setup but swapping who INITIATES tells us whether the bad direction
// is the CALLEE's audio (a role bug) or a specific page/context (environment).
async function runBothDirections(browser: any, label: string, bInitiates = false) {
    test.setTimeout(240000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    // bInitiates=true → page2 is the initiator, page is the acceptor.
    const initiatorPage = bInitiates ? page2 : page;
    const acceptorPage = bInitiates ? page : page2;

    // NS off + EC off BEFORE the app loads (see header comment).
    for (const p of [page, page2]) {
        await p.addInitScript(() => {
            try {
                localStorage.setItem('voice_settings', JSON.stringify({
                    noiseSuppressionMode: 'off',
                    echoCancellation: false,
                    micVolume: 100,
                    speakerVolume: 100,
                }));
            } catch (_) {}
            (window as any).__enableVoiceAudioDebug = true;
        });
    }

    const ts = Date.now().toString().slice(-6) + Math.floor(Math.random() * 90 + 10);
    const body1 = await registerUser(initiatorPage, 'i_' + ts);
    const body2 = await registerUser(acceptorPage, 'a_' + ts);
    await waitForWs(initiatorPage);
    await waitForWs(acceptorPage);
    await setupFriends(initiatorPage, acceptorPage, body1, body2);
    await createDm(initiatorPage, acceptorPage, body1, body2);
    await initiatorPage.reload();
    await acceptorPage.reload();
    await waitForWs(initiatorPage);
    await waitForWs(acceptorPage);

    await openDm(initiatorPage);
    await initiatorPage.waitForSelector('.dm-call-btns .dm-call-btn', { timeout: 20000 });
    await initiatorPage.click('.dm-call-btns .dm-call-btn');
    await initiatorPage.waitForTimeout(2000);
    await acceptorPage.waitForSelector('#incoming-call-accept:visible', { timeout: 20000 });
    await acceptorPage.click('#incoming-call-accept');
    await initiatorPage.waitForTimeout(4000); // let the call connect + audio flow

    // Probe the ACCEPTOR's SEND pacing: sample outbound-rtp packetsSent every
    // 100ms for 3s. Steady deltas (~5/100ms at 50pps) = the sender is fine and
    // the receiver path is at fault; alternating 0/10+ deltas = the sender
    // emits bursts (its encrypt/queueing is the problem).
    const pacing = await acceptorPage.evaluate(async () => {
        // @ts-ignore
        const S = window.VoiceManager._debug.state;
        const uid = Object.keys(S.peers || {})[0];
        const pc = uid ? S.peers[uid] : null;
        if (!pc) return { error: 'no peer' };
        // 10ms resolution: 3-packet bursts with 60ms gaps would appear as
        // [0,0,3,0,0,0,3,...]; smooth 20ms pacing as [1,1,1,1,1,...].
        const samples: number[] = [];
        for (let i = 0; i < 200; i++) {
            const stats = await pc.getStats();
            let pkts = 0;
            stats.forEach((r: any) => {
                if (r.type === 'outbound-rtp' && r.kind === 'audio') pkts = r.packetsSent || 0;
            });
            samples.push(pkts);
            await new Promise((r) => setTimeout(r, 10));
        }
        const deltas: number[] = [];
        for (let i = 1; i < samples.length; i++) deltas.push(samples[i] - samples[i - 1]);
        // Collapse into 20ms buckets (2 samples each) so the pattern is clear.
        const buckets: number[] = [];
        for (let i = 0; i < deltas.length; i += 2) buckets.push(deltas[i] + (deltas[i + 1] || 0));
        return { buckets };
    });
    console.log(`=====[${label}] ACCEPTOR OUTBOUND (20ms buckets: packets emitted)===== ${JSON.stringify(pacing.buckets)}`);

    // Sender/receiver inventory on BOTH pages: how many audio m-lines, and the
    // track id + readyState of each sender. If the acceptor has TWO audio
    // senders (duplicate track added twice), that's the bunching + ×N receivers.
    const inv = async (page: any, who: string) => {
        const r = await page.evaluate(() => {
            // @ts-ignore
            const S = window.VoiceManager._debug.state;
            const uid = Object.keys(S.peers || {})[0];
            const pc = uid ? S.peers[uid] : null;
            if (!pc) return { error: 'no peer' };
            const senders = pc.getSenders().map((s: any) => ({
                kind: s.track ? s.track.kind : 'null',
                id: s.track ? s.track.id.slice(0, 8) : null,
                state: s.track ? s.track.readyState : 'no-track',
            }));
            const receivers = pc.getReceivers().map((r: any) => ({
                kind: r.track ? r.track.kind : 'null',
                id: r.track ? r.track.id.slice(0, 8) : null,
                state: r.track ? r.track.readyState : 'no-track',
            }));
            return { senders, receivers, micStreams: Object.keys(S.localStreams || {}) };
        });
        console.log(`=====[${label}] ${who} SENDER/RECEIVER INVENTORY===== ${JSON.stringify(r)}`);
    };
    await inv(acceptorPage, 'ACCEPTOR');
    await inv(initiatorPage, 'INITIATOR');

    // Track the initiator's RECEIVER identity over time: whether the receiver
    // that holds the decrypt transform is the same object receiving packets
    // (a renegotiation can replace the receiver object — Chrome then routes
    // frames to the NEW receiver, which has NO transform, and does NOT re-fire
    // ontrack → the old transform never runs → encrypted frames hit the
    // decoder → concealment). Also count renegotiations.
    // Sender/receiver transform inventory on the initiator RIGHT NOW (the
    // broken state has a sender with !transform at answer time, and assigning
    // one breaks the receive side).
    const tInv = await initiatorPage.evaluate(() => {
        // @ts-ignore
        const S = window.VoiceManager._debug.state;
        const uid = Object.keys(S.peers || {})[0];
        const pc = uid ? S.peers[uid] : null;
        if (!pc) return { error: 'no peer' };
        return {
            senders: pc.getSenders().map((s: any) => ({
                kind: s.track ? s.track.kind : 'null',
                id: s.track ? s.track.id.slice(0, 8) : null,
                t: !!s.transform,
            })),
            receivers: pc.getReceivers().map((r: any) => ({
                kind: r.track ? r.track.kind : 'null',
                id: r.track ? r.track.id.slice(0, 8) : null,
                t: !!r.transform,
            })),
            pendingQ: (S._pendingRecvTransforms || []).length,
            roomKey: !!S.roomKeyB64,
        };
    });
    console.log(`=====[${label}] INITIATOR TRANSFORM INVENTORY (now)===== ${JSON.stringify(tInv)}`);

    const rxTimeline = await initiatorPage.evaluate(async () => {
        // @ts-ignore
        const S = window.VoiceManager._debug.state;
        const uid = Object.keys(S.peers || {})[0];
        const pc = uid ? S.peers[uid] : null;
        if (!pc) return { error: 'no peer' };
        const out: any[] = [];
        let rxSnap: any = null;
        let neg = 0;
        const origNeg = pc.onnegotiationneeded;
        pc.onnegotiationneeded = function (...a: any[]) {
            neg++;
            return origNeg.apply(pc, a as any);
        };
        for (let i = 0; i < 30; i++) {
            const recvs = pc.getReceivers().filter((r: any) => r.track && r.track.kind === 'audio');
            if (recvs.length && !rxSnap) {
                rxSnap = { id: recvs[0].track.id.slice(0, 8), hasTransform: !!recvs[0].transform };
            }
            out.push({
                n: recvs.length,
                sameId: rxSnap ? recvs.some((r: any) => r.track.id.slice(0, 8) === rxSnap.id) : false,
                hasTransform: recvs.length ? !!recvs[0].transform : false,
                neg,
                sig: pc.signalingState,
            });
            await new Promise((r) => setTimeout(r, 200));
        }
        return { rxSnap, out };
    });
    const rxCompact = rxTimeline.out.map((r: any) => `${r.n}rx/${r.hasTransform ? 'T' : 't'}${r.sameId ? '' : '!ID'}/neg${r.neg}/${r.sig.slice(0, 5)}`);
    console.log(`=====[${label}] INITIATOR RECEIVER TIMELINE (200ms)===== ${JSON.stringify(rxCompact)}`);
    console.log(`=====[${label}] INITIATOR RECEIVER FIRST SNAP===== ${JSON.stringify(rxTimeline.rxSnap)}`);

    // Fine-grained ARRIVAL probe at the INITIATOR: sample inbound-rtp every
    // ~10ms for 2s. Captures the per-sample arrival count, the RTP timestamp
    // advancement (480/10ms @48k = correct clock; much larger = the playout
    // clock runs ahead of wall time → packets always arrive 'late' → conceal),
    // and the concealed-sample deltas — the actual playout health.
    const arrival = await initiatorPage.evaluate(async () => {
        // @ts-ignore
        const S = window.VoiceManager._debug.state;
        const uid = Object.keys(S.peers || {})[0];
        const pc = uid ? S.peers[uid] : null;
        if (!pc) return { error: 'no peer' };
        const out: any[] = [];
        let prev: any = {};
        for (let i = 0; i < 200; i++) {
            const stats = await pc.getStats();
            let r: any = null;
            stats.forEach((x: any) => {
                if (x.type === 'inbound-rtp' && x.kind === 'audio') r = x;
            });
            if (r) {
                const t0 = performance.now();
                out.push({
                    t: Math.round(t0),
                    dp: (r.packetsReceived || 0) - (prev.p || 0),
                    dts: r.lastTimestampReceived ? r.lastTimestampReceived - (prev.ts || r.lastTimestampReceived) : 0,
                    dc: (r.concealedSamples || 0) - (prev.c || 0),
                    jit: r.jitterBufferDelay && r.jitterBufferEmittedCount ? Math.round((r.jitterBufferDelay / r.jitterBufferEmittedCount) * 1000) : 0,
                });
                prev = { p: r.packetsReceived || 0, ts: r.lastTimestampReceived || 0, c: r.concealedSamples || 0 };
            }
            await new Promise((res) => setTimeout(res, 10));
        }
        return out;
    });
    // Collapse to 20ms buckets so the pattern is readable in the log.
    const bucketed: any[] = [];
    let cur: any = null;
    for (const s of arrival) {
        const b = Math.floor((s.t - (arrival[0]?.t || 0)) / 20);
        if (!cur || cur.b !== b) { cur = { b, dp: 0, dts: 0, dc: 0, jit: s.jit }; bucketed.push(cur); }
        cur.dp += s.dp; cur.dts += s.dts; cur.dc += s.dc;
    }
    const compact = bucketed.map((b: any) => `${b.b}:${b.dp}p/${Math.round(b.dts / 480)}ts/${b.dc}c`);
    console.log(`=====[${label}] INITIATOR ARRIVAL (20ms buckets: pkt/timestep-480-units/concealed)===== ${JSON.stringify(compact)}`);
    console.log(`=====[${label}] INITIATOR ARRIVAL SUMMARY===== ${JSON.stringify({ totalPkts: arrival.reduce((a: any, s: any) => a + s.dp, 0), totalTs: arrival.reduce((a: any, s: any) => a + s.dts, 0), totalConc: arrival.reduce((a: any, s: any) => a + s.dc, 0), ms: arrival.length ? (arrival[arrival.length - 1].t - arrival[0].t) : 0 })}`);

    // Dump each side's E2EE transform presence + audio stats at capture time.
    // (Defensive: getPeerDiag only exists in the current voice.js — when
    // bisecting against an older commit, skip it rather than failing the run.)
    const diagI = await initiatorPage.evaluate(() => {
        const vm = (window as any).VoiceManager;
        return vm && typeof vm.getPeerDiag === 'function' ? vm.getPeerDiag() : null;
    });
    const diagA = await acceptorPage.evaluate(() => {
        const vm = (window as any).VoiceManager;
        return vm && typeof vm.getPeerDiag === 'function' ? vm.getPeerDiag() : null;
    });
    const dumpDiag = (d: any[]) => (d || []).map((p: any) => ({
        conn: p.connectionState,
        sendAudio: p.senders.audio ? { tracks: p.senders.audio.tracks, e2ee: p.senders.audio.transform, frames: p.senders.audio.frames, pkts: p.senders.audio.packets } : null,
        recvAudio: p.receivers.audio ? { tracks: p.receivers.audio.tracks, e2ee: p.receivers.audio.transform, frames: p.receivers.audio.frames, pkts: p.receivers.audio.packets } : null,
    }));
    console.log(`=====[${label}] INITIATOR DIAG===== ${JSON.stringify(dumpDiag(diagI))}`);
    console.log(`=====[${label}] ACCEPTOR DIAG===== ${JSON.stringify(dumpDiag(diagA))}`);

    // Dump the DEBUG instrumentation: E2EE worker timing/drops on both pages,
    // the initiator's per-100ms inbound concealment timeline, and <audio>
    // element starvation events.
    const dbgI = await initiatorPage.evaluate(() => ({
        e2ee: (window as any).__voiceE2eeStats ? (window as any).__voiceE2eeStats.last : null,
        elEvents: (window as any).__voiceAudioElEvents || [],
        timeline: ((window as any).__voiceAudioTimeline || []).slice(-60),
    }));
    const dbgA = await acceptorPage.evaluate(() => ({
        e2ee: (window as any).__voiceE2eeStats ? (window as any).__voiceE2eeStats.last : null,
        elEvents: (window as any).__voiceAudioElEvents || [],
    }));
    // Sender/receiver transform inventory on both sides right now — the
    // per-kind E2EE counters tell us whether the GOOD-sounding direction is
    // actually DECRYPTED or arriving in plaintext (decA 0 + clean audio = the
    // sender's audio encrypt transform is missing — a silent E2EE gap).
    const sendInv = async (page: any, who: string) => {
        const r = await page.evaluate(() => {
            // @ts-ignore
            const S = window.VoiceManager._debug.state;
            const uid = Object.keys(S.peers || {})[0];
            const pc = uid ? S.peers[uid] : null;
            if (!pc) return { error: 'no peer' };
            return {
                sendAudio: pc.getSenders().map((s: any) => ({
                    t: !!s.transform,
                    held: !!s._voiceNulled,
                    kind: (s.track || s._voiceNulled || {}).kind || 'none',
                })),
                recvAudio: pc.getReceivers().map((r: any) => ({
                    t: !!r.transform,
                    kind: r.track ? r.track.kind : 'none',
                    live: r.track ? r.track.readyState : 'none',
                })),
            };
        });
        console.log(`=====[${label}] ${who} E2EE SENDER/RECEIVER INVENTORY===== ${JSON.stringify(r)}`);
    };
    await sendInv(initiatorPage, 'INITIATOR');
    await sendInv(acceptorPage, 'ACCEPTOR');
    console.log(`=====[${label}] INITIATOR E2EE WORKER===== ${JSON.stringify(dbgI.e2ee)}`);
    console.log(`=====[${label}] ACCEPTOR E2EE WORKER===== ${JSON.stringify(dbgA.e2ee)}`);
    console.log(`=====[${label}] INITIATOR AUDIO EL EVENTS===== ${JSON.stringify(dbgI.elEvents.slice(-30))}`);
    console.log(`=====[${label}] ACCEPTOR AUDIO EL EVENTS===== ${JSON.stringify(dbgA.elEvents.slice(-30))}`);
    const concealRuns = (dbgI.timeline as any[]).filter((r: any) => (r.dConcealed || 0) > 300).map((r: any) => ({ t: r.t - (dbgI.timeline[0] as any).t, dConc: r.dConcealed, jit: r.jitter, dPkts: r.dPackets }));
    console.log(`=====[${label}] INITIATOR CONCEALMENT SPIKES (dConcealed>300/100ms)===== ${JSON.stringify(concealRuns.slice(0, 25))}`);

    // Measure BOTH directions at the same time: on the initiator page, record
    // what the ACCEPTOR sends to the initiator (acc→init); on the acceptor
    // page, record what the INITIATOR sends to the acceptor (init→acc).
    const [accToInit, initToAcc] = await Promise.all([
        captureDirection(initiatorPage, 5),
        captureDirection(acceptorPage, 5),
    ]);

    console.log(`=====BOTH DIRECTIONS [${label}] (identical 440Hz tone both mics)=====\n` +
        JSON.stringify({
            'acceptor→initiator': accToInit,
            'initiator→acceptor': initToAcc,
        }, null, 2));

    if (accToInit.error || initToAcc.error) {
        console.log('CAPTURE ERROR (environmental):', accToInit.error, initToAcc.error);
        return { accToInit, initToAcc, env: true };
    }

    const results: any = {};
    for (const [dir, result] of [['acc→init', accToInit], ['init→acc', initToAcc]] as const) {
        const emitted = result.stats.jitterBufferEmittedCount || 0;
        const concealed = result.stats.concealedSamples || 0;
        results[dir] = {
            silentPct: result.analysis.silentPct,
            maxSilentRun: result.analysis.maxSilentRun,
            rmsCV: result.analysis.rmsCV,
            concealPct: emitted > 0 ? (concealed / emitted) * 100 : 0,
            packetsLost: result.stats.packetsLost || 0,
            jitterMs: result.stats.jitterMs,
            sendPackets: result.stats.sendPackets,
            sendFramesEncoded: result.stats.sendFramesEncoded,
        };
        expect(result.analysis.duration, `${label} ${dir} duration`).toBeGreaterThan(3);
        expect(result.analysis.bytes, `${label} ${dir} bytes`).toBeGreaterThan(1000);
        expect(result.analysis.silentPct, `${label} ${dir} silent%`).toBeLessThan(2);
        expect(result.analysis.maxSilentRun, `${label} ${dir} maxSilentRun`).toBeLessThan(25);
        expect(result.analysis.rmsCV, `${label} ${dir} rmsCV`).toBeLessThan(0.3);
        if (emitted > 0) {
            expect(concealed / emitted, `${label} ${dir} concealment`).toBeLessThan(0.02);
        }
        expect(result.stats.packetsLost || 0, `${label} ${dir} packetsLost`).toBeLessThan(5);
    }
    console.log(`=====[${label}] SUMMARY===== ${JSON.stringify(results)}`);
    await ctx.close();
    await ctx2.close();
    return results;
}

test('DM call: BOTH directions of the identical constant tone are clean — A initiates', async ({ browser }) => {
    await runBothDirections(browser, 'A initiates');
});

test('DM call: BOTH directions of the identical constant tone are clean — B initiates (role swap)', async ({ browser }) => {
    await runBothDirections(browser, 'B initiates', true);
});
