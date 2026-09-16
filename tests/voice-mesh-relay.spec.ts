import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

test.use({
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
        const encName = E2ECrypto.aeadEncrypt('MeshRelay Server', symKey);
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

    const serverKeyB64 = await page.evaluate((sid) => {
        return E2ECrypto.arrayBufferToBase64(E2ECrypto.getServerKey(sid));
    }, serverId);
    const encName2 = await page.evaluate(async ({ name, serverKeyB64 }) => {
        const sk = new Uint8Array(E2ECrypto.base64ToArrayBuffer(serverKeyB64));
        const enc = E2ECrypto.aeadEncrypt(name, sk);
        return { ciphertext: enc.ciphertext, nonce: enc.nonce };
    }, { name: 'Voice', serverKeyB64 });

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            name: 'Voice',
            encrypted_name: encName2.ciphertext,
            name_nonce: encName2.nonce,
            channel_type: 'voice',
        },
    })).json();
    expect(ch.channel_type).toBe('voice');
    return { serverId, voiceChannelId: ch.id, inviteCode };
}

async function joinServerViaInvite(page: any, token: string, inviteCode: string) {
    const join = await page.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: { code: inviteCode },
    });
    if (!join.ok()) {
        const body = await join.text();
        console.log('joinServerViaInvite failed:', join.status(), body);
    }
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

async function isInVoiceChannel(page: any) {
    return await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        return V && V._debug && V._debug.state && V._debug.state.connected;
    });
}

async function getVoiceState(page: any) {
    return await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        if (!V || !V._debug || !V._debug.state) return null;
        const S = V._debug.state;
        return {
            connected: S.connected,
            roomType: S.roomType,
            channelId: S.channelId,
            muted: S.muted,
            deafened: S.deafened,
            cameraOn: S.cameraOn,
            screenOn: S.screenOn,
            members: Object.keys(S.members || {}),
            memberCount: Object.keys(S.members || {}).length,
            peerCount: Object.keys(S.peers || {}).length,
            lastAudioMode: S._lastAudioMode,
            videoMeshMode: !!(S.settings && S.settings.videoMeshMode),
        };
    });
}

async function startCamera(page: any) {
    return await page.evaluate(async () => {
        const V = (window as any).VoiceManager;
        if (typeof V.startCamera === 'function') {
            await V.startCamera();
        } else if (typeof V.toggleCamera === 'function') {
            await V.toggleCamera();
        }
        return true;
    });
}

async function stopCamera(page: any) {
    return await page.evaluate(async () => {
        const V = (window as any).VoiceManager;
        if (typeof V.stopCamera === 'function') {
            V.stopCamera();
        }
        return true;
    });
}

async function toggleDeafen(page: any) {
    return await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        V.toggleDeafen();
    });
}

async function toggleMute(page: any) {
    return await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        V.toggleMute();
    });
}

async function getActiveParticipantCount(page: any) {
    return await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        if (!V || !V._debug || !V._debug.state) return 0;
        const S = V._debug.state;
        let count = 0;
        for (const uid of Object.keys(S.members || {})) {
            const m = S.members[uid];
            if (!m.deafened && !m.force_deafened) count++;
        }
        if (!S.deafened) count = Math.max(count, 1);
        return count;
    });
}

async function getRelayMode(page: any) {
    return await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        if (!V || !V._debug || !V._debug.state) return null;
        return V._debug.state._lastAudioMode;
    });
}

async function waitForMode(page: any, expected: string, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const mode = await getRelayMode(page);
        if (mode === expected) return mode;
        await page.waitForTimeout(500);
    }
    return await getRelayMode(page);
}

async function waitForActiveCount(page: any, min: number, timeoutMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const count = await getActiveParticipantCount(page);
        if (count >= min) return count;
        await page.waitForTimeout(500);
    }
    return await getActiveParticipantCount(page);
}

async function getVideoMeshMode(page: any) {
    return await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        if (!V || !V._debug || !V._debug.state) return false;
        return V._debug.state.settings.videoMeshMode;
    });
}

async function setVideoMeshMode(page: any, on: boolean) {
    return await page.evaluate((on) => {
        const V = (window as any).VoiceManager;
        V.setVideoMeshMode(on);
    }, on);
}

async function leaveVoice(page: any) {
    return await page.evaluate(() => {
        const V = (window as any).VoiceManager;
        V.leaveVoice();
    });
}

// Setup a user that can join an existing server via invite code
async function setupMemberPage(browser: any, inviteCode: string, username: string, ts: number) {
    const ctx = await browser.newContext();
    const p = await ctx.newPage();
    p.on('pageerror', (err) => console.log(`MEMBER ERROR: ${err.message}`));
    const u = await registerUser(p, username);

    // Navigate to index.html so E2ECrypto is available for identity operations
    await p.goto(`${BASE}/index.html`);
    await waitForWs(p);

    // Now join server via invite (needs E2ECrypto for key exchange)
    await joinServerViaInvite(p, u.token, inviteCode);

    // Navigate to index and wait for WS reconnect
    await p.goto(`${BASE}/index.html`);
    await waitForWs(p);

    return { page: p, token: u.token, user: u.user, context: ctx };
}

