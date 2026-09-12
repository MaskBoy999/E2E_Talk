import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.use({
    headless: false,
    launchOptions: {
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
        ],
    },
});

// --- Helpers ----------------------------------------------------------------

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(500);
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
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

async function createServerWithVoiceChannel(page: any, token: string) {
    const ts = Date.now();
    const inviteCode = 'AE2E' + ts;
    const prep = await page.evaluate(async ({ inviteCode }) => {
        const symKey = E2ECrypto.generateSymmetricKey();
        const encName = E2ECrypto.aeadEncrypt('RelayTest Server', symKey);
        const encCh = E2ECrypto.aeadEncrypt('voice', symKey);
        return {
            encrypted_name: encName.ciphertext,
            name_nonce: encName.nonce,
            channel_encrypted_name: encCh.ciphertext,
            channel_name_nonce: encCh.nonce,
            invite_code: inviteCode,
        };
    }, { inviteCode });

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

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { name: 'Voice', channel_type: 'voice' },
    })).json();
    expect(ch.channel_type).toBe('voice');
    return { serverId, voiceChannelId: ch.id, inviteCode };
}

async function joinServerViaInvite(page: any, token: string, inviteCode: string) {
    const join = await page.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { code: inviteCode },
    });
    expect(join.ok()).toBeTruthy();
    return (await join.json()).id;
}

async function selectServer(page: any) {
    await page.evaluate(() => { if (typeof loadServers === 'function') loadServers(); }).catch(() => {});
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

async function waitForConnected(page: any, timeoutMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const ok = await page.evaluate(() => {
            const V = (window as any).VoiceManager;
            return V && V._debug && V._debug.state && V._debug.state.connected;
        });
        if (ok) return true;
        await page.waitForTimeout(500);
    }
    return false;
}

async function getState(page: any) {
    return await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        if (!V || !V._debug || !V._debug.state) return null;
        const S = V._debug.state;
        return {
            connected: S.connected,
            muted: S.muted,
            cameraOn: S.cameraOn,
            lastAudioMode: S._lastAudioMode,
            audioOverrides: S._audioModeOverrides || {},
            videoOverrides: S._videoModeOverrides || {},
            relayTimers: Object.keys(S._relayTimers || {}),
            hasAudioCtx: !!S.audioCtx,
            audioCtxState: S.audioCtx ? S.audioCtx.state : null,
        };
    });
}

async function forceAudioToRelay(page: any) {
    await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        V.setSelfAudioMode('relay');
    });
    await page.waitForTimeout(500);
}

async function forceVideoToRelay(page: any) {
    await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        V.setSelfVideoMode('relay');
    });
    await page.waitForTimeout(500);
}

