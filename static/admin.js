let rawData = {
    users: [], servers: [], channels: [], messages: [], serverKeys: [], serverMembers: [],
    serverBans: [], dmChannels: [], dmMembers: [],
    dmMessages: [], friendRequests: [], friendships: [], files: [],
    adminConfig: [], pendingEvents: [], pendingNotifications: [],
    voiceSessions: [], voiceParticipants: [], userMedia: [], userKeyBlobs: [], profileDataKeys: [], sharedProfileDataKeys: [],
    auditLog: []
};

const PAGE_SIZES = [25, 50, 100];
let tabPages = {};

function getPageSize() {
    var saved = localStorage.getItem('admin_page_size');
    var n = parseInt(saved, 10);
    if (saved === 'All') return Infinity;
    if (PAGE_SIZES.indexOf(n) !== -1) return n;
    return 50;
}

function setPageSize(size) {
    localStorage.setItem('admin_page_size', String(size));
    // Reset all pages to 0
    for (var k in tabPages) tabPages[k] = 0;
    // Re-render the active tab
    var activeTab = document.querySelector('.tab-btn.active');
    if (activeTab) filterTab(activeTab.dataset.tab);
}

let autoRefreshInterval = null;
function toggleAutoRefresh() {
    const btn = document.getElementById('auto-refresh-btn');
    if (autoRefreshInterval) {
        clearInterval(autoRefreshInterval);
        autoRefreshInterval = null;
        btn.textContent = 'Auto-Refresh: OFF';
        btn.style.background = '#555';
        btn.style.color = '#aaa';
        btn.style.borderColor = '#777';
    } else {
        autoRefreshInterval = setInterval(function() {
            loadAllData().then(function() {
                var activeTab = document.querySelector('.tab-btn.active');
                if (activeTab) filterTab(activeTab.dataset.tab);
            });
        }, 5000);
        btn.textContent = 'Auto-Refresh: ON';
        btn.style.background = '#2e7d32';
        btn.style.color = '#fff';
        btn.style.borderColor = '#4caf50';
    }
}
document.addEventListener('DOMContentLoaded', () => {
    const arBtn = document.getElementById('auto-refresh-btn');
    if (arBtn) arBtn.addEventListener('click', toggleAutoRefresh);

    // Clear stale HttpOnly token cookie that might interfere with admin password setup
    fetch('/api/logout', { method: 'POST' }).catch(function() {});

    // Invalidate any existing admin session so the user must re-enter the password
    invalidateAdminSession();
});

/** Clear admin auth from client sessionStorage and tell the server to invalidate the token. */
function invalidateAdminSession() {
    const currentToken = sessionStorage.getItem('admin_token');
    if (currentToken) {
        // Notify the server to remove this token from its in-memory store
        fetch('/api/admin/logout', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + currentToken }
        }).catch(function() {});
    }
    // Always clear client-side storage so the login form shows
    sessionStorage.removeItem('admin_auth');
    sessionStorage.removeItem('admin_token');
}

function paginate(data, tab) {
    var pageSize = getPageSize();
    var page = tabPages[tab] || 0;
    var total = data.length;
    var totalPages = pageSize === Infinity ? 1 : Math.ceil(total / pageSize) || 1;
    if (page >= totalPages) tabPages[tab] = totalPages - 1;
    var curPage = tabPages[tab] || 0;
    var start = curPage * (pageSize === Infinity ? total : pageSize);
    var end = pageSize === Infinity ? total : Math.min(start + pageSize, total);
    return { items: data.slice(start, end), total: total, page: curPage, totalPages: totalPages };
}

let tabTotals = {};
let tabFilteredCache = {};

function searchTab(tab) {
    tabPages[tab] = 0;
    filterTab(tab);
}

function renderPaginationControls(tab) {
    var pageSize = getPageSize();
    var p = tabPages[tab] || 0;
    var total = tabTotals[tab] || 0;
    var totalPages = pageSize === Infinity ? 1 : Math.ceil(total / pageSize) || 1;
    var container = document.getElementById(tab + '-pagination');
    if (!container) return;
    var html = '<div class="pagination-bar">';
    html += '<span class="pag-size-label">Rows:</span>';
    html += '<select class="pag-size-select" data-tab="' + tab + '">';
    PAGE_SIZES.forEach(function (s) {
        html += '<option value="' + s + '"' + (pageSize === s ? ' selected' : '') + '>' + s + '</option>';
    });
    html += '<option value="All"' + (pageSize === Infinity ? ' selected' : '') + '>All</option>';
    html += '</select>';
    html += '<button class="pag-btn" data-tab="' + tab + '" data-dir="first" ' + (p <= 0 ? 'disabled' : '') + '>&#171;</button>';
    html += '<button class="pag-btn" data-tab="' + tab + '" data-dir="prev" ' + (p <= 0 ? 'disabled' : '') + '><svg class="ui-icon" width="14" height="14"><use href="#icon-chevron-left"/></svg></button>';
    html += '<span class="pag-info">Page ' + (p + 1) + ' of ' + totalPages + ' (' + total + ' records)</span>';
    html += '<button class="pag-btn" data-tab="' + tab + '" data-dir="next" ' + (p >= totalPages - 1 ? 'disabled' : '') + '><svg class="ui-icon" width="14" height="14"><use href="#icon-chevron-right"/></svg></button>';
    html += '<button class="pag-btn" data-tab="' + tab + '" data-dir="last" ' + (p >= totalPages - 1 ? 'disabled' : '') + '><svg class="ui-icon" width="14" height="14"><use href="#icon-chevrons-right"/></svg></button>';
    html += '</div>';
    container.innerHTML = html;
}

document.addEventListener('DOMContentLoaded', () => {
    // Admin password show/hide toggle
    const adminToggleBtn = document.getElementById('toggle-admin-password');
    const adminPasswordInput = document.getElementById('admin-password');
    if (adminToggleBtn && adminPasswordInput) {
        adminToggleBtn.addEventListener('click', function () {
            const visible = adminPasswordInput.type === 'text';
            adminPasswordInput.type = visible ? 'password' : 'text';
            adminToggleBtn.innerHTML = visible ? '&#128065;' : '&#128064;';
            adminToggleBtn.classList.toggle('active', !visible);
        });
    }
    if (sessionStorage.getItem('admin_auth')) {
        showPanel();
        loadAllData();
    }

});  // close DOMContentLoaded — functions below are global

var _pendingPreToken = null;
var _admin2faMode = 'enroll';

