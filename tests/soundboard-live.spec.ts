/**
 * Soundboard — live behaviour in real Chromium browsers.
 *
 * These tests drive the REAL UI (right-click member menu, settings checkbox,
 * real clips uploaded + played through the voice relay) and assert what a user
 * would experience, not internal flags:
 *
 *   L1  mute → unmute while a clip is playing resumes it mid-clip (this only
 *       holds on the AudioContext playback path — the <audio> fallback pauses
 *       without firing onended, which is why every earlier suite passed while
 *       real users heard silence).
 *   L2  owner "Disable Soundboard" stops that player for everyone (other
 *       players keep playing) and enabling again does NOT resume the clip.
 *   L3  the player's own Settings → Voice disable stops it for the room too,
 *       and re-enabling does not resurrect it.
 *   L4  the 🎵 playing indicator shows in the channel list chip and the voice
 *       popup member row while a clip plays, and disappears when it stops.
 *   L5  a DM call tile shows the same 🎵 indicator.
 *   L6  per-user soundboard volume is separate from the mic volume and applies
 *       LIVE to a clip that is already playing (measured RMS through the gain).
 */
import { test, expect, Page, BrowserContext } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PW = 'testpass123';

let counter = 0;
const unique = (p: string) => `${p}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

/** Surface page-side errors in the test output — a silent playback failure is
 *  exactly how this bug hid for so long. */
function captureConsole(page: Page, tag: string) {
    page.on('console', (m) => {
        if (m.type() === 'error') console.log(`[${tag} console.error]`, m.text().slice(0, 240));
    });
    page.on('pageerror', (e) => console.log(`[${tag} pageerror]`, String(e).slice(0, 300)));
}

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 15000 });
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', PW);
    await page.fill('#register-confirm-password', PW);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 20000 });
    return await page.evaluate(() => ({
        token: localStorage.getItem('token'),
        user: JSON.parse(localStorage.getItem('user') || '{}'),
    }));
}

async function waitForWs(page: Page) {
    await page.waitForFunction(
        () => (window as any).ws && (window as any).ws.readyState === 1,
        { timeout: 25000 }
    );
}

function newCtx(context: BrowserContext) {
    return context.browser()!.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1280, height: 800 } });
}

/** Register a fresh user in a fresh context. */
async function newUser(context: BrowserContext, prefix: string) {
    const ctx = await newCtx(context);
    const page = await ctx.newPage();
    const body = await register(page, unique(prefix));
    await waitForWs(page);
    return { ctx, page, body };
}

async function createServer(page: Page) {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 10000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#new-server-name', { state: 'visible', timeout: 10000 });
    await page.fill('#new-server-name', 'SBLive_' + Date.now());
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 20000 });
    await page.waitForTimeout(1200);
    const serverId = await page.evaluate(
        () => document.querySelector('.server-icon[data-id]')!.getAttribute('data-id')!
    );
    const channelId = await page.evaluate(async (sid: string) => {
        const res = await fetch(`/api/servers/${sid}/channels`, {
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token') },
        });
        const raw = await res.json();
        const arr = Array.isArray(raw) ? raw : (raw.channels || []);
        const vc = arr.find((c: any) => (c.channel_type || c.type) === 'voice');
        return vc ? vc.id : '';
    }, serverId);
    expect(channelId).toBeTruthy();
    return { serverId, channelId };
}

/** Invite `page2` into the server (API) and reload so the sidebar shows it. */
async function inviteUser(page1: Page, page2: Page, serverId: string) {
    const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    const code = Array.from({ length: 16 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
    const t1 = await page1.evaluate(() => localStorage.getItem('token'));
    const t2 = await page2.evaluate(() => localStorage.getItem('token'));
    await page1.request.post(`${BASE}/api/servers/${serverId}/invite`, {
        headers: { Authorization: `Bearer ${t1}`, 'Content-Type': 'application/json' },
        data: { invite_code: code },
    });
    const joined = await page2.request.post(`${BASE}/api/invites/join`, {
        headers: { Authorization: `Bearer ${t2}`, 'Content-Type': 'application/json' },
        data: { code },
    });
    expect(joined.ok()).toBeTruthy();
    await page2.reload();
    await page2.waitForSelector(`.server-icon[data-id="${serverId}"]`, { timeout: 25000 });
    await waitForWs(page2);
    // The server E2EE key must be present before joining voice, or the room key
    // cannot be derived.
    await page2.evaluate(async (sid: string) => {
        for (let i = 0; i < 40; i++) {
            if ((window as any).E2ECrypto && (window as any).E2ECrypto.getServerKey(sid)) return;
            await new Promise((r) => setTimeout(r, 400));
        }
    }, serverId);
}

async function joinVoice(page: Page, serverId: string, channelId: string) {
    await page.click(`.server-icon[data-id="${serverId}"]`);
    await page.waitForSelector(`.channel-item[data-id="${channelId}"]`, { timeout: 20000 });
    await page.waitForTimeout(400);
    await page.click(`.channel-item[data-id="${channelId}"]`);
    await page.waitForFunction(() => {
        const bar = document.getElementById('voice-bar');
        return !!bar && bar.style.display !== 'none';
    }, { timeout: 25000 });
}

async function uploadClip(page: Page, name: string, durationSec: number): Promise<string> {
    return await page.evaluate(async ({ name, durationSec }) => {
        // A REAL RIFF/WAVE file, byte for byte: "RIFF" + size + "WAVE" +
        // "fmt " chunk + "data" chunk. get-out-of-jail note: an earlier helper
        // in this repo wrote the chunk size where "RIFF" belongs, which made
        // decodeAudioData reject and silently pushed playback onto the <audio>
        // fallback — so tests "passed" while nothing was actually audible.
        const rate = 44100;
        const n = Math.floor(rate * durationSec);
        const dataSize = n * 2;
        const buf = new ArrayBuffer(44 + dataSize);
        const dv = new DataView(buf);
        const u8 = (o: number, v: number) => dv.setUint8(o, v);
        const u32 = (o: number, v: number) => dv.setUint32(o, v, true);
        const u16 = (o: number, v: number) => dv.setUint16(o, v, true);
        const ascii = (o: number, s: string) => { for (let i = 0; i < s.length; i++) u8(o + i, s.charCodeAt(i)); };
        ascii(0, 'RIFF'); u32(4, 36 + dataSize); ascii(8, 'WAVE');
        ascii(12, 'fmt '); u32(16, 16); u16(20, 1); u16(22, 1);
        u32(24, rate); u32(28, rate * 2); u16(32, 2); u16(34, 16);
        ascii(36, 'data'); u32(40, dataSize);
        for (let i = 0; i < n; i++) {
            dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.5 * 32767), true);
        }
        const E = (window as any).E2ECrypto;
        const identity = E.getIdentityKeyPair();
        const enc = E.envelopeEncrypt(new Uint8Array(buf), identity.publicKey, identity.privateKey);
        const res = await fetch('/api/soundboard', {
            method: 'POST',
            headers: { Authorization: 'Bearer ' + localStorage.getItem('token'), 'Content-Type': 'application/json' },
            body: JSON.stringify({
                server_id: '_global', name,
                encrypted_audio: enc.ciphertext, audio_nonce: enc.nonce,
                duration_ms: Math.round(durationSec * 1000),
            }),
        });
        const data = await res.json();
        if (!data.ok && !data.id) throw new Error('clip upload failed: ' + JSON.stringify(data));
        return data.clip_id || data.id;
    }, { name, durationSec });
}

/** Press a clip's real play button (the same call the overlay button makes).
 *  Clips are per-ACCOUNT, so a page can only play clips uploaded on that
 *  account — fail loudly instead of silently playing nothing. */
async function playClip(page: Page, clipId: string) {
    await page.evaluate(async () => { await (window as any)._loadSoundboardClips(); });
    const found = await page.evaluate(
        (cid: string) => ((window as any)._sbClipsCache || []).some((c: any) => c.id === cid),
        clipId
    );
    if (!found) throw new Error(`clip ${clipId} is not in this page's cache (wrong account?)`);
    await page.evaluate((cid: string) => { (window as any)._playSoundboardClip(cid); }, clipId);
}

