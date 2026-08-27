import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const BASE = 'https://localhost:3443';
const DIR = path.join(__dirname, '..', 'browser-screenshots');

function u(pfx: string) { return pfx + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

async function waitWs(page: any) {
    for (let i = 0; i < 60; i++) {
        if (await page.evaluate(() => (window as any).ws?.readyState === 1)) return;
        await page.waitForTimeout(300);
    }
}

async function reg(page: any, name: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 15000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible', timeout: 5000 });
    await page.fill('#register-username', name);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#current-user', { timeout: 15000 });
}

async function ss(page: any, name: string) {
    if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });
    await page.screenshot({ path: path.join(DIR, `${name}.png`) });
    console.log(`📸 ${name}`);
}

test.describe('Visual 2-user test', () => {
    test('register, join, soundboard, group, mic', async ({ browser }) => {
        const c1 = await browser.newContext({ ignoreHTTPSErrors: true });
        const c2 = await browser.newContext({ ignoreHTTPSErrors: true });
        const p1 = await c1.newPage();
        const p2 = await c2.newPage();

        // -- Register User A --
        const userA = u('owner');
        await reg(p1, userA); await waitWs(p1); await p1.waitForTimeout(2000);

        // -- Create server --
        await p1.click('#add-server-btn');
        await p1.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
        await p1.click('#choice-create-server');
        await p1.waitForSelector('#new-server-name', { state: 'visible', timeout: 5000 });
        await p1.fill('#new-server-name', 'Test Server');
        await p1.click('#confirm-create-server');
        await p1.waitForFunction(() => document.querySelectorAll('.server-icon').length > 0, { timeout: 15000 });
        await p1.waitForTimeout(3000);

        const sid = await p1.evaluate(async () => {
            const t = localStorage.getItem('token');
            const r = await fetch('/api/servers', { headers: { 'Authorization': 'Bearer ' + t } });
            const d = await r.json();
            return d[d.length - 1]?.id || '';
        });
        const invite = await p1.evaluate((s: string) => localStorage.getItem('e2e_invite_' + s) || '', sid);

        // Create voice channel
        await p1.evaluate(async (s: string) => {
            const t = localStorage.getItem('token');
            await fetch(`/api/servers/${s}/channels`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
                body: JSON.stringify({ name: 'Voice', type: 'voice' })
            });
        }, sid);
        await p1.reload({ waitUntil: 'networkidle' }); await waitWs(p1); await p1.waitForTimeout(3000);
        await ss(p1, 'A-server-created');

        console.log(`Server: ${sid}, Invite: ${invite.substring(0, 8)}`);

        // -- Register User B --
        const userB = u('joiner');
        await reg(p2, userB); await waitWs(p2); await p2.waitForTimeout(2000);
        await ss(p2, 'B-registered');

        // -- User B joins via API --
        const jr = await p2.evaluate(async (c: string) => {
            const t = localStorage.getItem('token');
            const r = await fetch('/api/invites/join', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
                body: JSON.stringify({ code: c })
            });
            return { ok: r.ok, data: await r.json() };
        }, invite);
        console.log('Join result:', JSON.stringify(jr));

        // Reload to trigger loadServers()
        await p2.reload({ waitUntil: 'networkidle' }); await waitWs(p2); await p2.waitForTimeout(5000);

        // CHECK: User B server icons
        const bIcons = await p2.evaluate(() => {
            const icons = document.querySelectorAll('.server-icon');
            return Array.from(icons).map((el: any) => ({
                id: el.dataset.id,
                text: el.textContent?.trim(),
                visible: el.offsetParent !== null
            }));
        });
        console.log('User B icons:', JSON.stringify(bIcons));
        const bApiCount = await p2.evaluate(async () => {
            const t = localStorage.getItem('token');
            const r = await fetch('/api/servers', { headers: { 'Authorization': 'Bearer ' + t } });
            return (await r.json()).length;
        });
        console.log(`User B: ${bIcons.length} DOM icons, ${bApiCount} API servers`);
        await ss(p2, 'B-joined-server');

        // CHECK: Soundboard decrypt
        const sb = await p1.evaluate(async (s: string) => {
            const E = (window as any).E2ECrypto;
            const key = E.getServerKey(s);
            if (!key) return { error: 'NO KEY' };

            // Create WAV
            const sr = 44100, dur = 0.5, ns = Math.floor(sr * dur);
            const buf = new ArrayBuffer(44 + ns * 2);
            const v = new DataView(buf);
            const ws = (o: number, str: string) => { for (let i = 0; i < str.length; i++) v.setUint8(o + i, str.charCodeAt(i)); };
            ws(0, 'RIFF'); v.setUint32(4, 36 + ns * 2, true); ws(8, 'WAVE');
            ws(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true);
            v.setUint16(22, 1, true); v.setUint32(24, sr, true);
            v.setUint32(28, sr * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
            ws(36, 'data'); v.setUint32(40, ns * 2, true);
            for (let i = 0; i < ns; i++) v.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * (i / sr)) * 32767), true);

            // Encrypt & upload
            const enc = E.encryptBytesForServer(new Uint8Array(buf), s);
            const t = localStorage.getItem('token');
            const up = await fetch('/api/soundboard', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + t },
                body: JSON.stringify({ server_id: s, name: 'tone440', encrypted_audio: enc.ciphertext, audio_nonce: enc.nonce })
            });
            if (!up.ok) return { error: 'UPLOAD ' + (await up.json()).error };

            // Fetch back & decrypt
            const cr = await fetch('/api/soundboard/' + s, { headers: { 'Authorization': 'Bearer ' + t } });
            const clips = await cr.json();
            if (!clips.length) return { error: 'NO CLIPS' };
            const clip = clips[0];

            try {
                const dec = E.decryptBytesForServer(clip.encrypted_audio, clip.audio_nonce, s);
                let hdr = '';
                for (let i = 0; i < 4; i++) hdr += String.fromCharCode(dec[i]);

                // Try playing
                const blob = new Blob([dec], { type: 'audio/wav' });
                const url = URL.createObjectURL(blob);
                const audio = new Audio(url);
                await audio.play();
                audio.pause();
                URL.revokeObjectURL(url);
                return { ok: true, wav: hdr === 'RIFF', len: dec.length };
            } catch (e: any) {
                return { error: 'DECRYPT: ' + e.message };
            }
        }, sid);
        console.log('Soundboard:', JSON.stringify(sb));

        // CHECK: DM call soundboard button
        const dmSb = await p1.evaluate(() => ({
            dmCall: !!document.getElementById('dm-call-soundboard'),
            dmMini: !!document.getElementById('dm-mini-bar-soundboard'),
            voiceBar: !!document.getElementById('voice-bar-soundboard'),
            voicePopup: !!document.getElementById('voice-popup-soundboard'),
        }));
        console.log('Soundboard buttons:', JSON.stringify(dmSb));

        // CHECK: Hear-self button
        await p1.click('#settings-btn');
        await p1.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await p1.click('.settings-tab[data-tab="voice-settings"]');
        await p1.waitForTimeout(500);
        await ss(p1, 'A-voice-settings');
        const hs = await p1.evaluate(() => ({
            btn: !!document.getElementById('voice-hear-self-btn'),
            tag: document.getElementById('voice-hear-self-btn')?.tagName,
            meter: !!document.getElementById('voice-hear-self-meter-wrap'),
            status: !!document.getElementById('voice-hear-self-status'),
        }));
        console.log('Hear-self:', JSON.stringify(hs));
        await p1.keyboard.press('Escape');

        // CHECK: VoiceManager.getVoiceState
        const vs = await p1.evaluate(() => {
            const s = (window as any).VoiceManager?.getVoiceState?.();
            return s ? { keys: Object.keys(s), inVoice: s.inVoice } : null;
        });
        console.log('VoiceState:', JSON.stringify(vs));

        // SUMMARY
        console.log('\n========== RESULTS ==========');
        console.log(`Join: ${jr.ok ? '✅' : '❌'} (User B sees ${bIcons.length} icons, API has ${bApiCount} servers)`);
        console.log(`Soundboard: ${sb.ok ? '✅ WAV decrypted + playable' : '❌ ' + sb.error}`);
        console.log(`DM call sb btn: ${dmSb.dmCall ? '✅' : '❌'} | DM mini: ${dmSb.dmMini ? '✅' : '❌'} | Voice bar: ${dmSb.voiceBar ? '✅' : '❌'}`);
        console.log(`Hear-self btn: ${hs.btn ? '✅' + hs.tag : '❌'} | Meter: ${hs.meter ? '✅' : '❌'}`);
        console.log(`VoiceState: ${vs ? '✅' : '❌'}`);
        console.log('============================');

        await c1.close(); await c2.close();
    });
});