// Check 2FA status when admin panel loads and update button label
function updateAdmin2faButton() {
    var btn = document.getElementById('admin-2fa-panel-btn');
    if (!btn) return;
    var token = sessionStorage.getItem('admin_token') || '';
    fetch('/api/admin/2fa/status', { headers: { 'Authorization': 'Bearer ' + token } })
        .then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r.json();
        })
        .then(function (data) {
            if (data.enabled) {
                btn.textContent = '2FA: ON';
                btn.style.background = '#2e7d32';
            } else {
                btn.textContent = '2FA: OFF';
                btn.style.background = '#555';
            }
        })
        .catch(function (e) {
            console.error('2FA status check failed:', e);
            btn.textContent = '2FA: OFF (err)';
            btn.style.background = '#555';
        });
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('admin-2fa-panel-btn').addEventListener('click', function () {
        var token = sessionStorage.getItem('admin_token') || '';
        fetch('/api/admin/2fa/status', { headers: { 'Authorization': 'Bearer ' + token } })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                var modal = document.getElementById('admin-2fa-modal');
                var titleEl = document.getElementById('admin-2fa-modal-title');
                var hintEl = document.getElementById('admin-2fa-modal-hint');
                var qrEl = document.getElementById('admin-2fa-qr');
                var secretEl = document.getElementById('admin-2fa-secret');
                var codesWrap = document.getElementById('admin-2fa-codes-wrap');
                var codeInput = document.getElementById('admin-2fa-code-input');
                var errEl = document.getElementById('admin-2fa-error');
                var submitBtn = document.getElementById('admin-2fa-submit');

                codeInput.value = '';
                errEl.style.display = 'none';

                if (data.enabled) {
                    _admin2faMode = 'disable';
                    titleEl.textContent = 'Disable Admin 2FA';
                    hintEl.textContent = 'Enter a code from your authenticator app to disable 2FA.';
                    qrEl.style.display = 'none';
                    secretEl.style.display = 'none';
                    codesWrap.style.display = 'none';
                    codeInput.placeholder = 'Enter 6-digit code';
                    codeInput.maxLength = 6;
                    codeInput.style.letterSpacing = '2px';
                    codeInput.style.fontFamily = 'monospace';
                    submitBtn.textContent = 'Disable';
                    submitBtn.style.background = 'linear-gradient(135deg,#c62828,#b71c1c)';
                } else {
                    _admin2faMode = 'enroll';
                    modal.dataset.step = '';
                    titleEl.textContent = 'Enable Admin 2FA';
                    hintEl.textContent = 'Enter your admin password to start enrollment.';
                    qrEl.style.display = 'none';
                    secretEl.style.display = 'none';
                    codesWrap.style.display = 'none';
                    codeInput.placeholder = 'Enter admin password';
                    codeInput.maxLength = 128;
                    codeInput.style.letterSpacing = '0';
                    codeInput.style.fontFamily = 'inherit';
                    submitBtn.textContent = 'Start Enrollment';
                    submitBtn.style.background = 'linear-gradient(135deg,#4caf50,#388e3c)';
                }
                modal.style.display = 'flex';
            })
            .catch(function () {});
    });

    document.getElementById('admin-2fa-cancel').addEventListener('click', function () {
        document.getElementById('admin-2fa-modal').style.display = 'none';
    });
    document.getElementById('admin-2fa-modal').addEventListener('click', function (e) {
        if (e.target.id === 'admin-2fa-modal') document.getElementById('admin-2fa-modal').style.display = 'none';
    });

    document.getElementById('admin-2fa-submit').addEventListener('click', function () {
        var codeInput = document.getElementById('admin-2fa-code-input');
        var errEl = document.getElementById('admin-2fa-error');
        var val = codeInput.value.trim();
        errEl.style.display = 'none';

        if (_admin2faMode === 'enroll') {
            var modal = document.getElementById('admin-2fa-modal');
            if (modal.dataset.step === 'verify-code') {
                // Code verification step — send 6-digit TOTP code
                if (!val || val.length !== 6) { errEl.textContent = 'Enter a 6-digit code'; errEl.style.display = 'block'; return; }
                var btnCode = this;
                btnCode.disabled = true;
                btnCode.textContent = 'Verifying...';
                fetch('/api/admin/2fa/verify-enroll', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: val })
                })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    btnCode.disabled = false;
                    if (!data.ok) {
                        errEl.textContent = data.error || 'Invalid code';
                        errEl.style.display = 'block';
                        btnCode.textContent = 'Verify';
                        return;
                    }
                    alert('Admin 2FA enabled!');
                    modal.style.display = 'none';
                    updateAdmin2faButton();
                })
                .catch(function () {
                    errEl.textContent = 'Server is not running';
                    errEl.style.display = 'block';
                    btnCode.disabled = false;
                    btnCode.textContent = 'Verify';
                });
            } else {
                // Password step — verify password then show QR
                if (!val) { errEl.textContent = 'Enter your admin password'; errEl.style.display = 'block'; return; }
                var btnPass = this;
                btnPass.disabled = true;
                btnPass.textContent = 'Starting...';
                fetch('/api/admin/2fa/enroll', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ password: val })
                })
                .then(function (r) { return r.json(); })
                .then(function (data) {
                    btnPass.disabled = false;
                    if (data.error) {
                        errEl.textContent = data.error;
                        errEl.style.display = 'block';
                        btnPass.textContent = 'Start Enrollment';
                        return;
                    }
                    document.getElementById('admin-2fa-modal-title').textContent = 'Scan QR Code';
                    document.getElementById('admin-2fa-modal-hint').textContent = 'Scan this QR code in your authenticator app, then enter a code to verify.';
                    var qrEl = document.getElementById('admin-2fa-qr');
                    qrEl.innerHTML = '';
                    try {
                        var qr = qrcode(0, 'M');
                        qr.addData(data.otpauth_url);
                        qr.make();
                        qrEl.innerHTML = qr.createImgTag(4, 8);
                    } catch (_) {
                        qrEl.textContent = 'QR unavailable — enter the secret manually.';
                    }
                    qrEl.style.display = '';
                    var secretEl = document.getElementById('admin-2fa-secret');
                    secretEl.textContent = 'Secret: ' + data.secret_base32;
                    secretEl.style.display = '';
                    var codesWrap = document.getElementById('admin-2fa-codes-wrap');
                    var codesEl = document.getElementById('admin-2fa-codes');
                    codesEl.innerHTML = '';
                    data.recovery_codes.forEach(function (c) {
                        var span = document.createElement('span');
                        span.textContent = c;
                        span.style.cssText = 'background:#0f0f23;border:1px solid #333;border-radius:4px;padding:4px 8px;font-family:monospace;font-size:12px;color:#e0e0e0';
                        codesEl.appendChild(span);
                    });
                    codesWrap.style.display = '';
                    codeInput.value = '';
                    codeInput.placeholder = 'Enter 6-digit code';
                    codeInput.maxLength = 6;
                    codeInput.style.letterSpacing = '2px';
                    codeInput.style.fontFamily = 'monospace';
                    btnPass.textContent = 'Verify';
                    modal.dataset.step = 'verify-code';
                })
                .catch(function () {
                    errEl.textContent = 'Server is not running';
                    errEl.style.display = 'block';
                    btnPass.disabled = false;
                    btnPass.textContent = 'Start Enrollment';
                });
            }
        } else {
            // Disable mode — need TOTP code
            if (!val || val.length !== 6) { errEl.textContent = 'Enter a 6-digit code'; errEl.style.display = 'block'; return; }
            var btn3 = this;
            btn3.disabled = true;
            btn3.textContent = 'Disabling...';
            fetch('/api/admin/2fa/disable', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ code: val })
            })
            .then(function (r) { return r.json(); })
            .then(function (data) {
                btn3.disabled = false;
                if (!data.ok) {
                    errEl.textContent = data.error || 'Invalid code';
                    errEl.style.display = 'block';
                    btn3.textContent = 'Disable';
                    return;
                }
                alert('Admin 2FA disabled!');
                document.getElementById('admin-2fa-modal').style.display = 'none';
                updateAdmin2faButton();
            })
            .catch(function () {
                errEl.textContent = 'Server is not running';
                errEl.style.display = 'block';
                btn3.disabled = false;
                btn3.textContent = 'Disable';
            });
        }
    });

    // Copy recovery codes
    document.getElementById('admin-2fa-copy-codes').addEventListener('click', function () {
        var codesEl = document.getElementById('admin-2fa-codes');
        var codes = Array.from(codesEl.querySelectorAll('span')).map(function (s) { return s.textContent; });
        navigator.clipboard.writeText(codes.join('\n')).then(function () {
            document.getElementById('admin-2fa-copy-codes').textContent = 'Copied!';
            setTimeout(function () { document.getElementById('admin-2fa-copy-codes').textContent = 'Copy Codes'; }, 1500);
        });
    });

    document.getElementById('admin-login-form').addEventListener('submit', async (e) => {
        e.preventDefault();
        const password = document.getElementById('admin-password').value;
        const btn = document.getElementById('admin-login-btn');
        const codeRow = document.getElementById('admin-2fa-code-row');
        const codeInput = document.getElementById('admin-2fa-code');

        // If 2FA code row is visible, we're in the second step
        if (codeRow.style.display !== 'none' && codeInput.value.trim()) {
            btn.disabled = true;
            btn.textContent = 'Verifying...';
            try {
                const res = await fetch('/api/admin/verify-2fa', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: codeInput.value.trim(), pre_token: _pendingPreToken })
                });
                const data = await res.json();
                if (!data.ok) {
                    showError(data.error || 'Invalid code');
                    btn.disabled = false;
                    btn.textContent = 'Verify';
                    codeInput.value = '';
                    return;
                }
                sessionStorage.setItem('admin_auth', 'true');
                sessionStorage.setItem('admin_token', data.token || '');
                _pendingPreToken = null;
                codeRow.style.display = 'none';
                codeInput.value = '';
                document.getElementById('admin-login-2fa-hint').style.display = 'none';
                showPanel();
                loadAllData();
            } catch (err) {
                showError('Server is not running');
                btn.disabled = false;
                btn.textContent = 'Verify';
            }
            return;
        }

        btn.disabled = true;
        btn.textContent = 'Connecting...';
        try {
            const res = await fetch('/api/admin/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password })
            });
            const data = await res.json();
            if (!res.ok) {
                if (data.setup_required) {
                    showError('No admin password set. Enter a new password to set it.');
                    document.getElementById('admin-password').value = '';
                    document.getElementById('admin-password').placeholder = 'Choose a password';
                    document.getElementById('admin-login-subtitle').textContent = 'Set admin password (first time)';
                    btn.textContent = 'Set Password';
                    btn.disabled = false;
                    return;
                }
                showError(data.error || 'Wrong password');
                btn.disabled = false;
                btn.textContent = 'Access Panel';
                return;
            }
            if (data.setup_complete) {
                document.getElementById('admin-login-subtitle').textContent = 'Enter admin password';
                document.getElementById('admin-password').placeholder = 'Admin password';
                btn.textContent = 'Access Panel';
                document.getElementById('admin-password').value = '';
                showError('Password set! Now login with it.');
                document.getElementById('error-message').style.color = '#4caf50';
                btn.disabled = false;
                return;
            }
            if (data.requires_2fa) {
                _pendingPreToken = data.pre_token;
                codeRow.style.display = '';
                document.getElementById('admin-login-2fa-hint').style.display = '';
                codeInput.value = '';
                codeInput.focus();
                btn.disabled = false;
                btn.textContent = 'Verify';
                return;
            }
            sessionStorage.setItem('admin_auth', 'true');
            sessionStorage.setItem('admin_token', data.token || '');
            showPanel();
            loadAllData();
        } catch (err) {
            showError('Server is not running');
            btn.disabled = false;
            btn.textContent = 'Access Panel';
        }
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
            btn.classList.add('active');
            document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
            // Raw Tables loads lazily on first open.
            if (btn.dataset.tab === 'raw-tables' && !rawTablesCache) loadRawTables();
        });
    });

    // Pagination button clicks (delegated)
    document.getElementById('admin-panel').addEventListener('click', function (e) {
        var btn = e.target.closest('.pag-btn');
        if (!btn) return;
        var tab = btn.dataset.tab;
        var dir = btn.dataset.dir;
        var cur = tabPages[tab] || 0;
        var total = tabTotals[tab] || 0;
        var pageSize = getPageSize();
        var totalPages = pageSize === Infinity ? 1 : Math.ceil(total / pageSize) || 1;
        if (dir === 'first') tabPages[tab] = 0;
        else if (dir === 'prev') tabPages[tab] = Math.max(0, cur - 1);
        else if (dir === 'next') tabPages[tab] = Math.min(totalPages - 1, cur + 1);
        else if (dir === 'last') tabPages[tab] = totalPages - 1;
        filterTab(tab);
    });

    // Force-disable a user's 2FA (delegated — rows are re-rendered frequently)
    document.getElementById('admin-panel').addEventListener('click', function (e) {
        var btn = e.target.closest('[data-2fa-uid]');
        if (!btn) return;
        disableUser2fa(btn.dataset['2faUid'], btn.dataset['2faUname']);
    });

    // Page size selector change (delegated)
    document.getElementById('admin-panel').addEventListener('change', function (e) {
        var sel = e.target.closest('.pag-size-select');
        if (!sel) return;
        var val = sel.value;
        setPageSize(val);
    });

    document.getElementById('clear-all-btn').addEventListener('click', clearAll);
    document.getElementById('confirm-wipe-all').addEventListener('click', confirmWipeAll);
    document.getElementById('cancel-wipe-confirm').addEventListener('click', closeWipeModal);
    document.getElementById('wipe-confirm-input').addEventListener('input', updateWipeConfirmState);
    document.addEventListener('keydown', (e) => {
        const wipeModal = document.getElementById('wipe-confirm-modal');
        if (e.key === 'Escape' && wipeModal && wipeModal.style.display === 'flex') closeWipeModal();
    });
    document.getElementById('export-db-btn').addEventListener('click', showExportModal);
    document.getElementById('import-db-btn').addEventListener('click', importDB);
    document.getElementById('validate-db-btn').addEventListener('click', validateImportDB);

    // Export/Import password modal show/hide toggles
    setupPasswordToggle('toggle-export-password', 'export-password-input');
    setupPasswordToggle('toggle-export-password-confirm', 'export-password-confirm-input');
    setupPasswordToggle('toggle-import-password', 'import-password-input');

    // Export modal buttons + no-password toggle
    document.getElementById('confirm-export-db').addEventListener('click', confirmExport);
    document.getElementById('cancel-export-db').addEventListener('click', closeExportModal);
    const exportNopw = document.getElementById('export-db-nopw');
    if (exportNopw) exportNopw.addEventListener('change', updateExportEncryptionUI);

    // Import modal buttons
    document.getElementById('confirm-import-db').addEventListener('click', confirmImport);
    document.getElementById('cancel-import-db').addEventListener('click', closeImportModal);
    document.getElementById('continue-import-confirm').addEventListener('click', continueImportConfirm);
    document.getElementById('cancel-import-confirm').addEventListener('click', closeImportConfirmModal);
    document.getElementById('import-from-results').addEventListener('click', importFromResults);
    document.getElementById('close-import-results').addEventListener('click', function () {
        document.getElementById('import-results-modal').style.display = 'none';
        pendingDecrypted = null;
        pendingRiskyImport = false;
    });

    // Risky-import typed-word guard
    document.getElementById('confirm-risky-import').addEventListener('click', confirmRiskyImport);
    document.getElementById('cancel-risky-import').addEventListener('click', closeRiskyImportModal);
    document.getElementById('risky-import-input').addEventListener('input', updateRiskyImportState);
    document.addEventListener('keydown', (e) => {
        const modal = document.getElementById('risky-import-modal');
        if (e.key === 'Escape' && modal && modal.style.display === 'flex') closeRiskyImportModal();
    });

    // Dry-run table preview
    document.getElementById('close-import-preview').addEventListener('click', function () {
        document.getElementById('import-preview-modal').style.display = 'none';
    });
});