/**
 * Unlock the shared soundboard AudioContext the way a user does (click the real
 * soundboard button in the voice popup). The AudioContext playback path is the
 * one that regressed, so tests must not silently fall back to the <audio> path.
 */
/** Make sure the voice popup is OPEN (toggleServerPopup would close it). */
async function ensureServerPopup(page: Page) {
    const open = await page.evaluate(() => {
        const p = document.getElementById('voice-popup');
        return !!p && p.style.display !== 'none';
    });
    if (!open) await page.evaluate(() => (window as any).VoiceManager.toggleServerPopup());
    await page.waitForTimeout(400);
}

async function unlockSbAudio(page: Page) {
    await ensureServerPopup(page);
    await page.waitForSelector('#voice-popup-soundboard', { state: 'visible', timeout: 10000 });
    await page.click('#voice-popup-soundboard');
    await page.waitForSelector('#soundboard-overlay', { state: 'visible', timeout: 10000 });
    await page.waitForTimeout(400);
    const state = await page.evaluate(async () => {
        const ctx = (window as any).__sbAudioCtxRef;
        if (!ctx) return 'not-exposed'; // older builds keep the context private
        if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (_) {} }
        return ctx.state;
    });
    await page.click('#soundboard-close');
    return state;
}

// --- state probes -----------------------------------------------------------

