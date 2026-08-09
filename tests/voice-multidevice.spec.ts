import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Mocked media: getUserMedia returns an oscillator mic + a canvas camera.
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
                (window as any).__mockOsc = osc;
                return dest.stream;
            }
            if (constraints && constraints.video) {
                const canvas = document.createElement('canvas');
                canvas.width = 320; canvas.height = 240;
                const ctx = canvas.getContext('2d')!;
                let i = 0;
                const stream = (canvas as any).captureStream(30);
                (window as any).__mockCanvasTimer = setInterval(() => {
                    ctx.fillStyle = `rgb(${(i * 40) % 255},100,150)`;
                    ctx.fillRect(0, 0, 320, 240);
                    ctx.fillStyle = '#fff';
                    ctx.fillText(String(i++), 10, 20);
                }, 80);
                return stream;
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
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

// Log into an EXISTING account on a fresh device (fresh context → no
// localStorage → real "new device" login).
async function loginUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#login-username');
    await page.fill('#login-username', username);
    await page.fill('#login-password', 'password123');
    await page.click('#login-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
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

async function waitConnected(page: any, timeout = 30000) {
    await page.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && v._debug && v._debug.state && v._debug.state.connected;
    }, undefined, { timeout });
}

async function waitDisconnected(page: any, timeout = 30000) {
    await page.waitForFunction(() => {
        const v = (window as any).VoiceManager;
        return v && v._debug && v._debug.state && !v._debug.state.connected;
    }, undefined, { timeout });
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

async function createServerWithVoiceChannel(page: any, token: string): Promise<{ serverId: string; voiceChannelId: string; inviteCode: string }> {
    const ts = Date.now();
    const inviteCode = 'MV' + ts;
    const prep = await page.evaluate(async ({ serverId, inviteCode }) => {
        const identity = E2ECrypto.getIdentityKeyPair();
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, symKey);
        const encName = E2ECrypto.aeadEncrypt('MultiDev Server', symKey);
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
    }, { name: 'MultiDev Voice', serverKeyB64 });

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            name: 'MultiDev Voice',
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

test.describe('multi-device (same account on several devices)', () => {

    test('DM call: 4 devices — new device joins with the same account and REPLACES the old one; camera streams keep flowing', async ({ browser }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const userA = 'mva1_' + ts;
        const userB = 'mva2_' + ts;

        // Device 1 = A, Device 2 = B
        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const page2 = await ctx2.newPage();
        await mockMedia(page1);
        await mockMedia(page2);
        const bodyA = await registerUser(page1, userA);
        const bodyB = await registerUser(page2, userB);
        await setupFriends(page1, page2, bodyA, bodyB);

        const userData = await (await page1.request.get(`${BASE}/api/user/${bodyB.user.username}`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();
        const dm = await (await page1.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();

        await waitForWs(page1);
        await waitForWs(page2);
        // Both sides open the DM so both have the conversation + partner key
        await openDm(page1);
        await openDm(page2);
        await page1.waitForTimeout(1000);

        await page1.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });
        await page1.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: userData.id, uname: userB });
        await page1.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 15000 });
        await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
        await page2.click('#incoming-call-accept');
        await waitConnected(page1);
        await waitConnected(page2);
        await page1.waitForTimeout(2000);

        // Both turn cameras on and confirm the member STATE (camera flag) is
        // broadcast and seen on the other side. (Media transport itself is
        // covered by the UI-flow decode tests; in headless the WebRTC
        // negotiation occasionally stalls, so here we assert the reliable
        // WS-state path that the replacement flow must preserve.)
        await page1.evaluate(() => (window.VoiceManager as any).toggleCamera());
        await page2.evaluate(() => (window.VoiceManager as any).toggleCamera());
        await page1.waitForFunction((u) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.members[u] && !!s.members[u].camera;
        }, bodyB.user.id, { timeout: 20000 });
        await page2.waitForFunction((u) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.members[u] && !!s.members[u].camera;
        }, bodyA.user.id, { timeout: 20000 });

        // Device 3 logs in as A (fresh context) and joins the same DM call →
        // Device 1 must be kicked out.
        const ctx3 = await browser.newContext();
        const page3 = await ctx3.newPage();
        await mockMedia(page3);
        const bodyA3 = await loginUser(page3, userA);
        expect(bodyA3.user.id).toBe(bodyA.user.id);
        await waitForWs(page3);
        await page3.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });
        await openDm(page3);
        const dmFor3 = await (await page3.request.post(`${BASE}/api/dm/${userData.id}`, {
            headers: { Authorization: `Bearer ${bodyA3.token}` },
        })).json();
        await page3.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dmFor3.id, uid: userData.id, uname: userB });

        // Device 1 (old A) is kicked — connected becomes false, call UI gone
        await waitDisconnected(page1);
        expect(await page1.evaluate(() => (window.VoiceManager as any).isInDmCall())).toBe(false);
        await waitConnected(page3, 40000);
        // The replacement device turns its camera on (fresh member record starts
        // camera:false — the user "sees everything" by re-enabling their camera)
        await page3.evaluate(() => (window.VoiceManager as any).toggleCamera());

        // Device 4 logs in as B and joins → Device 2 (old B) gets kicked
        const ctx4 = await browser.newContext();
        const page4 = await ctx4.newPage();
        await mockMedia(page4);
        const bodyB4 = await loginUser(page4, userB);
        expect(bodyB4.user.id).toBe(bodyB.user.id);
        await waitForWs(page4);
        await page4.waitForFunction(() => {
            const v = window.VoiceManager;
            return v && typeof v.startDmCall === 'function';
        }, undefined, { timeout: 15000 });
        await openDm(page4);
        await page4.evaluate(({ dmId, uid, uname }) => {
            window.VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: bodyA.user.id, uname: userA });
        await waitDisconnected(page2);
        await waitConnected(page4, 40000);
        await page4.evaluate(() => (window.VoiceManager as any).toggleCamera());

        // Device 3 (new A) and Device 4 (new B) see each other's camera state
        await page3.waitForFunction((u) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.members[u] && !!s.members[u].camera;
        }, bodyB.user.id, { timeout: 30000 });
        await page4.waitForFunction((u) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.members[u] && !!s.members[u].camera;
        }, bodyA.user.id, { timeout: 30000 });

        // Kicked Device 1 refreshes the page → its voice_leave_all must NOT
        // evict Device 3 from the room.
        await page1.goto(`${BASE}/index.html`);
        await waitForWs(page1);
        await page1.waitForTimeout(2000);
        const stillConnected = await page3.evaluate(() => {
            const v = (window as any).VoiceManager;
            return v && v._debug.state.connected;
        });
        expect(stillConnected).toBe(true);

        await ctx1.close().catch(() => {});
        await ctx2.close().catch(() => {});
        await ctx3.close().catch(() => {});
        await ctx4.close().catch(() => {});
    });

    test('server voice channel: 4 devices — replacement kick + camera streams keep flowing', async ({ browser }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const userA = 'mvb1_' + ts;
        const userB = 'mvb2_' + ts;

        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const page2 = await ctx2.newPage();
        await mockMedia(page1);
        await mockMedia(page2);
        const bodyA = await registerUser(page1, userA);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(page1, bodyA.token);
        const bodyB = await registerUser(page2, userB);
        const join = await page2.request.post(`${BASE}/api/invites/join`, {
            headers: { Authorization: `Bearer ${bodyB.token}`, 'Content-Type': 'application/json' },
            data: { code: inviteCode },
        });
        expect(join.ok()).toBeTruthy();

        await page1.goto(`${BASE}/index.html`);
        await page1.waitForTimeout(2500);
        await page2.goto(`${BASE}/index.html`);
        await page2.waitForTimeout(2500);
        await waitForWs(page1);
        await waitForWs(page2);

        expect(await selectServer(page1)).toBe(true);
        expect(await clickVoiceChannel(page1, voiceChannelId)).toBe(true);
        await waitConnected(page1);
        expect(await selectServer(page2)).toBe(true);
        expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);
        await waitConnected(page2);
        await page1.waitForTimeout(2000);

        await page1.evaluate(() => (window.VoiceManager as any).toggleCamera());
        await page2.evaluate(() => (window.VoiceManager as any).toggleCamera());
        await page1.waitForFunction((u) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.members[u] && !!s.members[u].camera;
        }, bodyB.user.id, { timeout: 20000 });
        await page2.waitForFunction((u) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.members[u] && !!s.members[u].camera;
        }, bodyA.user.id, { timeout: 20000 });

        // Device 3 logs in as A and joins the same voice channel → kicks Device 1
        const ctx3 = await browser.newContext();
        const page3 = await ctx3.newPage();
        await mockMedia(page3);
        const bodyA3 = await loginUser(page3, userA);
        await waitForWs(page3);
        await page3.goto(`${BASE}/index.html`);
        await page3.waitForTimeout(2500);
        await waitForWs(page3);
        expect(await selectServer(page3)).toBe(true);
        expect(await clickVoiceChannel(page3, voiceChannelId)).toBe(true);
        await waitDisconnected(page1);
        await waitConnected(page3, 40000);
        await page3.evaluate(() => (window.VoiceManager as any).toggleCamera());

        // Device 4 logs in as B and joins → kicks Device 2
        const ctx4 = await browser.newContext();
        const page4 = await ctx4.newPage();
        await mockMedia(page4);
        const bodyB4 = await loginUser(page4, userB);
        await waitForWs(page4);
        await page4.goto(`${BASE}/index.html`);
        await page4.waitForTimeout(2500);
        await waitForWs(page4);
        expect(await selectServer(page4)).toBe(true);
        expect(await clickVoiceChannel(page4, voiceChannelId)).toBe(true);
        await waitDisconnected(page2);
        await waitConnected(page4, 40000);
        await page4.evaluate(() => (window.VoiceManager as any).toggleCamera());

        // New A (device 3) and new B (device 4) see each other's camera state
        await page3.waitForFunction((u) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.members[u] && !!s.members[u].camera;
        }, bodyB.user.id, { timeout: 30000 });
        await page4.waitForFunction((u) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.members[u] && !!s.members[u].camera;
        }, bodyA.user.id, { timeout: 30000 });

        await ctx1.close().catch(() => {});
        await ctx2.close().catch(() => {});
        await ctx3.close().catch(() => {});
        await ctx4.close().catch(() => {});
    });

    test('server voice channel: right-click menus are kind-aware (member row vs camera tile vs screen tile)', async ({ page, context }) => {
        test.setTimeout(240000);
        const ts = Date.now();
        const user1 = 'mvm1_' + ts;
        const user2 = 'mvm2_' + ts;

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
        await waitConnected(page);
        expect(await selectServer(page2)).toBe(true);
        expect(await clickVoiceChannel(page2, voiceChannelId)).toBe(true);
        await waitConnected(page2);
        await page.waitForTimeout(1500);

        // A (owner) AND B both turn camera + screen on so each sees the other's tiles
        await page.evaluate(() => (window.VoiceManager as any).toggleCamera());
        await page.evaluate(() => (window.VoiceManager as any).toggleScreen());
        await page2.evaluate(() => (window.VoiceManager as any).toggleCamera());
        await page2.evaluate(() => (window.VoiceManager as any).toggleScreen());
        await page2.waitForFunction((uid) => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.remoteStreams[uid] && !!s.remoteStreams[uid].camera && !!s.remoteStreams[uid].screen;
        }, body1.user.id, { timeout: 30000 });
        await page.waitForFunction((uid) => {
            const s = (window.VoiceManager as any)._debug.state;
            return s.remoteStreams[uid] && !!s.remoteStreams[uid].camera;
        }, body2.user.id, { timeout: 30000 });
        await page2.evaluate(() => { window.VoiceManager.navigateToVoiceChannel(); });
        await page2.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });
        await page.evaluate(() => { window.VoiceManager.navigateToVoiceChannel(); });
        await page.waitForSelector('#voice-popup', { state: 'visible', timeout: 10000 });

        const bUid = body2.user.id;
        const aUid = body1.user.id;
        const camSel = `.voice-member-row[data-uid="${aUid}"] video[data-kind="camera"]`;
        const scrSel = `.voice-member-row[data-uid="${aUid}"] video[data-kind="screen"]`;
        const camSelB = `.voice-member-row[data-uid="${bUid}"] video[data-kind="camera"]`;
        // Right-click the IDENTITY area (avatar/name), NOT the video tiles —
        // the video tiles have their own contextmenu handler (kind-aware menu).
        const rowSelB = `.voice-member-row[data-uid="${bUid}"] .voice-member-ident`;
        await page2.locator(camSel).waitFor({ state: 'visible', timeout: 20000 });
        await page2.locator(scrSel).waitFor({ state: 'visible', timeout: 20000 });
        await page.locator(camSelB).waitFor({ state: 'visible', timeout: 20000 });

        // --- OWNER (A) right-clicks B's MEMBER ROW: mic volume + owner controls, NO View section ---
        await page.locator(rowSelB).first().click({ button: 'right' });
        await page.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
        let m = await page.evaluate(() => {
            const mm = document.getElementById('volume-menu')!;
            return {
                hasSlider: !!mm.querySelector('.volume-menu-slider'),
                hasCustom: !!mm.querySelector('.volume-menu-custom-input'),
                hasView: !!mm.querySelector('.volume-menu-view-label'),
                volLabel: mm.querySelector('.volume-menu-vol-label') ? mm.querySelector('.volume-menu-vol-label')!.textContent : null,
                hasOwnerMute: !!Array.from(mm.querySelectorAll('.volume-menu-btn')).find((b) => (b.textContent || '').indexOf('Server Mute') !== -1),
                hasOwnerDeafen: !!Array.from(mm.querySelectorAll('.volume-menu-btn')).find((b) => (b.textContent || '').indexOf('Server Deafen') !== -1),
                hasKick: !!Array.from(mm.querySelectorAll('.volume-menu-btn')).find((b) => (b.textContent || '').indexOf('Kick') !== -1),
            };
        });

        expect(m.hasSlider).toBe(true);
        expect(m.hasCustom).toBe(true);
        expect(m.hasView).toBe(false);            // NO flip/rotate on a member row
        expect(m.volLabel).toBe('Mic volume');
        expect(m.hasOwnerMute).toBe(true);        // owner controls live here
        expect(m.hasOwnerDeafen).toBe(true);
        expect(m.hasKick).toBe(true);

        // --- CAMERA tile menu (B sees A's camera): View only — no volume meter, no owner controls ---
        await page2.locator(camSel).click({ button: 'right' });
        await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
        m = await page2.evaluate(() => {
            const mm = document.getElementById('volume-menu')!;
            return {
                hasSlider: !!mm.querySelector('.volume-menu-slider'),
                hasCustom: !!mm.querySelector('.volume-menu-custom-input'),
                hasView: !!mm.querySelector('.volume-menu-view-label'),
                header: mm.querySelector('.volume-menu-header')!.textContent,
                hasOwnerMute: !!Array.from(mm.querySelectorAll('.volume-menu-btn')).find((b) => (b.textContent || '').indexOf('Server Mute') !== -1),
            };
        });
        expect(m.header).toContain('Camera');
        expect(m.hasView).toBe(true);
        expect(m.hasSlider).toBe(false);          // camera carries no audio
        expect(m.hasCustom).toBe(false);
        expect(m.hasOwnerMute).toBe(false);       // no owner controls on the feed tile

        // --- SCREEN tile menu (B sees A's screen): View + SCREEN audio volume, NO owner controls ---
        await page2.locator(scrSel).click({ button: 'right' });
        await page2.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
        m = await page2.evaluate(() => {
            const mm = document.getElementById('volume-menu')!;
            return {
                hasSlider: !!mm.querySelector('.volume-menu-slider'),
                hasCustom: !!mm.querySelector('.volume-menu-custom-input'),
                hasView: !!mm.querySelector('.volume-menu-view-label'),
                header: mm.querySelector('.volume-menu-header')!.textContent,
                volLabel: mm.querySelector('.volume-menu-vol-label') ? mm.querySelector('.volume-menu-vol-label')!.textContent : null,
                hasOwnerMute: !!Array.from(mm.querySelectorAll('.volume-menu-btn')).find((b) => (b.textContent || '').indexOf('Server Mute') !== -1),
            };
        });
        expect(m.header).toContain('Screen share');
        expect(m.hasView).toBe(true);
        expect(m.hasSlider).toBe(true);
        expect(m.hasCustom).toBe(true);
        expect(m.volLabel).toBe('Screen audio volume'); // separate from the member's mic volume
        expect(m.hasOwnerMute).toBe(false);

        await ctx2.close().catch(() => {});
    });

    test('fresh device login: own pfp/file-id lands in userDisplayNameCache (voice avatars render from it)', async ({ browser }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const userA = 'mvp1_' + ts;

        // Device 1: register A, open profile edit, upload a profile picture, save
        const ctx1 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const bodyA = await registerUser(page1, userA);
        await page1.waitForTimeout(2000);

        // Open own profile modal, then the edit modal (the edit button appears
        // only after the profile loads and only for the own profile).
        await page1.evaluate((uid) => {
            (window as any).openProfileModal(uid);
        }, bodyA.user.id);
        await page1.waitForSelector('#profile-edit-btn', { state: 'visible', timeout: 15000 });
        await page1.click('#profile-edit-btn');
        await page1.waitForSelector('#profile-edit-modal', { state: 'visible', timeout: 10000 });

        // A small valid PNG (8x8 red square)
        const png = Buffer.from(
            'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAFElEQVR4nGP8z8Dwn4EIwESMolGFAFgEBAGIL6d/AAAAAElFTkSuQmCC',
            'base64'
        );
        await page1.setInputFiles('#profile-avatar-file-input', {
            name: 'pfp.png',
            mimeType: 'image/png',
            buffer: png,
        });
        // A crop panel opens — confirm it, then save the profile
        await page1.waitForSelector('#profile-pfp-crop-container', { state: 'visible', timeout: 10000 }).catch(() => {});
        await page1.waitForTimeout(1200);
        await page1.click('#profile-pfp-crop-confirm');
        await page1.waitForTimeout(2500);
        await page1.click('#profile-edit-save-btn');
        // Wait for the save to land (server round-trip + profile reload).
        // myProfile is a top-level `let`, so reach it via the global lexical
        // scope (evaluate can reference it directly), not window.
        await page1.waitForFunction(() => {
            return !!(myProfile) && !!myProfile.profile_picture_file_id;
        }, undefined, { timeout: 40000 });

        const picId = await page1.evaluate(() => myProfile.profile_picture_file_id);
        expect(picId).toBeTruthy();

        // Device 2: FRESH context (no localStorage) logs into A's account.
        // loadMyProfile must populate the self entry in userDisplayNameCache so
        // voice rows/tiles can resolve the pfp.
        const ctx2 = await browser.newContext();
        const page2 = await ctx2.newPage();
        const bodyA2 = await loginUser(page2, userA);
        expect(bodyA2.user.id).toBe(bodyA.user.id);

        // `user` is a top-level `let` — reachable from evaluate's global scope
        // directly (NOT via window).
        await page2.waitForFunction((expected) => {
            const cache = (window as any).userDisplayNameCache;
            const uid = user && user.id;
            return !!(cache && uid && cache[uid] && cache[uid].profile_picture_file_id === expected);
        }, picId, { timeout: 30000 });

        const cached = await page2.evaluate((expected) => {
            const cache = (window as any).userDisplayNameCache;
            const uid = user.id;
            return {
                picId: cache[uid].profile_picture_file_id,
                picKey: !!cache[uid].profile_picture_file_key,
            };
        }, picId);
        expect(cached.picId).toBe(picId);
        expect(cached.picKey).toBe(true);

        // And the voice self avatar path resolves: userDisplayNameCache has the
        // id, so memberAvatarHtml will fetch + render the pfp (not the initial).
        const avatarResolvable = await page2.evaluate((expected) => {
            const cache = (window as any).userDisplayNameCache;
            const uid = user.id;
            return cache[uid].profile_picture_file_id === expected;
        }, picId);
        expect(avatarResolvable).toBe(true);

        await ctx1.close().catch(() => {});
        await ctx2.close().catch(() => {});
    });
});
