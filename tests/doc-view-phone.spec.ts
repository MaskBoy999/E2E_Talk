import { test, expect, type Page } from '@playwright/test';

/**
 * Every document view, on a phone-sized viewport.
 *
 * Reported: a `.docx` "looks bad on phone with an infinite loading page effect"
 * and is "cropped". Three separate causes, all pinned here:
 *
 *  1. **The loading placeholder was never cleared.** `openDocModal` puts a
 *     "Loading document…" block in the content area, and only the PDF and ZIP
 *     renderers replaced it — docx, xlsx, csv and pptx *append* to the
 *     container, so the spinner stayed as a full-height first child and the
 *     document sat one screen below it. That is the "still loading" document.
 *  2. **docx-preview renders a fixed 794px-wide Word page.** On a 380-390px
 *     phone the right half of every line was off-screen with nothing to scroll
 *     to: the cropped document. Below 700px the page geometry is dropped
 *     (`ignoreWidth`/`ignoreHeight`, no page wrapper, no page breaks) so the
 *     text reflows to the device width.
 *  3. **PowerPoint slides are laid out at absolute pixels** (960x720), so they
 *     were cropped the same way; on a narrow viewport the canvas is scaled.
 *
 * The test drives the real renderers through `DocPreview.previewDocument` with
 * fixtures built in the page out of the libraries the app already ships, and
 * asserts on what a user can actually be hurt by: nothing still says "Loading",
 * the modal is the whole screen, and no view scrolls sideways.
 */

const BASE = 'https://localhost:3443';
const PHONE = { width: 390, height: 844 };

async function register(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 15000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 8000 });
    await page.fill('#register-username', `viewphone_${ts}`);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 20000 });
    await page.waitForFunction(() => {
        const ws = (window as any).ws;
        return ws && ws.readyState === 1;
    }, { timeout: 20000 });
}

