import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Mocked media: oscillator mic + canvas camera; getDisplayMedia returns a
// stream with BOTH video and audio (screen-share audio), mirroring real usage.
async function mockMedia(page: any) {
    await page.addInitScript(() => {
        const origGUM = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
        navigator.mediaDevices.getUserMedia = async (constraints: any) => {
            if (constraints && constraints.audio) {
                const ac = new (window as any).AudioContext();
                const osc = ac.createOscillator();
                osc.frequency.value = 300;
                const dest = ac.createMediaStreamDestination();
                osc.connect(dest);
                osc.start();
                return dest.stream;
            }
            if (constraints && constraints.video) {
                const canvas = document.createElement('canvas');
                canvas.width = 320; canvas.height = 240;
                const ctx = canvas.getContext('2d')!;
                let i = 0;
                setInterval(() => {
                    ctx.fillStyle = `rgb(${(i * 40) % 255},100,150)`;
                    ctx.fillRect(0, 0, 320, 240);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(i++), 10, 20);
                }, 80);
                return (canvas as any).captureStream(10);
            }
            return origGUM(constraints);
        };
        (navigator.mediaDevices as any).getDisplayMedia = async (constraints: any) => {
            const vStream = await (navigator.mediaDevices as any).getUserMedia({ video: true });
            const aStream = await (navigator.mediaDevices as any).getUserMedia({ audio: true });
            const out = new MediaStream();
            vStream.getTracks().forEach((t: any) => out.addTrack(t));
            aStream.getTracks().forEach((t: any) => out.addTrack(t));
            return out;
        };
    });
}

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

async function waitForWs(page: any) {
    return await page.evaluate(() => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) resolve(true);
                else if (tries >= 60) resolve(false);
                else setTimeout(check, 200);
            };
            setTimeout(check, 500);
        });
    });
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
    return { userData, dm };
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

// Measure a tile and detect horizontal overlap between the camera and screen
// tiles as they appear on B's screen.
async function measureTiles(page2: any) {
    return await page2.evaluate(() => {
        const r = (el: Element | null) => {
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return {
                w: Math.round(b.width), h: Math.round(b.height),
                left: Math.round(b.left), right: Math.round(b.right),
                top: Math.round(b.top), bottom: Math.round(b.bottom),
                parentSlot: el.parentElement ? el.parentElement.className : '',
            };
        };
        const cam = document.querySelector('.dm-call-tile video[data-kind="camera"]');
        const scr = document.querySelector('.dm-call-tile video[data-kind="screen"]');
        const camRect = r(cam);
        const scrRect = r(scr);
        let overlap = null;
        if (camRect && scrRect) {
            const ox = Math.max(0, Math.min(camRect.right, scrRect.right) - Math.max(camRect.left, scrRect.left));
            const oy = Math.max(0, Math.min(camRect.bottom, scrRect.bottom) - Math.max(camRect.top, scrRect.top));
            overlap = Math.round(ox * oy);
        }
        return { cam: camRect, scr: scrRect, overlap };
    });
}

