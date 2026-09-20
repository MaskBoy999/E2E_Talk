// Probe the live box for the notification path and the tile/permission behaviour.
//   E2E_BOX_DEBUG_PORT=9334 node tools/box/probe-notify.mjs
import { chromium } from 'playwright';

const port = process.env.E2E_BOX_DEBUG_PORT || '9333';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const page = browser.contexts()[0].pages()[0];

const out = await page.evaluate(async () => {
    const res = {
        notificationPermission: typeof Notification !== 'undefined' ? Notification.permission : 'absent',
        hasRequestPermission: typeof Notification?.requestPermission === 'function',
        hasTauri: typeof window.__TAURI__,
        requestResult: null,
        err: null,
    };
    try {
        if (res.hasRequestPermission) res.requestResult = await Notification.requestPermission();
    } catch (e) {
        res.err = String(e && e.message ? e.message : e);
    }
    return res;
});
console.log(JSON.stringify(out, null, 2));
await browser.close();
