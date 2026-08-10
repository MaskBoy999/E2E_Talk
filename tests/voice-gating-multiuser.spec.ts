import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

// Mocked media: getUserMedia returns an oscillator mic + a canvas camera;
// getDisplayMedia returns canvas video + oscillator audio (tab/system audio).
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

async function createServerWithVoiceChannel(page: any, token: string): Promise<{ serverId: string; voiceChannelId: string; inviteCode: string }> {
    const ts = Date.now();
    const inviteCode = 'MG' + ts;
    const prep = await page.evaluate(async ({ serverId, inviteCode }) => {
        const identity = E2ECrypto.getIdentityKeyPair();
        const symKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, symKey);
        const encName = E2ECrypto.aeadEncrypt('Gate Multi Server', symKey);
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
    }, { name: 'Gate Multi Voice', serverKeyB64 });

    const ch = await (await page.request.post(`${BASE}/api/servers/${serverId}/channels`, {
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        data: {
            name: 'Gate Multi Voice',
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

// Wait until `page` has exactly `count` gated (or ungated) senders of `kind`
// for the peer `uid`. Gated = the receiver isn't watching / can't hear.
async function waitSenderGatedCount(page: any, uid: string, kind: string, gated: boolean, count: number, timeout = 20000) {
    await page.waitForFunction(({ uid, kind, gated, count }) => {
        const gates = (window as any).VoiceManager._debug.senderGates(uid) || [];
        return gates.filter((g: any) => g.kind === kind && g.gated === gated).length === count;
    }, { uid, kind, gated, count }, { timeout });
}

test.describe('4-user voice channel: per-receiver gating end to end', () => {

    test('camera+screen on; B manual-loads, C deafens; D control sees everything', async ({ browser }) => {
        test.setTimeout(420000);
        const ts = Date.now();
        const userA = 'g4a_' + ts;
        const userB = 'g4b_' + ts;
        const userC = 'g4c_' + ts;
        const userD = 'g4d_' + ts;

        const ctxA = await browser.newContext();
        const pageA = await ctxA.newPage();
        await mockMedia(pageA);
        const bodyA = await registerUser(pageA, userA);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(pageA, bodyA.token);

        const ctxB = await browser.newContext();
        const pageB = await ctxB.newPage();
        const ctxC = await browser.newContext();
        const pageC = await ctxC.newPage();
        const ctxD = await browser.newContext();
        const pageD = await ctxD.newPage();
        await mockMedia(pageB);
        await mockMedia(pageC);
        await mockMedia(pageD);
        const bodyB = await registerUser(pageB, userB);
        const bodyC = await registerUser(pageC, userC);
        const bodyD = await registerUser(pageD, userD);
        for (const [p, b] of [[pageB, bodyB], [pageC, bodyC], [pageD, bodyD]] as any) {
            const join = await p.request.post(`${BASE}/api/invites/join`, {
                headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
                data: { code: inviteCode },
            });
            expect(join.ok()).toBeTruthy();
        }

        await pageA.goto(`${BASE}/index.html`);
        await pageB.goto(`${BASE}/index.html`);
        await pageC.goto(`${BASE}/index.html`);
        await pageD.goto(`${BASE}/index.html`);
        for (const p of [pageA, pageB, pageC, pageD]) {
            await p.waitForTimeout(2000);
            await waitForWs(p);
        }

        // All four join the voice channel (A first, then the others).
        expect(await selectServer(pageA)).toBe(true);
        expect(await clickVoiceChannel(pageA, voiceChannelId)).toBe(true);
        await waitConnected(pageA);
        await pageA.waitForTimeout(1500);
        for (const p of [pageB, pageC, pageD]) {
            expect(await selectServer(p)).toBe(true);
            expect(await clickVoiceChannel(p, voiceChannelId)).toBe(true);
            await waitConnected(p);
            await p.waitForTimeout(1500);
        }

        // A turns camera AND screen share on.
        await pageA.evaluate(() => (window as any).VoiceManager.toggleCamera());
        await pageA.waitForFunction(() => (window as any).VoiceManager._debug.state.cameraOn, undefined, { timeout: 20000 });
        await pageA.evaluate(() => (window as any).VoiceManager.toggleScreen());
        await pageA.waitForFunction(() => (window as any).VoiceManager._debug.state.screenOn, undefined, { timeout: 20000 });

        // B, C, D all receive A's camera + screen streams (media flows).
        for (const p of [pageB, pageC, pageD]) {
            await p.waitForFunction((aUid) => {
                const s = (window as any).VoiceManager._debug.state;
                const rs = s.remoteStreams[aUid];
                return rs && rs.camera && rs.screen && rs.audio && rs.screenAudio;
            }, bodyA.user.id, { timeout: 45000 });
        }

        // D (control): A's senders to D are ALL ungated.
        await waitSenderGatedCount(pageA, bodyD.user.id, 'video', false, 2, 15000);
        await waitSenderGatedCount(pageA, bodyD.user.id, 'audio', false, 2, 15000);

        // --- B enables manual video load → A gates BOTH feeds to B ---
        await pageB.evaluate(() => (window as any).VoiceManager.setManualVideoLoad(true));
        await waitSenderGatedCount(pageA, bodyB.user.id, 'video', true, 2, 20000);
        await waitSenderGatedCount(pageA, bodyB.user.id, 'video', false, 0, 15000);

        // B enters the voice channel view so its member rows + Load buttons are
        // visible, then loads the CAMERA feed only.
        await clickVoiceChannel(pageB, voiceChannelId);
        await pageB.waitForFunction(() => {
            var p = document.getElementById('voice-popup');
            return p && p.style.display === 'flex';
        }, undefined, { timeout: 10000 });
        const camLoad = pageB.locator('.voice-member-media .voice-feed-load-btn[data-feed$=":camera"]');
        await camLoad.first().waitFor({ state: 'visible', timeout: 15000 });
        await camLoad.first().click();
        // Camera ungated, screen still gated.
        await waitSenderGatedCount(pageA, bodyB.user.id, 'video', false, 1, 20000);
        await waitSenderGatedCount(pageA, bodyB.user.id, 'video', true, 1, 15000);

        // The unload button appears INSIDE the camera tile (top-right corner)
        // of the SAME member row (the voice popup has many member rows — scope
        // by the button's own row).
        const camUnload = pageB.locator('.voice-member-media .voice-feed-unload-btn[data-feed$=":camera"]');
        await camUnload.first().waitFor({ state: 'visible', timeout: 10000 });
        await pageB.waitForFunction(() => {
            const b = document.querySelector('.voice-member-media .voice-feed-unload-btn[data-feed$=":camera"]');
            if (!b) return false;
            const row = b.closest('.voice-member-row');
            const v = row ? row.querySelector('.remote-video-tile[data-kind="camera"]') : null;
            if (!v) return false;
            const bb = (b as HTMLElement).getBoundingClientRect();
            const vb = (v as HTMLElement).getBoundingClientRect();
            return bb.left >= vb.left - 1 && bb.top >= vb.top - 1 &&
                bb.right <= vb.right + 1 && bb.bottom <= vb.bottom + 1;
        }, undefined, { timeout: 10000 });

        // B loads the SCREEN feed too → both ungated.
        const scrLoad = pageB.locator('.voice-member-media .voice-feed-load-btn[data-feed$=":screen"]');
        await scrLoad.first().waitFor({ state: 'visible', timeout: 15000 });
        await scrLoad.first().click();
        await waitSenderGatedCount(pageA, bodyB.user.id, 'video', false, 2, 20000);
        await waitSenderGatedCount(pageA, bodyB.user.id, 'video', true, 0, 15000);

        // B unloads the camera → camera gated again, screen still on.
        const camUnload2 = pageB.locator('.voice-member-media .voice-feed-unload-btn[data-feed$=":camera"]');
        await camUnload2.first().waitFor({ state: 'visible', timeout: 10000 });
        await camUnload2.first().click();
        await waitSenderGatedCount(pageA, bodyB.user.id, 'video', true, 1, 20000);
        await waitSenderGatedCount(pageA, bodyB.user.id, 'video', false, 1, 15000);

        // --- C deafens → A gates ALL audio to C (mic + screen audio) ---
        await pageC.evaluate(() => (window as any).VoiceManager.toggleDeafen());
        await pageC.waitForFunction(() => (window as any).VoiceManager._debug.state.deafened === true, undefined, { timeout: 10000 });
        await waitSenderGatedCount(pageA, bodyC.user.id, 'audio', true, 2, 20000);
        // C's video feeds stay ungated (deafen only blocks audio).
        await waitSenderGatedCount(pageA, bodyC.user.id, 'video', false, 2, 15000);

        // C undeafens → audio resumes.
        await pageC.evaluate(() => (window as any).VoiceManager.toggleDeafen());
        await pageC.waitForFunction(() => (window as any).VoiceManager._debug.state.deafened === false, undefined, { timeout: 10000 });
        await waitSenderGatedCount(pageA, bodyC.user.id, 'audio', false, 2, 20000);

        // Final sanity: D still sees everything (control unchanged), and B's
        // screen feed (still loaded) is delivered while camera is unloaded.
        await waitSenderGatedCount(pageA, bodyD.user.id, 'video', false, 2, 15000);
        await waitSenderGatedCount(pageA, bodyD.user.id, 'audio', false, 2, 15000);

        await ctxA.close().catch(() => {});
        await ctxB.close().catch(() => {});
        await ctxC.close().catch(() => {});
        await ctxD.close().catch(() => {});
    });

    // Assert this page's audio topology is clean: for EVERY remote peer there
    // is EXACTLY ONE audio sender (the mic) and EXACTLY ONE audio receiver.
    // Before the mute-gating fix, every mute/unmute cycle removed the audio
    // m-line and unmute addTrack()ed a fresh transceiver — the receiver on the
    // other side accumulated one extra audio receiver per cycle ("recv audio
    // ×N"), each new sender could lose its E2EE transform, and every cycle
    // forced a renegotiation. Gating (replaceTrack(null) ↔ restore on the SAME
    // sender) must keep the count pinned at 1 no matter how often everyone
    // mutes/unmutes/deafens/undeafens.
    async function assertCleanAudioTopology(page: any, others: any[], label: string) {
        for (const other of others) {
            await page.waitForFunction(({ uid }) => {
                const V = (window as any).VoiceManager;
                const S = V._debug.state;
                const pc = S.peers[uid];
                if (!pc) return false;
                const senders = pc.getSenders().filter((s: any) => {
                    const held = s.track || s._voiceNulled;
                    return held && held.kind === 'audio';
                });
                const receivers = pc.getReceivers().filter((r: any) => r.track && r.track.kind === 'audio');
                return senders.length === 1 && receivers.length === 1;
            }, { uid: other.user.id }, { timeout: 20000 });
        }
        console.log(`[${label}] audio topology clean: 1 sender + 1 receiver per peer`);
    }

    // Audio is actually FLOWING on this page (outbound audio packets are
    // climbing) — guards against the gating leaving everything permanently
    // held. Samples the peers' outbound-rtp audio twice ~1.2s apart.
    async function audioPackets(page: any, uids: string[]) {
        return page.evaluate(({ uids }) => {
            const S = (window as any).VoiceManager._debug.state;
            return Promise.all(uids.map((uid: string) => {
                const pc = S.peers[uid];
                if (!pc) return Promise.resolve(0);
                return pc.getStats().then((stats: any) => {
                    let pkts = 0;
                    stats.forEach((r: any) => {
                        if (r.type === 'outbound-rtp' && r.kind === 'audio') pkts += r.packetsSent || 0;
                    });
                    return pkts;
                });
            })).then((arr: number[]) => arr.reduce((a: any, b: any) => a + b, 0));
        }, { uids });
    }
    async function assertAudioFlowing(page: any, others: any[], label: string) {
        const uids = others.map((o: any) => o.user.id);
        const p1 = await audioPackets(page, uids);
        await page.waitForTimeout(1200);
        const p2 = await audioPackets(page, uids);
        expect(p2, `[${label}] outbound audio packets must climb (${p1} → ${p2})`).toBeGreaterThan(p1);
        console.log(`[${label}] audio flowing: outbound pkts ${p1} → ${p2}`);
    }

    test('everyone mutes/unmutes and deafens/undeafens several times — no receiver accumulation on any side', async ({ browser }) => {
        test.setTimeout(600000);
        const ts = Date.now();
        const userA = 'ma_' + ts;
        const userB = 'mb_' + ts;
        const userC = 'mc_' + ts;
        const userD = 'md_' + ts;

        const ctxA = await browser.newContext();
        const pageA = await ctxA.newPage();
        await mockMedia(pageA);
        const bodyA = await registerUser(pageA, userA);
        const { serverId, voiceChannelId, inviteCode } = await createServerWithVoiceChannel(pageA, bodyA.token);

        const ctxB = await browser.newContext();
        const pageB = await ctxB.newPage();
        const ctxC = await browser.newContext();
        const pageC = await ctxC.newPage();
        const ctxD = await browser.newContext();
        const pageD = await ctxD.newPage();
        await mockMedia(pageB);
        await mockMedia(pageC);
        await mockMedia(pageD);
        const bodyB = await registerUser(pageB, userB);
        const bodyC = await registerUser(pageC, userC);
        const bodyD = await registerUser(pageD, userD);
        for (const [p, b] of [[pageB, bodyB], [pageC, bodyC], [pageD, bodyD]] as any) {
            const join = await p.request.post(`${BASE}/api/invites/join`, {
                headers: { Authorization: `Bearer ${b.token}`, 'Content-Type': 'application/json' },
                data: { code: inviteCode },
            });
            expect(join.ok()).toBeTruthy();
        }

        await pageA.goto(`${BASE}/index.html`);
        await pageB.goto(`${BASE}/index.html`);
        await pageC.goto(`${BASE}/index.html`);
        await pageD.goto(`${BASE}/index.html`);
        for (const p of [pageA, pageB, pageC, pageD]) {
            await p.waitForTimeout(2000);
            await waitForWs(p);
        }

        // All four join the voice channel (A first, then the others).
        expect(await selectServer(pageA)).toBe(true);
        expect(await clickVoiceChannel(pageA, voiceChannelId)).toBe(true);
        await waitConnected(pageA);
        await pageA.waitForTimeout(1500);
        for (const p of [pageB, pageC, pageD]) {
            expect(await selectServer(p)).toBe(true);
            expect(await clickVoiceChannel(p, voiceChannelId)).toBe(true);
            await waitConnected(p);
            await p.waitForTimeout(1500);
        }
        // Everyone's mic is on (mocked getUserMedia → 300Hz oscillator).
        await assertAudioFlowing(pageA, [bodyB, bodyC, bodyD], 'initial A');

        // --- Phase 1: EVERYONE mutes/unmutes 3 times ---
        for (const [p, b] of [[pageA, bodyA], [pageB, bodyB], [pageC, bodyC], [pageD, bodyD]] as any) {
            for (let cycle = 0; cycle < 3; cycle++) {
                await p.evaluate(() => (window as any).VoiceManager.toggleMute());
                await p.waitForFunction(() => (window as any).VoiceManager._debug.state.muted === true, undefined, { timeout: 10000 });
                await p.waitForTimeout(400);
                await p.evaluate(() => (window as any).VoiceManager.toggleMute());
                await p.waitForFunction(() => (window as any).VoiceManager._debug.state.muted === false, undefined, { timeout: 10000 });
                // Unmute re-acquires the mic (fresh getUserMedia) — wait for it.
                await p.waitForFunction(() => {
                    const S = (window as any).VoiceManager._debug.state;
                    return S.localStreams && S.localStreams.mic && S.localStreams.mic.getAudioTracks().length > 0;
                }, undefined, { timeout: 10000 });
                await p.waitForTimeout(700);
            }
            console.log(`[mute] ${b.user.username} finished 3× mute/unmute`);
        }

        // After all the mute/unmute churn: every page must still see exactly
        // ONE audio receiver per peer (no accumulation) and send with ONE
        // sender, and audio must still flow.
        await assertCleanAudioTopology(pageA, [bodyB, bodyC, bodyD], 'post-mute A');
        await assertCleanAudioTopology(pageB, [bodyA, bodyC, bodyD], 'post-mute B');
        await assertCleanAudioTopology(pageC, [bodyA, bodyB, bodyD], 'post-mute C');
        await assertCleanAudioTopology(pageD, [bodyA, bodyB, bodyC], 'post-mute D');
        await assertAudioFlowing(pageA, [bodyB, bodyC, bodyD], 'post-mute A');

        // --- Phase 2: EVERYONE deafens/undeafens 3 times ---
        for (const [p, b] of [[pageA, bodyA], [pageB, bodyB], [pageC, bodyC], [pageD, bodyD]] as any) {
            for (let cycle = 0; cycle < 3; cycle++) {
                await p.evaluate(() => (window as any).VoiceManager.toggleDeafen());
                await p.waitForFunction(() => (window as any).VoiceManager._debug.state.deafened === true, undefined, { timeout: 10000 });
                await p.waitForTimeout(500);
                await p.evaluate(() => (window as any).VoiceManager.toggleDeafen());
                await p.waitForFunction(() => (window as any).VoiceManager._debug.state.deafened === false, undefined, { timeout: 10000 });
                await p.waitForFunction(() => {
                    const S = (window as any).VoiceManager._debug.state;
                    return S.localStreams && S.localStreams.mic && S.localStreams.mic.getAudioTracks().length > 0;
                }, undefined, { timeout: 10000 });
                await p.waitForTimeout(700);
            }
            console.log(`[deafen] ${b.user.username} finished 3× deafen/undeafen`);
        }

        await assertCleanAudioTopology(pageA, [bodyB, bodyC, bodyD], 'post-deafen A');
        await assertCleanAudioTopology(pageB, [bodyA, bodyC, bodyD], 'post-deafen B');
        await assertCleanAudioTopology(pageC, [bodyA, bodyB, bodyD], 'post-deafen C');
        await assertCleanAudioTopology(pageD, [bodyA, bodyB, bodyC], 'post-deafen D');
        await assertAudioFlowing(pageA, [bodyB, bodyC, bodyD], 'post-deafen A');
        await assertAudioFlowing(pageB, [bodyA, bodyC, bodyD], 'post-deafen B');

        // --- Phase 3: one user stays MUTED at the end — others must still see
        // exactly ONE receiver for them (a held/0-packet sender, not a new one)
        // and their own topology stays clean. ---
        await pageC.evaluate(() => (window as any).VoiceManager.toggleMute());
        await pageC.waitForFunction(() => (window as any).VoiceManager._debug.state.muted === true, undefined, { timeout: 10000 });
        await pageC.waitForTimeout(600);
        // C's senders are gated (held), not removed: 1 audio sender, held.
        await pageC.waitForFunction(() => {
            const V = (window as any).VoiceManager;
            const gates = V._debug.senderGates(Object.keys(V._debug.state.peers)[0]) || [];
            return gates.filter((g: any) => g.kind === 'audio' && g.gated).length === 1;
        }, undefined, { timeout: 15000 });
        await assertCleanAudioTopology(pageA, [bodyB, bodyC, bodyD], 'C-muted A');
        await assertCleanAudioTopology(pageB, [bodyA, bodyC, bodyD], 'C-muted B');
        await assertCleanAudioTopology(pageD, [bodyA, bodyB, bodyC], 'C-muted D');
        // Unmute C so the mesh ends fully live.
        await pageC.evaluate(() => (window as any).VoiceManager.toggleMute());
        await pageC.waitForFunction(() => (window as any).VoiceManager._debug.state.muted === false, undefined, { timeout: 10000 });
        await pageC.waitForTimeout(800);
        await assertAudioFlowing(pageA, [bodyB, bodyC, bodyD], 'final A');

        await ctxA.close().catch(() => {});
        await ctxB.close().catch(() => {});
        await ctxC.close().catch(() => {});
        await ctxD.close().catch(() => {});
    });
});