// Store pending import data between file selection and password entry
let pendingImportData = null;
// When true, the next import confirmation runs a dry-run validation instead
// of replacing the live database.
let pendingDryRun = false;
// When true, the flow came from the Import button with “Validate before
// importing” checked, so the dry-run results offer “Import this backup”.
let pendingValidateFirst = false;
// Decrypted SQLite bytes retained after a validate-first dry run so the
// “Import this backup” action can reuse them without re-decrypting.
let pendingDecrypted = null;
// Set when the dry run found integrity or foreign-key problems: the final
// import must then pass a typed-word (IMPORT) confirmation.
let pendingRiskyImport = false;

function setupPasswordToggle(toggleId, inputId) {
    const toggleBtn = document.getElementById(toggleId);
    const input = document.getElementById(inputId);
    if (toggleBtn && input) {
        toggleBtn.addEventListener('click', function () {
            const visible = input.type === 'text';
            input.type = visible ? 'password' : 'text';
            toggleBtn.innerHTML = visible ? '&#128065;' : '&#128064;';
            toggleBtn.classList.toggle('active', !visible);
        });
    }
}

function showExportModal() {
    document.getElementById('export-password-input').value = '';
    document.getElementById('export-password-confirm-input').value = '';
    document.getElementById('export-password-error').style.display = 'none';
    const nopw = document.getElementById('export-db-nopw');
    if (nopw) nopw.checked = false;
    updateExportEncryptionUI();
    document.getElementById('export-db-password-modal').style.display = 'flex';
}

function updateExportEncryptionUI() {
    const nopw = document.getElementById('export-db-nopw');
    const fields = document.getElementById('export-db-fields');
    const hint = document.getElementById('export-db-hint');
    const unchecked = !nopw || !nopw.checked;
    if (fields) fields.style.display = unchecked ? '' : 'none';
    if (hint) {
        hint.textContent = unchecked
            ? 'Encrypt the exported database with a password (Argon2id + AEAD — the same strong scheme the app uses).'
            : 'No password will be used — the backup is saved unencrypted.';
    }
}

function closeExportModal() {
    document.getElementById('export-db-password-modal').style.display = 'none';
}

function showImportModal() {
    document.getElementById('import-password-input').value = '';
    document.getElementById('import-password-error').style.display = 'none';
    document.getElementById('import-password-error').textContent = '';
    document.getElementById('import-db-password-modal').style.display = 'flex';
}

function closeImportModal() {
    document.getElementById('import-db-password-modal').style.display = 'none';
    pendingDryRun = false;
}

async function confirmExport() {
    const errorEl = document.getElementById('export-password-error');
    errorEl.style.display = 'none';

    // Export without a password → unencrypted backup (magic 0x00).
    const nopw = document.getElementById('export-db-nopw');
    if (nopw && nopw.checked) {
        closeExportModal();
        await doExport('');
        return;
    }

    const password = document.getElementById('export-password-input').value;
    const confirmPw = document.getElementById('export-password-confirm-input').value;
    if (!password) {
        errorEl.textContent = 'Enter a password or check “Export without a password”.';
        errorEl.style.display = 'block';
        return;
    }
    if (password !== confirmPw) {
        errorEl.textContent = 'Passwords do not match.';
        errorEl.style.display = 'block';
        return;
    }

    closeExportModal();
    await doExport(password);
}

async function confirmImport() {
    const password = document.getElementById('import-password-input').value;
    const errorEl = document.getElementById('import-password-error');
    errorEl.style.display = 'none';

    if (!password) {
        errorEl.textContent = 'Password is required for encrypted databases.';
        errorEl.style.display = 'block';
        return;
    }

    // Capture the flags BEFORE closing — closeImportModal resets pendingDryRun.
    const dryRun = pendingDryRun;
    const validateFirst = pendingValidateFirst;
    closeImportModal();
    pendingDryRun = false;
    pendingValidateFirst = false;
    await doImport(pendingImportData, password, dryRun, validateFirst);
    pendingImportData = null;
}

// --- Busy overlay (export/import/validate can take a while on a big DB) ---
function setBusy(label) {
    const ov = document.getElementById('admin-busy-overlay');
    if (!ov) return;
    const lbl = document.getElementById('admin-busy-label');
    if (lbl) lbl.textContent = label || 'Working…';
    ov.style.display = 'flex';
}
function clearBusy() {
    const ov = document.getElementById('admin-busy-overlay');
    if (ov) ov.style.display = 'none';
}

// --- Backup bundle (DB + uploaded file bytes) ---
// New exports embed the SQLite DB plus an uploads bundle (all uploaded image
// bytes) under one inner header so an export → wipe → import round-trip
// restores pictures too. Legacy backups (raw DB, no header) still import.
// Inner payload layout:
//   [0xDB][u32 LE db_len][db bytes][uploads bundle (manifest+payload)]
const BACKUP_BUNDLE_MAGIC = 0xDB;

// Build the inner payload: DB bytes + uploads bundle (may be null/empty).
function buildBackupPayload(dbBytes, uploadsBundle) {
    const dbLen = dbBytes.byteLength;
    const up = uploadsBundle ? new Uint8Array(uploadsBundle) : new Uint8Array(0);
    const out = new Uint8Array(1 + 4 + dbLen + up.byteLength);
    out[0] = BACKUP_BUNDLE_MAGIC;
    const dv = new DataView(out.buffer);
    dv.setUint32(1, dbLen, true);
    out.set(new Uint8Array(dbBytes), 5);
    out.set(up, 5 + dbLen);
    return out.buffer;
}

// Split a decrypted backup into { dbBytes, uploadsBundle }. Legacy backups
// (no bundle magic) are returned whole as dbBytes with a null uploadsBundle.
function unpackBackup(decrypted) {
    const bytes = new Uint8Array(decrypted);
    if (bytes.length >= 1 && bytes[0] === BACKUP_BUNDLE_MAGIC) {
        if (bytes.length < 5) throw new Error('Corrupted backup bundle (truncated header).');
        const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
        const dbLen = dv.getUint32(1, true);
        if (5 + dbLen > bytes.length) throw new Error('Corrupted backup bundle (DB length overflows).');
        const dbBytes = decrypted.slice(5, 5 + dbLen);
        const uploadsBundle = decrypted.slice(5 + dbLen);
        return { dbBytes, uploadsBundle: uploadsBundle.byteLength > 0 ? uploadsBundle : null };
    }
    return { dbBytes: decrypted, uploadsBundle: null };
}

// Parse an API error body that may or may not be JSON (axum returns plain-text
// for body-limit 413s and other early rejections). Never throw a SyntaxError.
async function apiErrorText(res) {
    try {
        const data = await res.json();
        if (data && data.error) return data.error;
        return 'HTTP ' + res.status;
    } catch (_) {
        try {
            const text = await res.text();
            if (text) return text.slice(0, 300);
        } catch (_) {}
        return 'HTTP ' + res.status;
    }
}

function showError(msg) {
    const errDiv = document.getElementById('error-message');
    errDiv.textContent = msg;
    errDiv.style.display = 'block';
    errDiv.style.color = '';
}