const entriesFor = (page: Page, uid: string) =>
    page.evaluate((uid: string) => ((window as any)._sbAllPlaying || []).filter((e: any) => {
        const u = (e && e.userId) || (e && e._sbUserId) || null;
        return u === uid;
    }).map((e: any) => ({ type: e.type || 'audio', clipId: e.clipId || e._sbClipId || null })), uid);

const playingUsers = (page: Page) =>
    page.evaluate(() => Object.keys((window as any)._sbPlayingUsers || {}));

const hasResume = (page: Page, uid: string) =>
    page.evaluate((uid: string) => !!(window as any)._sbHasResumeFor && (window as any)._sbHasResumeFor(uid), uid);

/** Wait until `uid` has a live soundboard entry on this page (or throw). */
async function waitForEntry(page: Page, uid: string, timeout = 20000) {
    await page.waitForFunction(
        (uid: string) => ((window as any)._sbAllPlaying || []).some((e: any) =>
            ((e && e.userId) || (e && e._sbUserId) || null) === uid),
        uid,
        { timeout }
    );
}

/** Wait until `uid` has NO live soundboard entry on this page. */
async function waitForNoEntry(page: Page, uid: string, timeout = 25000) {
    await page.waitForFunction(
        (uid: string) => !((window as any)._sbAllPlaying || []).some((e: any) =>
            ((e && e.userId) || (e && e._sbUserId) || null) === uid),
        uid,
        { timeout }
    );
}

// --- real UI interactions ---------------------------------------------------

/** Right-click a member row / DM tile the way a user does. */
async function openMemberMenu(page: Page, uid: string) {
    const row = page.locator(`.voice-member-row[data-uid="${uid}"], .dm-call-tile[data-uid="${uid}"]`).first();
    await expect(row).toBeVisible({ timeout: 15000 });
    const box = await row.boundingBox();
    await row.dispatchEvent('contextmenu', {
        clientX: (box?.x || 100) + 10,
        clientY: (box?.y || 100) + 10,
        bubbles: true,
    });
    await page.waitForSelector('#volume-menu', { state: 'visible', timeout: 10000 });
}

/** Click a button inside the open volume menu by its visible label. */
async function clickVolumeMenuButton(page: Page, label: string) {
    const clicked = await page.evaluate((want: string) => {
        const btns = Array.from(document.querySelectorAll('#volume-menu .volume-menu-btn')) as HTMLElement[];
        const b = btns.find((el) => (el.textContent || '').trim().endsWith(want));
        if (!b) return false;
        b.click();
        return true;
    }, label);
    if (!clicked) {
        const seen = await page.evaluate(() =>
            Array.from(document.querySelectorAll('#volume-menu .volume-menu-btn')).map((b) => (b.textContent || '').trim()));
        throw new Error(`volume-menu button "${label}" not found. Saw: ${JSON.stringify(seen)}`);
    }
    await page.waitForTimeout(250);
}

