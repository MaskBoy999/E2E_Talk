import { test, expect, type Page } from '@playwright/test';

/**
 * The icon-pack filter (static/icon-packs.js).
 *
 * A pack is markup the user chose, and it is inserted into the app's own DOM —
 * so the filter is the only thing between an uploaded file and the page. It was
 * a blocklist: it deleted <script>, on* handlers and `javascript:`, and it was
 * bypassable in ways nothing tested:
 *
 *   - `<animate attributeName="href" values="//evil.example/x.png"/>` made the
 *     icon point at a remote URL, a request the app then makes for the user.
 *   - `style="background-image:url(http://evil.example/x)"` fetched too, and
 *     `position:fixed;inset:0` painted over the app.
 *   - `<image href="data:image/svg+xml;…">` smuggled in a picture that can name
 *     remote sub-resources of its own.
 *
 * It is now an allow-list: an element or attribute that is not named is removed
 * with its subtree, so the default is "gone" rather than "kept unless I thought
 * of it". These tests run the real file, loaded by the real app.
 */

const BASE = process.env.E2E_TEST_BASE_URL || 'https://localhost:3443';

async function openAppWithIconPacks(page: Page) {
  const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  await page.goto(`${BASE}/login.html`);
  await page.evaluate(() => localStorage.clear());
  await page.goto(`${BASE}/login.html`);
  await page.waitForSelector('#show-register', { timeout: 20000 });
  await page.click('#show-register');
  await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 10000 });
  await page.fill('#register-username', `san_${ts}`);
  await page.fill('#register-password', 'testpass123');
  await page.fill('#register-confirm-password', 'testpass123');
  await page.click('#register-form button[type="submit"]');
  await page.waitForURL('**/index.html', { timeout: 60000 });
  await page.waitForFunction(() => typeof (window as any).IconPacks?.sanitize === 'function', null, {
    timeout: 20000,
  });
}

/** sanitize() every case in the page, once. */
function sanitizeAll(page: Page, inputs: Record<string, string>) {
  return page.evaluate((batch: Record<string, string>) => {
    const s = (window as any).IconPacks.sanitize as (m: string) => string;
    const out: Record<string, string> = {};
    for (const [name, markup] of Object.entries(batch)) {
      try {
        out[name] = s(markup);
      } catch (err) {
        out[name] = `THREW: ${String(err)}`;
      }
    }
    return out;
  }, inputs);
}

