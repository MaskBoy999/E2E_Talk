// Read the live state of a running Website-in-a-Box window over CDP.
//   E2E_BOX_DEBUG_PORT=9333 node tools/box/probe-box-live.mjs
import { chromium } from 'playwright';

const port = process.env.E2E_BOX_DEBUG_PORT || '9333';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const ctx = browser.contexts()[0];
const pages = ctx.pages();
console.log('pages:', pages.length);
for (const p of pages) {
    console.log('--- url:', p.url(), '| title:', await p.title());
    const state = await p.evaluate(async () => {
        const out = {
            url: location.href,
            title: document.title,
            bodyText: (document.body?.innerText || '').slice(0, 300),
            hasAppRoot: !!document.getElementById('app') || !!document.getElementById('server-list'),
            // Setup screen only: what the app says went wrong on the last launch.
            launchError: (document.getElementById('launch-error')?.textContent || '').trim() || null,
            pinChecked: document.getElementById('pin-cert')?.checked ?? null,
            pinDisabled: document.getElementById('pin-cert')?.disabled ?? null,
            perms: {},
        };
        for (const name of ['microphone', 'camera', 'notifications']) {
            try {
                const st = await navigator.permissions.query({ name });
                out.perms[name] = st.state;
            } catch (e) {
                out.perms[name] = 'err:' + e.message;
            }
        }
        return out;
    });
    console.log(JSON.stringify(state, null, 2));
}
await browser.close();
