/* Bootstrap for the sandboxed DOCX preview frame (docxSandboxDocument() in
   doc-preview.js).

   It used to be an inline <script nonce=...> in the blob: document. A blob
   document inherits the app's CSP *in addition to* its own meta CSP, and the
   app's script-src no longer allows inline scripts — so the bootstrap is a
   same-origin external file, which the inherited policy ('self') and the
   frame's own meta CSP (origin) both allow. The frame's per-instance message
   token and the narrow/desktop mode arrive as data-* attributes. */
(function () {
    var s = document.currentScript;
    var nonce = (s && s.dataset && s.dataset.nonce) || '';
    var narrow = !!(s && s.dataset && s.dataset.narrow === '1');

    function esc(x) {
        return String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }
    function done() {
        parent.postMessage({ type: 'rendered', nonce: nonce, height: document.documentElement.scrollHeight }, '*');
    }

    window.addEventListener('message', function (ev) {
        var d = ev.data || {};
        if (d.nonce !== nonce || d.type !== 'render-docx') return;
        var w = document.getElementById('w');
        try {
            docx.renderAsync(new Uint8Array(d.bytes), w, w, {
                className: narrow ? 'docx docx-narrow' : 'docx',
                breakPages: !narrow,
                ignoreWidth: narrow,
                ignoreHeight: narrow,
                inWrapper: !narrow,
                ignoreLastRenderedPageBreak: false,
                renderHeaders: true,
                renderFooters: true,
                renderFootnotes: true,
                renderEndnotes: true,
            }).then(function () { done(); })
                .catch(function (e) {
                    w.innerHTML = '<div class="err">Error rendering document: ' +
                        esc(e && e.message ? e.message : e) + '</div>';
                    done();
                });
        } catch (e) {
            parent.postMessage({ type: 'error', nonce: nonce, message: String(e && e.message ? e.message : e) }, '*');
        }
    });

    parent.postMessage({ type: 'ready', nonce: nonce }, '*');
})();
