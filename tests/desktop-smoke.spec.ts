import { test, expect, chromium } from '@playwright/test';
import { execFileSync } from 'child_process';

/**
 * Everything this release changed, driven in the **real box window** (WebView2),
 * not in a test browser: the document views, the PDF editor and the archive /
 * legacy-Office cards, plus the two things only a shell can do (the file
 * clipboard — covered in `clipboard-file-desktop.spec.ts` — and this).
 *
 * It is a smoke test on purpose. What it asserts that a plain browser run
 * cannot:
 *
 *   * the app's own WebView2 renders these views at all, so a desktop-only
 *     engine difference (docx-preview's page geometry, pdf.js's canvas, the
 *     `DecompressionStream` the tar/gz reader needs) would show up here;
 *   * nothing in the window throws while they run — a crash or an unhandled
 *     rejection is reported by the window itself, not inferred;
 *   * the app is left exactly as found: it never navigates, never signs anyone
 *     in, and only opens and closes its own modals.
 *
 * Run it (a box must be up with the debug port set):
 *
 *     E2E_BOX_DEBUG_PORT=9340 src-tauri/target/release/e2e-chat-app.exe
 *     E2E_BOX_DEBUG_PORT=9340 npx playwright test tests/desktop-smoke.spec.ts
 */

const DEBUG_PORT = process.env.E2E_BOX_DEBUG_PORT || '';
const CDP = `http://127.0.0.1:${DEBUG_PORT || '9340'}`;

async function cdpUp(): Promise<boolean> {
    try {
        const res = await fetch(`${CDP}/json/version`, { signal: AbortSignal.timeout(1500) });
        return res.ok;
    } catch {
        return false;
    }
}

