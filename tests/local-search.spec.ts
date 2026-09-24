// 5.7 on-device search index — FEATURE_PLAN.md.
//
// The index is built from messages we already decrypted, matched locally, and
// sent nowhere. These tests cover the plan's rules: disappearing messages are
// never indexed, the index is bounded (rotates), device-only mode answers
// without touching the network, and the panic wipe takes the index with it.
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

test.describe('5.7 on-device search index', () => {
  test('indexes decrypted text, matches locally, and never sends the query', async ({ page }) => {
    await register(page, unique('local_1'));
    const sent: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('/api/search') || u.includes('/search/index')) sent.push(u);
    });

    // Device-only mode: the whole point is that nothing about the message or
    // the query leaves the machine, so this is the mode that must be silent.
    await page.evaluate(() => localStorage.setItem('localSearchOnly', '1'));
    const r = await page.evaluate(() => {
      const T = (window as any).__localSearchTest;
      const msg = (s: string) => JSON.stringify({ type: 'text', text: s });
      T.clear();
      T.queue(null, 'dm-a', 'msg-1', msg('the quarterly numbers look good'), {});
      T.queue(null, 'dm-a', 'msg-2', msg('unrelated chatter'), { sender_user_id: 'u9', timestamp: 1700000000000 });
      return {
        hit: T.query('quarterly', null, 50),
        miss: T.query('zzz-nothing', null, 50),
        stored: T.count(),
        meta: T.query('unrelated', null, 50)[0],
      };
    });

    expect(r.stored).toBe(2);
    expect(r.hit).toHaveLength(1);
    expect(r.hit[0].id).toBe('msg-1');
    expect(r.hit[0].text).toContain('quarterly');
    expect(r.hit[0].sender).toBeNull();
    expect(r.miss).toHaveLength(0);
    // The second entry kept the metadata the result row renders with.
    expect({ sender: r.meta.sender, ts: r.meta.ts, kind: r.meta.kind, cid: r.meta.cid })
      .toEqual({ sender: 'u9', ts: 1700000000000, kind: 'dm', cid: 'dm-a' });

    // Indexing locally must not have caused a server round-trip by itself.
    await page.waitForTimeout(2000);
    expect(sent).toEqual([]);
  });

  test('disappearing messages are never indexed and never uploaded', async ({ page }) => {
    await register(page, unique('local_2'));
    const sent: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (u.includes('/search')) sent.push(u);
    });

    await page.evaluate(() => localStorage.setItem('localSearchOnly', '1'));
    const r = await page.evaluate(() => {
      const T = (window as any).__localSearchTest;
      const msg = (s: string) => JSON.stringify({ type: 'text', text: s });
      T.clear();
      // expires_at set => disappearing => must not be stored anywhere.
      T.queue(null, 'dm-b', 'burn-1', msg('this one self destructs'), { expires_at: 1700000000 });
      const afterBurn = T.count();
      T.queue(null, 'dm-b', 'keep-1', msg('this one is durable'), {});
      return {
        afterBurn,
        burn: T.query('destructs', null, 50),
        keep: T.query('durable', null, 50).length,
        stored: T.count(),
      };
    });

    expect(r.afterBurn).toBe(0);
    expect(r.burn).toHaveLength(0);
    expect(r.keep).toBe(1);
    expect(r.stored).toBe(1);

    // And nothing about the disappearing message went to the server either.
    await page.waitForTimeout(2000);
    expect(sent).toEqual([]);
  });

  test('the index is bounded — oldest entries rotate out at the limit', async ({ page }) => {
    await register(page, unique('local_3'));
    const r = await page.evaluate(() => {
      const T = (window as any).__localSearchTest;
      T.clear();
      // Seed exactly at the bound, then add one more.
      const entries = [];
      for (let i = 0; i < T.max; i++) {
        entries.push({ id: 'seed-' + i, kind: 'dm', cid: 'dm-c', sid: null, sender: null, ts: i, text: 'seeded ' + i });
      }
      localStorage.setItem(T.key, JSON.stringify({ v: 1, entries }));
      const seeded = T.count();
      T.queue(null, 'dm-c', 'newest', JSON.stringify({ type: 'text', text: 'newest entry' }), {});
      return { seeded, after: T.count(), max: T.max, hits: T.query('newest', null, 50).length };
    });
    expect(r.seeded).toBe(r.max);
    // Adding the (max+1)th entry rotates the OLDEST one out, so the count is
    // capped rather than growing without bound.
    expect(r.after).toBeLessThanOrEqual(r.max);
    expect(r.hits).toBe(1);
  });

  test('the stored copy is ciphertext, not plaintext', async ({ page }) => {
    await register(page, unique('local_4'));
    const r = await page.evaluate(() => {
      const T = (window as any).__localSearchTest;
      T.clear();
      T.queue(null, 'dm-d', 'ct-1', JSON.stringify({ type: 'text', text: 'super secret phrase' }), {});
      const raw = T.raw() || '';
      return { len: raw.length, plain: raw.includes('super secret phrase') };
    });
    // secure-storage encrypts e2e_-prefixed keys at rest, so the on-disk value
    // must not contain the message text.
    expect(r.len).toBeGreaterThan(0);
    expect(r.plain).toBe(false);
  });

  test('device-only mode is a real switch and the palette answers from it', async ({ page }) => {
    await register(page, unique('local_5'));
    const hits: string[] = [];
    await page.route('**/*', async (route) => {
      const u = route.request().url();
      if (u.includes('/search')) hits.push(u);
      await route.continue();
    });

    // Default: off.
    expect(await page.evaluate(() => (window as any).__localSearchTest.only())).toBe(false);

    await page.evaluate(() => {
      const T = (window as any).__localSearchTest;
      T.clear();
      T.queue(null, 'dm-e', 'pal-1', JSON.stringify({ type: 'text', text: 'palette lightning check' }), {});
    });

    // Flip the Settings → Privacy toggle and confirm it persisted.
    await page.evaluate(() => {
      const el = document.getElementById('local-search-only-toggle') as HTMLInputElement;
      el.checked = true;
      el.dispatchEvent(new Event('change'));
    });
    expect(await page.evaluate(() => localStorage.getItem('localSearchOnly'))).toBe('1');
    expect(await page.evaluate(() => (window as any).__localSearchTest.only())).toBe(true);

    // Open the palette (Ctrl+K) and search: the result comes from the device
    // index and NOTHING matching /search is requested.
    await page.keyboard.press('Control+k');
    await page.waitForSelector('#search-input', { state: 'visible', timeout: 10000 });
    await page.fill('#search-input', 'lightning');
    await page.waitForSelector('.search-result-item', { timeout: 10000 });
    await expect(page.locator('.search-result-item').first()).toContainText('palette lightning check');
    await expect(page.locator('.search-result-item').first()).toHaveAttribute('data-mid', 'pal-1');
    expect(hits).toEqual([]);
  });

  test('the panic wipe takes the index with it', async ({ page }) => {
    await register(page, unique('local_6'));
    await page.evaluate(() => {
      const T = (window as any).__localSearchTest;
      T.clear();
      T.queue(null, 'dm-f', 'pw-1', JSON.stringify({ type: 'text', text: 'about to be wiped' }), {});
      localStorage.setItem('localSearchOnly', '1');
    });
    expect(await page.evaluate(() => (window as any).__localSearchTest.count())).toBe(1);

    await page.evaluate(() => (window as any).panicWipe('test'));
    await page.waitForURL(/login\.html/, { timeout: 20000 });
    await page.waitForTimeout(1000);
    const left = await page.evaluate(() => ({
      index: localStorage.getItem('e2e_local_search'),
      pref: localStorage.getItem('localSearchOnly'),
    }));
    expect(left.index).toBeNull();
    // The preference is not session state, but an explicit wipe is explicit.
    expect(left.pref).toBeNull();
  });

  test('scope filtering keeps a channel search out of DM hits', async ({ page }) => {
    await register(page, unique('local_7'));
    const r = await page.evaluate(() => {
      const T = (window as any).__localSearchTest;
      const msg = (s: string) => JSON.stringify({ type: 'text', text: s });
      T.clear();
      T.queue('chan-1', null, 'c-1', msg('shared keyword here'), {});
      T.queue(null, 'dm-g', 'd-1', msg('shared keyword here'), {});
      return {
        all: T.query('shared keyword', null, 50).length,
        chan: T.query('shared keyword', { type: 'channel', channelId: 'chan-1' }, 50).map((e: any) => e.id),
        dm: T.query('shared keyword', { type: 'dm', dmChannelId: 'dm-g' }, 50).map((e: any) => e.id),
      };
    });
    expect(r.all).toBe(2);
    expect(r.chan).toEqual(['c-1']);
    expect(r.dm).toEqual(['d-1']);
  });
});