/** Diagnostic: what does the DOM actually show about playing badges? */
async function dumpIndicators(page: Page, uid: string, channelId: string) {
    const dump = await page.evaluate(({ uid, channelId }) => {
        const q = (sel: string) => document.querySelector(sel) as HTMLElement | null;
        const row = q(`.voice-member-row[data-uid="${uid}"]`);
        const chip = q(`.channel-item[data-id="${channelId}"] .voice-chip-row[data-uid="${uid}"]`);
        const tile = q(`.dm-call-tile[data-uid="${uid}"]`);
        const vis = (el: HTMLElement | null) => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { w: Math.round(r.width), h: Math.round(r.height), display: getComputedStyle(el).display };
        };
        return {
            playingUsers: Object.keys((window as any)._sbPlayingUsers || {}),
            // The refresh callback lives in voice.js; if it is missing (it used
            // to be clobbered by soundboard-pairing.js) NOTHING updates.
            refreshCallback: typeof (window as any)._sbOnSbPlayingChanged,
            badgeCount: document.querySelectorAll('.sb-playing-indicator').length,
            rowBadge: !!row && row.querySelector('.sb-playing-indicator')
                ? vis(row.querySelector('.sb-playing-indicator') as HTMLElement) : null,
            chipBadge: !!chip && chip.querySelector('.sb-playing-indicator')
                ? vis(chip.querySelector('.sb-playing-indicator') as HTMLElement) : null,
            tileBadge: !!tile && tile.querySelector('.sb-playing-indicator')
                ? vis(tile.querySelector('.sb-playing-indicator') as HTMLElement) : null,
        };
    }, { uid, channelId });
    console.log(`[dump ${uid.slice(0, 6)}]`, JSON.stringify(dump));
    return dump;
}

const sbIndicator = {
    popupRow: (uid: string) => `.voice-member-row[data-uid="${uid}"] .sb-playing-indicator`,
    channelChip: (channelId: string, uid: string) =>
        `.channel-item[data-id="${channelId}"] .voice-chip-row[data-uid="${uid}"] .sb-playing-indicator`,
    dmTile: (uid: string) => `.dm-call-tile[data-uid="${uid}"] .sb-playing-indicator`,
};

// ---------------------------------------------------------------------------
// L1 — mute → unmute resumes the clip mid-way (AudioContext path)
// ---------------------------------------------------------------------------
test('L1: muting then unmuting a playing user resumes their clip mid-way (ctx path)', async ({ page, context }) => {
    test.setTimeout(240000);
    await register(page, unique('sbl1a'));
    await waitForWs(page);
    const { serverId, channelId } = await createServer(page);
    const clipId = await uploadClip(page, 'l1_' + Date.now(), 14);

    const b = await newUser(context, 'sbl1b');
    captureConsole(page, 'L1-sender');
    captureConsole(b.page, 'L1-receiver');
    await inviteUser(page, b.page, serverId);

    await joinVoice(page, serverId, channelId);
    await joinVoice(b.page, serverId, channelId);
    await page.waitForTimeout(2000);

    // Receiver unlocks the soundboard AudioContext before the clip arrives.
    // (Informational only — the authoritative precondition is the entry type
    // checked below, which works on pre-fix builds too.)
    const ctxState = await unlockSbAudio(b.page);
    console.log('[L1] receiver AudioContext state:', ctxState);

    await playClip(page, clipId);
    await waitForEntry(b.page, await page.evaluate(() => (window as any).currentUserId), 25000);

    const senderId = await page.evaluate(() => (window as any).currentUserId);
    const liveEntries = await entriesFor(b.page, senderId);
    console.log('[L1] receiver entries while playing:', JSON.stringify(liveEntries));
    // Precondition: this must be the AudioContext path (the one that was broken).
    // If it says 'audio', the WAV fixture was rejected / the context stayed
    // suspended and the test would no longer prove anything about the fix.
    expect(liveEntries[0].type).toBe('ctx');
    expect(await playingUsers(b.page)).toContain(senderId);

    // --- MUTE through the real right-click menu, mid-clip.
    await openMemberMenu(b.page, senderId);
    await clickVolumeMenuButton(b.page, 'Mute Soundboard');
    expect(await entriesFor(b.page, senderId)).toHaveLength(0);

    // --- 3s later UNMUTE (menu stayed open; the button flipped in place).
    await b.page.waitForTimeout(3000);
    await clickVolumeMenuButton(b.page, 'Unmute Soundboard');

    // The clip must come back, from where it got to…
    await waitForEntry(b.page, senderId, 15000);
    expect(await playingUsers(b.page)).toContain(senderId);
    const resumedAt = Date.now();

    // …and it must END early (it did not restart from 0). A 14s clip muted at
    // ~2.5s and resumed ~3s later has ~8.5s left; a restart would run ~14s.
    await waitForNoEntry(b.page, senderId, 20000);
    const remainingMs = Date.now() - resumedAt;
    console.log('[L1] ms left after unmute:', remainingMs);
    expect(remainingMs).toBeLessThan(11500);
    expect(remainingMs).toBeGreaterThan(2500);

    await b.ctx.close();
});