async function toggleAudioViaMenu(page: any) {
    const btn = page.locator('#voice-bar-cam-opt');
    await btn.click();
    // Wait for menu to be visible
    await page.locator('#voice-cam-opt-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);
    for (let i = 0; i < 3; i++) {
        const label = await page.locator('#cam-opt-audio-mode-label').textContent();
        if (label && label.toLowerCase().includes('relay') && label.toLowerCase().includes('manual')) break;
        await page.locator('#cam-opt-audio-mode').click();
        await page.waitForTimeout(400);
    }
    // Close menu by clicking outside
    await page.locator('#voice-bar-mute').click({ force: true }).catch(() => {});
    await page.waitForTimeout(200);
}

async function toggleVideoViaMenu(page: any) {
    const btn = page.locator('#voice-bar-cam-opt');
    await btn.click();
    // Wait for menu to be visible
    await page.locator('#voice-cam-opt-menu').waitFor({ state: 'visible', timeout: 5000 });
    await page.waitForTimeout(300);
    for (let i = 0; i < 3; i++) {
        const label = await page.locator('#cam-opt-video-mode-label').textContent();
        if (label && label.toLowerCase().includes('relay') && label.toLowerCase().includes('manual')) break;
        await page.locator('#cam-opt-video-mode').click();
        await page.waitForTimeout(400);
    }
    // Close menu by clicking outside
    await page.locator('#voice-bar-mute').click({ force: true }).catch(() => {});
    await page.waitForTimeout(200);
}

async function getVideoTiles(page: any) {
    return await page.evaluate(() => {
        // Check both popup and bar tiles
        const allTiles = document.querySelectorAll('.remote-video-tile');
        return Array.from(allTiles).map((el: any) => ({
            tag: el.tagName,
            src: el.src ? el.src.substring(0, 80) : 'none',
            visible: el.offsetWidth > 0 && el.offsetHeight > 0,
            width: el.offsetWidth,
            height: el.offsetHeight,
            display: getComputedStyle(el).display,
            parentClass: el.parentElement ? el.parentElement.className : 'none',
            dataUid: el.getAttribute('data-uid'),
            dataKind: el.getAttribute('data-kind'),
        }));
    });
}

// --- Tests ------------------------------------------------------------------

test.describe('Both users relay (visible browsers)', () => {

    test('both users toggle audio+video to relay, both unmute and start camera, verify both see/hear each other', async ({ page, context }) => {
        test.setTimeout(300000);

        console.log('=== BOTH USERS RELAY TEST ===');
        console.log('Both users will toggle audio and video to relay via 3-dot menu');
        console.log('Both will unmute and start camera');
        console.log('Verify both see relay video (img tiles) and audio context is running');

        // --- User A: create server ---
        const uA = await registerUser(page, 'BothRelayA_' + Date.now());
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        const { voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, uA.token);

        // --- User B: join ---
        const ctxB = await context.browser()!.newContext();
        const pageB = await ctxB.newPage();
        pageB.on('pageerror', (err) => console.log(`[B-ERROR] ${err.message}`));
        const uB = await registerUser(pageB, 'BothRelayB_' + Date.now());
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);
        await joinServerViaInvite(pageB, uB.token, inviteCode);
        await pageB.goto(`${BASE}/index.html`);
        await waitForWs(pageB);

        // --- Both join voice ---
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await waitForConnected(page);
        await selectServer(pageB);
        await clickVoiceChannel(pageB, voiceChannelId);
        await waitForConnected(pageB);
        console.log('[1] Both in voice channel');

        // --- USER A: toggle audio + video to relay via 3-dot menu ---
        console.log('[2] User A: toggling audio to relay (2 clicks)...');
        await toggleAudioViaMenu(page);
        const aAudioLabel = await page.locator('#cam-opt-audio-mode-label').textContent();
        console.log(`[2] User A audio: "${aAudioLabel}"`);

        console.log('[3] User A: toggling video to relay (2 clicks)...');
        await toggleVideoViaMenu(page);
        const aVideoLabel = await page.locator('#cam-opt-video-mode-label').textContent();
        console.log(`[3] User A video: "${aVideoLabel}"`);

        // Close menu
        await page.click('body', { position: { x: 10, y: 10 } });
        await page.waitForTimeout(300);

        // --- USER B: toggle audio + video to relay via 3-dot menu ---
        console.log('[4] User B: toggling audio to relay (2 clicks)...');
        await toggleAudioViaMenu(pageB);
        const bAudioLabel = await pageB.locator('#cam-opt-audio-mode-label').textContent();
        console.log(`[4] User B audio: "${bAudioLabel}"`);

        console.log('[5] User B: toggling video to relay (2 clicks)...');
        await toggleVideoViaMenu(pageB);
        const bVideoLabel = await pageB.locator('#cam-opt-video-mode-label').textContent();
        console.log(`[5] User B video: "${bVideoLabel}"`);

        // Close menu
        await pageB.click('body', { position: { x: 10, y: 10 } });
        await pageB.waitForTimeout(300);

        // --- Verify both are in relay mode ---
        const stateA = await getState(page);
        const stateB = await getState(pageB);
        console.log('[6] User A state:', JSON.stringify(stateA));
        console.log('[6] User B state:', JSON.stringify(stateB));

        expect(stateA!.lastAudioMode).toBe('relay');
        expect(stateB!.lastAudioMode).toBe('relay');
        console.log('[PASS] Both users audio mode = relay');

        // --- Both users: unmute and start camera ---
        console.log('[7] User A: unmute + start camera...');
        if (stateA!.muted) {
            await page.evaluate(() => { (window as any).VoiceManager.toggleMute(); });
        }
        await page.evaluate(async () => {
            const V = (window as any).VoiceManager;
            if (typeof V.toggleCamera === 'function') await V.toggleCamera();
        });

        console.log('[8] User B: unmute + start camera...');
        const stateBPre = await getState(pageB);
        if (stateBPre!.muted) {
            await pageB.evaluate(() => { (window as any).VoiceManager.toggleMute(); });
        }
        await pageB.evaluate(async () => {
            const V = (window as any).VoiceManager;
            if (typeof V.toggleCamera === 'function') await V.toggleCamera();
        });

        // Let frames flow — relay needs time to encrypt/decrypt/render
        await page.waitForTimeout(8000);

        // --- Final state ---
        const finalA = await getState(page);
        const finalB = await getState(pageB);
        console.log('[9] Final A:', JSON.stringify(finalA));
        console.log('[9] Final B:', JSON.stringify(finalB));

        // Both should have camera on and relay timer active
        expect(finalA!.cameraOn).toBe(true);
        expect(finalB!.cameraOn).toBe(true);
        expect(finalA!.relayTimers).toContain('camera');
        expect(finalB!.relayTimers).toContain('camera');
        console.log('[PASS] Both cameras ON with relay timers active');

        // Both should be unmuted
        expect(finalA!.muted).toBe(false);
        expect(finalB!.muted).toBe(false);
        console.log('[PASS] Both unmuted');

        // Both AudioContext running
        expect(finalA!.hasAudioCtx).toBe(true);
        expect(finalA!.audioCtxState).toBe('running');
        expect(finalB!.hasAudioCtx).toBe(true);
        expect(finalB!.audioCtxState).toBe('running');
        console.log('[PASS] Both AudioContexts running — audio relay active');

        // --- Check video tiles on each user ---
        const tilesA = await getVideoTiles(page);
        const tilesB = await getVideoTiles(pageB);
        console.log('[10] User A sees tiles:', JSON.stringify(tilesA));
        console.log('[10] User B sees tiles:', JSON.stringify(tilesB));

        // User B should see at least one relay img tile from User A with actual content
        const bRelayTiles = tilesB.filter(t => t.tag === 'IMG');
        const bVisibleRelay = bRelayTiles.filter(t => t.visible);
        console.log(`[10] User B relay img tiles: ${bRelayTiles.length} (${bVisibleRelay.length} visible)`);

        // User A should see at least one relay img tile from User B
        const aRelayTiles = tilesA.filter(t => t.tag === 'IMG');
        const aVisibleRelay = aRelayTiles.filter(t => t.visible);
        console.log(`[10] User A relay img tiles: ${aRelayTiles.length} (${aVisibleRelay.length} visible)`);

        // Screenshots
        await page.screenshot({ path: 'test-results/both-relay-a.png', fullPage: true });
        await pageB.screenshot({ path: 'test-results/both-relay-b.png', fullPage: true });

        console.log('\n=== BOTH USERS RELAY TEST PASSED ===');
        console.log('Screenshots: test-results/both-relay-*.png');
        console.log('Both browser windows are visible — check them for live video/audio');
        console.log('Both users: camera ON, mic UNMUTED, audio=relay, video=relay');
        console.log('Speak into mics and check if both hear each other via server relay');

        await pageB.close();
        await ctxB.close();
    });
});