// --- Tests ------------------------------------------------------------------

test.describe('Voice mesh/relay dynamic switching', () => {

    test('video defaults to P2P mesh in server voice channels', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const owner = await registerUser(page, 'vrelay_own_' + ts);

        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, owner.token);

        // Join voice channel
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await page.waitForTimeout(2000);
        expect(await isInVoiceChannel(page)).toBeTruthy();

        // Mesh is the default for every kind — nothing auto-enables relay.
        let st = await getVoiceState(page);
        expect(st).toBeTruthy();
        expect(st!.roomType).toBe('server');

        // Start camera — must stay on the P2P mesh (no relay loop).
        await startCamera(page);
        await page.waitForTimeout(2000);

        st = await getVoiceState(page);
        expect(st!.cameraOn).toBeTruthy();

        let relayTimers = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { camera: !!(S._relayTimers && S._relayTimers.camera) };
        });
        expect(relayTimers.camera).toBeFalsy();

        // Opting in per-kind starts the relay loop.
        await page.evaluate(() => (window as any).VoiceManager.setSelfCameraMode('relay'));
        await page.waitForTimeout(1500);
        relayTimers = await page.evaluate(() => {
            const S = (window as any).VoiceManager._debug.state;
            return { camera: !!(S._relayTimers && S._relayTimers.camera) };
        });
        expect(relayTimers.camera).toBeTruthy();

        await stopCamera(page);
        await leaveVoice(page);
    });

    test('6 members: audio stays on mesh (no auto relay)', async ({ page, context }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const browser = context.browser()!;
        const pages: any[] = [page];
        const members: any[] = [];

        // Register owner
        const owner = await registerUser(page, 'mesh_own_' + ts);

        // Create server with voice channel
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, owner.token);

        // Register 5 more members (they join server via invite AFTER navigating to index.html)
        for (let i = 0; i < 5; i++) {
            const m = await setupMemberPage(browser, inviteCode, `mesh_m${i}_${ts}`, ts);
            await selectServer(m.page);
            pages.push(m.page);
            members.push(m);
        }

        // All 6 join the voice channel (owner first, then members staggered)
        // Re-navigate owner to the server (setupMemberPage may have navigated away)
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await page.waitForTimeout(1500);
        expect(await isInVoiceChannel(page)).toBeTruthy();

        for (let i = 0; i < members.length; i++) {
            await clickVoiceChannel(pages[i + 1], voiceChannelId);
            await pages[i + 1].waitForTimeout(1500);
            expect(await isInVoiceChannel(pages[i + 1])).toBeTruthy();
        }

        // Wait for all 6 to join and mode to stabilize
        await page.waitForTimeout(3000);

        // Poll until we see all 6 members on the owner's page
        const activeCount = await waitForActiveCount(page, 6, 15000);
        expect(activeCount).toBeGreaterThanOrEqual(6);

        const st = await getVoiceState(page);
        expect(st).toBeTruthy();
        expect(st!.memberCount).toBeGreaterThanOrEqual(6);

        // No auto-relay: the mode stays on mesh at 6 members...
        await page.waitForTimeout(4000);
        let mode = await getRelayMode(page);
        expect(mode).toBe('mesh');

        // ...and deafening / leaving never switches it either.
        await toggleDeafen(pages[5]);
        await page.waitForTimeout(1500);
        mode = await getRelayMode(page);
        expect(mode).toBe('mesh');
        await toggleDeafen(pages[5]);
        await page.waitForTimeout(1500);
        mode = await getRelayMode(page);
        expect(mode).toBe('mesh');
        await leaveVoice(pages[2]);
        await page.waitForTimeout(1500);
        mode = await getRelayMode(page);
        expect(mode).toBe('mesh');

        // Manual relay opt-in still works, and can be switched back.
        await page.evaluate(() => (window as any).VoiceManager.setSelfAudioMode('relay'));
        mode = await waitForMode(page, 'relay', 10000);
        expect(mode).toBe('relay');
        await page.evaluate(() => (window as any).VoiceManager.setSelfAudioMode('mesh'));
        mode = await waitForMode(page, 'mesh', 10000);
        expect(mode).toBe('mesh');

        // Clean up: all leave
        for (let i = pages.length - 1; i >= 0; i--) {
            await leaveVoice(pages[i]).catch(() => {});
        }
    });

    test('video mesh mode toggle: switch relay ↔ mesh', async ({ page, context }) => {
        test.setTimeout(120000);
        const ts = Date.now();
        const owner = await registerUser(page, 'vtoggle_' + ts);

        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, owner.token);

        // Join voice channel
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await page.waitForTimeout(2000);
        expect(await isInVoiceChannel(page)).toBeTruthy();

        // Default: not mesh mode
        expect(await getVideoMeshMode(page)).toBeFalsy();

        // Start camera in relay mode
        await startCamera(page);
        await page.waitForTimeout(1500);

        let st = await getVoiceState(page);
        expect(st!.cameraOn).toBeTruthy();

        // Toggle to mesh mode
        await setVideoMeshMode(page, true);
        await page.waitForTimeout(1500);

        expect(await getVideoMeshMode(page)).toBeTruthy();
        st = await getVoiceState(page);
        expect(st!.cameraOn).toBeTruthy();

        // Switch back to relay
        await setVideoMeshMode(page, false);
        await page.waitForTimeout(1500);

        expect(await getVideoMeshMode(page)).toBeFalsy();
        st = await getVoiceState(page);
        expect(st!.cameraOn).toBeTruthy();

        // Clean up
        await stopCamera(page);
        await leaveVoice(page);
    });

    test('muting or deafening never auto-switches the audio mode', async ({ page, context }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const browser = context.browser()!;
        const pages: any[] = [page];

        // Register owner + 5 members = 6 total
        const owner = await registerUser(page, 'mmute_own_' + ts);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, owner.token);

        for (let i = 0; i < 5; i++) {
            const m = await setupMemberPage(browser, inviteCode, `mmute_m${i}_${ts}`, ts);
            await selectServer(m.page);
            pages.push(m.page);
        }

        // All 6 join voice
        // Re-navigate owner to the server first
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await page.waitForTimeout(1500);
        for (let i = 1; i < pages.length; i++) {
            await clickVoiceChannel(pages[i], voiceChannelId);
            await pages[i].waitForTimeout(1500);
        }
        await page.waitForTimeout(3000);

        // 6 participants, but relay is opt-in only — the mode stays on mesh.
        await waitForActiveCount(page, 6, 15000);
        await page.waitForTimeout(4000);
        let mode = await getRelayMode(page);
        expect(mode).toBe('mesh');

        // Muting and deafening other members must not switch the mode either.
        await toggleMute(pages[1]);
        await page.waitForTimeout(1500);
        mode = await getRelayMode(page);
        expect(mode).toBe('mesh');

        await toggleDeafen(pages[1]);
        await page.waitForTimeout(1500);
        mode = await getRelayMode(page);
        expect(mode).toBe('mesh');

        await toggleDeafen(pages[1]);
        await page.waitForTimeout(1500);
        mode = await getRelayMode(page);
        expect(mode).toBe('mesh');

        // Clean up
        for (let i = pages.length - 1; i >= 0; i--) {
            await leaveVoice(pages[i]).catch(() => {});
        }
    });

    test('joining a 6th member does not auto-enable relay', async ({ page, context }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const browser = context.browser()!;
        const pages: any[] = [page];

        const owner = await registerUser(page, 'bound_own_' + ts);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, owner.token);

        // Register 4 more (5 total for mesh)
        for (let i = 0; i < 4; i++) {
            const m = await setupMemberPage(browser, inviteCode, `bound_m${i}_${ts}`, ts);
            await selectServer(m.page);
            pages.push(m.page);
        }

        // All 5 join voice (owner re-navigates first)
        await page.goto(`${BASE}/index.html`);
        await waitForWs(page);
        await selectServer(page);
        await clickVoiceChannel(page, voiceChannelId);
        await page.waitForTimeout(1500);
        for (let i = 1; i < pages.length; i++) {
            await clickVoiceChannel(pages[i], voiceChannelId);
            await pages[i].waitForTimeout(1500);
        }
        await page.waitForTimeout(3000);

        // 5 participants → mesh, as always.
        await waitForActiveCount(page, 5, 15000);
        const activeCount = await getActiveParticipantCount(page);
        expect(activeCount).toBe(5);
        let mode = await waitForMode(page, 'mesh', 15000);
        expect(mode).toBe('mesh');

        // A 6th user joining must NOT flip the room onto the relay.
        const m6 = await setupMemberPage(browser, inviteCode, `bound_m5_${ts}`, ts);
        await selectServer(m6.page);
        await clickVoiceChannel(m6.page, voiceChannelId);
        await m6.page.waitForTimeout(2000);
        pages.push(m6.page);

        await waitForActiveCount(page, 6, 15000);
        await page.waitForTimeout(4000);
        mode = await getRelayMode(page);
        expect(mode).toBe('mesh');

        // Clean up
        for (let i = pages.length - 1; i >= 0; i--) {
            await leaveVoice(pages[i]).catch(() => {});
        }
    });
});
