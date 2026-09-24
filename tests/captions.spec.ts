// 1.7 on-device live captions — FEATURE_PLAN.md.
//
// The plan's exploit review, expressed as tests:
//   (a) the engine must be OFFLINE — no path may fall back to a network
//       recogniser, so with no offline engine captions must simply not start;
//   (b) captions are display-only by DEFAULT, and publishing to the call is a
//       second, separate opt-in over the existing E2EE signal envelope;
//   (c) captions never reach notifications, logs or disk.
//
// The Android box is mocked (there is no real device in this harness), so the
// tests drive the documented bridge contract: captionsAvailable /
// captionsStart / captionsStop plus a `box:caption` event.
import { test, expect, type Page } from '@playwright/test';

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';
const PASSWORD = 'testpass1234';

// Captions only ever run inside the Android box (that is the whole point of the
// offline-engine gate), so the harness is an Android box.
test.use({
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36',
});

function unique(b: string): string {
  return `${b}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

async function register(page: Page, username: string) {
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
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
 * Install a fake Android box bridge. `available` decides whether the device
 * claims to have an OFFLINE recogniser, and the returned object records every
 * invoke plus lets a test emit recognition events.
 */
async function installBridge(page: Page, available: boolean) {
  await page.addInitScript(({ avail }) => {
    const listeners: Record<string, ((ev: any) => void)[]> = {};
    const calls: any[] = [];
    (window as any).__bridgeCalls = calls;
    (window as any).__emitCaption = (payload: any) => {
      (listeners['box:caption'] || []).forEach((fn) => fn({ payload }));
    };
    (window as any).__TAURI__ = {
      core: {
        invoke: (cmd: string, args: any) => {
          calls.push({ cmd, args });
          if (cmd === 'plugin:box-shell|captionsAvailable') {
            return Promise.resolve({ available: avail, onDevice: avail, reason: avail ? '' : 'no-offline-recognizer' });
          }
          if (cmd === 'plugin:box-shell|captionsStart') {
            return avail ? Promise.resolve({}) : Promise.reject(new Error('no-offline-recognizer'));
          }
          if (cmd === 'plugin:box-shell|captionsStop') return Promise.resolve({});
          if (cmd === 'plugin:box-shell|sharedPending') return Promise.resolve({ staged: false });
          if (cmd === 'plugin:box-shell|audioRoutes') return Promise.resolve({ routes: [] });
          if (cmd === 'plugin:box-shell|batteryStatus') return Promise.resolve({ ignoring: false, supported: false });
          return Promise.resolve({});
        },
      },
      event: {
        listen: (name: string, fn: (ev: any) => void) => {
          (listeners[name] = listeners[name] || []).push(fn);
          return Promise.resolve(() => {
            listeners[name] = (listeners[name] || []).filter((f) => f !== fn);
          });
        },
      },
    };
  }, { avail: available });
}

test.describe('1.7 on-device captions', () => {
  test('no offline engine: captions refuse to start and say why', async ({ page }) => {
    await installBridge(page, false);
    await register(page, unique('cap_1'));
    await page.waitForSelector('#captions-status', { state: 'attached' });

    // The status line must state the truth rather than offer a toggle that
    // silently does nothing. (It lives inside a settings panel, so it is read
    // rather than waited to become visible.)
    await expect(page.locator('#captions-status')).toContainText(/offline|recognis/i, { timeout: 15000 });

    const r = await page.evaluate(async () => {
      const started = await (window as any).__captions.start();
      const calls = (window as any).__bridgeCalls.filter((c: any) => c.cmd.includes('captions'));
      return { started, running: (window as any).__captions.isRunning(), calls, status: (window as any).__captions.status() };
    });
    expect(r.started).toBe(false);
    expect(r.running).toBe(false);
    expect(r.status.available).toBe(false);
    // Crucially: captionsStart was NEVER invoked, so no recogniser — offline or
    // otherwise — was ever handed the microphone.
    expect(r.calls.some((c: any) => c.cmd.includes('captionsStart'))).toBe(false);
    expect(await page.locator('#captions-panel.captions-open').count()).toBe(0);
  });

  test('offline engine present: captions start, render, and stay local by default', async ({ page }) => {
    await installBridge(page, true);
    await register(page, unique('cap_2'));

    const r = await page.evaluate(async () => {
      const started = await (window as any).__captions.start();
      (window as any).__emitCaption({ text: 'hello there', final: false });
      (window as any).__emitCaption({ text: 'hello there everyone', final: true });
      return {
        started,
        running: (window as any).__captions.isRunning(),
        lines: (window as any).__captions.lines(),
        panelOpen: !!document.querySelector('#captions-panel.captions-open'),
        publishCalls: (window as any).__captionPublishCalls || null,
      };
    });
    expect(r.started).toBe(true);
    expect(r.running).toBe(true);
    expect(r.panelOpen).toBe(true);
    await expect(page.locator('#captions-panel')).toContainText('hello there everyone');
    // The partial hypothesis is replaced by the final one, not stacked.
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0].text).toBe('hello there everyone');
    expect(r.lines[0].final).toBe(true);
    // Display-only by default: nothing was published to the call.
    expect(await page.evaluate(() => (window as any).__captions.publishEnabled())).toBe(false);
    await expect(page.locator('#captions-mode')).toHaveText(/this device only/i);
  });

  test('publishing captions is a separate opt-in and rides the call channel', async ({ page }) => {
    await installBridge(page, true);
    await register(page, unique('cap_3'));

    // Count what the call layer would send (voice.js's E2EE signal envelope).
    await page.evaluate(() => {
      (window as any).__captionPublishCalls = [];
      (window as any).__voiceSendCaption = (text: string, isFinal: boolean) => {
        (window as any).__captionPublishCalls.push({ text, isFinal });
        return true;
      };
    });

    const before = await page.evaluate(async () => {
      await (window as any).__captions.start();
      (window as any).__emitCaption({ text: 'not published yet', final: true });
      return (window as any).__captionPublishCalls.length;
    });
    expect(before).toBe(0);

    // Only after the SECOND, explicit toggle...
    await page.evaluate(() => {
      const el = document.getElementById('captions-publish-toggle') as HTMLInputElement;
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    await expect(page.locator('#captions-mode')).toHaveText(/published to the call/i);

    const after = await page.evaluate(() => {
      (window as any).__emitCaption({ text: 'and now published', final: true });
      return (window as any).__captionPublishCalls;
    });
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual({ text: 'and now published', isFinal: true });

    // Partials are never published — only finalised lines.
    const partial = await page.evaluate(() => {
      (window as any).__emitCaption({ text: 'half a sentence', final: false });
      return (window as any).__captionPublishCalls.length;
    });
    expect(partial).toBe(1);
  });

  test('a peer’s published caption renders with their name', async ({ page }) => {
    await installBridge(page, true);
    await register(page, unique('cap_4'));
    await page.evaluate(() => {
      (window as any).userDisplayNameCache = { 'peer-1': { display_name: 'Robin' } };
      (window as any).__captionsShowRemote('peer-1', { text: 'can everyone hear me', final: true });
    });
    await expect(page.locator('#captions-panel')).toContainText('Robin');
    await expect(page.locator('#captions-panel')).toContainText('can everyone hear me');
  });

  test('captions never reach disk, the console or notifications', async ({ page }) => {
    await installBridge(page, true);
    await register(page, unique('cap_5'));

    const r = await page.evaluate(async () => {
      const secret = 'the-super-secret-sentence';
      const logs: string[] = [];
      const origLog = console.log, origWarn = console.warn, origErr = console.error;
      console.log = (...a: any[]) => { logs.push(a.join(' ')); };
      console.warn = (...a: any[]) => { logs.push(a.join(' ')); };
      console.error = (...a: any[]) => { logs.push(a.join(' ')); };
      const notifs: string[] = [];
      const RealNotif = (window as any).Notification;
      class SpyNotif {
        static permission = 'granted';
        static requestPermission() { return Promise.resolve('granted'); }
        constructor(title: string, opts: any) { notifs.push(String(title) + ' ' + JSON.stringify(opts || {})); }
        close() {}
      }
      (window as any).Notification = SpyNotif as any;

      await (window as any).__captions.start();
      (window as any).__emitCaption({ text: secret, final: true });
      await new Promise((res) => setTimeout(res, 300));

      console.log = origLog; console.warn = origWarn; console.error = origErr;
      (window as any).Notification = RealNotif;

      const dump = JSON.stringify(Object.keys(localStorage).map((k) => [k, localStorage.getItem(k)]));
      const onDisk = Object.keys(localStorage).filter((k) => (localStorage.getItem(k) || '').includes(secret));
      const sessionDump = JSON.stringify(Object.keys(sessionStorage).map((k) => [k, sessionStorage.getItem(k)]));
      return {
        onDisk,
        inSession: sessionDump.includes(secret),
        inLogs: logs.some((l) => l.includes(secret)),
        inNotifications: notifs.some((n) => n.includes(secret)),
        rendered: !!document.querySelector('#captions-panel')?.textContent?.includes(secret),
        dumpLen: dump.length,
      };
    });
    expect(r.rendered).toBe(true);        // it is shown...
    expect(r.onDisk).toEqual([]);         // ...and nowhere else
    expect(r.inSession).toBe(false);
    expect(r.inLogs).toBe(false);
    expect(r.inNotifications).toBe(false);
  });

  test('stopping captions releases the engine and drops the lines', async ({ page }) => {
    await installBridge(page, true);
    await register(page, unique('cap_6'));
    const r = await page.evaluate(async () => {
      await (window as any).__captions.start();
      (window as any).__emitCaption({ text: 'temporary words', final: true });
      const had = (window as any).__captions.lines().length;
      await (window as any).__captions.stop();
      return {
        had,
        lines: (window as any).__captions.lines().length,
        running: (window as any).__captions.isRunning(),
        stopped: (window as any).__bridgeCalls.some((c: any) => c.cmd.includes('captionsStop')),
        visible: !!document.querySelector('#captions-panel.captions-open'),
      };
    });
    expect(r.had).toBe(1);
    expect(r.lines).toBe(0);
    expect(r.running).toBe(false);
    expect(r.stopped).toBe(true);
    expect(r.visible).toBe(false);
  });
});