test('DM call: rotated camera/screen tiles never overlap the sibling tile', async ({ page, context }) => {
    test.setTimeout(240000);
    const ts = Date.now();
    const user1 = 'vrot1_' + ts;
    const user2 = 'vrot2_' + ts;

    const ctx2 = await context.browser()!.newContext();
    const page2 = await ctx2.newPage();
    await mockMedia(page);
    await mockMedia(page2);
    const body2 = await registerUser(page2, user2);
    const body1 = await registerUser(page, user1);

    await setupFriends(page, page2, body1, body2);
    const { userData, dm } = await createDm(page, page2, body1, body2);

    await waitForWs(page);
    await waitForWs(page2);
    await openDm(page);

    // A calls B, B accepts (REAL button)
    await page.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && typeof v.startDmCall === 'function';
    }, undefined, { timeout: 15000 });
    await page.evaluate(({ dmId, uid, uname }) => {
        window.VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userData.id, uname: user2 });
    await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
    await page2.waitForFunction(() => {
        const v = window.VoiceManager as any;
        return v && v._debug && v._debug.state && v._debug.state.incomingCall !== null;
    }, undefined, { timeout: 20000 });
    await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 10000 });
    await page2.click('#incoming-call-accept');
    await page.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout: 20000 });
    await page2.waitForFunction(() => {
        const v = window.VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout: 20000 });
    const aUid = body1.user.id;
    await page2.waitForFunction((uid) => {
        const s = (window.VoiceManager as any)._debug.state;
        return !!s.peers[uid];
    }, aUid, { timeout: 15000 });

    // A turns camera + screen share on → B sees BOTH tiles side by side
    await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.cameraOn;
    }, undefined, { timeout: 15000 });
    await page.evaluate(() => (window.VoiceManager as any).toggleScreen());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.screenOn;
    }, undefined, { timeout: 15000 });

    const camTile = page2.locator('.dm-call-tile video[data-kind="camera"]');
    const scrTile = page2.locator('.dm-call-tile video[data-kind="screen"]');
    await camTile.waitFor({ state: 'visible', timeout: 20000 });
    await scrTile.waitFor({ state: 'visible', timeout: 20000 });
    await page2.waitForTimeout(800); // let layout settle

    // Baseline: no overlap BEFORE any rotation
    let m = await measureTiles(page2);
    console.log('BASELINE', JSON.stringify(m));
    expect(m.cam && m.scr).toBeTruthy();
    expect(m.overlap!).toBe(0);

    // ---- Rotate the CAMERA tile 90° via the real right-click menu ----
    await camTile.click({ button: 'right' });
    await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 5000 });
    await page2.click('.volume-menu-view-btn[title="Rotate 90° left"]');
    await page2.waitForTimeout(500);

    m = await measureTiles(page2);
    console.log('CAM-ROTATED', JSON.stringify(m));
    // 1) The rotated camera is PORTRAIT and its visual matches its slot
    expect(m.cam!.h).toBeGreaterThan(m.cam!.w);
    expect(m.cam!.parentSlot).toContain('voice-tile-slot');
    // 2) NO overlap with the screen tile
    expect(m.overlap!).toBe(0);
    // 3) The rotated camera's right edge stays clear of the screen tile
    expect(m.cam!.right).toBeLessThanOrEqual(m.scr!.left);

    // ---- Rotate the SCREEN tile 90° as well → still no overlap ----
    await page2.click('body');
    await page2.waitForSelector('#volume-menu', { state: 'hidden', timeout: 5000 }).catch(() => {});
    await scrTile.click({ button: 'right' });
    await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 5000 });
    await page2.click('.volume-menu-view-btn[title="Rotate 90° left"]');
    await page2.waitForTimeout(500);

    m = await measureTiles(page2);
    console.log('BOTH-ROTATED', JSON.stringify(m));
    expect(m.cam!.parentSlot).toContain('voice-tile-slot');
    expect(m.scr!.parentSlot).toContain('voice-tile-slot');
    expect(m.overlap!).toBe(0);

    // ---- Reset the camera tile → slot removed, back in flow, still no overlap ----
    await camTile.click({ button: 'right' });
    await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 5000 });
    await page2.click('.volume-menu-view-btn[title="Reset view (no mirror, no rotation)"]');
    await page2.waitForTimeout(500);

    const camBack = await page2.evaluate(() => {
        const cam = document.querySelector('.dm-call-tile video[data-kind="camera"]');
        return cam ? { slot: cam.parentElement ? cam.parentElement.className : '', w: Math.round(cam.getBoundingClientRect().width), h: Math.round(cam.getBoundingClientRect().height) } : null;
    });
    console.log('CAM-RESET', JSON.stringify(camBack));
    expect(camBack!.slot).not.toContain('voice-tile-slot');
    expect(camBack!.w).toBeGreaterThan(camBack!.h); // landscape again
    m = await measureTiles(page2);
    expect(m.overlap!).toBe(0);

    // ---- Mirror + rotate combo: mirror is horizontal regardless of rotation ----
    await camTile.click({ button: 'right' });
    await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 5000 });
    await page2.click('.volume-menu-view-btn[title="Rotate 90° left"]');
    await page2.waitForTimeout(300);
    await camTile.click({ button: 'right' });
    await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 5000 });
    await page2.click('.volume-menu-view-btn[title="Mirror horizontally (always horizontal, independent of rotation)"]');
    await page2.waitForTimeout(500);

    const combo = await page2.evaluate(() => {
        const cam = document.querySelector('.dm-call-tile video[data-kind="camera"]') as HTMLElement;
        return cam ? { transform: cam.style.transform, slot: cam.parentElement ? cam.parentElement.className : '' } : null;
    });
    console.log('MIRROR+ROTATE', JSON.stringify(combo));
    expect(combo!.transform).toContain('scaleX(-1)');
    expect(combo!.transform).toMatch(/rotate\((90|270)deg\)/);
    expect(combo!.slot).toContain('voice-tile-slot');
    m = await measureTiles(page2);
    expect(m.overlap!).toBe(0);

    // Rotate to 180°: unwraps (not sideways), still no overlap
    await camTile.click({ button: 'right' });
    await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 5000 });
    await page2.click('.volume-menu-view-btn[title="Rotate 90° left"]');
    await page2.waitForTimeout(500);
    const at180 = await page2.evaluate(() => {
        const cam = document.querySelector('.dm-call-tile video[data-kind="camera"]') as HTMLElement;
        return cam ? { slot: cam.parentElement ? cam.parentElement.className : '', transform: cam.style.transform } : null;
    });
    console.log('AT-180', JSON.stringify(at180));
    expect(at180!.slot).not.toContain('voice-tile-slot');
    expect(at180!.transform).toContain('rotate(180deg)');
    m = await measureTiles(page2);
    expect(m.overlap!).toBe(0);
});

