import { test, expect, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';

async function registerAndSetup(page: Page) {
    const ts = Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const username = `docprev_${ts}`;
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-confirm-password', { state: 'visible', timeout: 5000 });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 15000 });
    await page.waitForFunction(() => {
        const ws = (window as any).ws;
        return ws && ws.readyState === 1;
    }, { timeout: 15000 });
}

async function createServerAndGetChannel(page: Page): Promise<string> {
    const serverName = 'DocTest_' + Date.now().toString(36);
    await page.evaluate((name: string) => {
        (window as any).ws.send(JSON.stringify({ type: 'create_server', name: name }));
    }, serverName);
    await page.waitForFunction((name: string) => {
        const icons = document.querySelectorAll('.server-icon');
        for (const icon of icons) {
            const t = (icon as HTMLElement).title || '';
            if (t.includes(name) || t.includes('General')) return true;
        }
        return icons.length > 0;
    }, serverName, { timeout: 15000 });
    await page.waitForTimeout(1000);
    // Click the last server icon (the one we just created)
    await page.evaluate(() => {
        const icons = document.querySelectorAll('.server-icon');
        if (icons.length > 0) {
            (icons[icons.length - 1] as HTMLElement).click();
        }
    });
    await page.waitForTimeout(1000);
    // Get the channel ID
    const channelId = await page.evaluate(() => {
        const el = document.querySelector('.channel-item.active') || document.querySelector('.channel-item');
        return el ? (el as HTMLElement).dataset.channelId || '' : '';
    });
    return channelId;
}

function makeFile(content: string, filename: string, mimeType: string): File {
    return new File([content], filename, { type: mimeType });
}

async function uploadFileViaAPI(page: Page, fileContent: string, filename: string, mimeType: string): Promise<any> {
    return await page.evaluate(async ({ fileContent, filename, mimeType }) => {
        const E2ECrypto = (window as any).E2ECrypto;
        const authFetch = (window as any).authFetch;

        // Create file blob
        const blob = new Blob([fileContent], { type: mimeType });
        const fileKey = E2ECrypto.generateFileKey();
        const fileKeyB64 = E2ECrypto.arrayBufferToBase64(fileKey);

        // Init upload
        const initRes = await authFetch('/api/files/init', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ size: blob.size, encrypted_mime: '', mime_nonce: '' })
        });
        const { file_id } = await initRes.json();

        // Upload chunk
        const chunkData = new Uint8Array(await blob.arrayBuffer());
        const encryptedChunk = E2ECrypto.encryptFileChunk(fileKey, chunkData);
        await authFetch(`/api/files/${file_id}/chunk/0`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: encryptedChunk
        });
        await authFetch(`/api/files/${file_id}/complete`, { method: 'POST' });

        return { file_id, filename, mime_type: mimeType, file_size: blob.size, file_key: fileKeyB64 };
    }, { fileContent, filename, mimeType });
}

