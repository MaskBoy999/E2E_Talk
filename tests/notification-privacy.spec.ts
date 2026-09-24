import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const PASSWORD = 'testpass1234';

function unique(b: string): string {
    return `${b}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASSWORD);
    await page.fill('#register-confirm-password', PASSWORD);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 60000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

/**
 * A notification is handed to the OPERATING SYSTEM: Windows files it in its
 * notification database, a phone paints it in the shade and can paint it on the
 * lock screen. Anything named there therefore leaves the app's end-to-end
 * boundary and outlives it — the class of leak behind the reports of an OS
 * handing over another messenger's notifications.
 *
 * Since 0.2.30 that is enforced unconditionally: a notification says only THAT
 * something happened. It must never carry:
 *   * message content,
 *   * a sender's name of any kind (the @username is plaintext server metadata,
 *     but it is still identity handed to the OS, and the setting that used to
 *     choose is gone),
 *   * a display name / nickname (end-to-end encrypted),
 *   * a server, channel or category name (also end-to-end encrypted),
 * while the in-app inbox may still show all of them (it never leaves the app).
 */
test.describe('notifications never carry end-to-end encrypted data', () => {
    test('a notification names nobody — not the sender, not a nickname', async ({ page }) => {
        await register(page, unique('notifpriv'));

        const result = await page.evaluate(() => {
            const w = window as any;
            // A nickname that exists ONLY as decrypted E2E data.
            w.userDisplayNameCache['u-secret'] = { display_name: 'TopSecretNickname', username: 'bob' };
            w.dmConversations = [{
                dm_channel_id: 'dm-1',
                other_user_id: 'u-secret',
                other_username: 'bob',
                other_display_name: 'TopSecretNickname',
            }];
            return {
                dm: w.notifText('dm', { userId: 'u-secret', dm: true }),
                mention: w.notifText('mention', { username: 'bob', dm: false }),
                reply: w.notifText('reply', { username: 'bob', dm: false }),
                call: w.notifText('call', { username: 'bob', dm: true }),
                unknown: w.notifText('dm', { userId: 'nobody', dm: true }),
                known: w.notifText('dm', { userId: 'u-secret', dm: true }),
            };
        });

        expect(result.dm.title).toBe('E2E Chat');
        expect(result.mention.title).toBe('E2E Chat');
        expect(result.reply.title).toBe('E2E Chat');
        expect(result.call.title).toBe('E2E Chat');

        // Nothing about the sender — known or unknown, nickname or @username.
        const all = JSON.stringify(result);
        expect(all).not.toContain('TopSecretNickname');
        expect(all).not.toContain('display_name');
        expect(all).not.toContain('@bob');
        expect(all).not.toContain('bob');
        // A sender we know and one we do not produce byte-identical text: the
        // notification cannot be used to tell anything about who sent it.
        expect(result.unknown).toEqual(result.known);
        expect(result.unknown).toEqual(result.dm);
    });

    test('server, channel and category names never reach the notification text', async ({ page }) => {
        await register(page, unique('notifnames'));

        const result = await page.evaluate(() => {
            const w = window as any;
            w.userDisplayNameCache['u-1'] = { display_name: 'NicknameLeak', username: 'carol' };
            return {
                mention: w.notifText('mention', { username: 'carol', dm: false }),
                reply: w.notifText('reply', { username: 'carol', dm: false }),
                dmMention: w.notifText('mention', { username: 'carol', dm: true }),
            };
        });

        // Only the two SAFE place words may appear — no sender at all.
        expect(result.mention.body).toBe('You were mentioned in a server');
        expect(result.reply.body).toBe('New reply in a server');
        expect(result.dmMention.body).toBe('You were mentioned in a server');
        for (const text of [result.mention, result.reply, result.dmMention]) {
            expect(JSON.stringify(text)).not.toContain('#');
            expect(JSON.stringify(text)).not.toContain('NicknameLeak');
            expect(JSON.stringify(text)).not.toContain('carol');
        }
    });

    test('there is no switch to turn it off, and no stale preference can', async ({ page }) => {
        await register(page, unique('notifhide'));

        const result = await page.evaluate(() => {
            const w = window as any;
            // Every value the old toggle could have left behind. None of them
            // may change what a notification says: the setting is gone, so the
            // only safe reading of a leftover key is "ignore it" (and boot
            // deletes it).
            localStorage.setItem('notifHidePreview', 'false');
            const withFalse = w.notifText('dm', { username: 'bob', dm: true });
            localStorage.setItem('notifHidePreview', 'true');
            const withTrue = w.notifText('dm', { username: 'bob', dm: true });
            localStorage.removeItem('streamerMode');
            const withStreamerOff = w.notifText('dm', { username: 'bob', dm: true });
            return {
                withFalse,
                withTrue,
                withStreamerOff,
                toggle: !!document.getElementById('notif-hide-preview'),
                hiddenFn: w.notifContentHidden(),
            };
        });

        for (const text of [result.withFalse, result.withTrue, result.withStreamerOff]) {
            expect(text.title).toBe('E2E Chat');
            expect(text.body).toBe('New direct message');
        }
        expect(result.toggle, 'Settings must not expose the removed switch').toBe(false);
        expect(result.hiddenFn).toBe(true);

        // A leftover preference is deleted at boot, so an old device cannot even
        // keep a "hide content = false" around to be picked up again.
        await page.evaluate(() => localStorage.setItem('notifHidePreview', 'false'));
        await page.reload();
        await page.waitForSelector('#current-user', { timeout: 20000 });
        expect(await page.evaluate(() => localStorage.getItem('notifHidePreview'))).toBeNull();
    });

    test('the Android box gets a silhouette drawable as the notification icon, not the launcher icon', async ({ page }) => {
        await page.addInitScript(() => {
            // Look like the Android box: Tauri bridge + Android UA.
            Object.defineProperty(navigator, 'userAgent', {
                get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36',
                configurable: true,
            });
            (window as any).__TAURI__ = { core: { invoke: () => Promise.resolve(null) } };
            const captured: any[] = [];
            (window as any).__notifications = captured;
            class FakeNotification {
                static permission = 'granted';
                static requestPermission = () => Promise.resolve('granted');
                onclick: (() => void) | null = null;
                constructor(title: string, options: any) { captured.push({ title, options }); }
                close() {}
            }
            (window as any).Notification = FakeNotification;
        });
        await register(page, unique('notificon'));

        await page.evaluate(() => {
            // The Android box only posts while BACKGROUNDED (chat.js gate) —
            // Playwright reports the page visible, so stand in for the OS here.
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            (window as any).showBrowserNotification('E2E Chat', 'New message');
        });

        const seen = await page.evaluate(() => (window as any).__notifications);
        expect(seen.length).toBeGreaterThan(0);
        // A drawable NAME — the plugin resolves it against `res/drawable`, and
        // Android masks a small icon to its alpha, so the full-colour launcher
        // icon there came out as a shapeless white blob.
        expect(seen[seen.length - 1].options.icon).toBe('ic_notification');
    });

    // ── F1–F3: the NATIVE surfaces (FEATURE_PLAN.md §1) ──────────────────
    // notifText() polices the web funnel; these tests pin the paths that go
    // around it: the Android call-service plugin and the desktop box's toast.

    function mockAndroidBox(page: Page) {
        return page.addInitScript(() => {
            Object.defineProperty(navigator, 'userAgent', {
                get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0 Mobile Safari/537.36',
                configurable: true,
            });
            const invokes: any[] = [];
            (window as any).__invokes = invokes;
            (window as any).__TAURI__ = {
                core: {
                    invoke: (cmd: string, args: any) => { invokes.push({ cmd, args }); return Promise.resolve(null); },
                },
                event: { emit: () => Promise.resolve() },
            };
            class FakeNotification {
                static permission = 'granted';
                static requestPermission = () => Promise.resolve('granted');
                onclick: (() => void) | null = null;
                constructor(public title: string, public options: any) {}
                close() {}
            }
            (window as any).Notification = FakeNotification;
        });
    }

    test('F1: the native call-service label comes from the room TYPE — never a channel name', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('f1label'));

        const result = await page.evaluate(() => {
            const w = window as any;
            const vm = w.VoiceManager;
            const S = vm._debug.state;
            // S.channelName is a DECRYPTED E2EE channel name in the real app.
            S.roomType = 'server';
            S.channelName = 'DecryptedSecretChannel';
            w.__invokes.length = 0;
            vm.boxCallService('start');
            const serverLabel = (w.__invokes.find((i: any) => i.cmd === 'plugin:call-service|start') || {}).args?.channelName;

            S.roomType = 'dm';
            w.__invokes.length = 0;
            vm.boxCallService('updateMedia');
            const dmLabel = (w.__invokes.find((i: any) => i.cmd === 'plugin:call-service|updateMedia') || {}).args?.channelName;

            S.roomType = null;
            S.channelName = '';
            return { serverLabel, dmLabel, everything: JSON.stringify(w.__invokes) };
        });

        expect(result.serverLabel).toBe('Voice call');
        expect(result.dmLabel).toBe('Direct call');
        // The decrypted name must not appear anywhere in what went to native.
        expect(result.everything).not.toContain('DecryptedSecretChannel');
    });

    test('F2: the native ring is name-free, with nothing left to override it', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('f2ring'));

        const result = await page.evaluate(async () => {
            const w = window as any;
            const vm = w.VoiceManager;
            // Backgrounded: only then does showIncomingCall post natively.
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            const call = { callerId: 'u-1', callerUsername: 'bob', dmChannelId: 'dm-f2' };
            const lastIncoming = () => {
                const hits = w.__invokes.filter((i: any) => i.cmd === 'plugin:call-service|incomingCall');
                return hits.length ? hits[hits.length - 1].args : {};
            };

            // The old preference, in the state that used to make the ring name
            // the caller. It must change nothing now.
            w.localStorage.setItem('notifHidePreview', 'false');
            w.__invokes.length = 0;
            vm.showIncomingCall(call);
            const args = lastIncoming();
            vm.hideIncomingCall();
            w.localStorage.removeItem('notifHidePreview');
            // document.hidden override is page-local; nothing to restore.
            await new Promise((r) => setTimeout(r, 50));
            return { args, everything: JSON.stringify(w.__invokes) };
        });

        // The caller's name is not sent at all — not as a flag to ignore, and
        // not as a name for native to hold: the notifier has no named branch.
        expect(result.args.callerName).toBeUndefined();
        expect(result.args.hideIdentity).toBeUndefined();
        expect(result.everything).not.toContain('bob');
        expect(result.args.dmChannelId).toBe('dm-f2');
    });

    test('F3 desktop: the box asks Rust for an expiring toast instead of the shim', async ({ page }) => {
        await page.addInitScript(() => {
            const emitted: any[] = [];
            (window as any).__emitted = emitted;
            (window as any).__posted = [];
            (window as any).__TAURI__ = {
                core: { invoke: () => Promise.resolve(null) },
                event: { emit: (name: string, payload: any) => { emitted.push({ name, payload }); return Promise.resolve(); } },
            };
            class FakeNotification {
                static permission = 'granted';
                static requestPermission = () => Promise.resolve('granted');
                onclick: (() => void) | null = null;
                constructor(title: string, options: any) { (window as any).__posted.push({ title, options }); }
                close() {}
            }
            (window as any).Notification = FakeNotification;
            // Desktop box: Tauri bridge present, UA NOT Android (default).
        });
        await register(page, unique('f3desk'));

        await page.evaluate(() => {
            const w = window as any;
            w.__emitted.length = 0;
            w.__posted.length = 0;
            w.showBrowserNotification('Mentioned by @bob', 'You were mentioned in a channel');
        });

        const { emitted, posted } = await page.evaluate(() => ({
            emitted: (window as any).__emitted,
            posted: (window as any).__posted,
        }));

        // Through the event channel — Rust then shows a tagged, expiring toast
        // (tauri-plugin-notification has NO close on desktop; shim cards used
        // to sit in the Windows Action Center database indefinitely).
        expect(emitted.length).toBe(1);
        expect(emitted[0].name).toBe('box:notify');
        expect(emitted[0].payload.title).toBe('Mentioned by @bob');
        expect(emitted[0].payload.ttl).toBe(10);
        // …and NOT through the shim (which can never be closed).
        expect(posted.length).toBe(0);
    });

    test('F3 Android: every posted card is cancelled by id once its time is up', async ({ page }) => {
        await mockAndroidBox(page);
        await register(page, unique('f3cancel'));

        const result = await page.evaluate(async () => {
            const w = window as any;
            const posted: any[] = [];
            const Orig = w.Notification;
            // Capture opts: this FakeNotification has no usable close(), the
            // exact shape of the plugin shim — cancellation must go by id.
            w.Notification = class extends Orig {
                constructor(title: string, options: any) { posted.push({ title, options }); super(title, options); }
            };
            Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
            w.showBrowserNotification.closeMs = 40;
            w.__invokes.length = 0;
            w.showBrowserNotification('E2E Chat', 'New direct message');
            await new Promise((r) => setTimeout(r, 300));
            w.Notification = Orig;
            return { posted, invokes: w.__invokes.slice() };
        });

        expect(result.posted.length).toBe(1);
        const id = result.posted[0].options.id;
        expect(typeof id).toBe('number');
        // The card got an explicit id…
        const cancel = result.invokes.find((i: any) => i.cmd === 'plugin:notification|cancel');
        expect(cancel, 'the card must be cancelled from the shade/history').toBeTruthy();
        // …and the cancel names exactly that id.
        expect(cancel.args.notifications).toEqual([id]);
    });
});