function showPanel() {
    document.getElementById('admin-login').style.display = 'none';
    document.getElementById('admin-panel').style.display = 'block';
    if (typeof updateAdmin2faButton === 'function') updateAdmin2faButton();
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

function truncate(str, len) {
    if (!str) return '';
    return str.length > len ? str.substring(0, len) + '...' : str;
}

async function apiFetch(url, method) {
    const adminToken = sessionStorage.getItem('admin_token') || '';
    const res = await fetch(url, {
        method: method || 'GET',
        headers: adminToken ? { 'Authorization': 'Bearer ' + adminToken } : {}
    });
    if (!res.ok) {
        // Redirect to login if unauthorized (token expired)
        if (res.status === 401) {
            sessionStorage.removeItem('admin_auth');
            sessionStorage.removeItem('admin_token');
            location.reload();
            return [];
        }
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Request failed with status ' + res.status);
    }
    return res.json();
}

function renderTable(tbodyId, cols, rows, emptyMsg) {
    const tbody = document.getElementById(tbodyId);
    if (!rows || rows.length === 0) {
        tbody.innerHTML = '<tr><td colspan="' + cols + '" class="empty-state">' + (emptyMsg || 'No data') + '</td></tr>';
        return;
    }
    tbody.innerHTML = '';
    rows.forEach(row => {
        const tr = document.createElement('tr');
        tr.innerHTML = row;
        tbody.appendChild(tr);
    });
}

function updateCount(id, count, suffix) {
    document.getElementById(id).textContent = count + (suffix || ' records');
}

// --- Search/Filter ---
function filterTab(tab) {
    const input = document.getElementById('search-' + tab);
    const q = input ? input.value.toLowerCase() : '';
    var filtered;
    switch (tab) {
        case 'users': filtered = rawData.users.filter(u => !q || u.username.toLowerCase().includes(q) || u.id.toLowerCase().includes(q)); tabFilteredCache['users'] = filtered; renderUsers(filtered); break;
        case 'servers': filtered = rawData.servers.filter(s => !q || (s.encrypted_name || '').toLowerCase().includes(q) || s.id.toLowerCase().includes(q)); tabFilteredCache['servers'] = filtered; renderServers(filtered); break;
        case 'channels': filtered = rawData.channels.filter(c => !q || (c.encrypted_name || '').toLowerCase().includes(q) || c.server_id.toLowerCase().includes(q)); tabFilteredCache['channels'] = filtered; renderChannels(filtered); break;
        case 'messages': filtered = rawData.messages.filter(m => !q || (m.sender_username || m.sender_id).toLowerCase().includes(q) || m.channel_id.toLowerCase().includes(q) || (m.timestamp || '').toLowerCase().includes(q)); tabFilteredCache['messages'] = filtered; renderMessages(filtered); break;
        case 'server-keys': filtered = rawData.serverKeys.filter(k => !q || k.server_name.toLowerCase().includes(q) || k.user_id.toLowerCase().includes(q) || String(k.version).includes(q)); tabFilteredCache['server-keys'] = filtered; renderServerKeys(filtered); break;
        case 'server-members': filtered = rawData.serverMembers.filter(m => !q || m.username.toLowerCase().includes(q) || m.user_id.toLowerCase().includes(q) || m.server_name.toLowerCase().includes(q)); tabFilteredCache['server-members'] = filtered; renderServerMembers(filtered); break;
        case 'server-bans': filtered = rawData.serverBans.filter(b => !q || b.server_name.toLowerCase().includes(q) || b.username.toLowerCase().includes(q) || (b.reason || '').toLowerCase().includes(q)); tabFilteredCache['server-bans'] = filtered; renderServerBans(filtered); break;
        case 'dm-channels': filtered = rawData.dmChannels.filter(c => !q || c.id.toLowerCase().includes(q)); tabFilteredCache['dm-channels'] = filtered; renderDmChannels(filtered); break;
        case 'dm-members': filtered = rawData.dmMembers.filter(m => !q || m.username.toLowerCase().includes(q) || m.user_id.toLowerCase().includes(q) || m.dm_channel_id.toLowerCase().includes(q)); tabFilteredCache['dm-members'] = filtered; renderDmMembers(filtered); break;
        case 'dm-messages': filtered = rawData.dmMessages.filter(m => !q || (m.sender_username || m.sender_id).toLowerCase().includes(q) || m.dm_channel_id.toLowerCase().includes(q) || (m.timestamp || '').toLowerCase().includes(q)); tabFilteredCache['dm-messages'] = filtered; renderDmMessages(filtered); break;
        case 'friend-requests': filtered = rawData.friendRequests.filter(r => !q || r.from_username.toLowerCase().includes(q) || r.to_username.toLowerCase().includes(q) || r.status.toLowerCase().includes(q)); tabFilteredCache['friend-requests'] = filtered; renderFriendRequests(filtered); break;
        case 'friendships': filtered = rawData.friendships.filter(f => !q || f.username_1.toLowerCase().includes(q) || f.username_2.toLowerCase().includes(q)); tabFilteredCache['friendships'] = filtered; renderFriendships(filtered); break;
        case 'files': filtered = rawData.files.filter(f => !q || f.original_name.toLowerCase().includes(q) || f.uploader_username.toLowerCase().includes(q) || f.mime_type.toLowerCase().includes(q)); tabFilteredCache['files'] = filtered; renderFiles(filtered); break;
        case 'admin-config': filtered = rawData.adminConfig.filter(c => !q || c.key.toLowerCase().includes(q) || c.value.toLowerCase().includes(q)); tabFilteredCache['admin-config'] = filtered; renderAdminConfig(filtered); break;
        case 'pending-events': filtered = rawData.pendingEvents.filter(e => !q || e.user_id.toLowerCase().includes(q) || e.event_type.toLowerCase().includes(q) || e.server_id.toLowerCase().includes(q)); tabFilteredCache['pending-events'] = filtered; renderPendingEvents(filtered); break;
        case 'pending-notifications': filtered = rawData.pendingNotifications.filter(n => !q || n.user_id.toLowerCase().includes(q) || n.notification_type.toLowerCase().includes(q)); tabFilteredCache['pending-notifications'] = filtered; renderPendingNotifications(filtered); break;
        case 'voice-sessions': filtered = rawData.voiceSessions.filter(s => !q || s.id.toLowerCase().includes(q) || s.channel_id.toLowerCase().includes(q)); tabFilteredCache['voice-sessions'] = filtered; renderVoiceSessions(filtered); break;
        case 'voice-participants': filtered = rawData.voiceParticipants.filter(p => !q || p.voice_session_id.toLowerCase().includes(q) || p.user_id.toLowerCase().includes(q)); tabFilteredCache['voice-participants'] = filtered; renderVoiceParticipants(filtered); break;
        case 'user-media': filtered = rawData.userMedia.filter(m => !q || m.id.toLowerCase().includes(q) || (m.username||'').toLowerCase().includes(q) || (m.media_type||'').toLowerCase().includes(q)); tabFilteredCache['user-media'] = filtered; renderUserMedia(filtered); break;
        case 'user-key-blobs': filtered = rawData.userKeyBlobs.filter(b => !q || (b.username||'').toLowerCase().includes(q) || b.user_id.toLowerCase().includes(q)); tabFilteredCache['user-key-blobs'] = filtered; renderUserKeyBlobs(filtered); break;
        case 'profile-data-keys': filtered = rawData.profileDataKeys.filter(k => !q || (k.username||'').toLowerCase().includes(q) || k.user_id.toLowerCase().includes(q)); tabFilteredCache['profile-data-keys'] = filtered; renderProfileDataKeys(filtered); break;
        case 'shared-profile-data-keys': filtered = rawData.sharedProfileDataKeys.filter(k => !q || k.id.toLowerCase().includes(q) || (k.username||'').toLowerCase().includes(q) || (k.target_type||'').toLowerCase().includes(q) || (k.target_id||'').toLowerCase().includes(q)); tabFilteredCache['shared-profile-data-keys'] = filtered; renderSharedProfileDataKeys(filtered); break;
        case 'audit-log': filtered = rawData.auditLog.filter(a => !q || (a.action||'').toLowerCase().includes(q) || (a.target||'').toLowerCase().includes(q) || (a.ip||'').toLowerCase().includes(q) || (a.actor||'').toLowerCase().includes(q)); tabFilteredCache['audit-log'] = filtered; renderAuditLog(filtered); break;
    }
}

async function loadTabData(endpoint, dataKey, renderFn) {
    try {
        const rows = await apiFetch(endpoint);
        rawData[dataKey] = Array.isArray(rows) ? rows : [];
        renderFn(rawData[dataKey]);
    } catch (err) {
        rawData[dataKey] = [];
        renderFn([]);
    }
}

async function loadAllData() {
    await Promise.all([
        loadUsers(),
        loadServers(),
        loadChannels(),
        loadMessages(),
        loadServerKeys(),
        loadServerMembers(),
        loadServerBans(),
        loadDmChannels(),
        loadDmMembers(),
        loadDmMessages(),
        loadFriendRequests(),
        loadFriendships(),
        loadFiles(),
        loadAdminConfig(),
        loadRuntimeConfig(),
        loadPendingEvents(),
        loadPendingNotifications(),
        loadVoiceSessions(),
        loadVoiceParticipants(),
        loadUserMedia(),
        loadUserKeyBlobs(),
        loadProfileDataKeys(),
        loadSharedProfileDataKeys(),
        loadAuditLog(),
    ]);
}

// --- Users ---
async function loadUsers() { await loadTabData("/api/admin/users", "users", renderUsers); }

function renderUsers(users) {
    tabTotals['users'] = users.length;
    const p = paginate(users, 'users');
    updateCount('users-count', p.total);
    renderTable('user-list', 15,
        p.items.map(u =>
            '<td>' + escapeHtml(u.username) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(u.id) + '">' + escapeHtml(truncate(u.id, 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(u.created_at || '') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.identity_public_key || '', 20)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(u.profile_picture_file_id || '', 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.profile_picture_file_key || '', 20)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(u.profile_banner_file_id || '', 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.profile_banner_file_key || '', 20)) + '</td>' +
            '<td>' + (u.friend_requests_disabled ? 'Yes' : 'No') + '</td>' +
            (u.two_factor_enabled
                ? '<td><span style="color:#43b581;font-weight:600;">ON</span> <button class="btn-delete-sm" data-2fa-uid="' + escapeHtml(u.id) + '" data-2fa-uname="' + escapeHtml(u.username) + '">Disable</button></td>'
                : '<td style="color:#666;">Off</td>') +
            '<td class="blob-cell">' + escapeHtml(truncate(u.encrypted_profile_data || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.friend_code_hash || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.encrypted_hash_key || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.hash_key_salt || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(u.hash_key_nonce || '', 20)) + '</td>'
        ),
        'No users'
    );
    renderPaginationControls('users');
}

// Force-disable 2FA for a user (admin action).
async function disableUser2fa(userId, username) {
    if (!confirm('Disable two-factor authentication for "' + username + '"?\nThey will no longer need a code to log in. This cannot be undone by the user.')) return;
    try {
        const adminToken = sessionStorage.getItem('admin_token') || '';
        const res = await fetch('/api/admin/users/' + encodeURIComponent(userId) + '/disable-2fa', {
            method: 'POST',
            headers: adminToken ? { 'Authorization': 'Bearer ' + adminToken } : {},
        });
        const data = await res.json();
        if (!res.ok) { alert('Failed: ' + (data.error || 'HTTP ' + res.status)); return; }
        alert('2FA disabled for ' + username);
        loadUsers();
        loadAuditLog();
    } catch (e) {
        alert('Server is not running');
    }
}

// --- Servers ---
async function loadServers() { await loadTabData("/api/admin/servers", "servers", renderServers); }

function renderServers(servers) {
    tabTotals['servers'] = servers.length;
    const p = paginate(servers, 'servers');
    updateCount('servers-count', p.total);
    renderTable('server-list', 12,
        p.items.map(s => {
            var nameHtml = s.encrypted_name
                ? '<span class="blob-cell">' + escapeHtml(truncate(s.encrypted_name, 30)) + '</span>'
                : '<span class="empty-state">(no name)</span>';
            return '<td>' + nameHtml + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(s.id) + '">' + escapeHtml(truncate(s.id, 12)) + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(s.owner_id) + '">' + escapeHtml(truncate(s.owner_id, 12)) + '</td>' +
                '<td class="ts-cell">' + escapeHtml(s.created_at || '') + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.invite_code_hash || '', 20)) + '</td>' +
                '<td>' + (s.joins_disabled ? 'Yes' : 'No') + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.encrypted_name || '', 20)) + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.name_nonce || '', 20)) + '</td>' +
                '<td class="id-cell">' + escapeHtml(truncate(s.server_picture_file_id || '', 12)) + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.server_picture_file_id_hash || '', 20)) + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.encrypted_server_picture_key || '', 20)) + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(s.server_picture_key_nonce || '', 20)) + '</td>';
        }),
        'No servers'
    );
    renderPaginationControls('servers');
}

// --- Channels ---
async function loadChannels() { await loadTabData("/api/admin/channels", "channels", renderChannels); }

function renderChannels(channels) {
    tabTotals['channels'] = channels.length;
    const p = paginate(channels, 'channels');
    updateCount('channels-count', p.total);
    renderTable('channel-list', 8,
        p.items.map(c => {
            var nameHtml = c.encrypted_name
                ? '<span class="blob-cell">' + escapeHtml(truncate(c.encrypted_name, 30)) + '</span>'
                : '<span class="empty-state">(no name)</span>';
            return '<td>' + nameHtml + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(c.id) + '">' + escapeHtml(truncate(c.id, 12)) + '</td>' +
                '<td class="id-cell" title="' + escapeHtml(c.server_id) + '">' + escapeHtml(truncate(c.server_id, 12)) + '</td>' +
                '<td>' + escapeHtml(c.type) + '</td>' +
                '<td>' + (c.position != null ? c.position : '') + '</td>' +
                '<td class="ts-cell">' + escapeHtml(c.created_at || '') + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(c.encrypted_name || '', 20)) + '</td>' +
                '<td class="blob-cell">' + escapeHtml(truncate(c.name_nonce || '', 20)) + '</td>';
        }),
        'No channels'
    );
    renderPaginationControls('channels');
}

// --- Messages ---
async function loadMessages() { await loadTabData("/api/admin/messages", "messages", renderMessages); }

function renderMessages(messages) {
    tabTotals['messages'] = messages.length;
    const p = paginate(messages, 'messages');
    updateCount('messages-count', p.total, ' records');
    renderTable('message-list', 12,
        p.items.map(m =>
            '<td>' + escapeHtml(m.sender_username || m.sender_id) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.channel_id) + '">' + escapeHtml(truncate(m.channel_id, 12)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(m.encrypted_content, 60)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.nonce, 30)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.timestamp) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(m.id || '', 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.edited_at || '') + '</td>' +
            '<td>' + (m.key_version != null ? m.key_version : '') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.sender_id_hash || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_profile_snapshot || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_file_key || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.file_key_nonce || '', 30)) + '</td>'
        ),
        'No messages'
    );
    renderPaginationControls('messages');
}

// --- Server Keys ---
async function loadServerKeys() { await loadTabData("/api/admin/server-keys", "serverKeys", renderServerKeys); }

