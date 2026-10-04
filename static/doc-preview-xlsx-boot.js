/* Bootstrap for the sandboxed XLSX preview frame (xlsxSandboxDocument() in
   doc-preview.js).

   It used to be an inline <script nonce=...> in the blob: document. A blob
   document inherits the app's CSP *in addition to* its own meta CSP, and the
   app's script-src no longer allows inline scripts — so the bootstrap is a
   same-origin external file, which the inherited policy ('self') and the
   frame's own meta CSP (origin) both allow. The frame's per-instance message
   token and the background colour arrive as data-* attributes. */
(function () {
    var s = document.currentScript;
    var nonce = (s && s.dataset && s.dataset.nonce) || '';
    var background = (s && s.dataset && s.dataset.background) || 'transparent';
    document.documentElement.style.background = background;
    document.body.style.background = background;
    var w = document.getElementById('w');
    var book = null;
    var XLSX_MAX_ROWS = 500;
    var XLSX_MAX_COLS = 100;

    function report(sheet, truncated) {
        parent.postMessage({
            type: 'rendered', nonce: nonce, sheet: sheet, truncated: truncated,
            maxRows: XLSX_MAX_ROWS, maxCols: XLSX_MAX_COLS,
            height: Math.ceil(w.getBoundingClientRect().height),
        }, '*');
    }

    function renderSheet(name) {
        var sheet = book.Sheets[name];
        var capped = sheet;
        var truncated = false;
        try {
            if (sheet && sheet['!ref']) {
                var range = XLSX.utils.decode_range(sheet['!ref']);
                var lastRow = Math.min(range.e.r, range.s.r + XLSX_MAX_ROWS - 1);
                var lastCol = Math.min(range.e.c, range.s.c + XLSX_MAX_COLS - 1);
                truncated = (range.e.r > lastRow) || (range.e.c > lastCol);
                if (truncated) {
                    capped = Object.assign({}, sheet);
                    capped['!ref'] = XLSX.utils.encode_range({ s: range.s, e: { r: lastRow, c: lastCol } });
                }
            }
        } catch (_) {}
        w.innerHTML = XLSX.utils.sheet_to_html(capped, { editable: false });
        report(name, truncated);
    }

    window.addEventListener('message', function (ev) {
        var d = ev.data || {};
        if (d.nonce !== nonce) return;
        try {
            if (d.type === 'render-xlsx') {
                if (typeof XLSX === 'undefined') {
                    parent.postMessage({ type: 'error', nonce: nonce, message: 'SheetJS failed to load' }, '*');
                    return;
                }
                book = XLSX.read(new Uint8Array(d.bytes), { type: 'array' });
                parent.postMessage({ type: 'sheets', nonce: nonce, names: book.SheetNames }, '*');
                if (book.SheetNames.length) renderSheet(book.SheetNames[0]);
                else { w.innerHTML = '<div class="empty">This workbook has no sheets.</div>'; report('', false); }
            } else if (d.type === 'sheet') {
                if (book) renderSheet(String(d.name));
            }
        } catch (e) {
            parent.postMessage({ type: 'error', nonce: nonce, message: String(e && e.message ? e.message : e) }, '*');
        }
    });

    parent.postMessage({ type: 'ready', nonce: nonce }, '*');
})();