// ---------------------------------------------------------------------------
// L2 — owner disable stops that player for everyone, no resume on re-enable
// ---------------------------------------------------------------------------
test('L2: owner Disable stops the player for everyone (others unaffected) and Enable does not resume', async ({ page, context }) => {
    test.setTimeout(300000);
    const owner = await register(page, unique('sbl2own'));
    await waitForWs(page);
    const { serverId, channelId } = await createServer(page);

    const b = await newUser(context, 'sbl2b');
    const c = await newUser(context, 'sbl2c');
    // Clips are per-account: each player must own the clip they play.
    const clip2 = await uploadClip(b.page, 'l2b_' + Date.now(), 22);
    const clip3 = await uploadClip(c.page, 'l2c_' + Date.now(), 22);
    await inviteUser(page, b.page, serverId);
    await inviteUser(page, c.page, serverId);

    await joinVoice(page, serverId, channelId);
    await joinVoice(b.page, serverId, channelId);
    await joinVoice(c.page, serverId, channelId);
    await page.waitForTimeout(2500);

    const uidB = await b.page.evaluate(() => (window as any).currentUserId);
    const uidC = await c.page.evaluate(() => (window as any).currentUserId);

    await playClip(b.page, clip2);
    await playClip(c.page, clip3);
    await waitForEntry(page, uidB, 25000);
    await waitForEntry(page, uidC, 25000);
    console.log('[L2] owner hears both players:', JSON.stringify(await playingUsers(page)));

    // Owner opens their voice popup and right-clicks B's row → Disable Soundboard.
    await ensureServerPopup(page);
    await openMemberMenu(page, uidB);
    await clickVolumeMenuButton(page, 'Disable Soundboard');
    await page.waitForTimeout(1200);

    // B is silenced for everyone; C is untouched.
    expect(await entriesFor(page, uidB)).toHaveLength(0);
    expect(await playingUsers(page)).not.toContain(uidB);
    expect(await entriesFor(page, uidC).then((e) => e.length)).toBeGreaterThan(0);
    // B's own playback stopped too (server told them).
    await waitForNoEntry(b.page, uidB, 15000);

    // --- Re-ENABLE: the clip must NOT come back (disable is a stop, not a mute).
    await clickVolumeMenuButton(page, 'Enable Soundboard');
    await page.waitForTimeout(3000);
    expect(await entriesFor(page, uidB)).toHaveLength(0);
    expect(await playingUsers(page)).not.toContain(uidB);
    expect(await hasResume(page, uidB)).toBe(false);
    console.log('[L2] after re-enable: B still stopped, C still playing =',
        (await entriesFor(page, uidC)).length > 0);

    await b.ctx.close();
    await c.ctx.close();
});