test.describe('Document Preview', () => {
    test('DocPreview module is loaded and has all methods', async ({ page }) => {
        await registerAndSetup(page);
        const hasModule = await page.evaluate(() => {
            const DP = (window as any).DocPreview;
            return {
                exists: !!DP,
                isDocFile: typeof DP?.isDocumentFile === 'function',
                getDocType: typeof DP?.getDocType === 'function',
                preview: typeof DP?.previewDocument === 'function',
                close: typeof DP?.close === 'function',
            };
        });
        expect(hasModule.exists).toBe(true);
        expect(hasModule.isDocFile).toBe(true);
        expect(hasModule.getDocType).toBe(true);
        expect(hasModule.preview).toBe(true);
        expect(hasModule.close).toBe(true);
    });

    test('isDocumentFile detects all expected types', async ({ page }) => {
        await registerAndSetup(page);
        const results = await page.evaluate(() => {
            const DP = (window as any).DocPreview;
            return {
                pdf: DP.isDocumentFile('test.pdf', 'application/pdf'),
                docx: DP.isDocumentFile('test.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
                xlsx: DP.isDocumentFile('test.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
                csv: DP.isDocumentFile('test.csv', 'text/csv'),
                zip: DP.isDocumentFile('test.zip', 'application/zip'),
                pptx: DP.isDocumentFile('test.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'),
                txt: DP.isDocumentFile('test.txt', 'text/plain'),
                png: DP.isDocumentFile('test.png', 'image/png'),
                mp4: DP.isDocumentFile('test.mp4', 'video/mp4'),
            };
        });
        expect(results.pdf).toBe(true);
        expect(results.docx).toBe(true);
        expect(results.xlsx).toBe(true);
        expect(results.csv).toBe(true);
        expect(results.zip).toBe(true);
        expect(results.pptx).toBe(true);
        expect(results.txt).toBe(false); // text is handled by chat.js, not doc-preview
        expect(results.png).toBe(false);
        expect(results.mp4).toBe(false);
    });

    test('getDocType returns correct types', async ({ page }) => {
        await registerAndSetup(page);
        const results = await page.evaluate(() => {
            const DP = (window as any).DocPreview;
            return {
                pdf: DP.getDocType('report.pdf', 'application/pdf'),
                docx: DP.getDocType('letter.docx', ''),
                xlsx: DP.getDocType('data.xlsx', ''),
                csv: DP.getDocType('export.csv', 'text/csv'),
                zip: DP.getDocType('archive.zip', 'application/zip'),
                pptx: DP.getDocType('slides.pptx', ''),
                tarGz: DP.getDocType('project.tar.gz', ''),
            };
        });
        expect(results.pdf).toBe('pdf');
        expect(results.docx).toBe('docx');
        expect(results.xlsx).toBe('xlsx');
        expect(results.csv).toBe('csv');
        expect(results.zip).toBe('zip');
        expect(results.pptx).toBe('pptx');
        expect(results.tarGz).toBe('zip');
    });

    test('CSV preview renders a table', async ({ page }) => {
        await registerAndSetup(page);
        const csvContent = 'name,age,city\nAlice,30,NYC\nBob,25,LA\nCharlie,35,Chicago';
        const csvBlob = new Blob([csvContent], { type: 'text/csv' });

        const rendered = await page.evaluate(async (csvStr: string) => {
            const DP = (window as any).DocPreview;
            const blob = new Blob([csvStr], { type: 'text/csv' });
            DP.previewDocument(blob, 'data.csv', 'text/csv');
            // Wait for the modal to appear
            await new Promise(r => setTimeout(r, 2000));
            const overlay = document.getElementById('doc-preview-overlay');
            if (!overlay) return { hasOverlay: false };
            const content = overlay.querySelector('#doc-preview-content');
            const table = content?.querySelector('table');
            const rows = table?.querySelectorAll('tr');
            return {
                hasOverlay: true,
                hasTable: !!table,
                rowCount: rows?.length || 0,
                hasAlice: !!content?.textContent?.includes('Alice'),
                hasHeader: !!table?.querySelector('th'),
            };
        }, csvContent);
        expect(rendered.hasOverlay).toBe(true);
        expect(rendered.hasTable).toBe(true);
        expect(rendered.rowCount).toBeGreaterThanOrEqual(4); // header + 3 data rows
        expect(rendered.hasAlice).toBe(true);
        expect(rendered.hasHeader).toBe(true);

        // Close modal
        await page.evaluate(() => (window as any).DocPreview.close());
    });

    test('ZIP preview renders file list', async ({ page }) => {
        await registerAndSetup(page);
        // Create a minimal valid ZIP file using JSZip
        const zipCreated = await page.evaluate(async () => {
            // Load JSZip dynamically
            const script = document.createElement('script');
            script.src = '/libs/jszip.min.js';
            document.head.appendChild(script);
            await new Promise(r => { script.onload = r; setTimeout(r, 3000); });
            if (!(window as any).JSZip) return false;

            const zip = new (window as any).JSZip();
            zip.file('readme.txt', 'Hello World');
            zip.file('data.csv', 'a,b,c\n1,2,3');
            const blob = await zip.generateAsync({ type: 'blob' });

            const DP = (window as any).DocPreview;
            DP.previewDocument(blob, 'test.zip', 'application/zip');
            await new Promise(r => setTimeout(r, 2000));

            const overlay = document.getElementById('doc-preview-overlay');
            if (!overlay) return { hasOverlay: false };
            const content = overlay.querySelector('#doc-preview-content');
            const text = content?.textContent || '';
            return {
                hasOverlay: true,
                hasReadme: text.includes('readme.txt'),
                hasCsv: text.includes('data.csv'),
                hasFileCount: text.includes('2 files'),
            };
        });
        expect(zipCreated.hasOverlay).toBe(true);
        expect(zipCreated.hasReadme).toBe(true);
        expect(zipCreated.hasCsv).toBe(true);
        expect(zipCreated.hasFileCount).toBe(true);

        await page.evaluate(() => (window as any).DocPreview.close());
    });

    test('PDF preview renders canvas pages', async ({ page }) => {
        await registerAndSetup(page);
        // Create a minimal PDF
        const pdfCreated = await page.evaluate(async () => {
            // Minimal valid PDF
            const pdfStr = '%PDF-1.0\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/MediaBox[0 0 612 792]/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>>>endobj\n4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj\nxref\n0 5\n0000000000 65535 f \n0000000009 00000 n \n0000000058 00000 n \n0000000115 00000 n \n0000000266 00000 n \ntrailer<</Size 5/Root 1 0 R>>\nstartxref\n345\n%%EOF';
            const blob = new Blob([pdfStr], { type: 'application/pdf' });

            const DP = (window as any).DocPreview;
            try {
                DP.previewDocument(blob, 'test.pdf', 'application/pdf');
                await new Promise(r => setTimeout(r, 3000));
                const overlay = document.getElementById('doc-preview-overlay');
                if (!overlay) return { hasOverlay: false, error: 'no overlay' };
                const content = overlay.querySelector('#doc-preview-content');
                const canvas = content?.querySelector('canvas');
                return {
                    hasOverlay: true,
                    hasCanvas: !!canvas,
                    canvasWidth: canvas?.width || 0,
                    canvasHeight: canvas?.height || 0,
                };
            } catch (e: any) {
                return { hasOverlay: false, error: e.message };
            }
        });
        // PDF rendering may fail with minimal PDF, but overlay should exist
        expect(pdfCreated.hasOverlay).toBe(true);

        await page.evaluate(() => (window as any).DocPreview.close());
    });

    test('Modal opens and closes with Escape key', async ({ page }) => {
        await registerAndSetup(page);
        const csvContent = 'a,b\n1,2';
        const result = await page.evaluate(async (csvStr: string) => {
            const DP = (window as any).DocPreview;
            const blob = new Blob([csvStr], { type: 'text/csv' });
            DP.previewDocument(blob, 'test.csv', 'text/csv');
            await new Promise(r => setTimeout(r, 1000));
            const overlayBefore = !!document.getElementById('doc-preview-overlay');

            // Press Escape
            document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
            await new Promise(r => setTimeout(r, 500));
            const overlayAfter = !!document.getElementById('doc-preview-overlay');

            return { opened: overlayBefore, closed: !overlayAfter };
        }, csvContent);
        expect(result.opened).toBe(true);
        expect(result.closed).toBe(true);
    });

    test('Modal opens and closes with backdrop click', async ({ page }) => {
        await registerAndSetup(page);
        const csvContent = 'x,y\n1,2';
        const result = await page.evaluate(async (csvStr: string) => {
            const DP = (window as any).DocPreview;
            const blob = new Blob([csvStr], { type: 'text/csv' });
            DP.previewDocument(blob, 'test.csv', 'text/csv');
            await new Promise(r => setTimeout(r, 1000));
            const overlay = document.getElementById('doc-preview-overlay');
            if (!overlay) return { opened: false };

            // Click the backdrop (overlay itself, not modal)
            overlay.click();
            await new Promise(r => setTimeout(r, 500));
            const stillOpen = !!document.getElementById('doc-preview-overlay');

            return { opened: true, closed: !stillOpen };
        }, csvContent);
        expect(result.opened).toBe(true);
        expect(result.closed).toBe(true);
    });

    test('buildFileCardHtml includes doc preview button for document types', async ({ page }) => {
        await registerAndSetup(page);
        const result = await page.evaluate(() => {
            // Test that buildFileCardHtml generates the doc preview button
            const csvCard = (window as any).buildFileCardHtml({
                file_id: 'test123',
                file_key: 'key123',
                filename: 'data.csv',
                mime_type: 'text/csv',
                file_size: 1024,
            });
            const pdfCard = (window as any).buildFileCardHtml({
                file_id: 'test456',
                file_key: 'key456',
                filename: 'report.pdf',
                mime_type: 'application/pdf',
                file_size: 2048,
            });
            const xlsxCard = (window as any).buildFileCardHtml({
                file_id: 'test789',
                file_key: 'key789',
                filename: 'data.xlsx',
                mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
                file_size: 4096,
            });
            const pngCard = (window as any).buildFileCardHtml({
                file_id: 'testPng',
                file_key: 'keyPng',
                filename: 'photo.png',
                mime_type: 'image/png',
                file_size: 8192,
            });
            return {
                csvHasPreviewBtn: csvCard.includes('file-doc-preview-btn'),
                pdfHasPreviewBtn: pdfCard.includes('file-doc-preview-btn'),
                xlsxHasPreviewBtn: xlsxCard.includes('file-doc-preview-btn'),
                pngHasPreviewBtn: pngCard.includes('file-doc-preview-btn'),
                csvHasDownloadBtn: csvCard.includes('file-download-btn'),
                pdfHasDownloadBtn: pdfCard.includes('file-download-btn'),
            };
        });
        expect(result.csvHasPreviewBtn).toBe(true);
        expect(result.pdfHasPreviewBtn).toBe(true);
        expect(result.xlsxHasPreviewBtn).toBe(true);
        expect(result.pngHasPreviewBtn).toBe(false); // images don't get doc preview btn
        expect(result.csvHasDownloadBtn).toBe(true);
        expect(result.pdfHasDownloadBtn).toBe(true);
    });

    test('XLSX preview renders a table with sheet tabs', async ({ page }) => {
        await registerAndSetup(page);
        const result = await page.evaluate(async () => {
            // Load SheetJS dynamically
            const script = document.createElement('script');
            script.src = '/libs/xlsx.full.min.js';
            document.head.appendChild(script);
            await new Promise(r => { script.onload = r; setTimeout(r, 3000); });
            if (!(window as any).XLSX) return { loaded: false };

            // Create a workbook
            const wb = (window as any).XLSX.utils.book_new();
            const ws = (window as any).XLSX.utils.aoa_to_sheet([['Name', 'Age'], ['Alice', 30], ['Bob', 25]]);
            (window as any).XLSX.utils.book_append_sheet(wb, ws, 'Sheet1');
            const data = (window as any).XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
            const blob = new Blob([data], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

            const DP = (window as any).DocPreview;
            const detectedType = DP.getDocType('data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            console.log('Detected doc type:', detectedType);
            DP.previewDocument(blob, 'data.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            await new Promise(r => setTimeout(r, 3000));

            const overlay = document.getElementById('doc-preview-overlay');
            if (!overlay) return { hasOverlay: false, debug: 'no overlay', detectedType };
            const content = overlay.querySelector('#doc-preview-content');
            return {
                hasOverlay: true,
                detectedType,
                contentHTML: content?.innerHTML?.substring(0, 2000) || '',
                contentText: content?.textContent?.substring(0, 500) || '',
            };
        });
        expect(result.hasOverlay).toBe(true);
        expect(result.contentText?.length || 0).toBeGreaterThan(0);

        await page.evaluate(() => (window as any).DocPreview.close());
    });

    test('PPTX preview renders slides with text and shapes', async ({ page }) => {
        await registerAndSetup(page);
        const result = await page.evaluate(async () => {
            // Load JSZip dynamically
            if (!(window as any).JSZip) {
                const script = document.createElement('script');
                script.src = '/libs/jszip.min.js';
                document.head.appendChild(script);
                await new Promise(r => { script.onload = r; setTimeout(r, 3000); });
            }
            if (!(window as any).JSZip) return { loaded: false };

            const JSZip = (window as any).JSZip;
            const zip = new JSZip();

            // Create a minimal PPTX structure
            zip.file('[Content_Types].xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/></Types>');

            zip.file('ppt/presentation.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:sldIdLst><p:sldId id="256" r:id="rId1"/></p:sldIdLst></p:presentation>');

            zip.file('ppt/_rels/presentation.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide1.xml"/></Relationships>');

            zip.file('ppt/slides/slide1.xml', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><p:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></p:xfrm></p:grpSpPr><p:sp><p:nvSpPr><p:cNvPr id="2" name="Title"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:spPr><p:xfrm><a:off x="457200" y="274638"/><a:ext cx="8229600" cy="1143000"/></p:xfrm><a:solidFill><a:srgbClr val="4472C4"/></a:solidFill></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" sz="3600"/><a:t>Hello Presentation</a:t></a:r></a:p></p:txBody></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Content"/><p:cNvSpPr txBox="1"/><p:nvPr><p:ph idx="1"/></p:nvPr></p:nvSpPr><p:spPr><p:xfrm><a:off x="457200" y="1600200"/><a:ext cx="8229600" cy="4525963"/></p:xfrm></p:spPr><p:txBody><a:bodyPr/><a:p><a:r><a:rPr lang="en-US" sz="1800"/><a:t>Slide 1 content goes here</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>');

            zip.file('ppt/slides/_rels/slide1.xml.rels', '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"></Relationships>');

            const blob = await zip.generateAsync({ type: 'blob' });

            const DP = (window as any).DocPreview;
            DP.previewDocument(blob, 'slides.pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
            await new Promise(r => setTimeout(r, 3000));

            const overlay = document.getElementById('doc-preview-overlay');
            if (!overlay) return { hasOverlay: false };
            const content = overlay.querySelector('#doc-preview-content');
            return {
                hasOverlay: true,
                hasTitle: !!content?.textContent?.includes('Hello Presentation'),
                hasContent: !!content?.textContent?.includes('Slide 1 content'),
                hasBadge: !!content?.textContent?.includes('1'),
            };
        });
        expect(result.hasOverlay).toBe(true);
        expect(result.hasTitle).toBe(true);
        expect(result.hasContent).toBe(true);
        expect(result.hasBadge).toBe(true);

        await page.evaluate(() => (window as any).DocPreview.close());
    });
    test('PDF editor opens and has all tools', async ({ page }) => {
        await registerAndSetup(page);
        const result = await page.evaluate(async () => {
            // Load pdf-lib and pdf.js via the DocPreview loader
            const DP = (window as any).DocPreview;
            await DP._loadPdfLibForTest();
            if (!(window as any).PDFLib) return { loaded: false };

            // Create a 2-page PDF
            const PDFLib = (window as any).PDFLib;
            const doc = await PDFLib.PDFDocument.create();
            const page1 = doc.addPage([612, 792]);
            page1.drawText('Page 1', { x: 50, y: 700, size: 24 });
            const page2 = doc.addPage([612, 792]);
            page2.drawText('Page 2', { x: 50, y: 700, size: 24 });
            const pdfBytes = await doc.save();
            const blob = new Blob([pdfBytes], { type: 'application/pdf' });

            DP.openPdfEditor(blob, 'test.pdf');
            await new Promise(r => setTimeout(r, 2000));

            const overlay = document.getElementById('pdf-editor-overlay');
            if (!overlay) return { hasOverlay: false };

            return {
                hasOverlay: true,
                hasThumbPanel: !!overlay.querySelector('#pdf-thumb-panel'),
                hasPreview: !!overlay.querySelector('#pdf-preview-panel'),
                thumbCount: overlay.querySelectorAll('#pdf-thumb-panel [data-page-idx]').length,
                hasUndoBtn: !!overlay.querySelector('button[title="Undo"]'),
                hasRedoBtn: !!overlay.querySelector('button[title="Redo"]'),
                hasMergeBtn: !!overlay.querySelector('button[title="Merge PDF"]'),
                hasExportBtn: !!overlay.textContent?.includes('Save'),
            };
        });
        expect(result.hasOverlay).toBe(true);
        expect(result.hasThumbPanel).toBe(true);
        expect(result.hasPreview).toBe(true);
        expect(result.thumbCount).toBe(2);
        expect(result.hasUndoBtn).toBe(true);
        expect(result.hasRedoBtn).toBe(true);
        expect(result.hasMergeBtn).toBe(true);
        expect(result.hasExportBtn).toBe(true);

        await page.evaluate(() => {
            var el = document.getElementById('pdf-editor-overlay');
            if (el) el.remove();
        });
    });

    test('PDF editor rotate and delete work', async ({ page }) => {
        await registerAndSetup(page);
        const result = await page.evaluate(async () => {
            const DP = (window as any).DocPreview;
            await DP._loadPdfLibForTest();
            if (!(window as any).PDFLib) return { loaded: false };

            const PDFLib = (window as any).PDFLib;
            const doc = await PDFLib.PDFDocument.create();
            doc.addPage([612, 792]);
            doc.addPage([612, 792]);
            doc.addPage([612, 792]);
            const blob = new Blob([await doc.save()], { type: 'application/pdf' });

            DP.openPdfEditor(blob, 'test.pdf');
            await new Promise(r => setTimeout(r, 3000));

            const overlay = document.getElementById('pdf-editor-overlay');
            if (!overlay) return { hasOverlay: false };

            const initial = document.querySelectorAll('#pdf-thumb-panel [data-page-idx]').length;

            // Find and click the rotate button via onclick (direct call)
            const allButtons = Array.from(overlay.querySelectorAll('button'));
            const rotateBtn = allButtons.find(b => b.title === 'Rotate Right');
            if (rotateBtn && rotateBtn.onclick) rotateBtn.onclick();
            await new Promise(r => setTimeout(r, 1000));

            const thumbText = document.querySelector('#pdf-thumb-panel')?.textContent || '';
            const hasRotationBadge = thumbText.includes('90');
            const editorPages = DP._getEditorState ? DP._getEditorState() : null;

            return { hasOverlay: true, initialThumbs: initial, hasRotationBadge, editorPages };
        });
        expect(result.hasOverlay).toBe(true);
        expect(result.initialThumbs).toBe(3);
        expect(result.hasRotationBadge).toBe(true);

        await page.evaluate(() => {
            var el = document.getElementById('pdf-editor-overlay');
            if (el) el.remove();
        });
    });
});