function renderServerKeys(keys) {
    tabTotals['server-keys'] = keys.length;
    const p = paginate(keys, 'server-keys');
    updateCount('server-keys-count', p.total);
    renderTable('server-key-list', 8,
        p.items.map(k =>
            '<td>' + escapeHtml(k.server_name) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(k.user_id) + '">' + escapeHtml(truncate(k.user_id, 12)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(k.encrypted_key, 40)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(k.sender_public_key, 40)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(k.nonce, 30)) + '</td>' +
            '<td>' + k.version + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(k.device_id || '', 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(k.created_at || '') + '</td>'
        ),
        'No server keys'
    );
    renderPaginationControls('server-keys');
}

// --- Server Members ---
async function loadServerMembers() { await loadTabData("/api/admin/server-members", "serverMembers", renderServerMembers); }

function renderServerMembers(members) {
    tabTotals['server-members'] = members.length;
    const p = paginate(members, 'server-members');
    updateCount('server-members-count', p.total);
    renderTable('server-member-list', 6,
        p.items.map(m =>
            '<td>' + escapeHtml(m.username) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.user_id) + '">' + escapeHtml(truncate(m.user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(m.server_name) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.server_id) + '">' + escapeHtml(truncate(m.server_id, 12)) + '</td>' +
            '<td>' + escapeHtml(m.role || 'member') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.joined_at || '') + '</td>'
        ),
        'No members'
    );
    renderPaginationControls('server-members');
}

// --- Server Bans ---
async function loadServerBans() { await loadTabData("/api/admin/server-bans", "serverBans", renderServerBans); }
function renderServerBans(rows) {
    tabTotals['server-bans'] = rows.length;
    const p = paginate(rows, 'server-bans');
    updateCount('server-bans-count', p.total);
    renderTable('server-ban-list', 6,
        p.items.map(r =>
            '<td>' + escapeHtml(r.server_name) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(r.server_id) + '">' + escapeHtml(truncate(r.server_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.username) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(r.user_id) + '">' + escapeHtml(truncate(r.user_id || '', 12)) + '</td>' +
            '<td>' + escapeHtml(r.reason || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No server bans'
    );
    renderPaginationControls('server-bans');
}

// --- DM Channels ---
async function loadDmChannels() { await loadTabData("/api/admin/dm-channels", "dmChannels", renderDmChannels); }
function renderDmChannels(rows) {
    tabTotals['dm-channels'] = rows.length;
    const p = paginate(rows, 'dm-channels');
    updateCount('dm-channels-count', p.total);
    renderTable('dm-channel-list', 2,
        p.items.map(r =>
            '<td class="id-cell" title="' + escapeHtml(r.id) + '">' + escapeHtml(truncate(r.id, 16)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No DM channels'
    );
    renderPaginationControls('dm-channels');
}

// --- DM Members ---
async function loadDmMembers() { await loadTabData("/api/admin/dm-members", "dmMembers", renderDmMembers); }
function renderDmMembers(rows) {
    tabTotals['dm-members'] = rows.length;
    const p = paginate(rows, 'dm-members');
    updateCount('dm-members-count', p.total);
    renderTable('dm-member-list', 4,
        p.items.map(r =>
            '<td class="id-cell" title="' + escapeHtml(r.dm_channel_id) + '">' + escapeHtml(truncate(r.dm_channel_id, 12)) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(r.user_id) + '">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.username) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No DM members'
    );
    renderPaginationControls('dm-members');
}

// --- DM Messages ---
async function loadDmMessages() { await loadTabData("/api/admin/dm-messages", "dmMessages", renderDmMessages); }
function renderDmMessages(rows) {
    tabTotals['dm-messages'] = rows.length;
    const p = paginate(rows, 'dm-messages');
    updateCount('dm-messages-count', p.total, ' records');
    renderTable('dm-message-list', 11,
        p.items.map(m =>
            '<td>' + escapeHtml(m.sender_username || m.sender_id) + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(m.dm_channel_id) + '">' + escapeHtml(truncate(m.dm_channel_id, 12)) + '</td>' +
            '<td class="blob-cell" title="Click to expand">' + escapeHtml(truncate(m.encrypted_content, 50)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.nonce, 30)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(m.timestamp) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(m.id || '', 12)) + '</td>' +
            '<td>' + (m.key_version != null ? m.key_version : '') + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.sender_id_hash || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_profile_snapshot || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.encrypted_file_key || '', 30)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(m.file_key_nonce || '', 30)) + '</td>'
        ),
        'No DM messages'
    );
    renderPaginationControls('dm-messages');
}

// --- Friend Requests ---
async function loadFriendRequests() { await loadTabData("/api/admin/friend-requests", "friendRequests", renderFriendRequests); }
function renderFriendRequests(rows) {
    tabTotals['friend-requests'] = rows.length;
    const p = paginate(rows, 'friend-requests');
    updateCount('friend-requests-count', p.total);
    renderTable('friend-request-list', 5,
        p.items.map(r =>
            '<td>' + escapeHtml(r.from_username) + ' <span class="id-cell">(' + escapeHtml(truncate(r.from_user_id, 8)) + ')</span></td>' +
            '<td>' + escapeHtml(r.to_username) + ' <span class="id-cell">(' + escapeHtml(truncate(r.to_user_id, 8)) + ')</span></td>' +
            '<td>' + escapeHtml(r.status) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.responded_at || '') + '</td>'
        ),
        'No friend requests'
    );
    renderPaginationControls('friend-requests');
}

// --- Friendships ---
async function loadFriendships() { await loadTabData("/api/admin/friendships", "friendships", renderFriendships); }
function renderFriendships(rows) {
    tabTotals['friendships'] = rows.length;
    const p = paginate(rows, 'friendships');
    updateCount('friendships-count', p.total);
    renderTable('friendship-list', 3,
        p.items.map(r =>
            '<td>' + escapeHtml(r.username_1) + ' <span class="id-cell">(' + escapeHtml(truncate(r.user_id_1, 8)) + ')</span></td>' +
            '<td>' + escapeHtml(r.username_2) + ' <span class="id-cell">(' + escapeHtml(truncate(r.user_id_2, 8)) + ')</span></td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>'
        ),
        'No friendships'
    );
    renderPaginationControls('friendships');
}

// --- Files ---
async function loadFiles() { await loadTabData("/api/admin/files", "files", renderFiles); }
function renderFiles(rows) {
    tabTotals['files'] = rows.length;
    const p = paginate(rows, 'files');
    updateCount('files-count', p.total);
    renderTable('file-list', 10,
        p.items.map(r => {
            const size = r.file_size > 1048576 ? (r.file_size / 1048576).toFixed(1) + ' MB' :
                         r.file_size > 1024 ? (r.file_size / 1024).toFixed(1) + ' KB' : r.file_size + ' B';
            return '<td class="id-cell">' + escapeHtml(truncate(r.original_name, 16)) + '</td>' +
            '<td>' + escapeHtml(r.uploader_username) + '</td>' +
            '<td>' + escapeHtml(r.mime_type) + '</td>' +
            '<td>' + size + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.file_id_hash || '', 20)) + '</td>' +
            '<td>' + (r.chunk_count != null ? r.chunk_count : '') + '</td>' +
            '<td>' + (r.upload_complete ? 'Yes' : 'No') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_mime_type || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.mime_nonce || '', 20)) + '</td>';
        }),
        'No files'
    );
    renderPaginationControls('files');
}

// --- Admin Config ---
async function loadAdminConfig() { await loadTabData("/api/admin/admin-config", "adminConfig", renderAdminConfig); }

// --- Runtime limits (G2) — live-tunable without a restart ---
async function loadRuntimeConfig() {
    try {
        const res = await fetch('/api/admin/runtime-config', { headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('admin_token') } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const cfg = await res.json();
        document.getElementById('rt-mutation-user-max').value = cfg.mutation_user_max;
        document.getElementById('rt-mutation-ip-max').value = cfg.mutation_ip_max;
        document.getElementById('rt-quota-bytes').value = cfg.file_storage_quota_bytes;
        document.getElementById('rt-max-file-size-mb').value = cfg.max_file_size_mb;
        const src = cfg.sources || {};
        document.getElementById('rt-src-user').textContent = '(' + (src.mutation_user_max || 'db') + ')';
        document.getElementById('rt-src-ip').textContent = '(' + (src.mutation_ip_max || 'db') + ')';
        document.getElementById('rt-src-quota').textContent = '(' + (src.file_storage_quota_bytes || 'db') + ')';
        document.getElementById('rt-src-file-size').textContent = '(' + (src.max_file_size_mb || 'db') + ')';
        const redactEl = document.getElementById('rt-redact-ips');
        if (redactEl) redactEl.checked = !!cfg.admin_audit_redact_ips;
        setRtStatus('Loaded');
    } catch (e) {
        setRtStatus('Load failed: ' + e.message, true);
    }
}

function setRtStatus(msg, isError) {
    const el = document.getElementById('rt-save-status');
    if (!el) return;
    el.textContent = msg;
    el.style.color = isError ? '#f04747' : '#2ecc71';
}

async function saveRuntimeConfig() {
    const redactEl = document.getElementById('rt-redact-ips');
    const payload = {
        mutation_user_max: parseInt(document.getElementById('rt-mutation-user-max').value, 10) || 0,
        mutation_ip_max: parseInt(document.getElementById('rt-mutation-ip-max').value, 10) || 0,
        file_storage_quota_bytes: parseInt(document.getElementById('rt-quota-bytes').value, 10) || 0,
        max_file_size_mb: parseInt(document.getElementById('rt-max-file-size-mb').value, 10) || 0,
        ...(redactEl ? { admin_audit_redact_ips: redactEl.checked } : {}),
    };
    try {
        const res = await fetch('/api/admin/runtime-config', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + sessionStorage.getItem('admin_token') },
            body: JSON.stringify(payload),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
        setRtStatus('Saved & applied live');
        // Refresh the generic config table too (new keys now appear there).
        loadAdminConfig();
        loadAuditLog();
        return true;
    } catch (e) {
        setRtStatus('Save failed: ' + e.message, true);
        return false;
    }
}

(function wireRtModal() {
    const modal = document.getElementById('runtime-limits-modal');
    const openBtn = document.getElementById('runtime-limits-btn');
    const cancelBtn = document.getElementById('rt-cancel-btn');
    const saveBtn = document.getElementById('rt-save-btn');
    const refreshBtn = document.getElementById('rt-usage-refresh');
    if (!modal || !openBtn) return;
    let usageTimer = null;
    function openModal() {
        modal.style.display = 'flex';
        loadRuntimeConfig();
        loadRateLimitUsage();
        if (usageTimer) clearInterval(usageTimer);
        usageTimer = setInterval(loadRateLimitUsage, 5000);
    }
    function closeModal() {
        modal.style.display = 'none';
        if (usageTimer) { clearInterval(usageTimer); usageTimer = null; }
    }
    openBtn.addEventListener('click', openModal);
    if (cancelBtn) cancelBtn.addEventListener('click', closeModal);
    // Click on the dark overlay (outside the card) closes the modal.
    modal.addEventListener('click', (e) => {
        if (e.target === modal) closeModal();
    });
    if (saveBtn) {
        saveBtn.addEventListener('click', async () => {
            const ok = await saveRuntimeConfig();
            if (ok) setTimeout(closeModal, 700);
        });
    }
    if (refreshBtn) refreshBtn.addEventListener('click', loadRateLimitUsage);
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && modal.style.display === 'flex') closeModal();
    });
})();

