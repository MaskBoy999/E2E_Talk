// Batch B (1.3 audio routing / 4.2 mini window / 3.3 region snip / 3.4 share-in
// / 4.4 deep links / 2.3 Quick Settings tile) — runtime + static assertions.
//
// Everything here targets what the code ACTUALLY exposes. The shell-only paths
// (TileService registration, share trampoline, setCommunicationDevice) are
// asserted textually, like android-plugin-startup.spec.ts does.
import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

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

test.describe('Batch B features', () => {
  // ── 1.3 audio output routing ──────────────────────────────────────────
  test('1.3 output picker is a real control and lists the OS output devices', async ({ page }) => {
    await register(page, unique('batchb_audio'));
    await expect(page.locator('#audio-output-select')).toHaveCount(1);

    const routes = await page.evaluate(async () => {
      (navigator.mediaDevices as any).enumerateDevices = async () => [
        { kind: 'audiooutput', deviceId: 'dev1', label: 'Speakers' },
        { kind: 'audiooutput', deviceId: 'dev2', label: 'Headset' },
        { kind: 'audioinput', deviceId: 'mic1', label: 'Mic' },
      ];
      const info = await (window as any).VoiceManager.listAudioOutputs();
      await (window as any).VoiceManager.setAudioOutput('dev2');
      return info.routes.map((r: any) => r.id);
    });
    expect(routes).toEqual(['dev1', 'dev2']);
    // refreshAudioOutputSelect() repopulates asynchronously — wait for it.
    await page.waitForFunction(() =>
      document.querySelectorAll('#audio-output-select option').length === 3);
    const sel = await page.evaluate(() => {
      const s = document.getElementById('audio-output-select') as HTMLSelectElement;
      return { values: Array.from(s.options).map((o) => o.value), chosen: s.value };
    });
    // '' (system default) + the two devices, and the choice stuck.
    expect(sel.values).toEqual(['', 'dev1', 'dev2']);
    expect(sel.chosen).toBe('dev2');
  });

  test('1.3 on the Android box the picker asks the shell for the real route', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
        configurable: true,
      });
      (window as any).__calls = [];
      (window as any).__TAURI__ = {
        core: {
          invoke: async (cmd: string, args: any) => {
            (window as any).__calls.push([cmd, args]);
            if (cmd === 'plugin:box-shell|audioRoutes') {
              return {
                routes: [
                  { id: '2', name: 'Speaker', type: 'speaker' },
                  { id: '7', name: 'Bluetooth', type: 'bluetooth' },
                ],
                current: '2',
              };
            }
            return { ok: true };
          },
        },
      };
    });
    await register(page, unique('batchb_audio_android'));

    const out = await page.evaluate(async () => {
      const info = await (window as any).VoiceManager.listAudioOutputs();
      await (window as any).VoiceManager.setAudioOutput('7');
      return { info, calls: (window as any).__calls };
    });
    expect(out.info.android).toBe(true);
    expect(out.info.routes.map((r: any) => r.id)).toEqual(['2', '7']);
    // read the routes, then push the chosen one at the real AudioManager.
    // (The app's own boot makes unrelated calls, so look the two up.)
    const cmds = out.calls.map((c: any[]) => c[0]);
    expect(cmds).toContain('plugin:box-shell|audioRoutes');
    const setCall = out.calls.find((c: any[]) => c[0] === 'plugin:box-shell|setAudioRoute');
    expect(setCall?.[1]).toEqual({ id: '7' });
  });

  // ── 4.2 mini call window ──────────────────────────────────────────────
  test('4.2 the voice-bar button asks the shell to open the mini window', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__emits = [];
      (window as any).__TAURI__ = {
        event: {
          emit: (name: string, payload: any) => { (window as any).__emits.push([name, payload]); },
          listen: async () => () => {},
        },
      };
    });
    await register(page, unique('batchb_mini'));
    const emits = await page.evaluate(() => {
      const before = (window as any).__emits.length;
      document.getElementById('voice-bar-mini')!.click();
      // Everything after the click — the app makes its own emits at boot.
      return (window as any).__emits.slice(before);
    });
    expect(emits).toEqual([['box:mini-window', { open: true }]]);
  });

  test('4.2 ?mini=1 renders ONLY the controls view and never boots the app', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__emits = [];
      (window as any).__TAURI__ = {
        event: {
          emit: (name: string, payload: any) => { (window as any).__emits.push([name, payload]); },
          listen: async () => () => {},
        },
      };
    });
    // No registration: the mini view must work before (and without) any session.
    await page.goto(`${BASE}/index.html?mini=1`);
    await expect(page.locator('#mini-call-bar')).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.classList.contains('mini-window'))).toBe(true);
    // The chat chrome is hidden by the mini stylesheet.
    await expect(page.locator('#sidebar')).toBeHidden();
    // ...and no socket was opened / no redirect to login happened.
    expect(page.url()).toContain('mini=1');

    // Buttons drive the MAIN window over events instead of acting locally.
    const emits = await page.evaluate(() => {
      document.getElementById('mini-mute')!.click();
      document.getElementById('mini-deafen')!.click();
      document.getElementById('mini-hangup')!.click();
      document.getElementById('mini-close')!.click();
      return (window as any).__emits;
    });
    expect(emits).toEqual([
      ['box:mini-control', { action: 'mute' }],
      ['box:mini-control', { action: 'deafen' }],
      ['box:mini-control', { action: 'hangup' }],
      ['box:mini-window', { open: false }],
    ]);

    // State pushed by the main window is rendered as a status line.
    await page.evaluate(() => (window as any).__miniApplyState({ in_call: true, muted: true, deafened: false, peers: 3 }));
    await expect(page.locator('#mini-status')).toContainText('In call');
    await expect(page.locator('#mini-status')).toContainText('muted');
    await expect(page.locator('#mini-status')).toContainText('3 peer');
    await expect(page.locator('#mini-mute')).toHaveText('Unmute');
  });

  test('4.2 the main window acts on the mini window\'s buttons', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__listeners = {};
      (window as any).__TAURI__ = {
        event: {
          emit: () => {},
          listen: async (name: string, cb: any) => { (window as any).__listeners[name] = cb; return () => {}; },
        },
      };
    });
    await register(page, unique('batchb_mini_ctrl'));
    const res = await page.evaluate(async () => {
      const before = (window as any).VoiceManager.getState().muted;
      const cb = (window as any).__listeners['box:mini-control'];
      if (!cb) return { missing: true };
      cb({ payload: { action: 'mute' } });
      await new Promise((r) => setTimeout(r, 50));
      return { before, after: (window as any).VoiceManager.getState().muted };
    });
    expect(res.missing).toBeUndefined();
    expect(res.after).not.toBe(res.before);
  });

  // ── 3.3 region snip ───────────────────────────────────────────────────
  test('3.3 snip overlay opens, cancels, and crops into the composer queue', async ({ page }) => {
    await register(page, unique('batchb_snip'));

    // The overlay itself: opens over the frame, Esc/cancel tears it down.
    const opened = await page.evaluate(() => {
      const c = document.createElement('canvas');
      c.width = 200; c.height = 120;
      const ctx = c.getContext('2d')!;
      ctx.fillStyle = '#123456'; ctx.fillRect(0, 0, 200, 120);
      (window as any).openSnipOverlay(c, 200, 120);
      const has = !!document.getElementById('snip-overlay')
        && !!document.getElementById('snip-use')
        && !!document.getElementById('snip-cancel');
      document.getElementById('snip-cancel')!.click();
      return { has, gone: !document.getElementById('snip-overlay') };
    });
    expect(opened.has).toBe(true);
    expect(opened.gone).toBe(true);

    // Dragging a rectangle and committing hands a real PNG to the file queue.
    const queued = await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 200; c.height = 120;
      c.getContext('2d')!.fillRect(0, 0, 200, 120);
      (window as any).openSnipOverlay(c, 200, 120);
      const img = document.getElementById('snip-img') as HTMLCanvasElement;
      const box = img.getBoundingClientRect();
      const fire = (type: string, x: number, y: number) =>
        document.getElementById('snip-overlay')!.dispatchEvent(new MouseEvent(type, {
          bubbles: true, clientX: x, clientY: y,
        }));
      fire('mousedown', box.left + 10, box.top + 10);
      fire('mousemove', box.left + 110, box.top + 90);
      fire('mouseup', box.left + 110, box.top + 90);
      (document.getElementById('snip-use') as HTMLButtonElement).click();
      await new Promise((r) => setTimeout(r, 500));
      // handleFileSelect() clears the input and opens the upload modal — the
      // crop reaching THAT modal is the real hand-off.
      const modal = document.getElementById('upload-modal');
      const info = document.getElementById('upload-file-info');
      return {
        overlayGone: !document.getElementById('snip-overlay'),
        modalShown: !!modal && getComputedStyle(modal).display !== 'none',
        info: info ? info.textContent : null,
      };
    });
    expect(queued.overlayGone).toBe(true);
    expect(queued.modalShown).toBe(true);
    expect(queued.info).toMatch(/snip-\d+\.png/);
  });

  test('3.3 the attach menu offers the snip action and it is wired', async ({ page }) => {
    await register(page, unique('batchb_snip_btn'));
    await expect(page.locator('.attach-popup-item[data-action="snip"]')).toHaveCount(1);
    expect(await page.evaluate(() => typeof (window as any).snipScreenRegion)).toBe('function');
  });

  // ── 3.4 share-into-app ────────────────────────────────────────────────
  test('3.4 staged share content lands in the composer, then is consumed', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
        configurable: true,
      });
      (window as any).__calls = [];
      (window as any).__TAURI__ = {
        core: {
          invoke: async (cmd: string, args: any) => {
            (window as any).__calls.push([cmd, args]);
            if (cmd === 'plugin:box-shell|sharedPending') {
              return { staged: true, text: 'shared from gallery', files: [{ name: 'pic.png', mime: 'image/png' }] };
            }
            if (cmd === 'plugin:box-shell|sharedRead') {
              return { name: 'pic.png', mime: 'image/png', dataB64: btoa('PNGDATA') };
            }
            return null;
          },
        },
      };
    });
    await register(page, unique('batchb_share'));
    const res = await page.evaluate(async () => {
      const ta = document.getElementById('message-input') as HTMLTextAreaElement | null;
      if (ta) ta.value = '';
      await (window as any).pollSharedIntoComposer();
      await new Promise((r) => setTimeout(r, 300));
      const modal = document.getElementById('upload-modal');
      const info = document.getElementById('upload-file-info');
      return {
        text: ta ? ta.value : null,
        modalShown: !!modal && getComputedStyle(modal).display !== 'none',
        info: info ? info.textContent : null,
        calls: (window as any).__calls.map((c: any[]) => c[0]),
      };
    });
    expect(res.text).toContain('shared from gallery');
    expect(res.modalShown).toBe(true);
    expect(res.info).toContain('pic.png');
    expect(res.calls).toContain('plugin:box-shell|sharedPending');
    expect(res.calls).toContain('plugin:box-shell|sharedRead');
    // Consumed once: the FIFO is read, then dropped — in that order.
    const readAt = res.calls.indexOf('plugin:box-shell|sharedRead');
    const discardAt = res.calls.indexOf('plugin:box-shell|sharedDiscard');
    expect(discardAt).toBeGreaterThan(readAt);
  });

  test('3.4 an empty FIFO is a no-op (no discard, no toast)', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'userAgent', {
        get: () => 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36',
        configurable: true,
      });
      (window as any).__calls = [];
      (window as any).__TAURI__ = {
        core: {
          invoke: async (cmd: string, args: any) => {
            (window as any).__calls.push(cmd);
            return cmd === 'plugin:box-shell|sharedPending' ? { staged: false } : null;
          },
        },
      };
    });
    await register(page, unique('batchb_share_empty'));
    const calls = await page.evaluate(async () => {
      const before = (window as any).__calls.length;
      await (window as any).pollSharedIntoComposer();
      return (window as any).__calls.slice(before);
    });
    // Nothing staged: the poll touches nothing beyond the single probe.
    expect(calls).toEqual(['plugin:box-shell|sharedPending']);
  });

  // ── 4.4 deep links ────────────────────────────────────────────────────
  test('4.4 deep-link handler accepts only in-scope id routes', async ({ page }) => {
    await register(page, unique('batchb_deeplink'));
    const res = await page.evaluate(() => {
      const out: any = {};
      // An unknown (not-yet-rendered) id is remembered, not dropped silently.
      localStorage.removeItem('pendingDeepLink');
      out.unknownOk = (window as any).__handleDeepLink('e2e-chat://channel/abc123');
      out.pending = localStorage.getItem('pendingDeepLink');

      // A row that IS on screen is clicked straight away.
      const row = document.createElement('a');
      row.className = 'channel-item';
      row.setAttribute('data-id', 'live1');
      let clicked = 0;
      row.addEventListener('click', (e) => { e.preventDefault(); clicked++; });
      document.body.appendChild(row);
      out.liveOk = (window as any).__handleDeepLink('e2e-chat://channel/live1');
      out.clicked = clicked;

      // DM form.
      localStorage.removeItem('pendingDeepLink');
      out.dmOk = (window as any).__handleDeepLink('e2e-chat://dm/u42');
      out.dmPending = localStorage.getItem('pendingDeepLink');

      // Everything below must be REFUSED outright.
      localStorage.removeItem('pendingDeepLink');
      out.foreign = (window as any).__handleDeepLink('https://example.com/channel/abc');
      out.ownSchemeBadRoute = (window as any).__handleDeepLink('e2e-chat://invite/srv1/chan1?token=abc');
      out.query = (window as any).__handleDeepLink('e2e-chat://channel/abc?x=1');
      out.creds = (window as any).__handleDeepLink('e2e-chat://evil@channel/abc');
      out.traversal = (window as any).__handleDeepLink('e2e-chat://channel/../../etc/passwd');
      out.empty = (window as any).__handleDeepLink('');
      out.stillNothing = localStorage.getItem('pendingDeepLink');
      return out;
    });
    expect(res.unknownOk).toBe(true);
    expect(JSON.parse(res.pending)).toEqual({ type: 'channel', id: 'abc123' });
    expect(res.liveOk).toBe(true);
    expect(res.clicked).toBe(1);
    expect(res.dmOk).toBe(true);
    expect(JSON.parse(res.dmPending)).toEqual({ type: 'dm', id: 'u42' });
    for (const key of ['foreign', 'ownSchemeBadRoute', 'query', 'creds', 'traversal', 'empty']) {
      expect(res[key]).toBe(false);
    }
    expect(res.stillNothing).toBeNull();
  });

  // ── 2.3 / 3.4 / 4.4 shell wiring (static) ─────────────────────────────
  test('shell manifest + Kotlin declare the tile, the share trampoline and the scheme', () => {
    const home = process.cwd();

    const boxManifest = readFileSync(
      home + '/src-tauri/plugins/box-shell/android/src/main/AndroidManifest.xml', 'utf8');
    expect(boxManifest).toContain('android.intent.action.SEND');
    expect(boxManifest).toContain('.SharedContentActivity');
    expect(boxManifest).toMatch(/android:exported="true"/);
    // Never a real UI: the trampoline finishes immediately.
    expect(boxManifest).toContain('Theme.NoDisplay');
    const shareKt = readFileSync(
      home + '/src-tauri/plugins/box-shell/android/src/main/java/com/e2echat/boxshell/SharedContentActivity.kt', 'utf8');
    expect(shareKt).toContain('stageShared');
    expect(shareKt).toContain('finish()');

    const callManifest = readFileSync(
      home + '/src-tauri/plugins/call-service/android/src/main/AndroidManifest.xml', 'utf8');
    expect(callManifest).toContain('android.service.quicksettings.action.QS_TILE');
    expect(callManifest).toContain('CallTileService');
    expect(callManifest).toContain('BIND_QUICK_SETTINGS_TILE');
    const tileKt = readFileSync(
      home + '/src-tauri/plugins/call-service/android/src/main/java/com/e2echat/callservice/CallTileService.kt', 'utf8');
    expect(tileKt).toContain(': TileService()');
    // Tile labels are compile-time literals — no message content can reach the
    // system UI process through the tile.
    expect(tileKt).not.toMatch(/\$\{/);

    const conf = JSON.parse(readFileSync(home + '/src-tauri/tauri.conf.json', 'utf8'));
    expect(JSON.stringify(conf)).toContain('e2e-chat');

    const buildRs = readFileSync(home + '/src-tauri/plugins/box-shell/build.rs', 'utf8');
    for (const cmd of ['audioRoutes', 'setAudioRoute', 'sharedPending', 'sharedRead', 'sharedDiscard']) {
      expect(buildRs).toContain(cmd);
    }
    expect(buildRs).not.toContain('setSecureMode');
  });
});