async function createServerWithVoiceChannel(page: any, token: string): Promise<{ serverId: string; voiceChannelId: string; inviteCode: string }> {
    const ts = Date.now();
    const inviteCode = 'ROT' + ts;
    const prep = await page.evaluate(async ({ serverId, inviteCode }) => {
        const identity = E2ECrypto.getIdentityKeyPair();
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, symKey);
        const encName = E2ECrypto.aeadEncrypt('Rot Server', symKey);
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
    }, { name: 'Rot Voice', serverKeyB64 });

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            name: 'Rot Voice',
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

test('server voice channel: rotated member-row tiles never overlap the sibling tile', async ({ page, context }) => {
    test.setTimeout(240000);
    const ts = Date.now();
    const user1 = 'vrots_' + ts;
    const user2 = 'vrotm_' + ts;

    const ctx2 = await context.browser()!.newContext();
    const page2 = await ctx2.newPage();
    await mockMedia(page);
    await mockMedia(page2);
    const body1 = await registerUser(page, user1);
    const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page, body1.token);
    const body2 = await registerUser(page2, user2);

    const join = await page2.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${body2.token}`, 'Content-Type': 'application/json' },
        data: { code: inviteCode },
    });
    expect(join.ok()).toBeTruthy();

    await page.goto(`${BASE}/index.html`);
    await page.waitForTimeout(2500);
    await page2.goto(`${BASE}/index.html`);
    await page2.waitForTimeout(2500);
    await waitForWs(page);
    await waitForWs(page2);

    expect(await selectServer(page)).toBe(true);
    expect(await clickVoiceChannel(page, voiceChannelId)).toBe(true);
    await page.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && v.getState && v.getState().connected;
    }, undefined, { timeout: 20000 });
    expect(await selectServer(page2)).toBe(true);
    expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);
    await page2.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && v.getState && v.getState().connected;
    }, undefined, { timeout: 20000 });
    const aUid = body1.user.id;

    // A: camera + screen on
    await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.cameraOn;
    }, undefined, { timeout: 15000 });
    await page.evaluate(() => (window.VoiceManager as any).toggleScreen());
    await page.waitForFunction(() => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.screenOn;
    }, undefined, { timeout: 15000 });
    // B receives both feeds
    await page2.waitForFunction((uid) => {
        const s = (window.VoiceManager as any)._debug.state;
        return s.remoteStreams[uid] && s.remoteStreams[uid].camera && s.remoteStreams[uid].screen;
    }, aUid, { timeout: 25000 });

    // B opens the voice channel view (member rows with tiles)
    await page2.evaluate(() => { (window as any).VoiceManager.navigateToVoiceChannel(); });
    await page2.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });

    const camSel = `.voice-member-row[data-uid="${aUid}"] video[data-kind="camera"]`;
    const scrSel = `.voice-member-row[data-uid="${aUid}"] video[data-kind="screen"]`;
    await page2.locator(camSel).waitFor({ state: 'visible', timeout: 15000 });
    await page2.locator(scrSel).waitFor({ state: 'visible', timeout: 15000 });
    await page2.waitForTimeout(600);

    const mRow = async () => await page2.evaluate(({ c, s }) => {
        const r = (el: Element | null) => {
            if (!el) return null;
            const b = el.getBoundingClientRect();
            return {
                w: Math.round(b.width), h: Math.round(b.height),
                left: Math.round(b.left), right: Math.round(b.right),
                top: Math.round(b.top), bottom: Math.round(b.bottom),
                parentSlot: el.parentElement ? el.parentElement.className : '',
            };
        };
        const cam = document.querySelector(c);
        const scr = document.querySelector(s);
        const cr = r(cam), sr = r(scr);
        let overlap = null;
        if (cr && sr) {
            const ox = Math.max(0, Math.min(cr.right, sr.right) - Math.max(cr.left, sr.left));
            const oy = Math.max(0, Math.min(cr.bottom, sr.bottom) - Math.max(cr.top, sr.top));
            overlap = Math.round(ox * oy);
        }
        return { cam: cr, scr: sr, overlap };
    }, { c: camSel, s: scrSel });

    let mm = await mRow();
    console.log('SRV BASELINE', JSON.stringify(mm));
    expect(mm.cam && mm.scr).toBeTruthy();
    expect(mm.overlap!).toBe(0);

    // Rotate A's CAMERA tile 90° in the row → portrait slot, no overlap
    await page2.locator(camSel).click({ button: 'right' });
    await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
    await page2.click('.volume-menu-view-btn[title="Rotate 90° left"]');
    await page2.waitForTimeout(500);
    mm = await mRow();
    console.log('SRV CAM-ROTATED', JSON.stringify(mm));
    expect(mm.cam!.h).toBeGreaterThan(mm.cam!.w);
    expect(mm.cam!.parentSlot).toContain('voice-tile-slot');
    expect(mm.overlap!).toBe(0);
    expect(mm.cam!.right).toBeLessThanOrEqual(mm.scr!.left);

    // Rotate the SCREEN tile too → still no overlap
    await page2.click('body'); // dismiss the camera menu first
    await page2.waitForSelector('#volume-menu', { state: 'hidden', timeout: 5000 }).catch(() => {});
    await page2.locator(scrSel).click({ button: 'right' });
    await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
    await page2.click('.volume-menu-view-btn[title="Rotate 90° left"]');
    await page2.waitForTimeout(500);
    mm = await mRow();
    console.log('SRV BOTH-ROTATED', JSON.stringify(mm));
    expect(mm.scr!.parentSlot).toContain('voice-tile-slot');
    expect(mm.overlap!).toBe(0);

    // Reset both → back to normal flow, no leftover slots
    await page2.click('body');
    await page2.waitForSelector('#volume-menu', { state: 'hidden', timeout: 5000 }).catch(() => {});
    await page2.locator(camSel).click({ button: 'right' });
    await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
    await page2.click('.volume-menu-view-btn[title="Reset view (no mirror, no rotation)"]');
    await page2.waitForTimeout(300);
    await page2.click('body');
    await page2.waitForSelector('#volume-menu', { state: 'hidden', timeout: 5000 }).catch(() => {});
    await page2.locator(scrSel).click({ button: 'right' });
    await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
    await page2.click('.volume-menu-view-btn[title="Reset view (no mirror, no rotation)"]');
    await page2.waitForTimeout(400);
    const slotsLeft = await page2.evaluate(() => document.querySelectorAll('.voice-tile-slot').length);
    expect(slotsLeft).toBe(0);
    mm = await mRow();
    expect(mm.overlap!).toBe(0);
});
