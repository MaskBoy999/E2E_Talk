// ─── Document Preview System ────────────────────────────────────────────
// Lazy-loads external libraries on first use and renders documents in a modal.
// All rendering is client-side after E2E decryption — the server never sees the file.

var DocPreview = (function () {
    'use strict';

    // ── Lazy loader cache ──────────────────────────────────────────────
    var _loaded = {};
    var _loading = {};

    function loadScript(url) {
        if (_loaded[url]) return Promise.resolve();
        if (_loading[url]) return _loading[url];
        _loading[url] = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            s.src = url;
            s.onload = function () { _loaded[url] = true; resolve(); };
            s.onerror = function () { reject(new Error('Failed to load ' + url)); };
            document.head.appendChild(s);
        });
        return _loading[url];
    }

    function loadCss(url) {
        if (_loaded[url]) return Promise.resolve();
        return new Promise(function (resolve) {
            var l = document.createElement('link');
            l.rel = 'stylesheet';
            l.href = url;
            l.onload = function () { _loaded[url] = true; resolve(); };
            l.onerror = function () { resolve(); }; // non-fatal
            document.head.appendChild(l);
        });
    }

    // ── Library loaders ────────────────────────────────────────────────

    function loadPdfJs() {
        return loadScript('/libs/pdf.min.js')
            .then(function () {
                // Set worker source
                if (window.pdfjsLib) {
                    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
                        '/libs/pdf.worker.min.js';
                }
            });
    }

    function loadDocxPreview() {
        return Promise.all([
            loadScript('/libs/jszip.min.js'),
            loadScript('/libs/docx-preview.min.js')
        ]);
    }

    function loadSheetJs() {
        return loadScript('/libs/xlsx.full.min.js');
    }

    function loadPapaParse() {
        return loadScript('/libs/papaparse.min.js');
    }

    // ── Document type detection ────────────────────────────────────────

    var DOC_EXTS = {
        pdf:  'application/pdf',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        doc:  'application/msword',
        xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        xls:  'application/vnd.ms-excel',
        csv:  'text/csv',
        tsv:  'text/tab-separated-values',
        ods:  'application/vnd.oasis.opendocument.spreadsheet',
        pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        ppt:  'application/vnd.ms-powerpoint',
        zip:  'application/zip',
        '7z':  'application/x-7z-compressed',
        rar:  'application/vnd.rar',
        tar:  'application/x-tar',
        gz:   'application/gzip',
        'tar.gz': 'application/gzip'
    };

    var DOC_EXTENSIONS = Object.keys(DOC_EXTS);

    function isDocumentFile(filename, mimeType) {
        if (!filename && !mimeType) return false;
        // Check mime first
        if (mimeType) {
            var m = mimeType.toLowerCase();
            if (m === 'application/pdf') return true;
            if (m.includes('word') || m.includes('document')) return true;
            if (m.includes('sheet') || m.includes('excel')) return true;
            if (m.includes('presentation') || m.includes('powerpoint')) return true;
            if (m === 'text/csv' || m === 'text/tab-separated-values') return true;
            if (m.includes('zip') || m.includes('rar') || m.includes('7z') || m.includes('tar') || m.includes('gzip')) return true;
        }
        // Check extension
        if (filename) {
            var ext = filename.split('.').pop().toLowerCase();
            if (DOC_EXTENSIONS.indexOf(ext) !== -1) return true;
            // Compound extensions (tar.gz)
            if (filename.toLowerCase().endsWith('.tar.gz') || filename.toLowerCase().endsWith('.tgz')) return true;
            return false;
        }
        return false;
    }

    function getDocType(filename, mimeType) {
        var ext = filename ? filename.split('.').pop().toLowerCase() : '';
        // Check by extension first (most reliable)
        if (ext === 'pdf') return 'pdf';
        if (ext === 'docx' || ext === 'doc') return 'docx';
        if (ext === 'xlsx' || ext === 'xls' || ext === 'ods') return 'xlsx';
        if (ext === 'pptx' || ext === 'ppt') return 'pptx';
        if (ext === 'csv' || ext === 'tsv') return 'csv';
        if (ext === 'zip' || ext === '7z' || ext === 'rar' || ext === 'tar' || ext === 'gz') return 'zip';
        if (filename && (filename.toLowerCase().endsWith('.tar.gz') || filename.toLowerCase().endsWith('.tgz'))) return 'zip';
        // Check by mime type (OOXML types: check specific substrings before 'document')
        if (mimeType) {
            var m = mimeType.toLowerCase();
            if (m.includes('pdf')) return 'pdf';
            if (m.includes('sheet') || m.includes('excel') || m.includes('opendocument.spreadsheet')) return 'xlsx';
            if (m.includes('presentation') || m.includes('powerpoint')) return 'pptx';
            if (m.includes('word')) return 'docx';
            if (m === 'text/csv' || m === 'text/tab-separated-values') return 'csv';
            if (m.includes('zip') || m.includes('rar') || m.includes('7z') || m.includes('tar') || m.includes('gzip')) return 'zip';
        }
        return null;
    }

    // ── Modal ──────────────────────────────────────────────────────────

    function openDocModal(title) {
        // Remove existing modal if any
        closeDocModal();

        var overlay = document.createElement('div');
        overlay.id = 'doc-preview-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;padding:20px';

        var modal = document.createElement('div');
        modal.style.cssText = 'background:var(--bg-secondary,#1e1e2e);border-radius:12px;width:min(95vw,1100px);height:min(90vh,800px);display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,0.5)';

        // Header
        var header = document.createElement('div');
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:12px 16px;border-bottom:1px solid var(--bg-border,#333);background:var(--bg-primary,#1a1a2e)';
        header.innerHTML = '<span style="color:var(--text-primary,#eee);font-weight:600;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' +
            escapeHtml(title) + '</span>';
        var closeBtn = document.createElement('button');
        closeBtn.innerHTML = '<svg class="ui-icon" width="16" height="16"><use href="#icon-close"/></svg>';
        closeBtn.style.cssText = 'background:none;border:none;color:var(--text-muted,#999);font-size:20px;cursor:pointer;padding:4px 8px;margin-left:8px';

        closeBtn.onclick = closeDocModal;
        header.appendChild(closeBtn);

        // Content area
        var content = document.createElement('div');
        content.id = 'doc-preview-content';
        content.style.cssText = 'flex:1;overflow:auto;padding:0;position:relative;background:var(--bg-primary,#1a1a2e)';

        // Loading spinner
        content.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:var(--text-muted,#999)"><div style="text-align:center"><div style="display:inline-block;width:32px;height:32px;border:3px solid #444;border-top-color:var(--accent,#4fc3f7);border-radius:50%;animation:docSpin .6s linear infinite"></div><div style="margin-top:12px;font-size:13px">Loading document…</div></div></div>';

        modal.appendChild(header);
        modal.appendChild(content);
        overlay.appendChild(modal);

        // Click outside to close
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeDocModal();
        });
        // Escape to close
        document.addEventListener('keydown', _docEscHandler);

        document.body.appendChild(overlay);
        return content;
    }

    var _docEscHandler = function (e) {
        if (e.key === 'Escape') closeDocModal();
    };

    function closeDocModal() {
        var existing = document.getElementById('doc-preview-overlay');
        if (existing) existing.remove();
        document.removeEventListener('keydown', _docEscHandler);
    }

    function escapeHtml(t) {
        return String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    }

    // ── PDF Preview ────────────────────────────────────────────────────

    async function renderPdf(blob, container) {
        await loadPdfJs();
        if (!window.pdfjsLib) {
            container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">PDF.js failed to load</div>';
            return;
        }

        var arrayBuffer = await blob.arrayBuffer();
        var pdf = await window.pdfjsLib.getDocument({ data: arrayBuffer }).promise;

        container.style.cssText += ';background:#525659;display:flex;flex-direction:column;align-items:center;gap:8px;padding:16px;overflow-y:auto';
        container.innerHTML = '<div style="color:#ccc;font-size:13px;margin-bottom:8px">' + pdf.numPages + ' page' + (pdf.numPages > 1 ? 's' : '') + '</div>';

        var MAX_PAGES = Math.min(pdf.numPages, 50); // safety limit
        for (var i = 1; i <= MAX_PAGES; i++) {
            var page = await pdf.getPage(i);
            var scale = 1.5;
            var viewport = page.getViewport({ scale: scale });
            var canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.style.cssText = 'max-width:100%;height:auto;box-shadow:0 2px 8px rgba(0,0,0,0.3);border-radius:4px;margin-bottom:8px';
            var ctx = canvas.getContext('2d');
            await page.render({ canvasContext: ctx, viewport: viewport }).promise;
            container.appendChild(canvas);
        }
    }

    // ── DOCX Preview ───────────────────────────────────────────────────

    async function renderDocx(blob, container) {
        await loadDocxPreview();
        if (!window.docx) {
            container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">docx-preview failed to load</div>';
            return;
        }

        container.style.cssText += ';background:#fff;color:#333;padding:24px;overflow-y:auto';
        var wrapper = document.createElement('div');
        wrapper.className = 'docx-container';
        wrapper.style.cssText = 'max-width:800px;margin:0 auto;font-family:Calibri,Arial,sans-serif;font-size:14px;line-height:1.6';
        container.appendChild(wrapper);

        try {
            await docx.renderAsync(blob, wrapper, wrapper, {
                className: 'docx',
                breakPages: true,
                ignoreLastRenderedPageBreak: false,
                renderHeaders: true,
                renderFooters: true,
                renderFootnotes: true,
                renderEndnotes: true
            });
        } catch (e) {
            console.warn('DOCX render error:', e);
            wrapper.innerHTML = '<div style="padding:20px;color:#c00">Error rendering document: ' + escapeHtml(e.message) + '</div>';
        }
    }

    // ── XLSX Preview ───────────────────────────────────────────────────

    async function renderXlsx(blob, container) {
        await loadSheetJs();
        if (!window.XLSX) {
            container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">SheetJS failed to load</div>';
            return;
        }

        var arrayBuffer = await blob.arrayBuffer();
        var workbook = XLSX.read(arrayBuffer, { type: 'array' });

        container.style.cssText += ';background:var(--bg-primary,#1e1e2e);padding:16px;overflow:auto';

        // Sheet tabs
        var tabBar = document.createElement('div');
        tabBar.style.cssText = 'display:flex;gap:4px;margin-bottom:12px;flex-wrap:wrap';
        container.appendChild(tabBar);

        // Content area
        var contentArea = document.createElement('div');
        contentArea.style.cssText = 'overflow:auto;flex:1';
        container.appendChild(contentArea);

        var sheets = workbook.SheetNames;

        function renderSheet(sheetName) {
            var html = XLSX.utils.sheet_to_html(workbook.Sheets[sheetName], { editable: false });
            contentArea.innerHTML = '<div style="font-size:13px;color:var(--text-muted);margin-bottom:8px">Sheet: ' + escapeHtml(sheetName) + '</div>';
            var tableWrap = document.createElement('div');
            tableWrap.style.cssText = 'overflow-x:auto';
            tableWrap.innerHTML = html;
            // Style the table
            var table = tableWrap.querySelector('table');
            if (table) {
                table.style.cssText = 'border-collapse:collapse;width:100%;font-size:13px';
                table.querySelectorAll('td, th').forEach(function (cell) {
                    cell.style.cssText = 'border:1px solid var(--bg-border,#444);padding:4px 8px;white-space:nowrap;max-width:300px;overflow:hidden;text-overflow:ellipsis';
                });
                table.querySelectorAll('th').forEach(function (th) {
                    th.style.cssText += ';background:var(--bg-secondary,#2a2a3e);font-weight:600;position:sticky;top:0';
                });
            }
            contentArea.appendChild(tableWrap);
        }

        sheets.forEach(function (name, idx) {
            var tab = document.createElement('button');
            tab.textContent = name;
            tab.style.cssText = 'padding:6px 14px;border-radius:6px;border:1px solid var(--bg-border,#444);background:' +
                (idx === 0 ? 'var(--accent,#4fc3f7)' : 'var(--bg-secondary,#2a2a3e))') +
                ';color:' + (idx === 0 ? '#fff' : 'var(--text-muted,#999)') +
                ';cursor:pointer;font-size:12px;font-weight:500;transition:all .15s';
            tab.onclick = function () {
                tabBar.querySelectorAll('button').forEach(function (b) {
                    b.style.background = 'var(--bg-secondary,#2a2a3e)';
                    b.style.color = 'var(--text-muted,#999)';
                });
                tab.style.background = 'var(--accent,#4fc3f7)';
                tab.style.color = '#fff';
                renderSheet(name);
            };
            tabBar.appendChild(tab);
        });

        if (sheets.length > 0) renderSheet(sheets[0]);
    }

    // ── CSV Preview ────────────────────────────────────────────────────

    async function renderCsv(blob, container) {
        await loadPapaParse();
        if (!window.Papa) {
            container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">PapaParse failed to load</div>';
            return;
        }

        var text = await blob.text();
        container.style.cssText += ';background:var(--bg-primary,#1e1e2e);padding:16px;overflow:auto';

        var result = Papa.parse(text, { header: true, skipEmptyLines: true });
        if (result.errors.length > 0) {
            console.warn('CSV parse warnings:', result.errors);
        }

        var data = result.data;
        var headers = result.meta.fields || [];

        if (data.length === 0) {
            container.innerHTML = '<div style="padding:20px;color:var(--text-muted)">Empty CSV file</div>';
            return;
        }

        var info = document.createElement('div');
        info.style.cssText = 'font-size:13px;color:var(--text-muted);margin-bottom:12px';
        info.textContent = data.length + ' rows × ' + headers.length + ' columns';
        container.appendChild(info);

        var tableWrap = document.createElement('div');
        tableWrap.style.cssText = 'overflow-x:auto';
        var table = document.createElement('table');
        table.style.cssText = 'border-collapse:collapse;width:100%;font-size:13px';

        // Header row
        var thead = document.createElement('thead');
        var htr = document.createElement('tr');
        headers.forEach(function (h) {
            var th = document.createElement('th');
            th.textContent = h;
            th.style.cssText = 'border:1px solid var(--bg-border,#444);padding:6px 10px;background:var(--bg-secondary,#2a2a3e);font-weight:600;text-align:left;position:sticky;top:0;white-space:nowrap';
            htr.appendChild(th);
        });
        thead.appendChild(htr);
        table.appendChild(thead);

        // Data rows
        var tbody = document.createElement('tbody');
        var MAX_ROWS = Math.min(data.length, 500);
        for (var i = 0; i < MAX_ROWS; i++) {
            var tr = document.createElement('tr');
            headers.forEach(function (h) {
                var td = document.createElement('td');
                td.textContent = data[i][h] || '';
                td.style.cssText = 'border:1px solid var(--bg-border,#444);padding:4px 10px;white-space:nowrap;max-width:300px;overflow:hidden;text-overflow:ellipsis';
                tr.appendChild(td);
            });
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        tableWrap.appendChild(table);
        container.appendChild(tableWrap);

        if (data.length > MAX_ROWS) {
            var more = document.createElement('div');
            more.style.cssText = 'padding:12px;color:var(--text-muted);font-size:12px;text-align:center';
            more.textContent = 'Showing ' + MAX_ROWS + ' of ' + data.length + ' rows';
            container.appendChild(more);
        }
    }

    // ── ZIP Preview ───────────────────────────────────────────────────

    async function renderZip(blob, container, filename) {
        await loadDocxPreview(); // loads jszip
        if (!window.JSZip) {
            container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">JSZip failed to load</div>';
            return;
        }

        var zip = await JSZip.loadAsync(blob);
        var entries = [];
        zip.forEach(function (relativePath, entry) {
            if (!entry.dir) {
                entries.push({ path: relativePath, size: entry._data ? entry._data.uncompressedSize || 0 : 0, entry: entry });
            }
        });
        entries.sort(function (a, b) { return a.path.localeCompare(b.path); });

        container.innerHTML = '';
        container.style.cssText += ';background:var(--bg-primary,#1e1e2e);padding:16px;overflow:auto;display:flex;flex-direction:column;gap:0';

        // Header with total info
        var totalSize = entries.reduce(function (s, e) { return s + e.size; }, 0);
        var header = document.createElement('div');
        header.style.cssText = 'padding:12px 16px;background:var(--bg-secondary,#2a2a3e);border-radius:8px 8px 0 0;border-bottom:1px solid var(--bg-border,#444)';
        header.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center">' +
            '<span style="font-size:14px;font-weight:600;color:var(--text-primary,#eee)">' + escapeHtml(filename || 'Archive') + '</span>' +
            '<span style="font-size:12px;color:var(--text-muted,#999)">' + entries.length + ' files, ' + formatSize(totalSize) + '</span>' +
            '</div>';
        container.appendChild(header);

        if (entries.length === 0) {
            container.innerHTML += '<div style="padding:24px;text-align:center;color:var(--text-muted)">Empty archive</div>';
            return;
        }

        // File list
        var list = document.createElement('div');
        list.style.cssText = 'flex:1;overflow-y:auto';

        entries.forEach(function (item) {
            var row = document.createElement('div');
            row.style.cssText = 'display:flex;align-items:center;padding:8px 16px;border-bottom:1px solid var(--bg-border,#333);gap:10px;transition:background .1s;cursor:pointer';
            row.onmouseenter = function () { row.style.background = 'rgba(255,255,255,0.03)'; };
            row.onmouseleave = function () { row.style.background = ''; };

            var iconId = getFileIconForZip(item.path);
            var nameEl = document.createElement('span');
            nameEl.style.cssText = 'flex:1;font-size:13px;color:var(--text-primary,#eee);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:monospace';
            nameEl.textContent = item.path;
            nameEl.title = item.path;

            var sizeEl = document.createElement('span');
            sizeEl.style.cssText = 'font-size:12px;color:var(--text-muted,#999);white-space:nowrap;min-width:60px;text-align:right';
            sizeEl.textContent = formatSize(item.size);
            var iconSpan = document.createElement('span');
            iconSpan.innerHTML = '<svg class="ui-icon" width="14" height="14"><use href="#icon-' + iconId + '"/></svg>';
            row.appendChild(iconSpan);
            row.appendChild(nameEl);
            row.appendChild(sizeEl);

            // Click to preview text/image files inside the zip
            row.addEventListener('click', async function () {
                try {
                    var data = await item.entry.async('uint8array');
                    var ext = item.path.split('.').pop().toLowerCase();
                    var textExts = ['txt','js','ts','jsx','tsx','py','cpp','c','h','hpp','java','rs','go','sh','sql','html','htm','css','json','xml','md','csv','yaml','yml','toml','ini','log','env','svg'];
                    var imgExts = ['png','jpg','jpeg','gif','bmp','webp','svg'];

                    if (textExts.indexOf(ext) !== -1) {
                        var text = new TextDecoder().decode(data);
                        openInlinePreview(item.path, text, 'text');
                    } else if (imgExts.indexOf(ext) !== -1) {
                        var mime = ext === 'jpg' ? 'image/jpeg' : ext === 'svg' ? 'image/svg+xml' : 'image/' + ext;
                        var imgBlob = new Blob([data], { type: mime });
                        var url = URL.createObjectURL(imgBlob);
                        openInlinePreview(item.path, url, 'image');
                    } else {
                        openInlinePreview(item.path, null, 'binary', formatSize(item.size));
                    }
                } catch (e) {
                    console.warn('Failed to extract file:', e);
                }
            });

            list.appendChild(row);
        });
        container.appendChild(list);

        // Inline preview pane (appears below when a file is clicked)
        var previewPane = document.createElement('div');
        previewPane.id = 'zip-inline-preview';
        previewPane.style.cssText = 'display:none;border-top:1px solid var(--bg-border,#444);background:var(--bg-secondary,#2a2a3e);max-height:50%;overflow:auto;position:relative';
        container.appendChild(previewPane);

        function openInlinePreview(path, data, type, extra) {
            previewPane.style.display = 'block';
            previewPane.innerHTML = '';

            var bar = document.createElement('div');
            bar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:8px 16px;border-bottom:1px solid var(--bg-border,#444);position:sticky;top:0;background:var(--bg-secondary,#2a2a3e);z-index:1';
            bar.innerHTML = '<span style="font-size:12px;color:var(--text-muted);font-family:monospace;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1">' + escapeHtml(path) + '</span>';
            var closeBtn = document.createElement('button');
        closeBtn.innerHTML = '<svg class="ui-icon" width="16" height="16"><use href="#icon-close"/></svg>';
            closeBtn.style.cssText = 'background:none;border:none;color:var(--text-muted);cursor:pointer;font-size:16px;padding:2px 6px;flex-shrink:0';
            closeBtn.onclick = function () { previewPane.style.display = 'none'; previewPane.innerHTML = ''; };
            bar.appendChild(closeBtn);
            previewPane.appendChild(bar);

            if (type === 'text') {
                var pre = document.createElement('pre');
                pre.style.cssText = 'padding:16px;font-size:13px;line-height:1.5;color:var(--text-primary,#eee);white-space:pre-wrap;word-break:break-all;margin:0;font-family:monospace';
                pre.textContent = data;
                previewPane.appendChild(pre);
            } else if (type === 'image') {
                var img = document.createElement('img');
                img.src = data;
                img.style.cssText = 'max-width:100%;max-height:100%;display:block;margin:0 auto;padding:16px';
                previewPane.appendChild(img);
            } else {
                previewPane.innerHTML += '<div style="padding:24px;text-align:center;color:var(--text-muted)">Binary file — ' + (extra || '') + ' — download to view</div>';
            }
            previewPane.scrollTop = 0;
        }
    }

    function getFileIconForZip(path) {
        var ext = path.split('.').pop().toLowerCase();
        var map = {
            'png': 'image', 'jpg': 'image', 'jpeg': 'image', 'gif': 'image', 'bmp': 'image', 'webp': 'image',
            'svg': 'edit', 'ico': 'image',
            'mp4': 'video', 'avi': 'video', 'mkv': 'video', 'mov': 'video',
            'mp3': 'music', 'wav': 'music', 'ogg': 'music', 'flac': 'music',
            'pdf': 'clipboard', 'doc': 'edit', 'docx': 'edit', 'xls': 'clipboard', 'xlsx': 'clipboard', 'ppt': 'video', 'pptx': 'video',
            'zip': 'folder', 'rar': 'folder', '7z': 'folder', 'tar': 'folder', 'gz': 'folder',
            'js': 'edit', 'ts': 'edit', 'py': 'edit', 'rs': 'edit', 'go': 'edit',
            'html': 'edit', 'css': 'edit', 'json': 'clipboard', 'xml': 'clipboard',
            'txt': 'clipboard', 'md': 'edit', 'csv': 'clipboard',
            'exe': 'gear', 'dll': 'gear', 'so': 'gear',
        };
        return map[ext] || 'clipboard';
    }

    // ── PPTX Preview (custom OOXML parser via JSZip) ──────────────────

    async function renderPptx(blob, container) {
        await loadDocxPreview(); // loads JSZip
        if (!window.JSZip) {
            container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">JSZip failed to load</div>';
            return;
        }

        container.style.cssText += ';background:#2b2b2b;padding:0;overflow-y:auto;display:flex;flex-direction:column;align-items:center;gap:16px';

        var zip = await JSZip.loadAsync(blob);

        // Find all slide XML files
        var slideFiles = [];
        zip.forEach(function (path, entry) {
            if (path.match(/^ppt\/slides\/slide\d+\.xml$/) && !entry.dir) {
                slideFiles.push({ path: path, entry: entry });
            }
        });
        slideFiles.sort(function (a, b) {
            var na = parseInt(a.path.match(/slide(\d+)/)?.[1] || '0');
            var nb = parseInt(b.path.match(/slide(\d+)/)?.[1] || '0');
            return na - nb;
        });

        if (slideFiles.length === 0) {
            container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">No slides found in presentation</div>';
            return;
        }

        // Slide counter
        var counter = document.createElement('div');
        counter.style.cssText = 'padding:12px 16px;color:#aaa;font-size:13px;width:100%;text-align:center;background:#1e1e1e;position:sticky;top:0;z-index:1';
        counter.textContent = slideFiles.length + ' slide' + (slideFiles.length > 1 ? 's' : '');
        container.appendChild(counter);

        // Collect images from ppt/media/
        var mediaCache = {};
        zip.forEach(function (path, entry) {
            if (path.startsWith('ppt/media/') && !entry.dir) {
                mediaCache[path] = entry;
            }
        });

        // Render each slide
        for (var si = 0; si < slideFiles.length; si++) {
            var xmlStr = await slideFiles[si].entry.async('string');
            var slideDiv = await renderPptxSlide(xmlStr, si + 1, mediaCache, zip);
            container.appendChild(slideDiv);
        }
    }

    // EMU to pixels (914400 EMU = 1 inch, 96 DPI)
    function emuToPx(emu) { return Math.round(emu / 914400 * 96); }

    function parseXml(str) {
        var parser = new DOMParser();
        // Strip namespace prefixes from both declarations and element/attribute names
        // so querySelector('sp') works instead of needing querySelector('p\\:sp')
        var stripped = str
            .replace(/\s+xmlns:\w+="[^"]*"/g, '')
            .replace(/<\/?\w+:/g, function(m) { return m.replace(/\w+:/, ''); })
            .replace(/\s+\w+:/g, function(m) { return m.replace(/\w+:/, ''); });
        return parser.parseFromString(stripped, 'application/xml');
    }

    function getTextContent(node) {
        if (!node) return '';
        var parts = [];
        function walk(n) {
            if (n.nodeType === 3) { parts.push(n.textContent); return; }
            if (n.localName === 't' || n.localName === 'r') {
                for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
            }
            if (n.localName === 'p') {
                for (var c = n.firstChild; c; c = c.nextSibling) walk(c);
                parts.push('\n');
            }
        }
        for (var c = node.firstChild; c; c = c.nextSibling) walk(c);
        return parts.join('').trim();
    }

    function getShapeBounds(sp) {
        var xfrm = sp.querySelector('spPr > xfrm, xfrm');
        if (!xfrm) return null;
        var off = xfrm.querySelector('off');
        var ext = xfrm.querySelector('ext');
        if (!off || !ext) return null;
        return {
            x: parseInt(off.getAttribute('x') || '0'),
            y: parseInt(off.getAttribute('y') || '0'),
            cx: parseInt(ext.getAttribute('cx') || '0'),
            cy: parseInt(ext.getAttribute('cy') || '0')
        };
    }

    function getShapeFill(sp) {
        var solidFill = sp.querySelector('spPr > solidFill, spPr > ln > solidFill');
        if (!solidFill) return null;
        var srgb = solidFill.querySelector('srgbClr');
        if (srgb) return '#' + srgb.getAttribute('val');
        var schemeClr = solidFill.querySelector('schemeClr');
        if (schemeClr) {
            var name = schemeClr.getAttribute('val');
            var colorMap = { 'dk1': '#1a1a1a', 'lt1': '#ffffff', 'dk2': '#333333', 'lt2': '#f0f0f0',
                'accent1': '#4472c4', 'accent2': '#ed7d31', 'accent3': '#a5a5a5', 'accent4': '#ffc000',
                'accent5': '#5b9bd5', 'accent6': '#70ad47', 'bg1': '#ffffff', 'bg2': '#f0f0f0',
                'tx1': '#1a1a1a', 'tx2': '#333333' };
            return colorMap[name] || null;
        }
        return null;
    }

    function getRunStyle(r) {
        var rPr = r.querySelector('rPr');
        var style = {};
        if (rPr) {
            var b = rPr.querySelector('b');
            if (b) style.fontWeight = 'bold';
            var i = rPr.querySelector('i');
            if (i) style.fontStyle = 'italic';
            var sz = rPr.getAttribute('sz');
            if (sz) style.fontSize = Math.round(parseInt(sz) / 100) + 'pt';
            var fill = rPr.querySelector('solidFill');
            if (fill) {
                var srgb = fill.querySelector('srgbClr');
                if (srgb) style.color = '#' + srgb.getAttribute('val');
            }
            var latin = rPr.querySelector('latin');
            if (latin) style.fontFamily = latin.getAttribute('typeface') || '';
        }
        return style;
    }

    async function renderPptxSlide(xmlStr, slideNum, mediaCache, zip) {
        var SLIDE_W = 9144000; // 10 inches in EMU
        var SLIDE_H = 6858000; // 7.5 inches in EMU
        var PX_W = emuToPx(SLIDE_W);
        var PX_H = emuToPx(SLIDE_H);

        var doc = parseXml(xmlStr);
        var ns = 'http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing';

        // Slide wrapper
        var slideDiv = document.createElement('div');
        slideDiv.style.cssText = 'position:relative;width:' + PX_W + 'px;height:' + PX_H + 'px;background:#fff;border-radius:4px;box-shadow:0 2px 12px rgba(0,0,0,0.4);overflow:hidden;flex-shrink:0';

        // Slide number badge
        var badge = document.createElement('div');
        badge.style.cssText = 'position:absolute;bottom:8px;right:8px;background:rgba(0,0,0,0.5);color:#fff;padding:2px 8px;border-radius:4px;font-size:11px;z-index:2';
        badge.textContent = slideNum;
        slideDiv.appendChild(badge);

        // Process all shape elements
        var shapes = doc.querySelectorAll('sp, pic, grpSp');
        for (var i = 0; i < shapes.length; i++) {
            var sp = shapes[i];
            var bounds = getShapeBounds(sp);
            if (!bounds) continue;

            var el = document.createElement('div');
            var left = emuToPx(bounds.x);
            var top = emuToPx(bounds.y);
            var width = emuToPx(bounds.cx);
            var height = emuToPx(bounds.cy);
            el.style.cssText = 'position:absolute;left:' + left + 'px;top:' + top + 'px;width:' + width + 'px;height:' + height + 'px;overflow:hidden;box-sizing:border-box';

            // Background fill
            var fill = getShapeFill(sp);
            if (fill) el.style.background = fill;

            // Border
            var ln = sp.querySelector('spPr > ln');
            if (ln) {
                var lnW = parseInt(ln.getAttribute('w') || '0');
                if (lnW > 0) {
                    var lnFill = ln.querySelector('solidFill');
                    var lnColor = '#999';
                    if (lnFill) {
                        var lsrgb = lnFill.querySelector('srgbClr');
                        if (lsrgb) lnColor = '#' + lsrgb.getAttribute('val');
                    }
                    el.style.border = Math.max(1, Math.round(lnW / 12700)) + 'px solid ' + lnColor;
                }
            }

            // Check if it's a picture
            var blipFill = sp.querySelector('blipFill');
            if (blipFill) {
                var blip = blipFill.querySelector('blip');
                if (blip) {
                    var rId = blip.getAttribute('r:embed') || blip.getAttribute('r:link');
                    if (rId) {
                        // Resolve the image from relationships
                        var relsPath = 'ppt/slides/_rels/slide' + slideNum + '.xml.rels';
                        var relsEntry = zip.file(relsPath);
                        if (relsEntry) {
                            var relsXml = await relsEntry.async('string');
                            var relsDoc = parseXml(relsXml);
                            var rel = relsDoc.querySelector('Relationship[Id="' + rId + '"]');
                            if (rel) {
                                var target = rel.getAttribute('Target');
                                if (target && !target.startsWith('http')) {
                                    var imgPath = target.startsWith('/') ? target.substring(1) : 'ppt/slides/' + target;
                                    var imgEntry = zip.file(imgPath);
                                    if (imgEntry) {
                                        var imgData = await imgEntry.async('base64');
                                        var ext = imgPath.split('.').pop().toLowerCase();
                                        var imgMime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'gif' ? 'image/gif' : ext === 'png' ? 'image/png' : 'image/' + ext;
                                        var img = document.createElement('img');
                                        img.src = 'data:' + imgMime + ';base64,' + imgData;
                                        img.style.cssText = 'width:100%;height:100%;object-fit:contain;display:block';
                                        el.appendChild(img);
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // Text content
            var txBody = sp.querySelector('txBody');
            if (txBody) {
                var paragraphs = txBody.querySelectorAll('p');
                for (var pi = 0; pi < paragraphs.length; pi++) {
                    var p = paragraphs[pi];
                    var pDiv = document.createElement('div');
                    pDiv.style.cssText = 'margin:2px 4px;line-height:1.3';

                    var runs = p.querySelectorAll('r');
                    for (var ri = 0; ri < runs.length; ri++) {
                        var r = runs[ri];
                        var t = r.querySelector('t');
                        if (!t) continue;
                        var span = document.createElement('span');
                        span.textContent = t.textContent || '';
                        var style = getRunStyle(r);
                        Object.keys(style).forEach(function (k) { span.style[k] = style[k]; });
                        if (!style.color) span.style.color = '#1a1a1a';
                        if (!style.fontSize) span.style.fontSize = '14px';
                        pDiv.appendChild(span);
                    }
                    el.appendChild(pDiv);
                }
            }

            slideDiv.appendChild(el);
        }

        return slideDiv;
    }

    function formatSize(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    // ── Main entry point ───────────────────────────────────────────────

    async function previewDocument(blob, filename, mimeType) {
        var docType = getDocType(filename, mimeType);
        if (!docType) return false;

        var title = filename || 'Document';
        var container = openDocModal(title);

        try {
            switch (docType) {
                case 'pdf':
                    await renderPdf(blob, container);
                    break;
                case 'docx':
                case 'pptx':
                    if (docType === 'pptx') {
                        await renderPptx(blob, container);
                    } else {
                        await renderDocx(blob, container);
                    }
                    break;
                case 'xlsx':
                    await renderXlsx(blob, container);
                    break;
                case 'csv':
                    await renderCsv(blob, container);
                    break;
                case 'zip':
                    await renderZip(blob, container, filename);
                    break;
                default:
                    container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">Preview not available for this file type</div>';
            }
        } catch (e) {
            console.error('Document preview error:', e);
            container.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-muted)">' +
                '<div style="margin-bottom:12px">' + icon('warning') + '</div>' +
                '<div>Failed to render document</div>' +
                '<div style="font-size:12px;margin-top:8px;color:var(--text-faint)">' + escapeHtml(e.message) + '</div>' +
                '</div>';
        }
        return true;
    }

    // ── PDF Editor ────────────────────────────────────────────────────────

    var _pdfLibLoaded = false;

    function loadPdfLib() {
        if (_pdfLibLoaded) return Promise.resolve();
        return loadScript('/libs/pdf-lib.min.js').then(function () {
            _pdfLibLoaded = true;
        });
    }

    // State for the PDF editor
    var _pdfEditor = {
        pdfBytes: null,     // Original PDF bytes
        pdfDoc: null,       // PDFLib document
        pages: [],          // [{index, rotation, deleted}]
        currentPage: 0,
        history: [],        // For undo
        historyIdx: -1,
        filename: '',
    };

    function pdfEditorSaveState() {
        // Save both page metadata AND the actual PDF bytes for undo/redo
        _pdfEditor.history = _pdfEditor.history.slice(0, _pdfEditor.historyIdx + 1);
        _pdfEditor.history.push({
            pages: JSON.parse(JSON.stringify(_pdfEditor.pages)),
            pdfBytes: _pdfEditor.pdfBytes ? _pdfEditor.pdfBytes.slice() : null
        });
        _pdfEditor.historyIdx = _pdfEditor.history.length - 1;
        if (_pdfEditor.history.length > 30) {
            _pdfEditor.history.shift();
            _pdfEditor.historyIdx--;
        }
    }

    async function pdfEditorUndo() {
        if (_pdfEditor.historyIdx <= 0) return;
        _pdfEditor.historyIdx--;
        var state = _pdfEditor.history[_pdfEditor.historyIdx];
        _pdfEditor.pages = JSON.parse(JSON.stringify(state.pages));
        if (state.pdfBytes) {
            _pdfEditor.pdfBytes = state.pdfBytes.slice();
            _pdfEditor.pdfDoc = await PDFLib.PDFDocument.load(_pdfEditor.pdfBytes);
        }
        pdfEditorRenderThumbnails();
        pdfEditorRenderPreview();
        pdfEditorUpdateNav();
    }

    async function pdfEditorRedo() {
        if (_pdfEditor.historyIdx >= _pdfEditor.history.length - 1) return;
        _pdfEditor.historyIdx++;
        var state = _pdfEditor.history[_pdfEditor.historyIdx];
        _pdfEditor.pages = JSON.parse(JSON.stringify(state.pages));
        if (state.pdfBytes) {
            _pdfEditor.pdfBytes = state.pdfBytes.slice();
            _pdfEditor.pdfDoc = await PDFLib.PDFDocument.load(_pdfEditor.pdfBytes);
        }
        pdfEditorRenderThumbnails();
        pdfEditorRenderPreview();
        pdfEditorUpdateNav();
    }

    // Open PDF editor
    async function openPdfEditor(blob, filename) {
        await Promise.all([loadPdfLib(), loadPdfJs()]);
        if (!window.PDFLib) {
            alert('pdf-lib failed to load');
            return;
        }

        var arrayBuffer = await blob.arrayBuffer();
        _pdfEditor.pdfBytes = new Uint8Array(arrayBuffer);
        _pdfEditor.pdfDoc = await PDFLib.PDFDocument.load(_pdfEditor.pdfBytes);
        _pdfEditor.filename = filename || 'document.pdf';
        _pdfEditor.currentPage = 0;
        _pdfEditor.history = [];
        _pdfEditor.historyIdx = -1;

        // Initialize pages array
        var pageCount = _pdfEditor.pdfDoc.getPageCount();
        _pdfEditor.pages = [];
        for (var i = 0; i < pageCount; i++) {
            _pdfEditor.pages.push({ index: i, rotation: 0, deleted: false });
        }
        pdfEditorSaveState();

        // Build editor UI
        var overlay = document.createElement('div');
        overlay.id = 'pdf-editor-overlay';
        overlay.style.cssText = 'position:fixed;inset:0;z-index:10001;background:rgba(0,0,0,0.9);display:flex;flex-direction:column';

        // Header
        var header = document.createElement('div');
        // Class (not id): the phone layout in style.css reflows this header and
        // the two side panels (see the "Editor modals: phone layout" block).
        header.className = 'pdf-editor-header';
        header.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:#1a1a2e;border-bottom:1px solid #333;flex-shrink:0';
        header.innerHTML = '<span style="color:#eee;font-weight:600;font-size:14px">' + icon('edit') + ' PDF Editor — ' + escapeHtml(filename) + '</span>';
        var headerBtns = document.createElement('div');
        headerBtns.style.cssText = 'display:flex;gap:8px;align-items:center';

        // Undo/Redo
        var undoBtn = pdfEditorBtn('icon-undo', 'Undo', function () { pdfEditorUndo(); });
        var redoBtn = pdfEditorBtn('icon-redo', 'Redo', function () { pdfEditorRedo(); });
        headerBtns.appendChild(undoBtn);
        headerBtns.appendChild(redoBtn);

        // Separator
        var sep = document.createElement('span');
        sep.style.cssText = 'width:1px;height:24px;background:#444;margin:0 4px';
        headerBtns.appendChild(sep);

        // Merge button
        var mergeBtn = pdfEditorBtn('icon-merge', 'Merge PDF', function () { pdfEditorMerge(); });
        headerBtns.appendChild(mergeBtn);

        // Export button
        var exportBtn = document.createElement('button');
        exportBtn.innerHTML = icon('download') + ' Save & Download';
        exportBtn.style.cssText = 'padding:6px 16px;border-radius:6px;border:none;background:linear-gradient(135deg,#4fc3f7,#29b6f6);color:#fff;font-weight:600;font-size:13px;cursor:pointer';
        exportBtn.onclick = function () { pdfEditorExport(); };
        headerBtns.appendChild(exportBtn);

        // Close button
        var closeBtn = pdfEditorBtn('icon-close', 'Close', function () { pdfEditorClose(); });
        headerBtns.appendChild(closeBtn);

        header.appendChild(headerBtns);
        overlay.appendChild(header);

        // Main content
        var main = document.createElement('div');
        main.className = 'pdf-editor-main';
        main.style.cssText = 'display:flex;flex:1;overflow:hidden';

        // Left panel: thumbnails
        var leftPanel = document.createElement('div');
        leftPanel.id = 'pdf-thumb-panel';
        leftPanel.style.cssText = 'width:160px;background:#1e1e2e;border-right:1px solid #333;overflow-y:auto;padding:8px;flex-shrink:0;display:flex;flex-direction:column;gap:8px';
        main.appendChild(leftPanel);

        // Center: preview
        var center = document.createElement('div');
        center.id = 'pdf-preview-panel';
        center.style.cssText = 'flex:1;overflow:auto;display:flex;align-items:center;justify-content:center;background:#2b2b2b;padding:16px';
        main.appendChild(center);

        // Right panel: tools
        var rightPanel = document.createElement('div');
        rightPanel.id = 'pdf-tools-panel';
        rightPanel.style.cssText = 'width:200px;background:#1e1e2e;border-left:1px solid #333;padding:12px;flex-shrink:0;overflow-y:auto;display:flex;flex-direction:column;gap:8px';

        // Page tools
        var pageToolsLabel = document.createElement('div');
        pageToolsLabel.style.cssText = 'color:#aaa;font-size:12px;font-weight:600;text-transform:uppercase;margin-bottom:4px';
        pageToolsLabel.textContent = 'Page Tools';
        rightPanel.appendChild(pageToolsLabel);

        var toolBtns = [
            { icon: '🔄', label: 'Rotate Left', action: function () { pdfEditorRotate(-90); } },
            { icon: '🔄', label: 'Rotate Right', action: function () { pdfEditorRotate(90); } },
            { icon: 'icon-trash', label: 'Delete Page', action: function () { pdfEditorDeletePage(); } },
            { icon: 'icon-clipboard', label: 'Duplicate Page', action: function () { pdfEditorDuplicatePage(); } },
        ];
        toolBtns.forEach(function (t) {
            var btn = pdfEditorToolBtn(t.icon, t.label, t.action);
            rightPanel.appendChild(btn);
        });

        // Separator
        var sep2 = document.createElement('div');
        sep2.style.cssText = 'height:1px;background:#333;margin:8px 0';
        rightPanel.appendChild(sep2);

        var annotateLabel = document.createElement('div');
        annotateLabel.style.cssText = 'color:#aaa;font-size:12px;font-weight:600;text-transform:uppercase;margin-bottom:4px';
        annotateLabel.textContent = 'Annotate';
        rightPanel.appendChild(annotateLabel);

        var annotateBtns = [
            { icon: 'icon-edit', label: 'Add Text', action: function () { pdfEditorAnnotateText(); } },
            { icon: 'icon-brush', label: 'Draw', action: function () { pdfEditorAnnotateDraw(); } },
            { icon: '⬜', label: 'Whiteout', action: function () { pdfEditorAnnotateWhiteout(); } },
        ];
        annotateBtns.forEach(function (t) {
            var btn = pdfEditorToolBtn(t.icon, t.label, t.action);
            rightPanel.appendChild(btn);
        });

        // Separator
        var sep3 = document.createElement('div');
        sep3.style.cssText = 'height:1px;background:#333;margin:8px 0';
        rightPanel.appendChild(sep3);

        var cropLabel = document.createElement('div');
        cropLabel.style.cssText = 'color:#aaa;font-size:12px;font-weight:600;text-transform:uppercase;margin-bottom:4px';
        cropLabel.textContent = 'Crop';
        rightPanel.appendChild(cropLabel);

        var cropBtn = pdfEditorToolBtn('icon-crop', 'Crop Page', function () { pdfEditorCrop(); });
        rightPanel.appendChild(cropBtn);

        main.appendChild(rightPanel);
        overlay.appendChild(main);

        // Click outside to close
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) pdfEditorClose();
        });
        document.addEventListener('keydown', _pdfEditorEscHandler);
        document.body.appendChild(overlay);

        pdfEditorRenderThumbnails();
        pdfEditorRenderPreview();
        pdfEditorUpdateNav();
    }

    var _pdfEditorEscHandler = function (e) {
        if (e.key === 'Escape') pdfEditorClose();
    };

    function pdfEditorClose() {
        var el = document.getElementById('pdf-editor-overlay');
        if (el) el.remove();
        document.removeEventListener('keydown', _pdfEditorEscHandler);
    }

    function pdfEditorBtn(iconId, title, onclick) {
        var btn = document.createElement('button');
        btn.innerHTML = '<svg class="ui-icon" width="16" height="16"><use href="#' + iconId + '"/></svg>';
        btn.title = title;
        btn.style.cssText = 'background:rgba(255,255,255,0.1);border:1px solid #444;color:#ccc;width:32px;height:32px;border-radius:6px;cursor:pointer;font-size:16px;display:flex;align-items:center;justify-content:center';
        btn.onclick = onclick;
        return btn;
    }

    function pdfEditorToolBtn(icon, label, onclick) {
        var btn = document.createElement('button');
        btn.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 12px;background:rgba(255,255,255,0.05);border:1px solid #333;color:#ccc;border-radius:6px;cursor:pointer;font-size:13px;text-align:left;transition:background .15s';
        btn.title = label;
        btn.onmouseenter = function () { btn.style.background = 'rgba(255,255,255,0.1)'; };
        btn.onmouseleave = function () { btn.style.background = 'rgba(255,255,255,0.05)'; };
        btn.innerHTML = '<span style="flex-shrink:0"><svg class="ui-icon" width="14" height="14"><use href="#' + icon + '"/></svg></span><span>' + label + '</span>';
        btn.onclick = onclick;
        return btn;
    }

    // Render thumbnail strip
    function pdfEditorRenderThumbnails() {
        var panel = document.getElementById('pdf-thumb-panel');
        if (!panel) return;
        panel.innerHTML = '';

        var visibleIdx = 0;
        _pdfEditor.pages.forEach(function (page, i) {
            if (page.deleted) return;
            var thumb = document.createElement('div');
            var isActive = visibleIdx === _pdfEditor.currentPage;
            thumb.style.cssText = 'position:relative;background:#fff;border-radius:4px;overflow:hidden;cursor:pointer;border:2px solid ' + (isActive ? 'var(--accent,#4fc3f7)' : 'transparent') + ';transition:border .15s;flex-shrink:0';
            thumb.dataset.pageIdx = i;

            // Render thumbnail canvas
            var canvas = document.createElement('canvas');
            canvas.width = 120;
            canvas.height = 160;
            canvas.style.cssText = 'width:100%;display:block';
            thumb.appendChild(canvas);

            // Page number badge
            var badge = document.createElement('div');
            badge.style.cssText = 'position:absolute;bottom:2px;left:2px;background:rgba(0,0,0,0.6);color:#fff;padding:1px 5px;border-radius:3px;font-size:10px';
            badge.textContent = (visibleIdx + 1);
            thumb.appendChild(badge);

            // Rotation indicator
            if (page.rotation !== 0) {
                var rotBadge = document.createElement('div');
                rotBadge.style.cssText = 'position:absolute;top:2px;right:2px;background:rgba(0,100,255,0.7);color:#fff;padding:1px 4px;border-radius:3px;font-size:9px';
                rotBadge.textContent = page.rotation + '°';
                thumb.appendChild(rotBadge);
            }

            (function (capturedIdx) {
                thumb.onclick = function () {
                    _pdfEditor.currentPage = capturedIdx;
                    pdfEditorRenderThumbnails();
                    pdfEditorRenderPreview();
                };
            })(visibleIdx);

            // Drag to reorder
            thumb.draggable = true;
            thumb.ondragstart = function (e) {
                e.dataTransfer.setData('text/plain', i.toString());
                thumb.style.opacity = '0.5';
            };
            thumb.ondragend = function () { thumb.style.opacity = '1'; };
            thumb.ondragover = function (e) { e.preventDefault(); thumb.style.borderColor = 'var(--accent,#4fc3f7)'; };
            thumb.ondragleave = function () { thumb.style.borderColor = isActive ? 'var(--accent,#4fc3f7)' : 'transparent'; };
            thumb.ondrop = function (e) {
                e.preventDefault();
                var fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
                var toIdx = i;
                if (fromIdx === toIdx) return;
                var item = _pdfEditor.pages.splice(fromIdx, 1)[0];
                _pdfEditor.pages.splice(toIdx, 0, item);
                pdfEditorSaveState();
                pdfEditorRenderThumbnails();
                pdfEditorRenderPreview();
            };

            panel.appendChild(thumb);

            // Render thumbnail asynchronously
            (async function (c, pgIdx, rot) {
                try {
                    var tempDoc = await PDFLib.PDFDocument.create();
                    var copiedPages = await tempDoc.copyPages(_pdfEditor.pdfDoc, [pgIdx]);
                    var copied = copiedPages[0];
                    if (rot) copied.setRotation(PDFLib.degrees(rot));
                    tempDoc.addPage(copied);
                    var pdfBytes = await tempDoc.save();
                    var pdfDoc2 = await window.pdfjsLib.getDocument({ data: pdfBytes }).promise;
                    var page2 = await pdfDoc2.getPage(1);
                    var viewport = page2.getViewport({ scale: 0.2 });
                    c.width = viewport.width;
                    c.height = viewport.height;
                    var ctx = c.getContext('2d');
                    await page2.render({ canvasContext: ctx, viewport: viewport }).promise;
                } catch (_) {}
            })(canvas, i, page.rotation);

            visibleIdx++;
        });
    }

    // Render current page preview
    async function pdfEditorRenderPreview() {
        var panel = document.getElementById('pdf-preview-panel');
        if (!panel) return;
        panel.innerHTML = '<div style="color:#999">Loading page...</div>';

        var visibleIdx = 0;
        var targetIdx = -1;
        for (var i = 0; i < _pdfEditor.pages.length; i++) {
            if (_pdfEditor.pages[i].deleted) continue;
            if (visibleIdx === _pdfEditor.currentPage) { targetIdx = i; break; }
            visibleIdx++;
        }
        if (targetIdx === -1) { panel.innerHTML = '<div style="color:#999">No pages</div>'; return; }

        var page = _pdfEditor.pages[targetIdx];

        try {
            var tempDoc = await PDFLib.PDFDocument.create();
            var copiedPages = await tempDoc.copyPages(_pdfEditor.pdfDoc, [targetIdx]);
            var copied = copiedPages[0];
            if (page.rotation) copied.setRotation(PDFLib.degrees(page.rotation));
            tempDoc.addPage(copied);
            var pdfBytes = await tempDoc.save();
            var pdfDoc2 = await window.pdfjsLib.getDocument({ data: pdfBytes }).promise;
            var pdfPage = await pdfDoc2.getPage(1);

            // Scale to fit panel
            var panelRect = panel.getBoundingClientRect();
            var scale = Math.min(
                (panelRect.width - 40) / pdfPage.getViewport({ scale: 1 }).width,
                (panelRect.height - 40) / pdfPage.getViewport({ scale: 1 }).height,
                2.0
            );
            var viewport = pdfPage.getViewport({ scale: scale });

            var canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.style.cssText = 'border-radius:4px;box-shadow:0 4px 20px rgba(0,0,0,0.5)';
            var ctx = canvas.getContext('2d');
            await pdfPage.render({ canvasContext: ctx, viewport: viewport }).promise;

            panel.innerHTML = '';
            panel.appendChild(canvas);
        } catch (e) {
            panel.innerHTML = '<div style="color:#f66">Error rendering page: ' + escapeHtml(e.message) + '</div>';
        }
    }

    function pdfEditorUpdateNav() {
        var panel = document.getElementById('pdf-thumb-panel');
        if (!panel) return;
        // Highlight active thumbnail
        var thumbs = panel.querySelectorAll('[data-page-idx]');
        var visibleIdx = 0;
        thumbs.forEach(function (t) {
            var idx = parseInt(t.dataset.pageIdx);
            var page = _pdfEditor.pages[idx];
            var isActive = visibleIdx === _pdfEditor.currentPage;
            t.style.borderColor = isActive ? 'var(--accent,#4fc3f7)' : 'transparent';
            if (!page.deleted) visibleIdx++;
        });
    }

    // ── PDF Editor Actions ──────────────────────────────────────────────

    function pdfEditorRotate(deg) {
        var visibleIdx = 0;
        for (var i = 0; i < _pdfEditor.pages.length; i++) {
            if (_pdfEditor.pages[i].deleted) continue;
            if (visibleIdx === _pdfEditor.currentPage) {
                _pdfEditor.pages[i].rotation = ((_pdfEditor.pages[i].rotation || 0) + deg + 360) % 360;
                pdfEditorSaveState();
                pdfEditorRenderThumbnails();
                pdfEditorRenderPreview();
                return;
            }
            visibleIdx++;
        }
    }

    async function pdfEditorDeletePage() {
        var count = _pdfEditor.pages.filter(function (p) { return !p.deleted; }).length;
        if (count <= 1) { alert('Cannot delete the last page'); return; }
        if (!(await uiConfirm('Delete this page?'))) return;
        var visibleIdx = 0;
        for (var i = 0; i < _pdfEditor.pages.length; i++) {
            if (_pdfEditor.pages[i].deleted) continue;
            if (visibleIdx === _pdfEditor.currentPage) {
                _pdfEditor.pages[i].deleted = true;
                var newCount = _pdfEditor.pages.filter(function (p) { return !p.deleted; }).length;
                if (_pdfEditor.currentPage >= newCount) _pdfEditor.currentPage = newCount - 1;
                pdfEditorSaveState();
                pdfEditorRenderThumbnails();
                pdfEditorRenderPreview();
                return;
            }
            visibleIdx++;
        }
    }

    function pdfEditorDuplicatePage() {
        var visibleIdx = 0;
        for (var i = 0; i < _pdfEditor.pages.length; i++) {
            if (_pdfEditor.pages[i].deleted) continue;
            if (visibleIdx === _pdfEditor.currentPage) {
                var copy = Object.assign({}, _pdfEditor.pages[i]);
                _pdfEditor.pages.splice(i + 1, 0, copy);
                _pdfEditor.currentPage = visibleIdx + 1;
                pdfEditorSaveState();
                pdfEditorRenderThumbnails();
                pdfEditorRenderPreview();
                return;
            }
            visibleIdx++;
        }
    }

    // Merge another PDF into the current one
    async function pdfEditorMerge() {
        var input = document.createElement('input');
        input.type = 'file';
        input.accept = '.pdf';
        input.onchange = async function () {
            var file = input.files[0];
            if (!file) return;
            try {
                var mergeBytes = new Uint8Array(await file.arrayBuffer());
                var mergeDoc = await PDFLib.PDFDocument.load(mergeBytes);
                var mergePageCount = mergeDoc.getPageCount();
                if (!(await uiConfirm('Merge ' + mergePageCount + ' page' + (mergePageCount > 1 ? 's' : '') + ' from ' + file.name + '?'))) return;

                // Add pages to end
                for (var i = 0; i < mergePageCount; i++) {
                    var copiedPagesArr = await _pdfEditor.pdfDoc.copyPages(mergeDoc, [i]);
                    var copiedPage = copiedPagesArr[0];
                    _pdfEditor.pdfDoc.addPage(copiedPage);
                    _pdfEditor.pages.push({ index: _pdfEditor.pdfDoc.getPageCount() - 1, rotation: 0, deleted: false });
                }
                pdfEditorSaveState();
                pdfEditorRenderThumbnails();
                pdfEditorRenderPreview();
                alert('Merged ' + mergePageCount + ' page(s)');
            } catch (e) {
                alert('Failed to merge: ' + e.message);
            }
        };
        input.click();
    }

    // Export modified PDF
    async function pdfEditorExport() {
        try {
            var newDoc = await PDFLib.PDFDocument.create();
            var visiblePages = _pdfEditor.pages.filter(function (p) { return !p.deleted; });

            for (var i = 0; i < visiblePages.length; i++) {
                var srcPage = visiblePages[i];
                var copiedPagesFinal = await newDoc.copyPages(_pdfEditor.pdfDoc, [srcPage.index]);
                var copied = copiedPagesFinal[0];
                if (srcPage.rotation) copied.setRotation(PDFLib.degrees(srcPage.rotation));
                newDoc.addPage(copied);
            }

            var pdfBytes = await newDoc.save();
            var blob = new Blob([pdfBytes], { type: 'application/pdf' });
            // Inside a shell an <a download> writes nothing, so the edited PDF
            // goes through the native save bridge (box-shell.js) when present.
            if (typeof window.saveBlobToDisk === 'function') {
                window.saveBlobToDisk(blob, _pdfEditor.filename);
            } else {
                var url = URL.createObjectURL(blob);
                var a = document.createElement('a');
                a.href = url;
                a.download = _pdfEditor.filename;
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                setTimeout(function () { URL.revokeObjectURL(url); }, 5000);
            }
        } catch (e) {
            alert('Export failed: ' + e.message);
        }
    }

    // ── Annotations ─────────────────────────────────────────────────────

    async function pdfEditorAnnotateText() {
        var text = await uiPrompt('Enter text to add:');
        if (!text) return;
        var x = parseFloat(await uiPrompt('X position (inches from left, 0-8.5):', '1')) || 1;
        var y = parseFloat(await uiPrompt('Y position (inches from bottom, 0-11):', '9')) || 9;
        var size = parseFloat(await uiPrompt('Font size:', '14')) || 14;

        try {
            var visibleIdx = 0;
            for (var i = 0; i < _pdfEditor.pages.length; i++) {
                if (_pdfEditor.pages[i].deleted) continue;
                if (visibleIdx === _pdfEditor.currentPage) {
                    var page = _pdfEditor.pdfDoc.getPage(i);
                    page.drawText(text, {
                        x: x * 72,
                        y: y * 72,
                        size: size,
                        color: PDFLib.rgb(0, 0, 0),
                    });
                    pdfEditorSaveState();
                    pdfEditorRenderPreview();
                    return;
                }
                visibleIdx++;
            }
        } catch (e) {
            alert('Failed to add text: ' + e.message);
        }
    }

    async function pdfEditorAnnotateWhiteout() {
        var x = parseFloat(await uiPrompt('X position (inches from left, 0-8.5):', '1')) || 1;
        var y = parseFloat(await uiPrompt('Y position (inches from bottom, 0-11):', '9')) || 9;
        var w = parseFloat(await uiPrompt('Width (inches):', '3')) || 3;
        var h = parseFloat(await uiPrompt('Height (inches):', '1')) || 1;

        try {
            var visibleIdx = 0;
            for (var i = 0; i < _pdfEditor.pages.length; i++) {
                if (_pdfEditor.pages[i].deleted) continue;
                if (visibleIdx === _pdfEditor.currentPage) {
                    var page = _pdfEditor.pdfDoc.getPage(i);
                    page.drawRectangle({
                        x: x * 72,
                        y: y * 72,
                        width: w * 72,
                        height: h * 72,
                        color: PDFLib.rgb(1, 1, 1),
                        borderColor: PDFLib.rgb(1, 1, 1),
                    });
                    pdfEditorSaveState();
                    pdfEditorRenderPreview();
                    return;
                }
                visibleIdx++;
            }
        } catch (e) {
            alert('Failed to whiteout: ' + e.message);
        }
    }

    function pdfEditorAnnotateDraw() {
        // Open a draw-over modal on top of the page preview
        var panel = document.getElementById('pdf-preview-panel');
        if (!panel) return;
        var canvas = panel.querySelector('canvas');
        if (!canvas) return;

        // Remove any existing draw overlay first
        var existing = panel.querySelector('.pdf-draw-overlay-wrapper');
        if (existing) existing.remove();

        // Wrap the canvas in a position:relative container so the draw
        // overlay aligns exactly on top of the rendered page, regardless of
        // how the flex parent centers or pads the canvas.
        var wrap = document.createElement('div');
        wrap.className = 'pdf-draw-overlay-wrapper';
        wrap.style.cssText = 'position:relative;display:inline-block;line-height:0';
        canvas.parentNode.insertBefore(wrap, canvas);
        wrap.appendChild(canvas);

        // Create a drawing overlay canvas matching the original canvas pixel dimensions
        var drawCanvas = document.createElement('canvas');
        drawCanvas.width = canvas.width;
        drawCanvas.height = canvas.height;
        // Clone the original canvas's CSS so both scale identically; overlay sits
        // directly on top at (0,0) of the wrapper — which equals (0,0) of the canvas.
        drawCanvas.style.cssText = 'position:absolute;top:0;left:0;cursor:crosshair;z-index:10;border-radius:4px;pointer-events:auto;width:' + canvas.clientWidth + 'px;height:' + canvas.clientHeight + 'px';
        wrap.appendChild(drawCanvas);

        var ctx = drawCanvas.getContext('2d');
        ctx.strokeStyle = '#ff0000';
        ctx.lineWidth = 3;
        ctx.lineCap = 'round';
        var drawing = false;

        // Scale factor: canvas pixel dimensions vs CSS display dimensions
        function getScale() {
            var rect = drawCanvas.getBoundingClientRect();
            return { sx: canvas.width / rect.width, sy: canvas.height / rect.height };
        }

        drawCanvas.onmousedown = function (e) {
            drawing = true;
            ctx.beginPath();
            var rect = drawCanvas.getBoundingClientRect();
            var sc = getScale();
            ctx.moveTo((e.clientX - rect.left) * sc.sx, (e.clientY - rect.top) * sc.sy);
        };
        drawCanvas.onmousemove = function (e) {
            if (!drawing) return;
            var rect = drawCanvas.getBoundingClientRect();
            var sc = getScale();
            ctx.lineTo((e.clientX - rect.left) * sc.sx, (e.clientY - rect.top) * sc.sy);
            ctx.stroke();
        };
        drawCanvas.onmouseup = function () { drawing = false; };

        // Confirm/cancel buttons
        var drawBar = document.createElement('div');
        drawBar.style.cssText = 'position:absolute;bottom:16px;left:50%;transform:translateX(-50%);display:flex;gap:8px;z-index:11;background:rgba(0,0,0,0.8);padding:8px 12px;border-radius:8px';
        var confirmDraw = document.createElement('button');
        confirmDraw.innerHTML = icon('check') + ' Apply';
        confirmDraw.style.cssText = 'padding:6px 14px;border:none;background:#4caf50;color:#fff;border-radius:6px;cursor:pointer;font-weight:600';
        var cancelDraw = document.createElement('button');
        cancelDraw.innerHTML = icon('close') + ' Cancel';
        cancelDraw.style.cssText = 'padding:6px 14px;border:none;background:#f44336;color:#fff;border-radius:6px;cursor:pointer;font-weight:600';

        confirmDraw.onclick = async function () {
            try {
                // Embed the drawing as an image onto the PDF page
                var imgDataUrl = drawCanvas.toDataURL('image/png');
                var imgBytes = Uint8Array.from(atob(imgDataUrl.split(',')[1]), function (c) { return c.charCodeAt(0); });
                var img = await _pdfEditor.pdfDoc.embedPng(imgBytes);

                var visibleIdx = 0;
                for (var i = 0; i < _pdfEditor.pages.length; i++) {
                    if (_pdfEditor.pages[i].deleted) continue;
                    if (visibleIdx === _pdfEditor.currentPage) {
                        var page = _pdfEditor.pdfDoc.getPage(i);
                        var dims = page.getSize();
                        var scaleX = dims.width / drawCanvas.width;
                        var scaleY = dims.height / drawCanvas.height;
                        page.drawImage(img, {
                            x: 0,
                            y: 0,
                            width: dims.width,
                            height: dims.height,
                        });
                        break;
                    }
                    visibleIdx++;
                }
                pdfEditorSaveState();
                drawBar.remove();
                // Unwrap: move canvas back to its original parent and remove wrapper
                if (wrap && wrap.parentNode) {
                    wrap.parentNode.insertBefore(canvas, wrap);
                    wrap.remove();
                }
                pdfEditorRenderPreview();
            } catch (e) {
                alert('Failed to apply drawing: ' + e.message);
            }
        };

        cancelDraw.onclick = function () {
            drawBar.remove();
            // Unwrap: move canvas back and remove wrapper
            if (wrap && wrap.parentNode) {
                wrap.parentNode.insertBefore(canvas, wrap);
                wrap.remove();
            }
        };

        drawBar.appendChild(confirmDraw);
        drawBar.appendChild(cancelDraw);
        wrap.appendChild(drawBar);
    }

    // Crop
    async function pdfEditorCrop() {
        var left = parseFloat(await uiPrompt('Left margin to remove (inches):', '0.5')) || 0;
        var bottom = parseFloat(await uiPrompt('Bottom margin to remove (inches):', '0.5')) || 0;
        var right = parseFloat(await uiPrompt('Right margin to remove (inches):', '0.5')) || 0;
        var top = parseFloat(await uiPrompt('Top margin to remove (inches):', '0.5')) || 0;

        if (left + right >= 8.5 || bottom + top >= 11) {
            alert('Crop margins too large');
            return;
        }

        try {
            var visibleIdx = 0;
            for (var i = 0; i < _pdfEditor.pages.length; i++) {
                if (_pdfEditor.pages[i].deleted) continue;
                if (visibleIdx === _pdfEditor.currentPage) {
                    var page = _pdfEditor.pdfDoc.getPage(i);
                    var dims = page.getSize();
                    page.setCropBox(
                        left * 72,
                        bottom * 72,
                        dims.width - right * 72,
                        dims.height - top * 72
                    );
                    pdfEditorSaveState();
                    pdfEditorRenderPreview();
                    return;
                }
                visibleIdx++;
            }
        } catch (e) {
            alert('Failed to crop: ' + e.message);
        }
    }

    // ── Public API ─────────────────────────────────────────────────────

    // Test helper: load both pdf-lib and pdf.js
    function _loadPdfLibForTest() {
        return Promise.all([loadPdfLib(), loadPdfJs()]);
    }

    return {
        isDocumentFile: isDocumentFile,
        getDocType: getDocType,
        previewDocument: previewDocument,
        openPdfEditor: openPdfEditor,
        loadSheetJs: loadSheetJs,
        close: closeDocModal,
        _loadPdfLibForTest: _loadPdfLibForTest,
        _getEditorState: function () { return JSON.parse(JSON.stringify(_pdfEditor.pages)); }
    };
})();