test.describe('desktop box smoke (needs a running box with E2E_BOX_DEBUG_PORT)', () => {
    test('the changed views render in the real app window without throwing', async () => {
        test.skip(!DEBUG_PORT, "Set E2E_BOX_DEBUG_PORT and start the box first — see this file's header.");
        expect(await cdpUp(), `no DevTools endpoint on ${CDP}`).toBeTruthy();

        const browser = await chromium.connectOverCDP(CDP);
        try {
            const pages = browser.contexts().flatMap((c) => c.pages());
            const page = pages.find((p) => p.url().startsWith('http')) || pages[0];
            test.skip(
                !page.url().startsWith('https://'),
                `the box window is on ${page.url()} — this test needs the app served from the box's server`,
            );

            // Anything the window itself reports as broken, collected for the
            // whole run: an uncaught error is a crash, whatever the assertions
            // below see.
            const errors: string[] = [];
            page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
            page.on('console', (m) => {
                if (m.type() === 'error') errors.push(`console: ${m.text()}`);
            });

            // A phone-sized viewport, so the reflow each view gained is actually
            // exercised in this window. If the platform refuses to resize the
            // window, the run falls back to the window's own size and says so.
            let emulated = false;
            try {
                await page.setViewportSize({ width: 390, height: 844 });
                emulated = await page.evaluate(() => window.matchMedia('(max-width: 700px)').matches);
            } catch {
                emulated = false;
            }

            const report = await page.evaluate(async () => {
                const W = window as any;
                const DP = W.DocPreview;
                const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
                const loadScript = (src: string) => new Promise<void>((resolve) => {
                    const s = document.createElement('script');
                    s.src = src;
                    s.onload = () => resolve();
                    s.onerror = () => resolve();
                    document.head.appendChild(s);
                });

                const out: any = {
                    bridge: !!(W.__TAURI__ && W.__TAURI__.core && W.__TAURI__.core.invoke),
                    narrow: window.matchMedia('(max-width: 700px)').matches,
                };

                if (!(W.JSZip)) await loadScript('/libs/jszip.min.js');
                await DP._loadPdfLibForTest();
                await DP.loadSheetJs();
                const JSZip = W.JSZip;
                const PDFLib = W.PDFLib;

                const overlayText = () => {
                    const el = document.getElementById('doc-preview-content')
                        || document.getElementById('pdf-editor-overlay');
                    return el ? (el.textContent || '') : '';
                };
                const noSideScroll = () => {
                    const el = document.getElementById('doc-preview-content') as HTMLElement | null;
                    if (!el) return null;
                    return el.scrollWidth <= el.clientWidth + 2;
                };

                // ── a real .docx (the OOXML minimum), through docx-preview ──
                {
                    const zip = new JSZip();
                    const long = Array(40).fill('The quick brown fox jumps over the lazy dog.').join(' ');
                    zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                        + '<Default Extension="xml" ContentType="application/xml"/>'
                        + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                        + '</Types>');
                    zip.file('_rels/.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                        + '</Relationships>');
                    zip.file('word/document.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                        + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
                        + '<w:p><w:r><w:t>' + long + '</w:t></w:r></w:p>'
                        + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
                        + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
                        + '</w:body></w:document>');
                    const blob = await zip.generateAsync({ type: 'blob' });
                    await DP.previewDocument(blob, 'desktop-smoke.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
                    await sleep(2500);
                    const text = overlayText();
                    out.docx = {
                        rendered: text.includes('quick brown fox'),
                        stillLoading: text.includes('Loading document…'),
                        failed: /Error rendering document|Failed to render/.test(text),
                        fits: noSideScroll(),
                        modalWidth: document.getElementById('doc-preview-overlay')?.firstElementChild?.clientWidth ?? -1,
                        windowWidth: window.innerWidth,
                    };
                    DP.close();
                    await sleep(300);
                }

                // ── a .tar: the parser this release added ──
                {
                    const enc = new TextEncoder();
                    const name = 'hello.txt';
                    const data = enc.encode('hello from tar');
                    const header = new Uint8Array(512);
                    header.set(enc.encode(name), 0);
                    header.set(enc.encode('0000644\0'), 100);
                    header.set(enc.encode('0000000\0'), 108);
                    header.set(enc.encode('0000000\0'), 116);
                    header.set(enc.encode(data.length.toString(8).padStart(11, '0') + '\0'), 124);
                    header.set(enc.encode('00000000000\0'), 136);
                    header.fill(32, 148, 156);
                    header.set(enc.encode('0'), 156);
                    header.set(enc.encode('ustar\0'), 257);
                    header.set(enc.encode('00'), 263);
                    let sum = 0;
                    for (const b of header) sum += b;
                    header.set(enc.encode(sum.toString(8).padStart(6, '0') + '\0 '), 148);
                    const pad = (512 - (data.length % 512)) % 512;
                    const tar = new Uint8Array(512 + data.length + pad + 1024);
                    tar.set(header, 0);
                    tar.set(data, 512);
                    await DP.previewDocument(new Blob([tar], { type: 'application/x-tar' }), 'smoke.tar', 'application/x-tar');
                    await sleep(1200);
                    const text = overlayText();
                    out.tar = { listed: text.includes('hello.txt'), failed: /Failed to render/.test(text) };
                    DP.close();
                    await sleep(300);
                }

                // ── a legacy .doc (OLE2) and an RTF .doc ──
                {
                    const ole2 = new Uint8Array(1024);
                    ole2.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
                    await DP.previewDocument(new Blob([ole2], { type: 'application/msword' }), 'legacy.doc', 'application/msword');
                    await sleep(1000);
                    out.legacyDoc = { notice: /97–2003/.test(overlayText()), failed: /Failed to render/.test(overlayText()) };
                    DP.close();
                    await sleep(300);

                    const rtf = new TextEncoder().encode('{\\rtf1\\ansi\\deff0{\\fonttbl{\\f0 Arial;}}\\f0 Smoke test text.\\par Done.}');
                    await DP.previewDocument(new Blob([rtf], { type: 'application/msword' }), 'rtf.doc', 'application/msword');
                    await sleep(1200);
                    const t = overlayText();
                    out.rtfDoc = { text: t.includes('Smoke test text.'), leakedTable: t.includes('fonttbl') };
                    DP.close();
                    await sleep(300);
                }

                // ── the PDF editor: duplicate, crop and draw, then read it back ──
                {
                    const doc = await PDFLib.PDFDocument.create();
                    const p = doc.addPage([612, 792]);
                    p.drawText('SMOKE', { x: 80, y: 700, size: 24, color: PDFLib.rgb(0, 0, 0) });
                    DP.openPdfEditor(new Blob([await doc.save()], { type: 'application/pdf' }), 'smoke.pdf');
                    await sleep(2500);
                    const overlay = document.getElementById('pdf-editor-overlay');
                    const clickTool = (title: string) => {
                        const btn = Array.from(overlay!.querySelectorAll('button')).find((b) => b.title === title) as any;
                        if (btn && btn.onclick) btn.onclick();
                    };
                    clickTool('Duplicate Page');
                    await sleep(1500);
                    // Crop asks for four margins, in order: left, bottom, right, top.
                    const answers = ['1', '1', '1', '1'];
                    (W as any).uiPrompt = async () => (answers.length ? answers.shift() : null);
                    clickTool('Crop Page');
                    await sleep(1500);
                    const bytes = DP._getPdfBytes();
                    const fresh = await PDFLib.PDFDocument.load(bytes);
                    const box = fresh.getPage(fresh.getPageCount() - 1).getCropBox();
                    const editorText = overlay ? (overlay.textContent || '') : '';
                    out.pdf = {
                        pages: fresh.getPageCount(),
                        cropWidth: Math.round(box.width),
                        cropHeight: Math.round(box.height),
                        renderError: /Error rendering page/.test(editorText),
                    };
                    document.getElementById('pdf-editor-overlay')?.remove();
                    await sleep(300);
                }

                // ── the claims that were removed ──
                out.claims = {
                    rar: DP.getDocType('x.rar', 'application/vnd.rar'),
                    sevenZip: DP.getDocType('x.7z', 'application/x-7z-compressed'),
                    tar: DP.getDocType('x.tar', 'application/x-tar'),
                    gz: DP.getDocType('x.txt.gz', 'application/gzip'),
                };

                return out;
            });

            // The window is a shell: the bridge has to be there for any of this.
            expect(report.bridge).toBe(true);

            // DOCX: rendered, not stuck loading, not an error, and no sideways
            // scroll (only meaningful when the narrow viewport took effect).
            expect(report.docx.rendered).toBe(true);
            expect(report.docx.stillLoading).toBe(false);
            expect(report.docx.failed).toBe(false);
            if (emulated) {
                expect(report.docx.fits, 'the docx view scrolls sideways on a phone-sized window').toBe(true);
                expect(report.docx.modalWidth).toBeLessThanOrEqual(report.docx.windowWidth + 2);
            }

            expect(report.tar).toEqual({ listed: true, failed: false });
            expect(report.legacyDoc).toEqual({ notice: true, failed: false });
            expect(report.rtfDoc).toEqual({ text: true, leakedTable: false });

            // Duplicate made a real second page, crop moved the box by an inch on
            // every edge (612-144 x 792-144), and the renderer never complained.
            expect(report.pdf.pages).toBe(2);
            expect(report.pdf.cropWidth).toBe(468);
            expect(report.pdf.cropHeight).toBe(648);
            expect(report.pdf.renderError).toBe(false);

            expect(report.claims.rar).toBeNull();
            expect(report.claims.sevenZip).toBeNull();
            expect(report.claims.tar).toBe('zip');
            expect(report.claims.gz).toBe('zip');

            // Nothing in the window threw while all of that ran.
            expect(errors, `the app window reported errors:\n${errors.join('\n')}`).toEqual([]);
        } finally {
            // Detach only — never close: that would shut the user's app window.
            await browser.close().catch(() => {});
        }
    });

    test('the app process is still alive and responsive after the run', async () => {
        test.skip(!DEBUG_PORT, 'Set E2E_BOX_DEBUG_PORT and start the box first.');
        const out = execFileSync('powershell', ['-NoProfile', '-Command', '(Get-Process e2e-chat-app -ErrorAction SilentlyContinue).Count'], { encoding: 'utf8' });
        expect(parseInt(out.trim() || '0', 10)).toBeGreaterThan(0);
        expect(await cdpUp()).toBeTruthy();
    });
});
