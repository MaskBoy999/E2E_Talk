import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// 10-account, single server voice channel: every user must ACTUALLY HEAR the
// other 9 — played through the browser's audio sink, not merely decoded.
//
// Same methodology as the 2-user const-tone test:
//   - HEADED Chrome (headless has no audio pipeline — it receives RTP but
//     decodes zero samples, so it can never prove audible playback).
//   - A real 30s constant 440 Hz tone is injected into EVERY account's fake
//     microphone via --use-file-for-fake-audio-capture.
//   - Each user joins the SAME server voice channel (10-way mesh).
//   - For EVERY user we assert: 9 connected peers, 9 remote audio streams,
//     9 PLAYING <audio> elements (one per peer, !paused, volume applied),
//     matching E2EE room key, and then capture the element's ACTUAL output
//     via HTMLMediaElement.captureStream(), MediaRecord it, decode the PCM
//     and prove it contains a clean 440 Hz tone (RMS, silent %, no stops,
//     dominant zero-crossing frequency ≈ 440).
//
// Noise suppression forced 'off' (RNNoise VAD would gate a constant tone);
// echo cancellation OFF so AEC can't cancel the tone the caller plays back.

const BASE = 'https://localhost:3443';
const WAV_PATH = path.join(os.tmpdir(), 'voice-server-tone-10u.wav');

function writeToneWav(filePath: string, seconds = 300, rate = 48000, freq = 440, amp = 0.25) {
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
        ],
    },
});

// --- Helpers ----------------------------------------------------------------
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

async function createServerWithVoiceChannel(page: any, token: string): Promise<{ serverId: string; voiceChannelId: string; inviteCode: string }> {
    const ts = Date.now();
    const inviteCode = 'T10' + ts;
    const prep = await page.evaluate(async ({ serverId, inviteCode }) => {
        const identity = E2ECrypto.getIdentityKeyPair();
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, symKey);
        const encName = E2ECrypto.aeadEncrypt('Tone10 Server', symKey);
        const encCh = E2ECrypto.aeadEncrypt('general', symKey);
        return {
            encrypted_name: encName.ciphertext,
            name_nonce: encName.nonce,
            channel_encrypted_name: encCh.ciphertext,
            channel_name_nonce: encCh.nonce,
            invite_code: inviteCode,
        };
    }, { serverId: 'pending', inviteCode });

    const srv = await (await page.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            invite_code: inviteCode,
            encrypted_name: prep.encrypted_name,
            name_nonce: prep.name_nonce,
            channel_encrypted_name: prep.channel_encrypted_name,
            channel_name_nonce: prep.channel_name_nonce,
        },
    })).json();
    const serverId = srv.id;
    await page.evaluate(async ({ serverId }) => {
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, symKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const myId = JSON.parse(localStorage.getItem('user') || '{}').id;
        const pubRes = await fetch('/api/identity/' + myId, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const pubData = await pubRes.json();
        const pubKey = new Uint8Array(E2ECrypto.base64ToArrayBuffer(pubData.identity_public_key));
        const enc = E2ECrypto.envelopeEncrypt(symKey, pubKey, identity.privateKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                user_id: myId,
                encrypted_key: enc.ciphertext,
                sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey),
                nonce: enc.nonce,
            }),
        });
    }, { serverId });

    const serverKeyB64 = await page.evaluate((sid) => {
        const sk = E2ECrypto.getServerKey(sid);
        return E2ECrypto.arrayBufferToBase64(sk);
    }, serverId);
    const encName2 = await page.evaluate(async ({ name, serverKeyB64 }) => {
        const sk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(serverKeyB64));
        const enc = E2ECrypto.aeadEncrypt(name, sk);
        return { ciphertext: enc.ciphertext, nonce: enc.nonce };
    }, { name: 'Tone10 Voice', serverKeyB64 });

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            name: 'Tone10 Voice',
            encrypted_name: encName2.ciphertext,
            name_nonce: encName2.nonce,
            channel_type: 'voice',
        },
    })).json();
    expect(ch.channel_type).toBe('voice');
    return { serverId, voiceChannelId: ch.id, inviteCode };
}

async function selectServer(page: any) {
    await page.evaluate(() => {
        if (typeof loadServers === 'function') loadServers();
    }).catch(() => {});
    await page.click('#dm-strip-btn').catch(() => {});
    await page.waitForTimeout(800);
    for (let i = 0; i < 30; i++) {
        const count = await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').count();
        if (count > 0) {
            await page.locator('.server-icon:not(.add-server):not(.dm-strip-btn)').first().click().catch(() => {});
            await page.waitForTimeout(600);
            return true;
        }
        await page.waitForTimeout(300);
    }
    return false;
}