// --- Live mutation-limit usage (G2) ---
function rtTimeAgo(unixTs) {
    if (!unixTs) return '';
    const s = Math.max(0, Math.floor(Date.now() / 1000) - unixTs);
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    const m = Math.floor(s / 60);
    if (m < 60) return m + 'm ago';
    return Math.floor(m / 60) + 'h ago';
}

function renderUsageBucket(el, rows, limit, nameKey) {
    if (!rows || rows.length === 0) {
        el.innerHTML = '<span style="color:var(--text-muted);opacity:.6">No active buckets</span>';
        return;
    }
    el.innerHTML = rows.map((r) => {
        const name = r[nameKey] || r.username || r.user_id || '?';
        const pct = limit > 0 ? Math.round((r.count / limit) * 100) : 100;
        const color = pct >= 90 ? '#f04747' : (pct >= 60 ? '#faa61a' : 'inherit');
        return '<div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px solid var(--border,#2a2a3a);">' +
            '<span title="' + escapeHtml(r.user_id || '') + '" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:130px;">' + escapeHtml(name) + '</span>' +
            '<span style="color:' + color + ';white-space:nowrap;">' + r.count + '/' + limit + ' · ' + r.window_remaining_s + 's</span></div>';
    }).join('');
}

async function loadRateLimitUsage() {
    const usersEl = document.getElementById('rt-usage-users');
    const ipsEl = document.getElementById('rt-usage-ips');
    const hitsEl = document.getElementById('rt-usage-429s');
    const updatedEl = document.getElementById('rt-usage-updated');
    try {
        const res = await fetch('/api/admin/rate-limit-usage', { headers: { 'Authorization': 'Bearer ' + sessionStorage.getItem('admin_token') } });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        renderUsageBucket(usersEl, data.users, data.users && data.users.length ? data.users[0].limit : 0, 'username');
        renderUsageBucket(ipsEl, data.ips, data.ips && data.ips.length ? data.ips[0].limit : 0, 'ip');
        if (!data.recent_429s || data.recent_429s.length === 0) {
            hitsEl.innerHTML = '<span style="color:var(--text-muted);opacity:.6">No 429s in the last ' + data.window_seconds + 's window</span>';
        } else {
            hitsEl.innerHTML = data.recent_429s.map((h) =>
                '<div style="display:flex;justify-content:space-between;gap:8px;padding:2px 0;border-bottom:1px solid var(--border,#2a2a3a);">' +
                '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:150px;">' + escapeHtml(h.username) + '</span>' +
                '<span style="color:#8a8fa3;white-space:nowrap;">' + escapeHtml(h.ip) + ' · ' + rtTimeAgo(h.ts) + '</span></div>'
            ).join('');
        }
        if (updatedEl) updatedEl.textContent = 'updated ' + rtTimeAgo(data.last_updated);
    } catch (e) {
        usersEl.innerHTML = 'Usage load failed: ' + escapeHtml(e.message);
        if (updatedEl) updatedEl.textContent = 'error';
    }
}
function renderAdminConfig(rows) {
    tabTotals['admin-config'] = rows.length;
    const p = paginate(rows, 'admin-config');
    updateCount('admin-config-count', p.total);
    renderTable('admin-config-list', 2,
        p.items.map(r =>
            '<td>' + escapeHtml(r.key) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.value, 60)) + '</td>'
        ),
        'No config entries'
    );
    renderPaginationControls('admin-config');
}

// --- Pending Events ---
async function loadPendingEvents() { await loadTabData("/api/admin/pending-events", "pendingEvents", renderPendingEvents); }
function renderPendingEvents(rows) {
    tabTotals['pending-events'] = rows.length;
    const p = paginate(rows, 'pending-events');
    updateCount('pending-events-count', p.total);
    renderTable('pending-event-list', 5,
        p.items.map(r =>
            '<td>' + escapeHtml(r.id) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.server_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.event_type) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.affected_user_id, 12)) + '</td>'
        ),
        'No pending events'
    );
    renderPaginationControls('pending-events');
}

// --- Pending Notifications ---
async function loadPendingNotifications() { await loadTabData("/api/admin/pending-notifications", "pendingNotifications", renderPendingNotifications); }
function renderPendingNotifications(rows) {
    tabTotals['pending-notifications'] = rows.length;
    const p = paginate(rows, 'pending-notifications');
    updateCount('pending-notifications-count', p.total);
    renderTable('pending-notification-list', 4,
        p.items.map(r =>
            '<td>' + escapeHtml(r.id) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.notification_type) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.payload, 60)) + '</td>'
        ),
        'No pending notifications'
    );
    renderPaginationControls('pending-notifications');
}

// --- Voice Sessions ---
async function loadVoiceSessions() { await loadTabData("/api/admin/voice-sessions", "voiceSessions", renderVoiceSessions); }
function renderVoiceSessions(rows) {
    tabTotals['voice-sessions'] = rows.length;
    const p = paginate(rows, 'voice-sessions');
    updateCount('voice-sessions-count', p.total);
    renderTable('voice-session-list', 4,
        p.items.map(r =>
            '<td class="id-cell">' + escapeHtml(truncate(r.id, 12)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.channel_id, 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.started_at || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.ended_at || '') + '</td>'
        ),
        'No voice sessions'
    );
    renderPaginationControls('voice-sessions');
}

// --- Voice Participants ---
async function loadVoiceParticipants() { await loadTabData("/api/admin/voice-participants", "voiceParticipants", renderVoiceParticipants); }
function renderVoiceParticipants(rows) {
    tabTotals['voice-participants'] = rows.length;
    const p = paginate(rows, 'voice-participants');
    updateCount('voice-participants-count', p.total);
    renderTable('voice-participant-list', 8,
        p.items.map(r =>
            '<td class="id-cell">' + escapeHtml(truncate(r.voice_session_id, 12)) + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.joined_at || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.left_at || '') + '</td>' +
            '<td>' + (r.is_muted ? 'Yes' : 'No') + '</td>' +
            '<td>' + (r.is_deafened ? 'Yes' : 'No') + '</td>' +
            '<td>' + (r.is_camera_on ? 'Yes' : 'No') + '</td>' +
            '<td>' + (r.is_screen_sharing ? 'Yes' : 'No') + '</td>'
        ),
        'No voice participants'
    );
    renderPaginationControls('voice-participants');
}

// --- User Media ---
async function loadUserMedia() { await loadTabData("/api/admin/user-media", "userMedia", renderUserMedia); }
function renderUserMedia(rows) {
    tabTotals['user-media'] = rows.length;
    const p = paginate(rows, 'user-media');
    updateCount('user-media-count', p.total);
    renderTable('user-media-list', 8,
        p.items.map(r =>
            '<td class="id-cell">' + escapeHtml(truncate(r.id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.username || '') + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.file_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_file_key || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.eph_pub || '', 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.nonce || '', 20)) + '</td>' +
            '<td>' + escapeHtml(r.media_type || '') + '</td>' +
            '<td class="ts-cell">' + escapeHtml(r.created_at || '') + '</td>'
        ),
        'No user media'
    );
    renderPaginationControls('user-media');
}

// --- User Key Blobs ---
async function loadUserKeyBlobs() { await loadTabData("/api/admin/user-key-blobs", "userKeyBlobs", renderUserKeyBlobs); }
function renderUserKeyBlobs(rows) {
    tabTotals['user-key-blobs'] = rows.length;
    const p = paginate(rows, 'user-key-blobs');
    updateCount('user-key-blobs-count', p.total);
    renderTable('user-key-blob-list', 5,
        p.items.map(r =>
            '<td>' + escapeHtml(r.username || '') + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_blob, 40)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.salt, 20)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.nonce, 20)) + '</td>'
        ),
        'No key blobs'
    );
    renderPaginationControls('user-key-blobs');
}

// --- Profile Data Keys ---
async function loadProfileDataKeys() { await loadTabData("/api/admin/profile-data-keys", "profileDataKeys", renderProfileDataKeys); }
function renderProfileDataKeys(rows) {
    tabTotals['profile-data-keys'] = rows.length;
    const p = paginate(rows, 'profile-data-keys');
    updateCount('profile-data-keys-count', p.total);
    renderTable('profile-data-key-list', 4,
        p.items.map(r =>
            '<td>' + escapeHtml(r.username || '') + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.user_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_key, 40)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.nonce, 20)) + '</td>'
        ),
        'No profile data keys'
    );
    renderPaginationControls('profile-data-keys');
}

// --- Shared Profile Data Keys ---
async function loadSharedProfileDataKeys() { await loadTabData("/api/admin/shared-profile-data-keys", "sharedProfileDataKeys", renderSharedProfileDataKeys); }
function renderSharedProfileDataKeys(rows) {
    tabTotals['shared-profile-data-keys'] = rows.length;
    const p = paginate(rows, 'shared-profile-data-keys');
    updateCount('shared-profile-data-keys-count', p.total);
    renderTable('shared-profile-data-key-list', 6,
        p.items.map(r =>
            '<td class="id-cell">' + escapeHtml(truncate(r.id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.username || '') + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.owner_user_id, 12)) + '</td>' +
            '<td>' + escapeHtml(r.target_type || '') + '</td>' +
            '<td class="id-cell">' + escapeHtml(truncate(r.target_id, 12)) + '</td>' +
            '<td class="blob-cell">' + escapeHtml(truncate(r.encrypted_key, 40)) + '</td>'
        ),
        'No shared profile data keys'
    );
    renderPaginationControls('shared-profile-data-keys');
}

function clearAll() {
    // Open the typed-word confirmation modal with a fresh state.
    const input = document.getElementById('wipe-confirm-input');
    const confirmBtn = document.getElementById('confirm-wipe-all');
    const errorEl = document.getElementById('wipe-confirm-error');
    if (input) input.value = '';
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.5';
    }
    if (errorEl) errorEl.style.display = 'none';
    document.getElementById('wipe-confirm-modal').style.display = 'flex';
    if (input) input.focus();
}

function updateWipeConfirmState() {
    const input = document.getElementById('wipe-confirm-input');
    const confirmBtn = document.getElementById('confirm-wipe-all');
    const errorEl = document.getElementById('wipe-confirm-error');
    if (!input || !confirmBtn) return;
    const ok = input.value === 'DELETE';
    confirmBtn.disabled = !ok;
    confirmBtn.style.opacity = ok ? '1' : '0.5';
    if (errorEl) errorEl.style.display = 'none';
}

function closeWipeModal() {
    document.getElementById('wipe-confirm-modal').style.display = 'none';
}