// ---------------------------------------------------------------------------
// L3 — the player's own settings disable stops it for the room; re-enable must
//      not resurrect it
// ---------------------------------------------------------------------------
test('L3: Settings → Voice disable stops the clip for the room and re-enabling does not resume it', async ({ page, context }) => {
    test.setTimeout(240000);
    await register(page, unique('sbl3a'));
    await waitForWs(page);
    const { serverId, channelId } = await createServer(page);
    const clipId = await uploadClip(page, 'l3_' + Date.now(), 20);

    const b = await newUser(context, 'sbl3b');
    await inviteUser(page, b.page, serverId);
    await joinVoice(page, serverId, channelId);
    await joinVoice(b.page, serverId, channelId);
    await page.waitForTimeout(2000);

    const uidA = await page.evaluate(() => (window as any).currentUserId);
    await playClip(page, clipId);
    await waitForEntry(b.page, uidA, 25000);

    // Player turns their soundboard off in Settings → Voice (real checkbox).
    await page.evaluate(() => {
        const cb = document.getElementById('voice-disable-soundboard') as HTMLInputElement;
        cb.checked = true;
        cb.dispatchEvent(new Event('change'));
    });
    await waitForNoEntry(b.page, uidA, 15000);
    expect(await playingUsers(b.page)).not.toContain(uidA);
    expect(await hasResume(b.page, uidA)).toBe(false);

    // Re-enabling must NOT bring the stopped clip back for the room.
    await page.evaluate(() => {
        const cb = document.getElementById('voice-disable-soundboard') as HTMLInputElement;
        cb.checked = false;
        cb.dispatchEvent(new Event('change'));
    });
    await b.page.waitForTimeout(3000);
    expect(await entriesFor(b.page, uidA)).toHaveLength(0);
    expect(await hasResume(b.page, uidA)).toBe(false);

    await b.ctx.close();
});

// ---------------------------------------------------------------------------
// L4 — 🎵 indicators in the channel list + voice popup member row
// ---------------------------------------------------------------------------
test('L4: playing indicator shows in the channel list chip and the voice popup member row', async ({ page, context }) => {
    test.setTimeout(240000);
    await register(page, unique('sbl4a'));
    await waitForWs(page);
    const { serverId, channelId } = await createServer(page);
    const clipId = await uploadClip(page, 'l4_' + Date.now(), 16);

    const b = await newUser(context, 'sbl4b');
    await inviteUser(page, b.page, serverId);
    await joinVoice(page, serverId, channelId);
    await joinVoice(b.page, serverId, channelId);
    await page.waitForTimeout(2000);

    const uidA = await page.evaluate(() => (window as any).currentUserId);
    // Receiver opens their voice popup so both surfaces are on screen.
    await ensureServerPopup(b.page);

    await playClip(page, clipId);
    await waitForEntry(b.page, uidA, 25000);

    // Channel list chip (sidebar) — no popup needed, this is what you see while
    // browsing another channel.
    await b.page.waitForTimeout(800);
    await dumpIndicators(b.page, uidA, channelId);
    await b.page.waitForSelector(sbIndicator.channelChip(channelId, uidA), { timeout: 15000 });
    // Voice popup member row.
    await b.page.waitForSelector(sbIndicator.popupRow(uidA), { timeout: 15000 });
    console.log('[L4] both indicators visible');

    // Stopping clears both.
    await page.evaluate(() => (window as any)._sendSoundboardStop());
    await page.evaluate(() => (window as any)._stopAllSoundboardAudio());
    await b.page.waitForSelector(sbIndicator.channelChip(channelId, uidA), { state: 'detached', timeout: 20000 });
    await b.page.waitForSelector(sbIndicator.popupRow(uidA), { state: 'detached', timeout: 20000 });

    await b.ctx.close();
});