async function clickVoiceChannel(page: any, channelId: string) {
    for (let i = 0; i < 40; i++) {
        const el = page.locator(`.channel-item[data-id="${channelId}"]`);
        if (await el.count()) {
            await el.click();
            await page.waitForTimeout(600);
            return true;
        }
        await page.waitForTimeout(300);
    }
    return false;
}

// Dump the full per-user state: peers, remote streams, audio elements.
async function dumpState(pageRef: any, label: string) {
    return await pageRef.evaluate((label) => {
        const v = (window as any).VoiceManager;
        const dbg = v._debug && v._debug.state ? v._debug.state : v.getState();
        const peers: any = {};
        Object.keys(dbg.peers || {}).forEach((uid) => {
            const pc: any = dbg.peers[uid];
            if (!pc || typeof pc.getSenders !== 'function') return;
            peers[uid] = {
                cs: pc.connectionState,
                senders: pc.getSenders().map((x: any) => x.track ? x.track.kind : 'null'),
                receivers: pc.getReceivers().map((x: any) => x.track ? x.track.kind : 'null'),
                hasSendTransform: pc.getSenders().some((x: any) => x.track && !!x.transform),
                hasRecvTransform: pc.getReceivers().some((x: any) => x.track && !!x.transform),
            };
        });
        const audioEls = Object.keys(dbg.remoteAudioEls || {}).map((uid) => {
            const els = dbg.remoteAudioEls[uid] || [];
            return { uid, count: els.length, playing: els.filter((e: any) => e && !e.paused && e.srcObject).length };
        });
        return {
            label,
            connected: dbg.connected,
            key: dbg.roomKeyB64 ? dbg.roomKeyB64.slice(0, 12) + '…' : null,
            mic: !!(dbg.localStreams && dbg.localStreams.mic),
            members: Object.keys(dbg.members || {}).length,
            peers,
            audioEls,
            remoteAudio: Object.keys(dbg.remoteStreams || {}).filter((u) => dbg.remoteStreams[u] && dbg.remoteStreams[u].audio).length,
            pendingRecv: (dbg._pendingRecvTransforms || []).length,
        };
    }, label);
}

// Record the ACTUAL output of EVERY remote <audio> element (each one is a
// distinct peer's stream) via captureStream, decode, and analyze PCM for a
// clean 440 Hz tone. Returns one entry per element so the test can prove
// "every user hears every other user" — not just one sample.
async function captureAllElementsOutput(page: any, seconds = 4, onlyFirst = 0) {
    return await page.evaluate(async ({ seconds, onlyFirst }) => {
        const V = (window as any).VoiceManager;
        const S = V._debug.state;
        const uids = Object.keys(S.remoteAudioEls || {});
        if (!uids.length) return { error: 'no remote audio elements', perEl: [] };
        const els: { uid: string; el: any }[] = [];
        uids.forEach((uid) => {
            const list = (S.remoteAudioEls[uid] || []).filter((e: any) => e && e.srcObject);
            list.forEach((e: any) => els.push({ uid, el: e }));
        });
        if (onlyFirst > 0) els.splice(onlyFirst);
        if (!els.length) return { error: 'no element with srcObject', perEl: [] };
        const unsupported = els.filter((x) => typeof x.el.captureStream !== 'function');
        if (unsupported.length) return { error: 'captureStream unsupported', perEl: [] };

        const mime = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : '';
        // Capture ONE element at a time per page. Concurrent MediaRecorders on
        // this machine's capture pipeline come back empty (0 bytes), but a
        // single recorder per page reliably captures real audio (verified).
        // Pages run in parallel, so the total wall time stays ~N×seconds.
        const recs: any[] = [];
        for (const x of els) {
            const outStream = x.el.captureStream();
            const track = outStream.getAudioTracks()[0];
            const rec: any = { uid: x.uid, track: !!track, paused: x.el.paused, hasSrc: !!x.el.srcObject, volume: x.el.volume };
            if (track) {
                const mr = new MediaRecorder(new MediaStream([track]), mime ? { mimeType: mime } : undefined);
                const chunks: Blob[] = [];
                mr.ondataavailable = (e: any) => { if (e.data && e.data.size) chunks.push(e.data); };
                mr.start();
                await new Promise((r) => setTimeout(r, seconds * 1000));
                mr.stop();
                await new Promise((res) => { mr.onstop = res; });
                rec.analysisBytes = chunks.reduce((a, b) => a + b.size, 0);
                rec._chunks = chunks;
            }
            recs.push(rec);
        }

        const AC: any = window.AudioContext || (window as any).webkitAudioContext;
        const out: any[] = [];
        for (const r of recs) {
            if (!r._chunks) { out.push({ uid: r.uid, error: 'no track' }); continue; }
            const blob = new Blob(r._chunks, { type: 'audio/webm' });
            const buf = await blob.arrayBuffer();
            // decodeAudioData() DETACHES the ArrayBuffer in Chrome — capture the
            // byte length BEFORE decoding or it reads 0 afterwards.
            const rawBytes = buf.byteLength;
            let analysis: any = { bytes: rawBytes, decodeError: null };
            if (rawBytes > 0) {
                try {
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
                    let zc = 0;
                    for (let i = 1; i < pcm.length; i++) {
                        if ((pcm[i - 1] < 0 && pcm[i] >= 0) || (pcm[i - 1] >= 0 && pcm[i] < 0)) zc++;
                    }
                    const zeroCrossFreq = (zc / 2) * (rate / pcm.length);
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
                        zeroCrossFreq,
                        peak: pcm.reduce((a, b) => Math.max(a, Math.abs(b)), 0),
                    };
                    try { decCtx.close(); } catch (_) {}
                } catch (err: any) {
                    analysis.decodeError = String(err);
                }
            }
            out.push({ uid: r.uid, paused: r.paused, hasSrc: r.hasSrc, volume: r.volume, analysis });
        }
        return { perEl: out };
    }, { seconds, onlyFirst });
}

