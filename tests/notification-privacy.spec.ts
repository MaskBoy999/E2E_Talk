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
 * So a notification may name only the plaintext metadata the server already
 * holds (the sender's @username). It must never carry:
 *   * message content,
 *   * a display name / nickname (end-to-end encrypted),
 *   * a server, channel or category name (also end-to-end encrypted),
 * while the in-app inbox may still show all of them (it never leaves the app).
 */
test.describe('notifications never carry end-to-end encrypted data', () => {
    test('the sender is the plaintext @username — a display name is never used', async ({ page }) => {
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
            };
        });

        expect(result.dm.title).toContain('@bob');
        expect(result.mention.title).toContain('@bob');
        expect(result.reply.title).toContain('@bob');
        expect(result.call.title).toContain('@bob');

        // The display name must not appear anywhere in any of them, in any form.
        const all = JSON.stringify(result);
        expect(all).not.toContain('TopSecretNickname');
        expect(all).not.toContain('display_name');

        // An unknown sender degrades to a generic word, never to a leaked name.
        expect(result.unknown.title).toBe('New DM from Someone');
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

        // Only the sender and the two SAFE place words may be named.
        expect(result.mention.body).toBe('You were mentioned in a channel');
        expect(result.reply.body).toBe('New reply in a channel');
        expect(result.dmMention.body).toBe('You were mentioned in a direct message');
        for (const text of [result.mention, result.reply, result.dmMention]) {
            expect(JSON.stringify(text)).not.toContain('#');
            expect(JSON.stringify(text)).not.toContain('NicknameLeak');
        }
    });

    test('"hide message content in notifications" blanks the sender too', async ({ page }) => {
        await register(page, unique('notifhide'));

        const result = await page.evaluate(() => {
            const w = window as any;
            localStorage.setItem('notifHidePreview', 'true');
            const hidden = {
                dm: w.notifText('dm', { username: 'bob', dm: true }),
                mention: w.notifText('mention', { username: 'bob', dm: false }),
                reply: w.notifText('reply', { username: 'bob', dm: false }),
                call: w.notifText('call', { username: 'bob', dm: true }),
            };
            // The toggle in Settings must be the same switch the notifier reads.
            const toggle = document.getElementById('notif-hide-preview') as HTMLInputElement | null;
            localStorage.removeItem('notifHidePreview');
            return { hidden, hasToggle: !!toggle, streamsHidden: w.notifText('dm', { username: 'bob', dm: true }) };
        });

        for (const text of Object.values(result.hidden)) {
            expect(JSON.stringify(text)).not.toContain('@bob');
            expect((text as any).title).toBe('E2E Chat');
        }
        expect(result.hasToggle, 'Settings → Notifications must expose the switch').toBe(true);
        // With the setting off again, the sender is named once more.
        expect(result.streamsHidden.title).toContain('@bob');
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

    test('F2: the native ring carries the hide-preview flag, in both states', async ({ page }) => {
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

            w.localStorage.removeItem('notifHidePreview');
            w.__invokes.length = 0;
            vm.showIncomingCall(call);
            const visibleArgs = lastIncoming();
            vm.hideIncomingCall();

            w.localStorage.setItem('notifHidePreview', 'true');
            w.__invokes.length = 0;
            vm.showIncomingCall(call);
            const hiddenArgs = lastIncoming();
            vm.hideIncomingCall();

            w.localStorage.removeItem('notifHidePreview');
            // document.hidden override is page-local; nothing to restore.
            await new Promise((r) => setTimeout(r, 50));
            return { visibleArgs, hiddenArgs };
        });

        // Visible mode: the named ring still goes out (plaintext @username is
        // server-known metadata) but the flag must say so explicitly…
        expect(result.visibleArgs.hideIdentity).toBe(false);
        expect(result.visibleArgs.callerName).toBe('bob');
        // …and with "hide message content" on, native must be told to post a
        // name-free, lock-screen-private card.
        expect(result.hiddenArgs.hideIdentity).toBe(true);
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
