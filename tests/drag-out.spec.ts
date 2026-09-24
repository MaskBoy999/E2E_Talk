// 3.5 drag files out (FEATURE_PLAN.md).
//
// A drag fires dragstart synchronously while decryption is async, so the file
// is warmed on press and attached at dragstart as Chromium's `DownloadURL`
// (mime:filename:blob-url) — the format that makes an OS drop target receive a
// real file. A drag that catches the warm-up still running must be refused, not
// handed over empty.
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

/** A real-looking file card, plus a stubbed decrypt so no upload is needed. */
async function installCard(page: Page, id: string, delayMs = 0) {
  await page.evaluate(({ id, delayMs }: { id: string; delayMs: number }) => {
    (window as any).__toasts = [];
    (window as any).showToast = (m: string) => { (window as any).__toasts.push(m); };
    (window as any).__decryptCalls = [];
    (window as any).downloadAndDecryptFile = async (fileId: string) => {
      (window as any).__decryptCalls.push(fileId);
      if (delayMs) await new Promise((r) => setTimeout(r, delayMs));
      return new Blob([new Uint8Array([1, 2, 3, 4])], { type: 'image/png' });
    };
    const card = document.createElement('div');
    card.className = 'file-card';
    card.dataset.fileId = id;
    card.dataset.fileKey = 'a2V5';              // non-empty: no recovery needed
    card.dataset.fileName = 'photo.png';
    card.dataset.fileMime = 'image/png';
    card.dataset.fileSize = '4';
    document.getElementById('message-list')!.appendChild(card);
  }, { id, delayMs });
}

test.describe('3.5 drag files out', () => {
  test('a warmed card hands the OS a DownloadURL with the decrypted blob', async ({ page }) => {
    await register(page, unique('dragout_warm'));
    await installCard(page, 'file-warm');

    const res = await page.evaluate(async () => {
      const card = document.querySelector('.file-card[data-file-id="file-warm"]') as HTMLElement;
      card.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      // The press arms DRAGGABLE and starts the warm-up.
      const armedAfterPress = card.draggable;
      await new Promise((r) => setTimeout(r, 250));
      const dt = new DataTransfer();
      const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
      card.dispatchEvent(ev);
      return {
        armedAfterPress,
        prevented: ev.defaultPrevented,
        downloadUrl: dt.getData('DownloadURL'),
        uriList: dt.getData('text/uri-list'),
        decrypted: (window as any).__decryptCalls,
        toasts: (window as any).__toasts,
      };
    });
    expect(res.armedAfterPress).toBe(true);
    expect(res.prevented).toBe(false);          // a real drag went through
    expect(res.decrypted).toEqual(['file-warm']);
    expect(res.downloadUrl).toMatch(/^image\/png:photo\.png:blob:/);
    expect(res.uriList).toMatch(/^blob:/);
    expect(res.toasts).toEqual([]);             // no apology needed
  });

  test('a cold drag is refused with a word to the user, then works on the next try', async ({ page }) => {
    await register(page, unique('dragout_cold'));
    await installCard(page, 'file-cold', 400);  // slow decrypt

    const first = await page.evaluate(() => {
      const card = document.querySelector('.file-card[data-file-id="file-cold"]') as HTMLElement;
      // No pointerdown: straight to a drag, the warm-up has not run at all.
      const dt = new DataTransfer();
      const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
      card.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, downloadUrl: dt.getData('DownloadURL'), toasts: (window as any).__toasts };
    });
    expect(first.prevented).toBe(true);                 // bogus drop blocked
    expect(first.downloadUrl ?? '').toBe('');            // nothing handed over
    expect(first.toasts.join(' ')).toContain('again in a moment');

    // The refusal also kicked the warm-up, so the retry succeeds.
    const second = await page.evaluate(async () => {
      await new Promise((r) => setTimeout(r, 600));
      const card = document.querySelector('.file-card[data-file-id="file-cold"]') as HTMLElement;
      const dt = new DataTransfer();
      const ev = new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: dt });
      card.dispatchEvent(ev);
      return { prevented: ev.defaultPrevented, downloadUrl: dt.getData('DownloadURL') };
    });
    expect(second.prevented).toBe(false);
    expect(second.downloadUrl).toMatch(/^image\/png:photo\.png:blob:/);
  });

  test('warmed blob URLs are revoked with the other blob URLs', async ({ page }) => {
    await register(page, unique('dragout_revoke'));
    await installCard(page, 'file-revoke');

    const after = await page.evaluate(async () => {
      const card = document.querySelector('.file-card[data-file-id="file-revoke"]') as HTMLElement;
      card.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 250));
      const url = eval('_dragOutCache')['file-revoke'].url;
      const revoked: string[] = [];
      const orig = URL.revokeObjectURL.bind(URL);
      URL.revokeObjectURL = (u: string) => { revoked.push(u); orig(u); };
      // Leaving the channel revokes every blob URL — including this one.
      (window as any).revokeBlobUrls();
      URL.revokeObjectURL = orig;
      return { url, revoked, cached: Object.keys(eval('_dragOutCache')).length };
    });
    expect(after.revoked).toContain(after.url);
    expect(after.cached).toBe(0);
  });

  test('the drag-out path reuses the Save-as decryption (no new trust)', () => {
    const home = process.cwd();
    const js = readFileSync(home + '/static/chat.js', 'utf8');
    expect(js).toContain("setData('DownloadURL'");
    // Same helpers the download button uses.
    expect(js).toMatch(/warmDragOut[\s\S]{0,1200}downloadAndDecryptFile\(/);
    expect(js).toMatch(/warmDragOut[\s\S]{0,1200}recoverAttachmentFileKey\(/);
    // The cache is revoked with the rest of the blob URLs.
    expect(js).toMatch(/function revokeBlobUrls\(\)[\s\S]{0,900}_dragOutCache = \{\}/);
  });
});