async function confirmWipeAll() {
    const input = document.getElementById('wipe-confirm-input');
    const errorEl = document.getElementById('wipe-confirm-error');
    if (!input || input.value !== 'DELETE') {
        if (errorEl) {
            errorEl.textContent = 'Type DELETE to confirm the wipe.';
            errorEl.style.display = 'block';
        }
        return;
    }
    closeWipeModal();
    try {
        const adminToken = sessionStorage.getItem('admin_token') || '';
        const res = await fetch('/api/admin/clear', {
            method: 'POST',
            headers: adminToken ? { 'Authorization': 'Bearer ' + adminToken } : {}
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Wipe failed');
        // Clear admin auth from session storage
        sessionStorage.removeItem('admin_auth');
        sessionStorage.removeItem('admin_token');
        // Redirect to login page — server already reset setup_complete to false
        window.location.href = 'login.html';
    } catch (err) {
        alert('Wipe failed: ' + err.message);
    }
}

// Derive AES-256-GCM key from password+salt using SHA-256
async function deriveAESKey(password, salt) {
    const enc = new TextEncoder();
    const material = salt ? password + ':' + salt : password;
    const pwHash = await crypto.subtle.digest('SHA-256', enc.encode(material));
    return await crypto.subtle.importKey('raw', pwHash, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

// Chunked base64 for large files (avoids the spread-argument limit).
function bytesToB64(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) {
        s += String.fromCharCode.apply(null, u8.subarray(i, i + CH));
    }
    return btoa(s);
}
function b64ToBytes(b64) {
    const bin = atob(b64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8;
}

async function doExport(password) {
    setBusy(password ? 'Encrypting and downloading the database backup… this can take a while for a large database.' : 'Downloading the database backup…');
    try {
        const adminToken = sessionStorage.getItem('admin_token') || '';
        const res = await fetch('/api/admin/export-db', {
            headers: adminToken ? { 'Authorization': 'Bearer ' + adminToken } : {}
        });
        if (!res.ok) {
            throw new Error(await apiErrorText(res) || 'Export failed');
        }
        const blob = await res.blob();
        const data = await blob.arrayBuffer();
        // Fetch the uploaded-file bytes too, so the backup round-trips images.
        setBusy('Downloading uploaded files…');
        let uploadsBundle = null;
        try {
            const upRes = await fetch('/api/admin/export-uploads', {
                headers: adminToken ? { 'Authorization': 'Bearer ' + adminToken } : {}
            });
            if (upRes.ok) {
                uploadsBundle = await (await upRes.blob()).arrayBuffer();
            } else {
                console.warn('export-uploads failed with ' + upRes.status + ' — continuing DB-only');
            }
        } catch (e) {
            console.warn('export-uploads fetch failed — continuing DB-only:', e);
        }
        const data2 = buildBackupPayload(data, uploadsBundle);
        setBusy(password ? 'Encrypting the backup…' : 'Saving the backup…');
        let finalBlob;
        if (password) {
            // v2 (current): Argon2id + AEAD — the same password-encryption scheme
            // the chat app uses (crypto.js E2ECrypto via libsodium). Format:
            // magic 0x02 + salt(16) + nonce(24) + ciphertext
            const dataB64 = bytesToB64(new Uint8Array(data2));
            const enc = E2ECrypto.encryptWithPassword(dataB64, password);
            const saltBytes = b64ToBytes(enc.salt);
            const nonceBytes = b64ToBytes(enc.nonce);
            const ctBytes = b64ToBytes(enc.encrypted_private_key);
            const combined = new Uint8Array(1 + saltBytes.length + nonceBytes.length + ctBytes.length);
            combined[0] = 0x02;
            combined.set(saltBytes, 1);
            combined.set(nonceBytes, 1 + saltBytes.length);
            combined.set(ctBytes, 1 + saltBytes.length + nonceBytes.length);
            finalBlob = new Blob([combined], { type: 'application/octet-stream' });
        } else {
            // Unencrypted: magic byte 0x00 + raw bundle payload
            const combined = new Uint8Array(1 + data2.byteLength);
            combined[0] = 0x00;
            combined.set(new Uint8Array(data2), 1);
            finalBlob = new Blob([combined], { type: 'application/octet-stream' });
        }
        const url = URL.createObjectURL(finalBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'e2e_chat_' + new Date().toISOString().slice(0, 10) + '.dbpack';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    } catch (err) {
        alert('Export failed: ' + err.message);
    } finally {
        clearBusy();
    }
}

async function doImport(buffer, password, dryRun, validateFirst) {
    setBusy('Decrypting the backup file…');
    try {
        const magic = new Uint8Array(buffer, 0, 1)[0];
        let decrypted;
        if (magic === 0x02) {
            // v2 (Argon2id + AEAD): salt(16) + nonce(24) + ciphertext
            if (buffer.byteLength < 41) throw new Error('Corrupted encrypted file.');
            const saltB64 = E2ECrypto.arrayBufferToBase64(buffer.slice(1, 17));
            const nonceB64 = E2ECrypto.arrayBufferToBase64(buffer.slice(17, 41));
            const ctB64 = E2ECrypto.arrayBufferToBase64(buffer.slice(41));
            const plainB64 = E2ECrypto.decryptWithPassword(ctB64, password, saltB64, nonceB64);
            if (!plainB64) throw new Error('Wrong password or corrupted file');
            decrypted = b64ToBytes(plainB64).buffer;
        } else {
            // v1 (legacy SHA-256 + AES-GCM): salt(16) + nonce(12) + ciphertext
            const saltBytes = new Uint8Array(buffer, 1, 16);
            const salt = Array.from(saltBytes).map(b => b.toString(16).padStart(2, '0')).join('');
            const key = await deriveAESKey(password, salt);
            const nonce = new Uint8Array(buffer, 17, 12);
            const ciphertext = new Uint8Array(buffer, 29);
            decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: nonce }, key, ciphertext);
        }

        await uploadImport(decrypted, dryRun, validateFirst);
    } catch (err) {
        alert('Import failed: ' + err.message);
    } finally {
        clearBusy();
    }
}

// POST a decrypted SQLite body to the import endpoint (real or dry-run).
// validateFirst=true keeps the bytes so the results modal can offer
// “Import this backup” without re-decrypting.
async function uploadImport(decrypted, dryRun, validateFirst) {
    setBusy('Preparing the backup…');
    // Split DB + uploaded-file bytes (legacy DB-only backups have no bundle).
    const { dbBytes, uploadsBundle } = unpackBackup(decrypted);
    const adminToken = sessionStorage.getItem('admin_token') || '';
    let uploadsData = null;
    if (uploadsBundle) {
        setBusy(dryRun ? 'Validating uploaded files…' : 'Restoring uploaded files…');
        const upRes = await fetch('/api/admin/import-uploads' + (dryRun ? '?dry_run=1' : ''), {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + adminToken,
                'Content-Type': 'application/octet-stream'
            },
            body: uploadsBundle
        });
        let upJson = null;
        try { upJson = await upRes.json(); } catch (_) { upJson = null; }
        if (!upRes.ok) {
            throw new Error('Uploads restore failed: ' + ((upJson && upJson.error) || (await apiErrorText(upRes)) || upRes.status));
        }
        uploadsData = upJson || {};
        if (!dryRun && uploadsData && uploadsData.ok) {
            console.log('Uploads restored:', uploadsData.files, 'files,', uploadsData.bytes, 'bytes');
        }
    }

    setBusy(dryRun
        ? 'Validating the database on a staging copy…'
        : 'Replacing the live database with the backup… this can take a while for a large database.');
    const res = await fetch('/api/admin/import-db' + (dryRun ? '?dry_run=1' : ''), {
        method: 'POST',
        headers: {
            'Authorization': 'Bearer ' + adminToken,
            'Content-Type': 'application/octet-stream'
        },
        body: dbBytes
    });
    // The server may answer with a non-JSON body (body-limit 413 etc.) — parse
    // defensively so the admin sees the real reason, never "Unexpected token".
    let data = null;
    try { data = await res.json(); } catch (_) { data = null; }
    if (!res.ok) throw new Error((data && data.error) || (await apiErrorText(res)) || 'Import failed');
    if (!data) data = {};
    if (dryRun) {
        // Keep the bytes around for table previews (and, in the validate-first
        // flow, for “Import this backup”). Cleared when the results close.
        clearBusy();
        pendingDecrypted = decrypted;
        showImportResults(data, validateFirst, uploadsData);
        return;
    }
    pendingDecrypted = null;
    clearBusy();
    alert('Database imported successfully! You will need to re-login.');
    sessionStorage.removeItem('admin_auth');
    sessionStorage.removeItem('admin_token');
    window.location.reload();
}

// Shared file-picker flow; dryRun=true validates without replacing.
async function pickImportFile(dryRun) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.dbpack,.db,.sqlite,.sqlite3';
    input.onchange = async function(e) {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const buffer = await file.arrayBuffer();
            if (buffer.byteLength < 1) {
                alert('Empty file.');
                return;
            }
            if (dryRun) {
                // Standalone Validate button — straight to the dry run.
                await continueImportWithBuffer(buffer, true, false);
            } else {
                // Import button — confirm the replace and offer validate-first.
                pendingImportData = buffer;
                pendingValidateFirst = false;
                showImportConfirmModal();
            }
        } catch (err) {
            alert('Import failed: ' + err.message);
        }
    };
    input.click();
}

function importDB() {
    pickImportFile(false);
}

function validateImportDB() {
    pickImportFile(true);
}

function showImportConfirmModal() {
    document.getElementById('import-validate-first').checked = false;
    document.getElementById('import-confirm-modal').style.display = 'flex';
}

function closeImportConfirmModal() {
    document.getElementById('import-confirm-modal').style.display = 'none';
}

async function continueImportConfirm() {
    const validateFirst = document.getElementById('import-validate-first').checked;
    const buffer = pendingImportData;
    pendingImportData = null;
    closeImportConfirmModal();
    await continueImportWithBuffer(buffer, validateFirst, validateFirst);
}

// Route a picked buffer through decrypt (if needed) then upload.
async function continueImportWithBuffer(buffer, dryRun, validateFirst) {
    try {
        const magic = new Uint8Array(buffer, 0, 1)[0];
        if (magic === 0x01 || magic === 0x02) {
            // Encrypted (v1 SHA-256+AES-GCM or v2 Argon2id): ask for the password.
            if ((magic === 0x01 && buffer.byteLength < 29) || (magic === 0x02 && buffer.byteLength < 41)) {
                alert('Corrupted encrypted file.');
                return;
            }
            // Store buffer and show password modal
            pendingImportData = buffer;
            pendingDryRun = dryRun;
            pendingValidateFirst = validateFirst;
            showImportModal();
        } else {
            // Unencrypted: strip the magic byte and upload directly
            await uploadImport(buffer.slice(1), dryRun, validateFirst);
        }
    } catch (err) {
        alert('Import failed: ' + err.message);
    }
}

// “Import this backup” from the dry-run results modal (validate-first flow).
// When the dry run found problems, require a typed-word (IMPORT) confirm first.
async function importFromResults() {
    if (!pendingDecrypted) {
        alert('Import failed: no decrypted data available.');
        return;
    }
    if (pendingRiskyImport) {
        document.getElementById('import-results-modal').style.display = 'none';
        showRiskyImportModal();
        return;
    }
    document.getElementById('import-results-modal').style.display = 'none';
    const decrypted = pendingDecrypted;
    pendingDecrypted = null;
    await uploadImport(decrypted, false, false);
}

function showRiskyImportModal() {
    const input = document.getElementById('risky-import-input');
    const confirmBtn = document.getElementById('confirm-risky-import');
    if (input) input.value = '';
    if (confirmBtn) {
        confirmBtn.disabled = true;
        confirmBtn.style.opacity = '0.5';
    }
    document.getElementById('risky-import-error').style.display = 'none';
    document.getElementById('risky-import-modal').style.display = 'flex';
    if (input) input.focus();
}

function closeRiskyImportModal() {
    document.getElementById('risky-import-modal').style.display = 'none';
}