test('10 users, 1 voice channel: every user ACTUALLY HEARS the other 9 (played, 440Hz)', async ({ browser }) => {
    test.setTimeout(600000);
    const N = 10;
    const ctxs: any[] = [];
    const pages: any[] = [];
    const bodies: any[] = [];

    // Owner page (index 0) + 9 more contexts.
    const ctx0 = await browser.newContext();
    ctxs.push(ctx0);
    const page0 = await ctx0.newPage();
    pages.push(page0);

    for (const p of pages) {
        await p.addInitScript(() => {
            try {
                localStorage.setItem('voice_settings', JSON.stringify({
                    noiseSuppressionMode: 'off',
                    echoCancellation: false,
                    micVolume: 100,
                    speakerVolume: 100,
                }));
            } catch (_) {}
        });
    }

    const owner = await registerUser(page0, 't10a_' + Date.now().toString().slice(-6));
    bodies.push(owner);
    const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page0, owner.token);

    for (let i = 1; i < N; i++) {
        const ctx = await browser.newContext();
        ctxs.push(ctx);
        const p = await ctx.newPage();
        await p.addInitScript(() => {
            try {
                localStorage.setItem('voice_settings', JSON.stringify({
                    noiseSuppressionMode: 'off',
                    echoCancellation: false,
                    micVolume: 100,
                    speakerVolume: 100,
                }));
            } catch (_) {}
        });
        const b = await registerUser(p, 't10' + String.fromCharCode(97 + i) + '_' + Date.now().toString().slice(-6));
        const join = await p.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(join.ok()).toBeTruthy();
        pages.push(p);
        bodies.push(b);
    }

    // Load index on all, wait for WS.
    for (const p of pages) {
        await p.goto(`${BASE}/index.html`);
        await p.waitForTimeout(2500);
        await waitForWs(p);
    }

    // Everyone joins the voice channel.
    for (const p of pages) {
        expect(await selectServer(p)).toBe(true);
        expect(await clickVoiceChannel(p, voiceChannelId)).toBe(true);
    }
    await page0.waitForTimeout(4000);

    // Wait for every user to be connected AND have peers to all others.
    for (const p of pages) {
        await p.waitForFunction((n) => {
            const v = (window as any).VoiceManager;
            return v && v.getState && v.getState().connected &&
                Object.keys((v._debug.state.peers) || {}).length >= n - 1;
        }, N, { timeout: 90000 });
    }
    // A 10-way mesh takes a while for ICE to fully connect on every edge.
    // Poll until EVERY peer on EVERY user reports 'connected' (up to 90s),
    // then give audio elements a beat to start before the state dump.
    for (let pass = 0; pass < 18; pass++) {
        const allConnected = [];
        for (let i = 0; i < N; i++) {
            const ok = await pages[i].evaluate((n) => {
                const v = (window as any).VoiceManager;
                const peers = (v && v._debug && v._debug.state && v._debug.state.peers) || {};
                const keys = Object.keys(peers);
                if (keys.length < n - 1) return { ready: false, reason: 'peerCount:' + keys.length };
                const bad = keys.filter((uid) => {
                    const pc: any = peers[uid];
                    return !pc || pc.connectionState !== 'connected';
                });
                return { ready: bad.length === 0, bad };
            }, N);
            allConnected.push(ok);
        }
        if (allConnected.every((r) => r.ready)) break;
        if (pass === 17) {
            // Dump the stuck peers for diagnosis.
            for (let i = 0; i < N; i++) {
                const stuck = await pages[i].evaluate(() => {
                    const v = (window as any).VoiceManager;
                    const peers = (v && v._debug && v._debug.state && v._debug.state.peers) || {};
                    const out: any = {};
                    Object.keys(peers).forEach((uid) => {
                        const pc: any = peers[uid];
                        out[uid] = pc ? { cs: pc.connectionState, ice: pc.iceConnectionState, gath: pc.iceGatheringState } : 'missing';
                    });
                    return out;
                });
                console.log('STUCK U' + (i + 1) + ': ' + JSON.stringify(stuck));
            }
            throw new Error('mesh did not fully connect: ' + JSON.stringify(allConnected));
        }
        await page0.waitForTimeout(5000);
    }
    await page0.waitForTimeout(6000);

    // Dump every user's state.
    const states: any[] = [];
    for (let i = 0; i < N; i++) {
        states.push(await dumpState(pages[i], 'U' + (i + 1)));
    }
    states.forEach((s) => console.log('USER_STATE ' + s.label + ': ' + JSON.stringify(s)));

    // 1. All 10 agree on the SAME room key.
    const keys = states.map((s) => s.key).filter(Boolean);
    expect(keys.length).toBe(N);
    expect(new Set(keys).size).toBe(1);

    // 2. Every user has 9 peers, all connected, audio both ways + E2EE.
    states.forEach((s) => {
        expect(s.connected).toBe(true);
        expect(s.mic).toBe(true);
        expect(Object.keys(s.peers).length).toBe(N - 1);
        Object.values(s.peers).forEach((p: any) => {
            expect(p.cs).toBe('connected');
            expect(p.senders).toContain('audio');
            expect(p.receivers).toContain('audio');
            expect(p.hasSendTransform).toBe(true);
            expect(p.hasRecvTransform).toBe(true);
        });
        expect(s.remoteAudio).toBe(N - 1);
        expect(s.pendingRecv).toBe(0);
    });

    // 3. Every user has 9 PLAYING audio elements (one per other user).
    states.forEach((s) => {
        expect(s.audioEls.length).toBe(N - 1);
        s.audioEls.forEach((r: any) => {
            expect(r.count).toBeGreaterThan(0);
            expect(r.playing).toBeGreaterThan(0);
        });
    });

    // 4. Actual playback proof: capture the element OUTPUT on EVERY user for
    //    EVERY peer and verify a clean 440 Hz tone in each decoded PCM — the
    //    strongest "every user hears every other user" guarantee.
    const captures = await Promise.all(pages.map((p, i) => captureAllElementsOutput(p, 4)));
    let totalEls = 0;
    captures.forEach((c, i) => {
        console.log('PLAYBACK U' + (i + 1) + ' els=' + (c.perEl || []).length + ': ' + JSON.stringify((c.perEl || []).map((e: any) => ({
            uid: e.uid ? e.uid.slice(0, 8) : '?',
            paused: e.paused,
            silentPct: e.analysis && Math.round(e.analysis.silentPct),
            msr: e.analysis && e.analysis.maxSilentRun,
            rmsCV: e.analysis && Math.round(e.analysis.rmsCV * 100) / 100,
            freq: e.analysis && Math.round(e.analysis.zeroCrossFreq),
            rms: e.analysis && Math.round(e.analysis.rmsMean * 1000) / 1000,
            bytes: e.analysis && e.analysis.bytes,
        }))));
        if (c.error) expect(c.error, 'U' + (i + 1) + ' ' + c.error).toBeUndefined();
        if (c.error) return;
        // Every user must hear all 9 others.
        expect(c.perEl.length, 'U' + (i + 1) + ' element count').toBe(N - 1);
        c.perEl.forEach((e: any, j: number) => {
            totalEls++;
            const tag = 'U' + (i + 1) + ' el' + j;
            expect(e.paused, tag + ' paused').toBe(false);
            expect(e.hasSrc, tag + ' has src').toBe(true);
            expect(e.volume, tag + ' volume').toBeGreaterThan(0);
            if (e.analysis && e.analysis.decodeError) expect(e.analysis.decodeError, tag + ' decode').toBeUndefined();
            if (!e.analysis || e.analysis.decodeError) return;
            expect(e.analysis.duration, tag + ' duration').toBeGreaterThan(2.5);
            expect(e.analysis.bytes, tag + ' bytes').toBeGreaterThan(1000);
            // Constant tone ⇒ near-zero silence and no long gaps.
            expect(e.analysis.silentPct, tag + ' silent%').toBeLessThan(2);
            expect(e.analysis.maxSilentRun, tag + ' maxSilentRun').toBeLessThan(25);
            expect(e.analysis.rmsCV, tag + ' rmsCV').toBeLessThan(0.3);
            expect(e.analysis.rmsMean, tag + ' rmsMean').toBeGreaterThan(0.01);
            expect(Math.abs(e.analysis.zeroCrossFreq - 440), tag + ' freq').toBeLessThan(80);
        });
    });
    expect(totalEls).toBe(N * (N - 1));

    for (const ctx of ctxs) {
        await ctx.close().catch(() => {});
    }
});