test.describe('icon pack sanitising', () => {
  test('keeps what an icon is made of, and drops what can act or fetch', async ({ page }) => {
    await openAppWithIconPacks(page);
    const out = await sanitizeAll(page, {
      // ── what a real icon looks like ──────────────────────────────────────
      shape: '<path d="M4 4h16" fill="none" stroke="currentColor" stroke-width="1.5"/>',
      viewBoxCase: '<g viewBox="0 0 24 24"><circle cx="12" cy="12" r="5"/></g>',
      gradient:
        '<defs><linearGradient id="g" gradientTransform="rotate(45)">' +
        '<stop offset="0" stop-color="#fff" stop-opacity="0.5"/></linearGradient></defs>' +
        '<use href="#g"/><rect fill="url(#g)"/>',
      animation:
        '<circle cx="12" cy="12" r="6" fill="#ed4245">' +
        '<animate attributeName="opacity" values="0.5;0;0.5" dur="2s" repeatCount="indefinite"/></circle>',
      picture:
        '<image href="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" ' +
        'x="0" y="0" width="4" height="4" preserveAspectRatio="none"/>',
      paint:
        '<path style="fill:#fff;stroke:red;stroke-width:2" d="M0 0h1"/>',

      // ── what the old blocklist let through ───────────────────────────────
      animateHref:
        '<image width="4" height="4"><animate attributeName="href" ' +
        'values="//evil.example/a.png" dur="1s"/></image>',
      styleUrl: '<rect style="fill:url(http://evil.example/a.svg#x)"/>',
      styleOverlay:
        '<path style="position:fixed;inset:0;background-image:url(https://evil.example/x.png);fill:red" d="M0 0h1"/>',
      svgPicture:
        '<image href="data:image/svg+xml;base64,PHN2Zy8+" width="4" height="4"/>',

      // ── the classics it did catch ────────────────────────────────────────
      script: '<path d="M0 0h1"/><script>alert(1)</script>',
      handler: '<path onload="alert(1)" d="M0 0h1"/>',
      jsHref: '<a href="javascript:alert(1)"><rect width="1" height="1"/></a>',
      remoteHref: '<image href="https://evil.example/x.png" width="4" height="4"/>',
      protoRelative: '<use href="//evil.example/x"/>',
      foreignObject:
        '<foreignObject><div xmlns="http://www.w3.org/1999/xhtml">stolen</div></foreignObject>',
      styleElement: '<style>* { background: url(http://evil.example/x) }</style><rect width="1" height="1"/>',
      filter: '<filter id="f"><feImage href="https://evil.example/x.png"/></filter><rect filter="url(#f)"/>',

      // ── markup that cannot be trusted to have a shape ────────────────────
      entity: '<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><path d="&x;"/>',
      escapesWrapper: '</svg><img src=x onerror=alert(1)>',
      notSvg: 'not markup at all <<<',
      empty: '',
    });

    // An icon survives as an icon: geometry, paint, gradients, animation, a
    // picture, and inline paint styles.
    expect(out.shape, out.shape).toContain('d="M4 4h16"');
    expect(out.shape).toContain('stroke="currentColor"');
    expect(out.viewBoxCase).toContain('viewBox="0 0 24 24"');
    expect(out.gradient).toContain('linearGradient');
    expect(out.gradient).toContain('gradientTransform="rotate(45)"');
    expect(out.gradient).toContain('stop-color="#fff"');
    expect(out.gradient).toContain('href="#g"');
    expect(out.gradient).toContain('url(#g)');
    expect(out.animation).toContain('attributeName="opacity"');
    expect(out.animation).toContain('repeatCount="indefinite"');
    expect(out.animation).toContain('values="0.5;0;0.5"');
    expect(out.picture).toContain('data:image/gif;base64,');
    expect(out.paint).toContain('fill:#fff');

    // The two things the blocklist missed: an animation rewriting where an icon
    // points, and a style attribute reaching outside the app or over it.
    expect(out.animateHref, 'SMIL must not be able to rewrite href').not.toContain('evil');
    expect(out.animateHref).not.toContain('attributeName');
    expect(out.styleUrl).not.toContain('evil');
    expect(out.styleOverlay, 'style may not position anything').not.toContain('position');
    expect(out.styleOverlay).not.toContain('evil');
    expect(out.styleOverlay).not.toContain('background-image');
    // …while the paint in the same declaration list is kept.
    expect(out.styleOverlay).toContain('fill:red');
    expect(out.svgPicture, 'an SVG picture can name its own remote sub-resources').not.toContain(
      'svg+xml',
    );

    // Nothing that acts, and nothing that fetches.
    for (const [name, markup] of Object.entries(out)) {
      if (name === 'notSvg' || name === 'escapesWrapper' || name === 'entity') continue;
      expect(markup, `${name} must not contain a script tag`).not.toMatch(/<script/i);
      expect(markup, `${name} must not contain an event handler`).not.toMatch(/\son\w+\s*=/i);
      expect(markup, `${name} must not contain javascript:`).not.toMatch(/javascript\s*:/i);
      expect(markup, `${name} must not fetch anything`).not.toMatch(/https?:\/\/(?!www\.w3\.org)/i);
      expect(markup, `${name} must not smuggle an entity`).not.toContain('passwd');
      expect(markup, `${name} must not throw`).not.toContain('THREW:');
    }
    expect(out.script).not.toContain('alert');
    expect(out.script).toContain('M0 0h1');
    expect(out.handler).not.toContain('alert');
    expect(out.handler).toContain('M0 0h1');
    expect(out.jsHref).not.toContain('alert');
    expect(out.remoteHref).not.toContain('evil');
    expect(out.protoRelative).not.toContain('evil');
    expect(out.foreignObject, 'foreignObject is not geometry').not.toContain('stolen');
    expect(out.styleElement).not.toContain('evil');
    expect(out.styleElement).not.toContain('<style');
    expect(out.filter).not.toContain('evil');
    expect(out.filter).not.toContain('feImage');

    // Markup whose shape is unknown is dropped, not guessed at.
    expect(out.entity).toBe('');
    expect(out.escapesWrapper).toBe('');
    expect(out.notSvg).toBe('');
    expect(out.empty).toBe('');
  });

  test('the built-in pulsing live icon is still an icon after filtering', async ({ page }) => {
    await openAppWithIconPacks(page);
    // #icon-live is the app's own artwork and the only built-in that animates
    // (SMIL). If the allow-list broke animations, applying any pack to `live`
    // would silently stop the pulse — so the app's own markup is run through
    // the filter and has to come out animating.
    const result = await page.evaluate(() => {
      const sym = document.getElementById('icon-live')!;
      const before = sym.innerHTML;
      const after = (window as any).IconPacks.sanitize(before) as string;
      return { before, after };
    });
    expect(result.before).toContain('<animate');
    expect(result.after).toContain('<animate');
    expect(result.after).toContain('attributeName="r"');
    expect(result.after).toContain('indefinite');
    expect(result.after).toContain('fill="#ed4245"');
  });

  test('a parsed pack has already been filtered — the filter runs on the way in', async ({ page }) => {
    await openAppWithIconPacks(page);
    const parsed = await page.evaluate(() => {
      const text =
        '<svg xmlns="http://www.w3.org/2000/svg">' +
        '<symbol id="icon-copy" viewBox="0 0 24 24">' +
        '<path d="M1 1h2" onload="alert(1)"/><script>alert(2)</script>' +
        '<rect width="2" height="2" fill="url(https://evil.example/x)"/>' +
        '</symbol></svg>';
      const res = (window as any).IconPacks.parsePack(text) as {
        icons: Record<string, { inner: string; viewBox: string | null }>;
        error?: string;
      };
      return { entry: res.icons.copy || null, error: res.error || null };
    });
    expect(parsed.error, parsed.error ?? '').toBeNull();
    expect(parsed.entry, 'the good shape must survive the pack parse').not.toBeNull();
    expect(parsed.entry!.inner).toContain('M1 1h2');
    expect(parsed.entry!.inner).not.toContain('alert');
    expect(parsed.entry!.inner).not.toContain('onload');
    expect(parsed.entry!.inner).not.toContain('evil');
    expect(parsed.entry!.viewBox).toBe('0 0 24 24');
  });

  test('filtering is idempotent, so re-applying a stored pack changes nothing', async ({ page }) => {
    await openAppWithIconPacks(page);
    // A stored pack is filtered again on the way back into the DOM, so a second
    // pass has to be a no-op — otherwise an icon would change shape each time it
    // was restored.
    const result = await page.evaluate(() => {
      const s = (window as any).IconPacks.sanitize as (m: string) => string;
      const inputs = [
        '<defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs>' +
          '<path d="M0 0h4" stroke="url(#g)" style="fill:#fff;stroke-width:1"/>',
        '<image href="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7" width="4" height="4"/>',
        '<path onload="alert(1)" href="https://evil.example/x" d="M0 0h1"/>',
      ];
      return inputs.map((markup) => {
        const once = s(markup);
        return { once, twice: s(once) };
      });
    });
    for (const { once, twice } of result) {
      expect(twice, 'sanitize(sanitize(x)) must equal sanitize(x)').toBe(once);
    }
  });
});
