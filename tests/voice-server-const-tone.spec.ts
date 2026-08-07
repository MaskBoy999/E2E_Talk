import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Server voice channel constant-tone playback test.
//
// Feeds a 30-second constant 440 Hz tone into Chrome's FAKE microphone via
// --use-file-for-fake-audio-capture, then runs the app's REAL server voice
// channel with E2EE ON, in a HEADED browser (headless Chrome has no audio
// pipeline — it receives RTP bytes but decodes zero samples, so it can never
// prove audible playback).
//
// On the receiver we prove the audio is ACTUALLY PLAYED (not merely decoded):
//   1. The <audio> element the app created is a real HTMLAudioElement,
//      !paused, volume applied, srcObject attached.
//   2. HTMLMediaElement.captureStream() of THAT element (Chrome captures
//      exactly what the element outputs through its sink) is MediaRecorded,
//      decoded, and analyzed: non-silent, no long silent gaps, RMS CV low
//      (no highs/lows), and a dominant 440 Hz bin (the tone made it through
//      encrypt → transport → decrypt → element sink → speaker feed).
//
// Noise suppression is forced to 'off' so RNNoise's VAD can't gate a constant
// tone; echo cancellation OFF so Chrome's AEC can't cancel the caller's own
// tone playing back through its speakers.

const BASE = 'https://localhost:3443';
const WAV_PATH = path.join(os.tmpdir(), 'voice-server-tone-30s.wav');

// --- 30s constant-tone WAV (48 kHz, 16-bit PCM mono) -----------------------
function writeToneWav(filePath: string, seconds = 30, rate = 48000, freq = 440, amp = 0.25) {
    const n = Math.floor(seconds * rate);
    const dataSize = n * 2;
    const buf = Buffer.alloc(44 + dataSize);
    buf.write('RIFF', 0);
    buf.writeUInt32LE(36 + dataSize, 4);
    buf.write('WAVE', 8);
    buf.write('fmt ', 12);
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(1, 20);            // PCM
    buf.writeUInt16LE(1, 22);            // mono
    buf.writeUInt32LE(rate, 24);
    buf.writeUInt32LE(rate * 2, 28);     // byte rate
    buf.writeUInt16LE(2, 32);            // block align
    buf.writeUInt16LE(16, 34);           // bits per sample
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
    const inviteCode = 'TC' + ts;
    const prep = await page.evaluate(async ({ serverId, inviteCode }) => {
        const identity = E2ECrypto.getIdentityKeyPair();
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, symKey);
        const encName = E2ECrypto.aeadEncrypt('Tone Server', symKey);
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
    }, { name: 'Tone Voice', serverKeyB64 });

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            name: 'Tone Voice',
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

// Record what the receiver's <audio> element ACTUALLY outputs (its sink feed)
// via HTMLMediaElement.captureStream(), decode it, and analyze the PCM for a
// dominant 440 Hz tone + no silent gaps.
async function captureElementOutput(page: any, seconds = 6) {
    return await page.evaluate(async ({ seconds }) => {
        const V = (window as any).VoiceManager;
        const S = V._debug.state;
        const uids = Object.keys(S.remoteAudioEls || {});
        if (!uids.length) return { error: 'no remote audio elements', uids: Object.keys(S.remoteStreams || {}) };
        const els = (S.remoteAudioEls[uids[0]] || []).filter((e: any) => e && e.srcObject);
        if (!els.length) return { error: 'audio element has no srcObject' };

        const el = els[0] as HTMLAudioElement;
        const elState = { paused: el.paused, muted: el.muted, volume: el.volume, hasSrc: !!el.srcObject };
        if (typeof (el as any).captureStream !== 'function') {
            return { error: 'captureStream unsupported on this element', elState };
        }

        // Capture the element's OUTPUT — this is exactly what is being played.
        const outStream = (el as any).captureStream();
        const track = outStream.getAudioTracks()[0];
        if (!track) return { error: 'captureStream gave no audio track', elState };

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

                // Dominant frequency via zero-crossing rate of the decoded PCM.
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
        return { elState, analysis };
    }, { seconds });
}

test('server voice channel: constant 440Hz tone is ACTUALLY PLAYED by the receiver', async ({ browser }) => {
    test.setTimeout(240000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();

    // Force NS off + EC off BEFORE the app loads (see header comment).
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
        });
    }

    const body1 = await registerUser(page, 'tc1_' + Date.now().toString().slice(-6));
    const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);

    const body2 = await registerUser(page2, 'tc2_' + Date.now().toString().slice(-6));
    const join = await page2.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
        data: { code: inviteCode },
    });
    expect(join.ok()).toBeTruthy();

    await page.goto(`${BASE}/index.html`);
    await page2.goto(`${BASE}/index.html`);
    await page.waitForTimeout(2500);
    await page2.waitForTimeout(2500);
    await waitForWs(page);
    await waitForWs(page2);

    // Both join the voice channel (headed browser, real fake-mic tone).
    expect(await selectServer(page)).toBe(true);
    expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
    await page.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && v.getState && v.getState().connected;
    }, undefined, { timeout: 15000 });
    await page.waitForTimeout(2000);

    expect(await selectServer(page2)).toBe(true);
    expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);
    await page2.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && v.getState && v.getState().connected;
    }, undefined, { timeout: 15000 });
    await page.waitForTimeout(6000);

    // Receiver: capture what the <audio> element actually outputs.
    const played = await captureElementOutput(page2, 6);
    console.log('=====SERVER CHANNEL PLAYBACK (element output)=====\n' + JSON.stringify(played, null, 2));

    if (played.error) expect(played.error, played.error).toBeUndefined();
    if (played.error) return;

    // The element must be a real, playing, audible element.
    expect(played.elState.paused, 'audio element must not be paused').toBe(false);
    expect(played.elState.hasSrc, 'audio element must have a srcObject').toBe(true);
    expect(played.elState.volume, 'audio element volume must be audible').toBeGreaterThan(0);

    // The decoded PCM of the ELEMENT OUTPUT must contain the 440Hz tone:
    // non-silent, no long silent runs, no highs/lows, dominant freq ~440Hz.
    expect(played.analysis.duration).toBeGreaterThan(3);
    expect(played.analysis.bytes).toBeGreaterThan(1000);
    expect(played.analysis.silentPct).toBeLessThan(2);
    expect(played.analysis.maxSilentRun).toBeLessThan(25);
    expect(played.analysis.rmsCV).toBeLessThan(0.3);
    expect(played.analysis.rmsMean).toBeGreaterThan(0.01);
    // Zero-crossing of a 440Hz sine at the decoded sample rate ≈ 440 (allow
    // for the lossy webm codec + resampling).
    expect(Math.abs(played.analysis.zeroCrossFreq - 440)).toBeLessThan(80);

    await ctx.close();
    await ctx2.close();
});