// ---------------------------------------------------------------------------
// L5 — 🎵 indicator in a DM call tile
// ---------------------------------------------------------------------------
test('L5: playing indicator shows on the DM call tile of the player', async ({ page, context }) => {
    test.setTimeout(300000);
    const a = await register(page, unique('sbl5a'));
    await waitForWs(page);
    const clipId = await uploadClip(page, 'l5_' + Date.now(), 18);

    const b = await newUser(context, 'sbl5b');

    // Friends + DM channel (API), then A rings and B answers.
    const fcB = await b.page.evaluate(() => localStorage.getItem('e2e_friend_code'));
    await page.request.post(`${BASE}/api/friends/request`, {
        headers: { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/json' },
        data: { friend_code: fcB },
    });
    const incoming = await (await b.page.request.get(`${BASE}/api/friends/requests/incoming`, {
        headers: { Authorization: `Bearer ${b.body.token}` },
    })).json();
    await b.page.request.post(`${BASE}/api/friends/requests/accept`, {
        headers: { Authorization: `Bearer ${b.body.token}`, 'Content-Type': 'application/json' },
        data: { request_id: incoming[0].id },
    });
    const userB = await (await page.request.get(`${BASE}/api/user/${b.body.user.username}`, {
        headers: { Authorization: `Bearer ${a.token}` },
    })).json();
    const dm = await (await page.request.post(`${BASE}/api/dm/${userB.id}`, {
        headers: { Authorization: `Bearer ${a.token}` },
    })).json();
    expect(dm.id).toBeTruthy();

    await page.evaluate(({ dmId, uid, uname }) => {
        (window as any).VoiceManager.startDmCall(dmId, uid, uname);
    }, { dmId: dm.id, uid: userB.id, uname: b.body.user.username });
    await page.waitForSelector('#dm-call-panel', { state: 'visible', timeout: 25000 });
    await b.page.waitForFunction(() => {
        const vm = (window as any).VoiceManager;
        const inc = document.getElementById('incoming-call-panel');
        if (inc && inc.style.display !== 'none') { vm.acceptDmCall(); return true; }
        return false;
    }, undefined, { timeout: 25000 }).catch(async () => {
        await b.page.evaluate(() => (window as any).VoiceManager.acceptDmCall());
    });
    await b.page.waitForSelector('.dm-call-tile', { timeout: 25000 });
    await page.waitForTimeout(2500);

    const uidA = await page.evaluate(() => (window as any).currentUserId);
    await playClip(page, clipId);
    await waitForEntry(b.page, uidA, 25000);
    await b.page.waitForTimeout(800);
    await dumpIndicators(b.page, uidA, '');

    await b.page.waitForSelector(sbIndicator.dmTile(uidA), { timeout: 15000 });
    console.log('[L5] DM call tile indicator visible');

    await page.evaluate(() => (window as any)._sendSoundboardStop());
    await page.evaluate(() => (window as any)._stopAllSoundboardAudio());
    await b.page.waitForSelector(sbIndicator.dmTile(uidA), { state: 'detached', timeout: 20000 });

    await b.ctx.close();
});

// ---------------------------------------------------------------------------
// L6 — per-user soundboard volume: separate from mic volume, LIVE on a playing
//      clip (verified by measuring the audio level through the gain node)
// ---------------------------------------------------------------------------
async function measureRms(page: Page, uid: string, ms = 500) {
    return page.evaluate(async ({ uid, ms }) => {
        const g = (window as any).__sbGainNodes && (window as any).__sbGainNodes[uid];
        if (!g) return null;
        const ac = g.context;
        const an = ac.createAnalyser();
        an.fftSize = 2048;
        g.connect(an);
        const buf = new Float32Array(an.fftSize);
        let sum = 0, n = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
            an.getFloatTimeDomainData(buf);
            for (let i = 0; i < buf.length; i++) { sum += buf[i] * buf[i]; n++; }
            await new Promise((r) => setTimeout(r, 20));
        }
        try { g.disconnect(an); } catch (_) {}
        return n ? Math.sqrt(sum / n) : 0;
    }, { uid, ms });
}