function updateRiskyImportState() {
    const input = document.getElementById('risky-import-input');
    const confirmBtn = document.getElementById('confirm-risky-import');
    const errorEl = document.getElementById('risky-import-error');
    if (!input || !confirmBtn) return;
    const ok = input.value === 'IMPORT';
    confirmBtn.disabled = !ok;
    confirmBtn.style.opacity = ok ? '1' : '0.5';
    if (errorEl) errorEl.style.display = 'none';
}

async function confirmRiskyImport() {
    const input = document.getElementById('risky-import-input');
    const errorEl = document.getElementById('risky-import-error');
    if (!input || input.value !== 'IMPORT') {
        if (errorEl) {
            errorEl.textContent = 'Type IMPORT to confirm the import.';
            errorEl.style.display = 'block';
        }
        return;
    }
    closeRiskyImportModal();
    const decrypted = pendingDecrypted;
    pendingDecrypted = null;
    pendingRiskyImport = false;
    await uploadImport(decrypted, false, false);
}

// Human-readable byte size (B / KB / MB).
function formatBytes(n) {
    if (n == null || isNaN(n)) return '—';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / (1024 * 1024)).toFixed(2) + ' MB';
}

// Render dry-run validation results in the results modal.
// allowImport=true shows the “Import this backup” button (validate-first flow).
// uploadsData is the optional /api/admin/import-uploads?dry_run=1 response.
function showImportResults(data, allowImport, uploadsData) {
    const summary = document.getElementById('import-results-summary');
    const errorsEl = document.getElementById('import-results-errors');
    const body = document.getElementById('import-results-body');
    const fkViolations = (data.foreign_key_violations || []);
    const tableCount = (data.tables || []).length;
    const totalRows = (data.tables || []).reduce((sum, t) => sum + (t.count || 0), 0);
    const totalBytes = data.total_size_bytes != null ? data.total_size_bytes :
        (data.tables || []).reduce((sum, t) => sum + (t.size_bytes || 0), 0) || null;

    let summaryText = (data.integrity_ok ? icon('check') + ' Integrity check passed' : icon('warning') + ' Integrity check found problems') +
        ' · ' + tableCount + ' tables · ' + totalRows + ' rows · ' + formatBytes(totalBytes) + ' total';
    if (uploadsData) {
        const missing = uploadsData.missing_rows || 0;
        const upOk = uploadsData.ok && missing === 0;
        summaryText += ' · Uploaded files: ' + (uploadsData.files || 0) + ' (' + formatBytes(uploadsData.bytes || 0) + ')' +
            (missing > 0 ? ' · ' + icon('warning') + ' ' + missing + ' file(s) have no DB row (would be swept)' : '');
        if (!upOk) summary.style.color = '#faa61a';
    }
    summary.textContent = summaryText;
    summary.style.color = (data.integrity_ok && (!uploadsData || (uploadsData.ok && (uploadsData.missing_rows || 0) === 0))) ? 'var(--text-primary)' : '#faa61a';

    // The validate-first import is “risky” when the backup failed checks or
    // the uploads bundle references files with no DB row (they'd be swept).
    pendingRiskyImport = allowImport && (!data.integrity_ok || fkViolations.length > 0 ||
        (uploadsData && (!uploadsData.ok || (uploadsData.missing_rows || 0) > 0)));

    if (data.integrity_ok && fkViolations.length === 0) {
        errorsEl.style.display = 'none';
    } else {
        const lines = [];
        if (!data.integrity_ok) lines.push('Integrity check failed:\n' + (data.integrity || []).join('\n'));
        fkViolations.forEach(v => lines.push('Foreign-key violation: ' + v));
        errorsEl.textContent = lines.join('\n');
        errorsEl.style.display = 'block';
    }

    body.innerHTML = (data.tables || []).map(t =>
        '<tr data-import-preview="' + escapeHtml(t.name) + '"><td>' + escapeHtml(t.name) + '</td><td>' + t.count + '</td><td>' +
        formatBytes(t.size_bytes) + '</td></tr>'
    ).join('') || '<tr><td colspan="3" class="empty-state">No tables found</td></tr>';

    const importBtn = document.getElementById('import-from-results');
    if (importBtn) importBtn.style.display = allowImport ? '' : 'none';

    // Each table row is clickable → preview its columns + rows.
    body.querySelectorAll('tr[data-import-preview]').forEach(tr => {
        tr.style.cursor = 'pointer';
        tr.title = 'Click to preview rows';
        tr.addEventListener('click', () => openImportPreview(tr.getAttribute('data-import-preview')));
    });

    document.getElementById('import-results-modal').style.display = 'flex';
}

// Preview one table's columns + rows from the staged backup (dry run, read-only).
async function openImportPreview(table) {
    if (!pendingDecrypted) {
        alert('Preview failed: no decrypted data available.');
        return;
    }
    const titleEl = document.getElementById('import-preview-title');
    const subEl = document.getElementById('import-preview-sub');
    const headEl = document.getElementById('import-preview-head');
    const bodyEl = document.getElementById('import-preview-body');
    if (titleEl) titleEl.textContent = table;
    if (subEl) subEl.textContent = 'Loading…';
    document.getElementById('import-preview-modal').style.display = 'flex';

    try {
        const adminToken = sessionStorage.getItem('admin_token') || '';
        const { dbBytes } = unpackBackup(pendingDecrypted);
        const res = await fetch('/api/admin/import-db?dry_run=1&table=' + encodeURIComponent(table), {
            method: 'POST',
            headers: {
                'Authorization': 'Bearer ' + adminToken,
                'Content-Type': 'application/octet-stream'
            },
            body: dbBytes
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Preview failed');
        const cols = data.columns || [];
        const rows = data.rows || [];
        if (subEl) subEl.textContent = rows.length + ' rows (latest 100) · ' + cols.length + ' columns';
        if (headEl) headEl.innerHTML = '<tr>' + cols.map(c => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr>';
        if (rows.length === 0) {
            if (bodyEl) bodyEl.innerHTML = '<tr><td colspan="' + Math.max(1, cols.length) + '" class="empty-state">No rows.</td></tr>';
            return;
        }
        if (bodyEl) {
            bodyEl.innerHTML = rows.map(r =>
                '<tr>' + r.map((v, i) => {
                    const col = cols[i] || '';
                    const isId = /_id$|^id$|key|nonce|salt|token|hash|blob|payload|cipher/i.test(col);
                    const cls = isId ? 'id-cell' : 'blob-cell';
                    const txt = v === null ? '<i style="color:#777">NULL</i>' : String(v);
                    const long = txt.length > 60;
                    return '<td class="' + cls + '"' + (long ? ' title="' + escapeHtml(txt) + '"' : '') + '>' +
                        (long ? escapeHtml(truncate(txt, 60)) : escapeHtml(txt)) + '</td>';
                }).join('') + '</tr>'
            ).join('');
        }
    } catch (err) {
        if (bodyEl) bodyEl.innerHTML = '<tr><td class="empty-state" style="color:#ed4245">Failed: ' + escapeHtml(err.message) + '</td></tr>';
        if (subEl) subEl.textContent = '';
    }
}

// --- Raw Tables (generic browser over every DB table) ---
let rawTablesCache = null;
async function loadRawTables() {
    const listEl = document.getElementById('raw-tables-list');
    const countEl = document.getElementById('raw-tables-count');
    try {
        const rows = await apiFetch('/api/admin/tables');
        rawTablesCache = rows;
        if (countEl) countEl.textContent = rows.length + ' tables';
        renderRawTablesList();
    } catch (err) {
        if (listEl) listEl.innerHTML = '<span style="color:#ed4245">Failed to load tables: ' + escapeHtml(err.message) + '</span>';
    }
}
function renderRawTablesList() {
    const listEl = document.getElementById('raw-tables-list');
    if (!listEl) return;
    const q = (document.getElementById('search-raw-tables').value || '').toLowerCase();
    const rows = rawTablesCache || [];
    const filtered = rows.filter(t => !q || t.name.toLowerCase().includes(q) || String(t.count).includes(q));
    listEl.innerHTML = filtered.map(t =>
        '<button type="button" class="tab-btn" data-raw-table="' + escapeHtml(t.name) + '" style="font-size:12px;padding:6px 12px;border:1px solid #444;">' +
        escapeHtml(t.name) + ' <span style="color:#999">(' + t.count + ')</span></button>'
    ).join('') || '<span style="color:var(--text-muted)">No tables match.</span>';
    listEl.querySelectorAll('[data-raw-table]').forEach(btn => {
        btn.addEventListener('click', () => openRawTable(btn.getAttribute('data-raw-table')));
    });
}
function filterRawTables() { renderRawTablesList(); }
async function openRawTable(name) {
    const titleEl = document.getElementById('raw-table-title');
    const countEl = document.getElementById('raw-table-rows-count');
    const headEl = document.getElementById('raw-table-head');
    const bodyEl = document.getElementById('raw-table-body');
    if (titleEl) titleEl.textContent = name;
    if (countEl) countEl.textContent = 'Loading…';
    try {
        const data = await apiFetch('/api/admin/table/' + encodeURIComponent(name));
        const cols = data.columns || [];
        const rows = data.rows || [];
        if (countEl) countEl.textContent = rows.length + ' rows (latest 1000)';
        if (headEl) headEl.innerHTML = '<tr>' + cols.map(c => '<th>' + escapeHtml(c) + '</th>').join('') + '</tr>';
        if (rows.length === 0) {
            if (bodyEl) bodyEl.innerHTML = '<tr><td colspan="' + cols.length + '" class="empty-state">No rows.</td></tr>';
            return;
        }
        if (bodyEl) {
            bodyEl.innerHTML = rows.map(r =>
                '<tr>' + r.map((v, i) => {
                    const col = cols[i] || '';
                    const isId = /_id$|^id$|key|nonce|salt|token|hash|blob|payload|cipher/i.test(col);
                    const cls = isId ? 'id-cell' : 'blob-cell';
                    const txt = v === null ? '<i style="color:#777">NULL</i>' : String(v);
                    const long = txt.length > 60;
                    return '<td class="' + cls + '"' + (long ? ' title="' + escapeHtml(txt) + '"' : '') + '>' +
                        (long ? escapeHtml(truncate(txt, 60)) : escapeHtml(txt)) + '</td>';
                }).join('') + '</tr>'
            ).join('');
        }
    } catch (err) {
        if (bodyEl) bodyEl.innerHTML = '<tr><td class="empty-state" style="color:#ed4245">Failed: ' + escapeHtml(err.message) + '</td></tr>';
        if (countEl) countEl.textContent = '';
    }
}

// --- Audit Log (G4) ---
async function loadAuditLog() { await loadTabData("/api/admin/audit-log", "auditLog", renderAuditLog); }

function renderAuditLog(rows) {
    tabTotals['audit-log'] = rows.length;
    const p = paginate(rows, 'audit-log');
    updateCount('audit-log-count', p.total);
    renderTable('audit-log-list', 5,
        p.items.map(a =>
            '<td class="ts-cell">' + escapeHtml(a.timestamp || '') + '</td>' +
            '<td>' + escapeHtml(a.actor || '') + '</td>' +
            '<td>' + escapeHtml(a.action || '') + '</td>' +
            '<td class="id-cell" title="' + escapeHtml(a.target || '') + '">' + escapeHtml(truncate(a.target || '', 24)) + '</td>' +
            '<td>' + escapeHtml(a.ip || '') + '</td>'
        ),
        'No admin actions logged yet');
    renderPaginationControls('audit-log');
}
