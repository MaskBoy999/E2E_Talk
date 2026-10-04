// Show the native "clear all app data" overlay on a running box, including
// while the main window is unreachable — the state the whole window exists for.
//
//   E2E_BOX_DEBUG_PORT=9333 node tools/box/probe-wipe-overlay.mjs
//
// It lists every webview target, reloads the main one (so a dead host lands on
// Chromium's own error page), and then reports whether the overlay is still
// there, whether its button is visible and where it sits, and whether the panel
// still opens from it. Read-only: it never presses "Erase everything".
import { chromium } from 'playwright';

const port = process.env.E2E_BOX_DEBUG_PORT || '9333';
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
const pages = browser.contexts().flatMap((c) => c.pages());
console.log('targets:', pages.map((p) => p.url()).join('  |  '));

const overlay = pages.find((p) => p.url().includes('box-wipe.html'));
const main = pages.find((p) => p.url().startsWith('http') && !p.url().includes('box-wipe.html'));
if (!overlay) {
    console.error('no box-wipe.html target — is the box running with E2E_BOX_DEBUG_PORT set?');
    process.exit(1);
}

if (main) {
    console.log('before reload -> main:', main.url());
    await main.reload().catch((e) => console.log('reload refused (expected when the host is down):', String(e.message).split('\n')[0]));
    await new Promise((r) => setTimeout(r, 800));
    console.log('after reload  -> main:', main.url(), '| title:', await main.title().catch(() => '?'));
}

console.log('overlay present:', overlay.url());
console.log('button visible:', await overlay.locator('#wipe-button').isVisible());
console.log('button box:', JSON.stringify(await overlay.locator('#wipe-button').boundingBox()));
await overlay.locator('#wipe-button').click();
console.log('panel opens:', await overlay.locator('#panel').isVisible());
await overlay.locator('#wipe-cancel').click();
// Closing is a round trip through the shell (it owns the window size), so wait
// for the view to switch rather than sampling immediately.
let closed = true;
try {
    await overlay.locator('#panel').waitFor({ state: 'hidden', timeout: 3000 });
} catch {
    closed = false;
}
console.log('cancel closes the panel:', closed);

// Optional: exercise "Hide this button". Hiding is deliberately invisible to
// the page's DOM (the shell hides the *window*), so the real proof is the OS
// window list — see this file's header. Nothing can bring it back in the same
// run; reopening the app does.
if (process.env.E2E_BOX_PROBE_HIDE === '1') {
    await overlay.locator('#wipe-button').click();
    await overlay.locator('#wipe-hide').click();
    console.log('hide pressed — the shell should hide its window and keep it hidden');
}

await browser.close();