test.describe('document views on a phone', () => {
    test.use({ viewport: PHONE });

    test('every document view fits the phone, none is stuck loading, the docx reflows', async ({ page }) => {
        test.setTimeout(180000);
        await register(page);

        const report = await page.evaluate(async () => {
            const DP = (window as any).DocPreview;

            // JSZip is what the ZIP / PPTX / DOCX fixtures are built with; the
            // app ships it for its own docx-preview use.
            const loadScript = (src: string) => new Promise<void>((resolve) => {
                const s = document.createElement('script');
                s.src = src;
                s.onload = () => resolve();
                s.onerror = () => resolve();
                document.head.appendChild(s);
            });
            if (!(window as any).JSZip) await loadScript('/libs/jszip.min.js');
            await DP._loadPdfLibForTest(); // loads pdf-lib + pdf.js
            await DP.loadSheetJs();

            const JSZip = (window as any).JSZip;
            const PDFLib = (window as any).PDFLib;
            const XLSX = (window as any).XLSX;
            const longText = Array(30).fill('The quick brown fox jumps over the lazy dog.').join(' ');

            // ── fixtures ─────────────────────────────────────────────────
            async function docxBlob() {
                const zip = new JSZip();
                const ct = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                    + '<Default Extension="xml" ContentType="application/xml"/>'
                    + '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>'
                    + '</Types>';
                const rels = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
                    + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>'
                    + '</Relationships>';
                const doc = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    + '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
                    + '<w:p><w:r><w:t>' + longText + '</w:t></w:r></w:p>'
                    + '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>'
                    + '<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>'
                    + '</w:body></w:document>';
                zip.file('[Content_Types].xml', ct);
                zip.file('_rels/.rels', rels);
                zip.file('word/document.xml', doc);
                return await zip.generateAsync({ type: 'blob' });
            }

            async function pptxBlob() {
                // A realistic slide: every shape carries an `a:xfrm` (position +
                // extent), which is what the renderer positions it by. A shape
                // without one is not drawn — a real file always has them.
                const zip = new JSZip();
                zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
                    + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
                    + '<Default Extension="xml" ContentType="application/xml"/>'
                    + '<Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>'
                    + '</Types>');
                zip.file('ppt/slides/slide1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                    + '<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"'
                    + ' xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><p:cSld><p:spTree>'
                    + '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>'
                    + '<p:spPr><p:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></p:xfrm></p:spPr>'
                    + '<p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" sz="3600"/><a:t>Hello Presentation</a:t></a:r></a:p></p:txBody></p:sp>'
                    + '</p:spTree></p:cSld></p:sld>');
                return await zip.generateAsync({ type: 'blob' });
            }

            async function pdfBlob() {
                const doc = await PDFLib.PDFDocument.create();
                const p = doc.addPage([612, 792]);
                p.drawText('Phone page', { x: 40, y: 700, size: 20 });
                return new Blob([await doc.save()], { type: 'application/pdf' });
            }

            function xlsxBlob() {
                const wb = XLSX.utils.book_new();
                const ws = XLSX.utils.aoa_to_sheet([['name', 'age'], ['Alice', 30], ['Bob', 25]]);
                XLSX.utils.book_append_sheet(wb, ws, 'People');
                const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
                return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
            }

            async function zipBlob() {
                const zip = new JSZip();
                zip.file('readme.txt', 'hello');
                return await zip.generateAsync({ type: 'blob' });
            }

            const fixtures: { type: string; name: string; mime: string; blob: () => Promise<Blob> | Blob }[] = [
                { type: 'docx', name: 'protocol.docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', blob: docxBlob },
                { type: 'pdf', name: 'protocol.pdf', mime: 'application/pdf', blob: pdfBlob },
                { type: 'xlsx', name: 'grades.xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', blob: xlsxBlob },
                { type: 'csv', name: 'grades.csv', mime: 'text/csv', blob: () => new Blob(['a,b\n1,2\n3,4'], { type: 'text/csv' }) },
                { type: 'zip', name: 'stuff.zip', mime: 'application/zip', blob: zipBlob },
                { type: 'pptx', name: 'deck.pptx', mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', blob: pptxBlob },
            ];

            const out: any = {};
            for (const f of fixtures) {
                DP.close();
                const blob = await f.blob();
                DP.previewDocument(blob, f.name, f.mime);
                // The slowest renderer is docx-preview; the others land fast.
                await new Promise((r) => setTimeout(r, f.type === 'docx' ? 4000 : 2500));

                const overlay = document.getElementById('doc-preview-overlay');
                const modal = document.getElementById('doc-preview-modal');
                const content = document.getElementById('doc-preview-content');
                const text = content ? content.textContent || '' : '';
                const modalRect = modal ? modal.getBoundingClientRect() : null;
                const section = content ? content.querySelector('section') as HTMLElement | null : null;
                out[f.type] = {
                    opened: !!overlay && !!content,
                    stuckLoading: /Loading document/.test(text),
                    failed: /Failed to render|Error rendering/i.test(text),
                    overflowPx: content ? Math.max(0, content.scrollWidth - content.clientWidth) : -1,
                    modalWidth: modalRect ? Math.round(modalRect.width) : 0,
                    modalTop: modalRect ? Math.round(modalRect.top) : -1,
                    renderedSomething: content
                        ? !!(content.querySelector('canvas') || content.querySelector('table')
                            || content.querySelector('section') || content.querySelector('pre')
                            || content.querySelector('.doc-view-slide')
                            || (content.textContent || '').trim().length > 5)
                        : false,
                    // Per-type proof that the *content* arrived, not just a
                    // chrome element (a slide counter, a page count).
                    hasContent: {
                        docx: /quick brown fox/.test(text),
                        pdf: !!content?.querySelector('canvas'),
                        xlsx: !!content?.querySelector('table'),
                        csv: !!content?.querySelector('table'),
                        zip: /readme\.txt/.test(text),
                        pptx: /Hello Presentation/.test(text),
                    }[f.type] === true,
                    // docx only: the Word "sheet" must fit the column, and the
                    // text has to still be there.
                    sectionWidth: section ? Math.round(section.getBoundingClientRect().width) : -1,
                    sectionScrollOverflow: section ? Math.max(0, section.scrollWidth - section.clientWidth) : -1,
                    hasWords: /quick brown fox/.test(text),
                };
                DP.close();
                await new Promise((r) => setTimeout(r, 300));
            }
            return { out, viewport: window.innerWidth };
        });

        const rows = Object.entries(report.out) as [string, any][];
        expect(rows.length).toBe(6);

        for (const [type, r] of rows) {
            expect(r.opened, `${type}: the preview did not open`).toBe(true);
            expect(r.renderedSomething, `${type}: nothing was rendered`).toBe(true);
            expect(r.hasContent, `${type}: the file's own content is missing from the view`).toBe(true);
            // Cause 1: the placeholder used to stay behind every non-PDF render.
            expect(r.stuckLoading, `${type}: the view is still showing "Loading document…"`).toBe(false);
            expect(r.failed, `${type}: the render reported a failure`).toBe(false);
            // Phone shape: the modal takes the whole screen, edge to edge.
            expect(r.modalWidth, `${type}: the modal is not the width of the phone`).toBeGreaterThanOrEqual(PHONE.width - 2);
            expect(r.modalTop, `${type}: the modal is not full-screen`).toBeLessThanOrEqual(1);
            // Nothing scrolls sideways: that sideways scroll *was* the crop.
            expect(r.overflowPx, `${type}: the view overflows the phone horizontally`).toBeLessThanOrEqual(2);
        }

        const docx = report.out.docx;
        // Cause 2: a Word page is 794px wide; the phone is 390.
        expect(docx.sectionWidth, 'docx: the Word sheet was not reflowed to the device width')
            .toBeLessThanOrEqual(PHONE.width + 4);
        expect(docx.sectionScrollOverflow, 'docx: the Word sheet is cut off at its right edge').toBeLessThanOrEqual(2);
        expect(docx.hasWords, 'docx: the document text is missing').toBe(true);

        // Cause 3: a 960px slide canvas, scaled rather than cropped.
        expect(report.out.pptx.overflowPx, 'pptx: slides overflow the phone').toBeLessThanOrEqual(2);
    });

    test('the same views open full-screen-shaped on a desktop viewport', async ({ page }) => {
        // The phone layout must not leak into the desktop one: the modal is
        // still a centred card with a rounded corner and a margin around it.
        await page.setViewportSize({ width: 1280, height: 800 });
        await register(page);

        const result = await page.evaluate(async () => {
            const DP = (window as any).DocPreview;
            DP.previewDocument(new Blob(['a,b\n1,2'], { type: 'text/csv' }), 'x.csv', 'text/csv');
            await new Promise((r) => setTimeout(r, 2000));
            const overlay = document.getElementById('doc-preview-overlay');
            const modal = document.getElementById('doc-preview-modal');
            const rect = modal ? modal.getBoundingClientRect() : null;
            const overlayStyle = overlay ? getComputedStyle(overlay).padding : '';
            const content = document.getElementById('doc-preview-content');
            const out = {
                opened: !!overlay,
                modalWidth: rect ? Math.round(rect.width) : 0,
                modalTop: rect ? Math.round(rect.top) : -1,
                overlayPadding: overlayStyle,
                stuckLoading: /Loading document/.test(content ? content.textContent || '' : ''),
            };
            DP.close();
            return out;
        });

        expect(result.opened).toBe(true);
        expect(result.stuckLoading).toBe(false);
        // A card, not the whole window: it keeps its margin.
        expect(result.modalWidth).toBeLessThan(1200);
        expect(result.modalTop).toBeGreaterThan(5);
        expect(result.overlayPadding).toBe('20px');
    });
});