test('L6: soundboard volume is separate from mic volume and applies LIVE to a playing clip', async ({ page, context }) => {
    test.setTimeout(240000);
    await register(page, unique('sbl6a'));
    await waitForWs(page);
    const { serverId, channelId } = await createServer(page);
    const clipId = await uploadClip(page, 'l6_' + Date.now(), 24);

    const b = await newUser(context, 'sbl6b');
    await inviteUser(page, b.page, serverId);
    await joinVoice(page, serverId, channelId);
    await joinVoice(b.page, serverId, channelId);
    await page.waitForTimeout(2000);

    const ctxState = await unlockSbAudio(b.page);
    console.log('[L6] receiver AudioContext state:', ctxState);

    const uidA = await page.evaluate(() => (window as any).currentUserId);
    // Receiver sets a TIGHTER mic volume first — the soundboard volume must not reuse it.
    await b.page.evaluate((uid: string) => {
        localStorage.setItem('voice_volume_' + uid, '50');
    }, uidA);

    await playClip(page, clipId);
    await waitForEntry(b.page, uidA, 25000);
    await b.page.waitForTimeout(600);
    // Per-user gains only exist on the AudioContext path — assert we are on it.
    expect((await entriesFor(b.page, uidA))[0].type).toBe('ctx');

    // Open the real member menu: it must offer a separate Soundboard volume.
    await ensureServerPopup(b.page);
    await openMemberMenu(b.page, uidA);
    const menuInfo = await b.page.evaluate(() => ({
        labels: Array.from(document.querySelectorAll('#volume-menu .volume-menu-vol-label')).map((e) => (e.textContent || '').trim()),
        hasSbSlider: !!document.querySelector('#volume-menu .sb-volume-slider'),
        hasSbInput: !!document.querySelector('#volume-menu .sb-volume-input'),
        micPct: (document.querySelector('#volume-menu .volume-menu-value') as HTMLElement | null)?.textContent,
    }));
    console.log('[L6] menu:', JSON.stringify(menuInfo));
    expect(menuInfo.labels).toContain('Soundboard volume');
    expect(menuInfo.labels).toContain('Mic volume');
    expect(menuInfo.hasSbSlider).toBe(true);
    expect(menuInfo.hasSbInput).toBe(true);

    const gainBefore = await b.page.evaluate((uid: string) => {
        const g = (window as any).__sbGainNodes[uid];
        return g ? g.gain.value : null;
    }, uidA);
    const rmsBefore = await measureRms(b.page, uidA);
    console.log('[L6] before: gain =', gainBefore, 'rms =', rmsBefore);
    expect(gainBefore).toBeCloseTo(1, 5);
    expect(rmsBefore).toBeGreaterThan(0.02);

    // Type 25 into the custom percentage box (real input events).
    await b.page.fill('#volume-menu .sb-volume-input', '25');
    await b.page.dispatchEvent('#volume-menu .sb-volume-input', 'change');
    await b.page.waitForTimeout(800);

    const gainAfter = await b.page.evaluate((uid: string) => (window as any).__sbGainNodes[uid].gain.value, uidA);
    const rmsAfter = await measureRms(b.page, uidA);
    const stored = await b.page.evaluate((uid: string) => ({
        sb: localStorage.getItem('voice_sb_volume_' + uid),
        mic: localStorage.getItem('voice_volume_' + uid),
    }), uidA);
    const stillPlaying = (await entriesFor(b.page, uidA)).length;
    console.log('[L6] after 25%: gain =', gainAfter, 'rms =', rmsAfter, 'stored =', JSON.stringify(stored), 'still playing =', stillPlaying);

    expect(gainAfter).toBeCloseTo(0.25, 5);
    expect(stored.sb).toBe('25');
    expect(stored.mic).toBe('50');            // mic volume untouched
    expect(stillPlaying).toBe(1);             // the SAME clip is still playing
    expect(rmsAfter).toBeLessThan(rmsBefore * 0.6);
    expect(rmsAfter).toBeGreaterThan(rmsBefore * 0.1);

    // Reset button → back to 100% live.
    await clickVolumeMenuButton(b.page, 'Reset soundboard volume (100%)');
    await b.page.waitForTimeout(400);
    const gainReset = await b.page.evaluate((uid: string) => (window as any).__sbGainNodes[uid].gain.value, uidA);
    const rmsReset = await measureRms(b.page, uidA);
    console.log('[L6] after reset: gain =', gainReset, 'rms =', rmsReset);
    expect(gainReset).toBeCloseTo(1, 5);
    expect(rmsReset).toBeGreaterThan(rmsBefore * 0.6);

    await b.ctx.close();
});
