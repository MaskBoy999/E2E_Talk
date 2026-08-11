import { test, expect } from '@playwright/test';

// Probe: reproduce the app's tile layout (flex row, two 16:9 tiles, one
// rotated 90°) and measure whether the rotated tile overlaps its sibling.
// Verifies the NEW app formula exactly as implemented in applyTileTransform:
//   slot = (bh*s, bw*s) portrait; video layout = (bw*s, bh*s) rotated 90°.
test('rotation overlap geometry — new app formula', async ({ page }) => {
    await page.setContent(`
        <style>
            body { margin: 0; background: #111; }
            .row {
                display: flex; gap: 8px; align-items: center; justify-content: flex-end;
                height: 96px; width: 600px; background: #222; position: relative;
            }
            .tile { height: 96px; width: 170px; flex: 0 0 auto; background: #060; border: 1px solid #fff; }
        </style>
        <div class="row">
            <div class="tile" id="cam"></div>
            <div class="tile" id="scr"></div>
        </div>
    `);

    // Apply the exact new formula from voice.js applyTileTransform
    const fix = await page.evaluate(() => {
        const cam = document.getElementById('cam') as any;
        const scr = document.getElementById('scr') as any;
        const bw = cam.offsetWidth, bh = cam.offsetHeight;
        const parent = cam.parentElement as any;
        const pw = parent.clientWidth, ph = parent.clientHeight;
        const s = Math.min(1, pw > 0 ? pw / bh : 1, ph > 0 ? ph / bw : 1);
        const Vw = Math.max(1, Math.round(bh * s));  // slot width  (portrait)
        const Vh = Math.max(1, Math.round(bw * s));  // slot height
        const slot = document.createElement('div');
        slot.className = 'voice-tile-slot';
        slot.style.cssText = 'position:relative;flex:0 0 auto;display:flex;align-items:center;justify-content:center;overflow:hidden;background:#000;border:1px solid #0ff;width:' + Vw + 'px;height:' + Vh + 'px;';
        const next = cam.nextSibling;
        cam.remove();
        slot.appendChild(cam);
        if (next) parent.insertBefore(slot, next); else parent.appendChild(slot);
        cam.style.cssText = 'flex:0 0 auto;max-width:none !important;max-height:none !important;object-fit:contain;border:none;background:transparent;width:' + Vh + 'px;height:' + Vw + 'px;transform:rotate(90deg);';
        const r = (el: any) => { const b = el.getBoundingClientRect(); return { w: Math.round(b.width), h: Math.round(b.height), left: Math.round(b.left), right: Math.round(b.right), top: Math.round(b.top), bottom: Math.round(b.bottom) }; };
        return { cam: r(cam), slot: r(slot), scr: r(scr), slotLayout: { w: slot.offsetWidth, h: slot.offsetHeight } };
    });
    console.log('NEW-FORMULA cam=', JSON.stringify(fix.cam), 'slot=', JSON.stringify(fix.slot), 'scr=', JSON.stringify(fix.scr), 'slotLayout=', JSON.stringify(fix.slotLayout));
    // 1) No overlap with the sibling tile
    expect(fix.cam.right).toBeLessThanOrEqual(fix.scr.left);
    // 2) Rotated visual == slot (allow the slot's 1px border)
    expect(Math.abs(fix.cam.w - fix.slot.w)).toBeLessThanOrEqual(2);
    expect(Math.abs(fix.cam.h - fix.slot.h)).toBeLessThanOrEqual(2);
    // 3) Rotated feed is PORTRAIT (taller than wide) and fills the row height
    expect(fix.cam.h).toBeGreaterThan(fix.cam.w);
    expect(fix.cam.h).toBeLessThanOrEqual(96);

    // 4) Unrotate -> slot removed, video back in the row, no leftover
    const back = await page.evaluate(() => {
        const cam = document.getElementById('cam') as any;
        const slot = cam.parentElement as any;
        const media = slot.parentElement as any;
        media.insertBefore(cam, slot);
        slot.remove();
        ['width', 'height', 'maxWidth', 'maxHeight'].forEach((p: string) => cam.style.removeProperty(p));
        cam.style.transform = '';
        const b = cam.getBoundingClientRect();
        return { w: Math.round(b.width), h: Math.round(b.height), left: Math.round(b.left), right: Math.round(b.right), slotGone: !document.querySelector('.voice-tile-slot') };
    });
    console.log('UNROTATED cam=', JSON.stringify(back));
    expect(back.slotGone).toBe(true);
    expect(back.w).toBeGreaterThan(back.h); // back to landscape
    // Back in normal flow: sits immediately before the screen tile (gap 8).
    const scr = await page.evaluate(() => {
        const b = (document.getElementById('scr') as any).getBoundingClientRect();
        return { left: Math.round(b.left) };
    });
    expect(back.right + 8).toBe(scr.left);
});
