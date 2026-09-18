/* In-page replacements for the browser-native alert/confirm/prompt popups.
 *
 * Native dialogs are rendered by the browser chrome (and by the Tauri webview),
 * so they can't be styled, can't be themed, and block the JS thread. This module
 * routes every popup through a modal that lives inside the page instead.
 *
 *   window.alert(msg)          -> in-page modal (call sites unchanged)
 *   window.uiAlert(msg)        -> Promise<void>
 *   window.uiConfirm(msg)      -> Promise<boolean>
 *   window.uiPrompt(msg, def)  -> Promise<string|null>   (null = cancelled)
 *
 * Automation (Playwright sets navigator.webdriver; or set window.__uiDialogAuto
 * from the test) resolves without rendering, so scripted flows never stall:
 *
 *   window.__uiDialogQueue = { confirm: [], prompt: [] }   pre-seeded answers
 *   window.__uiDialogLog   = [{ type, message, result }]   what was shown
 *
 * Everything non-automated gets the real modal, including the Tauri webview.
 */
(function () {
    'use strict';

    var OVERLAY_ID = 'ui-dialog-overlay';

    function isAutomated() {
        try {
            // Tests flip __uiDialogForceShow to exercise the real modal under
            // Playwright (which otherwise always looks automated).
            if (window.__uiDialogForceShow) return false;
            if (window.__uiDialogAuto) return true;
            return !!(window.navigator && window.navigator.webdriver === true);
        } catch (e) {
            return false;
        }
    }

    function answers() {
        if (!window.__uiDialogQueue) window.__uiDialogQueue = { confirm: [], prompt: [] };
        return window.__uiDialogQueue;
    }

    function record(type, message, result) {
        var entry = { type: type, message: String(message), result: result };
        if (!window.__uiDialogLog) window.__uiDialogLog = [];
        window.__uiDialogLog.push(entry);
        window.__uiDialogLast = entry;
        // sessionStorage mirror so the log survives a navigation (tests and the
        // Tauri webview both reload the page far more often than a browser tab).
        try {
            var key = 'ui_dialog_log';
            var stored = sessionStorage.getItem(key);
            var list = stored ? JSON.parse(stored) : [];
            list.push(entry);
            sessionStorage.setItem(key, JSON.stringify(list.slice(-200)));
        } catch (e) { /* private mode / disabled storage */ }
        return entry;
    }

    // Under automation there is nobody to click, so answer immediately instead of
    // rendering (an unclicked modal would hang the script that awaits it).
    function autoAnswer(type, message, def) {
        var result;
        var q = answers();
        if (type === 'confirm') {
            result = q.confirm.length ? !!q.confirm.shift() : true;
        } else if (type === 'prompt') {
            result = q.prompt.length ? q.prompt.shift() : (def === undefined ? null : def);
        }
        record(type, message, result);
        return result;
    }

    // Only one dialog can be interactive at a time, mirroring native behaviour.
    var chain = Promise.resolve();

    function ask(type, message, def) {
        if (isAutomated()) return Promise.resolve(autoAnswer(type, message, def));
        chain = chain.then(function () {
            return new Promise(function (resolve) {
                render(type, message, def, resolve);
            });
        });
        return chain;
    }

    function render(type, message, def, resolve) {
        var host = document.body || document.documentElement;
        var settled = false;

        var overlay = document.createElement('div');
        overlay.className = 'ui-dialog';
        overlay.id = OVERLAY_ID;
        overlay.setAttribute('role', 'dialog');
        overlay.setAttribute('aria-modal', 'true');

        var box = document.createElement('div');
        box.className = 'ui-dialog-box';

        var text = document.createElement('div');
        text.className = 'ui-dialog-message';
        text.textContent = message;
        box.appendChild(text);

        var input = null;
        if (type === 'prompt') {
            input = document.createElement('input');
            input.className = 'ui-dialog-input';
            input.type = /password/i.test(message) ? 'password' : 'text';
            input.value = def === undefined || def === null ? '' : String(def);
            box.appendChild(input);
        }

        var actions = document.createElement('div');
        actions.className = 'modal-actions';

        var cancelBtn = null;
        if (type !== 'alert') {
            cancelBtn = document.createElement('button');
            cancelBtn.className = 'btn-cancel ui-dialog-cancel';
            cancelBtn.type = 'button';
            cancelBtn.textContent = 'Cancel';
            actions.appendChild(cancelBtn);
        }

        var okBtn = document.createElement('button');
        okBtn.className = 'btn btn-primary ui-dialog-ok';
        okBtn.type = 'button';
        okBtn.textContent = 'OK';
        actions.appendChild(okBtn);
        box.appendChild(actions);
        overlay.appendChild(box);

        function finish(result) {
            if (settled) return;
            settled = true;
            document.removeEventListener('keydown', onKey, true);
            if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
            record(type, message, result);
            resolve(result);
        }

        function accept() {
            finish(type === 'prompt' ? input.value : true);
        }
        function cancel() {
            finish(type === 'prompt' ? null : false);
        }

        okBtn.addEventListener('click', accept);
        if (cancelBtn) cancelBtn.addEventListener('click', cancel);
        overlay.addEventListener('mousedown', function (ev) {
            if (ev.target === overlay) (type === 'alert' ? accept : cancel)();
        });

        function onKey(ev) {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                cancel();
            } else if (ev.key === 'Enter') {
                ev.preventDefault();
                accept();
            }
        }
        document.addEventListener('keydown', onKey, true);

        host.appendChild(overlay);
        if (input) {
            input.focus();
            input.select();
        } else {
            okBtn.focus();
        }
    }

    window.uiDialog = {
        alert: function (message) { return ask('alert', message); },
        confirm: function (message) { return ask('confirm', message); },
        prompt: function (message, def) { return ask('prompt', message, def); },
        isAutomated: isAutomated
    };
    window.uiAlert = window.uiDialog.alert;
    window.uiConfirm = window.uiDialog.confirm;
    window.uiPrompt = window.uiDialog.prompt;

    // Same signature as the native alert (no return value), so the ~100 existing
    // `alert(...)` call sites keep working untouched.
    window.alert = function (message) {
        window.uiAlert(message);
    };
})();
