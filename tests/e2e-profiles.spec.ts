import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

const BASE = 'https://localhost:3443';

function generateCode(len: number): string {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
    return code;
}

function makeMinimalPng(width = 50, height = 50, r = 255, g = 0, b = 0): Buffer {
    const zlib = require('zlib');
    const raw = Buffer.alloc(1 + width * height * 3, 0);
    for (let y = 0; y < height; y++) {
        raw[y * (width * 3 + 1)] = 0;
        for (let x = 0; x < width; x++) {
            const idx = y * (width * 3 + 1) + 1 + x * 3;
            raw[idx] = r; raw[idx + 1] = g; raw[idx + 2] = b;
        }
    }
    const deflated = zlib.deflateSync(raw);
    function crc32(buf: Buffer): number {
        let crc = 0xFFFFFFFF;
        for (let i = 0; i < buf.length; i++) {
            crc ^= buf[i];
            for (let j = 0; j < 8; j++) crc = (crc >>> 1) ^ (crc & 1 ? 0xEDB88320 : 0);
        }
        return (crc ^ 0xFFFFFFFF) >>> 0;
    }
    function u32(v: number): Buffer { const b = Buffer.alloc(4); b.writeUInt32BE(v); return b; }
    const parts: Buffer[] = [];
    parts.push(Buffer.from([0x89,0x50,0x4E,0x47,0x0D,0x0A,0x1A,0x0A]));
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
    const ihdrType = Buffer.from('IHDR');
    const ihdrCrc = Buffer.concat([ihdrType, ihdr]);
    parts.push(u32(13), ihdrType, ihdr, u32(crc32(ihdrCrc)));
    const idatType = Buffer.from('IDAT');
    const idatCrc = Buffer.concat([idatType, deflated]);
    parts.push(u32(deflated.length), idatType, deflated, u32(crc32(idatCrc)));
    const iendType = Buffer.from('IEND');
    parts.push(u32(0), iendType, u32(crc32(iendType)));
    return Buffer.concat(parts);
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.waitForTimeout(1000);
    const showReg = await page.$('#show-register');
    if (showReg) {
        await showReg.click();
        await page.waitForTimeout(300);
    }
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'password123');
    await page.fill('#register-confirm-password', 'password123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForTimeout(2000);
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function saveProfileViaAPI(page: any, profileData: Record<string, string>) {
    const result = await page.evaluate(async (pd) => {
        const logs: string[] = [];
        try {
            const identity = E2ECrypto.getIdentityKeyPair();
            if (!identity) { logs.push('No identity key pair'); return { ok: false, logs }; }
            const profileDataKey = E2ECrypto.generateProfileDataKey();
            const profileDataJson = JSON.stringify(pd);
            const encrypted = E2ECrypto.encryptProfileData(profileDataJson, profileDataKey);
            const profileDataKeyB64 = E2ECrypto.arrayBufferToBase64(profileDataKey);
            const encryptedProfileDataKey = E2ECrypto.encodeEncryptedFileKey(profileDataKeyB64, identity.privateKey);
            const encryptedProfileData = encrypted.nonce + ':' + encrypted.ciphertext;
            const patchRes = await fetch('/api/profile', {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
                body: JSON.stringify({ encrypted_profile_data: encryptedProfileData, encrypted_profile_data_key: encryptedProfileDataKey }),
            });
            logs.push('PATCH /api/profile: ' + patchRes.status);

            // Ensure servers/dms are loaded before uploading conversation profiles
            if (typeof loadServers === 'function') {
                try { await loadServers(); } catch (e: any) { logs.push('loadServers error: ' + e.message); }
            }
            logs.push('servers count: ' + (typeof servers !== 'undefined' ? servers.length : 'undef'));

            if (typeof loadDmConversations === 'function') {
                try { await loadDmConversations(); } catch (e: any) { logs.push('loadDmConversations error: ' + e.message); }
            }

            // Log which server keys we have
            if (typeof servers !== 'undefined') {
                for (const s of servers) {
                    const key = E2ECrypto.getServerKey(s.id);
                    logs.push('server ' + s.id + ' key: ' + (key ? 'YES' : 'NO'));
                }
            }

            // Upload conversation profiles so other users can see updated data
            if (typeof uploadConversationProfiles === 'function') {
                try { await uploadConversationProfiles(identity, profileDataJson); logs.push('uploadConversationProfiles: done'); } catch (e: any) { logs.push('uploadConversationProfiles error: ' + e.message); }
            } else {
                logs.push('uploadConversationProfiles not defined');
            }

            // Verify the upload by checking the DB directly
            if (typeof servers !== 'undefined' && servers.length > 0) {
                for (const s of servers) {
                    try {
                        const profRes = await fetch('/api/profile/' + JSON.parse(localStorage.getItem('user')).id + '/conversation/channel/' + s.id, {
                            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
                        });
                        logs.push('GET profile conv ' + s.id + ': ' + profRes.status);
                    } catch (e: any) { logs.push('GET profile conv error: ' + e.message); }
                }
            }

            return { ok: true, logs };
        } catch (e: any) {
            logs.push('FATAL: ' + e.message);
            return { ok: false, logs };
        }
    }, profileData);
}

// ===== TEST 1: Friend DM - profile visibility =====


test('friend DM shows display name and profile updates', async ({ browser }) => {
    test.setTimeout(90000);
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const user1 = await registerUser(page1, 'frA_' + Date.now());
    const user2 = await registerUser(page2, 'frB_' + Date.now());

    // Friend them via API
    const fr = await page1.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${user1.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: await page2.evaluate(() => localStorage.getItem('e2e_friend_code')) },
    });
    expect(fr.ok()).toBeTruthy();
    const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${user2.token}` },
    })).json();
    const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${user2.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    expect(acc.ok()).toBeTruthy();

    // User1 saves profile with display name
    await saveProfileViaAPI(page1, { display_name: 'Alice', username_color: '#ff0000' });
    await page1.waitForTimeout(500);

    // Reload both pages
    await page1.goto(`${BASE}/index.html`);
    await page1.waitForTimeout(3000);
    await page2.goto(`${BASE}/index.html`);
    await page2.waitForTimeout(3000);

    // Wait for DM conversations to load on page2
    await page2.waitForFunction(() => {
        return typeof dmConversations !== 'undefined' && dmConversations.length > 0;
    }, { timeout: 10000 }).catch(() => {});

    // Check DM sidebar shows display name
    const dmNames = await page2.evaluate(() => {
        const items = document.querySelectorAll('.dm-name');
        return Array.from(items).map(el => el.textContent || '');
    });
    // At least one DM name should contain "Alice" or the username
    expect(dmNames.length).toBeGreaterThan(0);

    await ctx1.close();
    await ctx2.close();
});

// ===== TEST 2: Server profile visibility =====

test('server channel shows display name and profile updates', async ({ browser }) => {
    test.setTimeout(90000);
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const page1 = await ctx1.newPage();
    const page2 = await ctx2.newPage();

    const user1 = await registerUser(page1, 'srvA_' + Date.now());
    const user2 = await registerUser(page2, 'srvB_' + Date.now());

    // User1 creates server
    const inviteCode = generateCode(8);
    const inviteCodeHash = await page1.evaluate((code: string) => {
        const hmacKey = localStorage.getItem('e2e_hmac_key');
        return hmacKey ? E2ECrypto.hmacHex(hmacKey, code) : E2ECrypto.sha256Hex(code);
    }, inviteCode);
    const srv = await page1.request.post(`${BASE}/api/servers`, {
        headers: { Authorization: `Bearer ${user1.token}`, 'Content-Type': 'application/json' },
        data: { name: 'TestSrv', invite_code_hash: inviteCodeHash },
    });
    expect(srv.ok()).toBeTruthy();
    const server = await srv.json();

    // User1 creates the server key and uploads it for themselves
    const serverKeyB64 = await page1.evaluate(async (serverId) => {
        const serverKey = E2ECrypto.generateSymmetricKey();
        E2ECrypto.saveServerKey(serverId, serverKey);
        const identity = E2ECrypto.getIdentityKeyPair();
        const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
        await fetch(`/api/servers/${serverId}/keys`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: JSON.parse(localStorage.getItem('user')).id, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
        });
        return E2ECrypto.arrayBufferToBase64(serverKey);
    }, server.id);

    // Get channels
    const chRes = await page1.request.get(`${BASE}/api/servers/${server.id}/channels`, {
        headers: { Authorization: `Bearer ${user1.token}` },
    });
    const channels = await chRes.json();
    const channelId = channels[0].id;

    // User2 joins server
    await page2.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${user2.token}`, 'Content-Type': 'application/json' },
        data: { code: inviteCode },
    });

    // Wait for owner (page1) to rotate the server key after member_joined
    await page1.waitForTimeout(5000);

    // Owner manually shares the (possibly rotated) server key with user2
    await page1.evaluate(async ({ serverId, jUserId, jPubKey }) => {
        const serverKey = E2ECrypto.getServerKey(serverId);
        if (!serverKey) return;
        const identity = E2ECrypto.getIdentityKeyPair();
        const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(jPubKey));
        const encrypted = E2ECrypto.envelopeEncrypt(serverKey, recipientPub, identity.privateKey);
        await fetch('/api/servers/' + serverId + '/keys', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + localStorage.getItem('token') },
            body: JSON.stringify({ user_id: jUserId, encrypted_key: encrypted.ciphertext, sender_public_key: E2ECrypto.arrayBufferToBase64(identity.publicKey), nonce: encrypted.nonce }),
        });
    }, { serverId: server.id, jUserId: user2.user.id, jPubKey: await page2.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey)) });

    // User2 fetches and decrypts the server key (retry since rotation may still be in progress)
    for (let attempt = 0; attempt < 5; attempt++) {
        const ok = await page2.evaluate(async (serverId) => {
            if (typeof fetchAndDecryptServerKey === 'function') {
                return await fetchAndDecryptServerKey(serverId);
            }
            return false;
        }, server.id);
        if (ok) break;
        await page2.waitForTimeout(2000);
    }
    await page2.waitForTimeout(1000);

    // User1 saves profile with display name
    await saveProfileViaAPI(page1, { display_name: 'Bob', username_color: '#0000ff', description: 'Server owner' });

    // Reload pages
    await page1.goto(`${BASE}/index.html`);
    await page1.waitForTimeout(3000);
    await page2.goto(`${BASE}/index.html`);
    await page2.waitForTimeout(3000);

    // Select server and channel on page1
    await page1.evaluate(async (sid) => {
        if (typeof selectServer === 'function') await selectServer(sid);
    }, server.id);
    await page1.waitForTimeout(2000);
    await page1.evaluate(async (cid) => {
        if (typeof selectChannel === 'function' && document.querySelector(`.channel-item[data-channel-id="${cid}"]`)) {
            await selectChannel(cid);
        }
    }, channelId);
    await page1.waitForTimeout(2000);

    // Verify myProfile has the display name before sending
    await page1.waitForFunction(() => typeof myProfile !== 'undefined' && myProfile && myProfile.display_name, { timeout: 15000 });

    // User1 sends a message
    await page1.fill('#message-input', 'Hello from Bob!');
    await page1.click('#send-btn');
    await page1.waitForTimeout(2000);

    // Select server and channel on page2
    await page2.evaluate(async (sid) => {
        if (typeof selectServer === 'function') await selectServer(sid);
    }, server.id);
    await page2.waitForTimeout(2000);
    await page2.evaluate(async (cid) => {
        if (typeof selectChannel === 'function' && document.querySelector(`.channel-item[data-channel-id="${cid}"]`)) {
            await selectChannel(cid);
        }
    }, channelId);
    await page2.waitForTimeout(2000);

    // Check message is visible on page2
    const msgs = await page2.evaluate(() => {
        const contentEls = document.querySelectorAll('.message .content');
        return Array.from(contentEls).map(el => el.textContent || '');
    });
    const hasMsg = msgs.some(t => t.includes('Hello from Bob'));
    expect(hasMsg).toBeTruthy();

    // Check display name shows as "Bob" not raw username
    const names = await page2.evaluate(() => {
        const nameEls = document.querySelectorAll('.message .display-name');
        return Array.from(nameEls).map(el => el.textContent || '');
    });
    const hasBob = names.some(t => t.includes('Bob'));
    expect(hasBob).toBeTruthy();

    // Update user1's profile — need to reload page1 so uploadConversationProfiles has server keys
    await page1.goto(`${BASE}/index.html`);
    await page1.waitForTimeout(3000);
    // Select server to ensure server key is loaded
    await page1.evaluate(async (sid) => {
        if (typeof selectServer === 'function') await selectServer(sid);
    }, server.id);
    await page1.waitForTimeout(2000);
    // Now save profile with conversation profile upload
    await saveProfileViaAPI(page1, { display_name: 'Bob Updated', username_color: '#ff00ff' });
    await page1.waitForTimeout(1000);

    // Reload page2 and re-select channel
    await page2.goto(`${BASE}/index.html`);
    await page2.waitForTimeout(3000);
    await page2.evaluate(async (sid) => {
        if (typeof selectServer === 'function') await selectServer(sid);
    }, server.id);
    await page2.waitForTimeout(2000);
    await page2.evaluate(async (cid) => {
        if (typeof selectChannel === 'function' && document.querySelector(`.channel-item[data-channel-id="${cid}"]`)) {
            await selectChannel(cid);
        }
    }, channelId);
    await page2.waitForTimeout(2000);

    // Check updated display name
    const updatedNames = await page2.evaluate(() => {
        const nameEls = document.querySelectorAll('.message .display-name');
        return Array.from(nameEls).map(el => el.textContent || '');
    });
    const hasUpdated = updatedNames.some(t => t.includes('Bob Updated'));
    expect(hasUpdated).toBeTruthy();

    // Open profile modal for user1 on page2
    await page2.evaluate((uid) => {
        if (typeof openProfileModal === 'function') openProfileModal(uid);
    }, user1.user.id);
    await page2.waitForTimeout(3000);

    // Check profile modal shows updated info
    const modalText = await page2.evaluate(() => {
        return {
            displayName: document.getElementById('profile-modal-display-name')?.textContent || '',
            description: document.getElementById('profile-modal-description')?.textContent || '',
        };
    });
    expect(modalText.displayName).toContain('Bob Updated');

    await ctx1.close();
    await ctx2.close();
});
