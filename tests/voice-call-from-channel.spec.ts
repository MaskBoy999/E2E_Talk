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
    const inviteCode = 'VCF' + ts;
    const prep = await page.evaluate(async ({ serverId, inviteCode }) => {
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, symKey);
        const encName = E2ECrypto.aeadEncrypt('CallServer', symKey);
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
    }, { name: 'Call Voice', serverKeyB64 });

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            name: 'Call Voice',
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

test.describe('calls from voice channels + muted-DM call blocking', () => {

    test('call a member from a server voice channel: callee accepts → both leave the voice channel and connect in a DM call', async ({ browser }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const userA = 'vcf1_' + ts;
        const userB = 'vcf2_' + ts;

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

        // A and B must be friends for a DM call between them
        await setupFriends(page1, page2, bodyA, bodyB);

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

        // B's channel-list chip also carries a call button (second render path)
        await page1.waitForSelector(`.channel-item[data-id="${voiceChannelId}"] .voice-chip-row[data-uid="${bodyB.user.id}"] .voice-chip-call`, { timeout: 10000 });

        // Open the voice channel view — B's row has a call button
        await page1.evaluate(() => (window as any).VoiceManager.toggleServerPopup());
        await page1.waitForSelector(`.voice-member-call[data-uid="${bodyB.user.id}"]`, { timeout: 10000 });

        // A clicks the call button on B's row → starts a DM call (A leaves the voice channel)
        await page1.click(`.voice-member-call[data-uid="${bodyB.user.id}"]`);

        // B gets the incoming call bar and accepts → B leaves the voice channel
        await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
        await page2.click('#incoming-call-accept');

        await waitConnected(page1);
        await waitConnected(page2);

        // Both are in the DM call with each other, NOT the server voice channel
        const s1 = await page1.evaluate(() => (window as any).VoiceManager._debug.state);
        expect(s1.roomType).toBe('dm');
        expect(s1.dmCallPartner && s1.dmCallPartner.id).toBe(bodyB.user.id);
        const s2 = await page2.evaluate(() => (window as any).VoiceManager._debug.state);
        expect(s2.roomType).toBe('dm');
        expect(s2.dmCallPartner && s2.dmCallPartner.id).toBe(bodyA.user.id);

        // Both see each other in the DM room's member list
        await page1.waitForFunction((u) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.members[u] && !!s.members[u].user_id;
        }, bodyB.user.id, { timeout: 20000 });
        await page2.waitForFunction((u) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.members[u] && !!s.members[u].user_id;
        }, bodyA.user.id, { timeout: 20000 });

        await ctx1.close().catch(() => {});
        await ctx2.close().catch(() => {});
    });

    test('call someone who is already in a DM call: accepting leaves the old call and joins the new one', async ({ browser }) => {
        test.setTimeout(300000);
        const ts = Date.now();
        const userA = 'vcf3_' + ts;
        const userB = 'vcf4_' + ts;
        const userC = 'vcf5_' + ts;

        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const ctx3 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const page2 = await ctx2.newPage();
        const page3 = await ctx3.newPage();
        await mockMedia(page1);
        await mockMedia(page2);
        await mockMedia(page3);
        const bodyA = await registerUser(page1, userA);
        const bodyB = await registerUser(page2, userB);
        const bodyC = await registerUser(page3, userC);
        await setupFriends(page1, page2, bodyA, bodyB);
        await setupFriends(page1, page3, bodyA, bodyC);

        const dmAB = await (await page1.request.post(`${BASE}/api/dm/${bodyB.user.id}`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();
        const dmAC = await (await page1.request.post(`${BASE}/api/dm/${bodyC.user.id}`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();

        await waitForWs(page1);
        await waitForWs(page2);
        await waitForWs(page3);
        await openDm(page1);
        await openDm(page2);
        await page1.waitForTimeout(1000);

        // A calls B — they connect in a DM call
        await page1.evaluate(({ dmId, uid, uname }) => {
            (window as any).VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dmAB.id, uid: bodyB.user.id, uname: userB });
        await page2.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
        await page2.click('#incoming-call-accept');
        await waitConnected(page1);
        await waitConnected(page2);
        await page1.waitForTimeout(1500);

        // C calls A even though A is already in a DM call — A still sees the ring
        await page3.evaluate(({ dmId, uid, uname }) => {
            (window as any).VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dmAC.id, uid: bodyA.user.id, uname: userA });
        await page1.waitForSelector('#incoming-call-accept', { state: 'visible', timeout: 20000 });
        // A accepts → leaves the call with B, joins C
        await page1.click('#incoming-call-accept');

        await page3.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.connected && s.roomType === 'dm';
        }, undefined, { timeout: 30000 });
        await page1.waitForFunction((u) => {
            const s = (window as any).VoiceManager._debug.state;
            return s.connected && s.roomType === 'dm' && s.dmCallPartner && s.dmCallPartner.id === u;
        }, bodyC.user.id, { timeout: 30000 });

        // B is left in the waiting state — the call wasn't closed, A just moved out
        await page2.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.callWaiting === true;
        }, undefined, { timeout: 20000 });

        await ctx1.close().catch(() => {});
        await ctx2.close().catch(() => {});
        await ctx3.close().catch(() => {});
    });

    test('muted DM: the callee never rings and the caller enters the waiting state', async ({ browser }) => {
        test.setTimeout(180000);
        const ts = Date.now();
        const userA = 'vcf6_' + ts;
        const userB = 'vcf7_' + ts;

        const ctx1 = await browser.newContext();
        const ctx2 = await browser.newContext();
        const page1 = await ctx1.newPage();
        const page2 = await ctx2.newPage();
        await mockMedia(page1);
        await mockMedia(page2);
        const bodyA = await registerUser(page1, userA);
        const bodyB = await registerUser(page2, userB);
        await setupFriends(page1, page2, bodyA, bodyB);

        const dm = await (await page1.request.post(`${BASE}/api/dm/${bodyB.user.id}`, {
            headers: { Authorization: `Bearer ${bodyA.token}` },
        })).json();

        await waitForWs(page1);
        await waitForWs(page2);
        await openDm(page1);
        await openDm(page2);
        await page1.waitForTimeout(1000);

        // B mutes the DM conversation with A
        await page2.evaluate((dmId) => {
            (window as any).toggleMuteDm(dmId);
        }, dm.id);

        // A calls B
        await page1.evaluate(({ dmId, uid, uname }) => {
            (window as any).VoiceManager.startDmCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: bodyB.user.id, uname: userB });

        // B NEVER gets the incoming call bar or any "is calling you" state
        // (muted → no ring, no alert) — but the call is NOT blocked: A waits
        // in the room and B still gets the joinable waiting marker.
        await page2.waitForTimeout(4000);
        const barVisible = await page2.evaluate(() => {
            const b = document.getElementById('incoming-call-bar');
            return b ? b.style.display !== 'none' : false;
        });
        expect(barVisible).toBe(false);
        const incoming = await page2.evaluate(() => (window as any).VoiceManager._debug.state.incomingCall);
        expect(incoming).toBeNull();

        // The caller (A) is auto-declined → enters the waiting state
        await page1.waitForFunction(() => {
            const s = (window as any).VoiceManager._debug.state;
            return s.callWaiting === true;
        }, undefined, { timeout: 20000 });

        // B sees the joinable waiting marker (caller is waiting in the room)
        await page2.waitForFunction((dmId) => {
            const wc = (window as any).VoiceManager.getWaitingCall(dmId);
            return wc && !!wc.waitingUserId;
        }, dm.id, { timeout: 15000 });

        // The call is NOT blocked: B can join the waiting call manually and
        // both connect (mute only suppressed the alert, not the call).
        await page2.evaluate(({ dmId, uid, uname }) => {
            (window as any).VoiceManager.joinWaitingCall(dmId, uid, uname);
        }, { dmId: dm.id, uid: bodyA.user.id, uname: userA });
        await waitConnected(page1);
        await waitConnected(page2);
        const s1b = await page1.evaluate(() => (window as any).VoiceManager._debug.state);
        expect(s1b.dmCallAnswered).toBe(true);
        const s2b = await page2.evaluate(() => (window as any).VoiceManager._debug.state);
        expect(s2b.dmCallAnswered).toBe(true);

        await ctx1.close().catch(() => {});
        await ctx2.close().catch(() => {});
    });
});
