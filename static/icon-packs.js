/**
 * Custom UI icons (F15, FEATURE_PLAN.md).
 *
 * Every icon in this app is a `<symbol id="icon-…">` in the sprite at the top of
 * index.html, drawn through the `icon(name)` helper (`<svg class="ui-icon">
 * <use href="#icon-copy"/></svg>`). There are no emoji stand-ins left — copy,
 * preview, download, pin, mic, the lot — so restyling the app means restyling
 * those symbols.
 *
 * This module lets one account replace them, in two server-side encrypted slots
 * (mirroring the custom-CSS slots, F14) that switch on demand:
 *
 *   - upload one SVG "icon pack" (any number of <symbol id="…"> / <g id="…">
 *     definitions) and every icon it names changes at once, or
 *   - click a single icon in the grid and upload one .svg/.png for just that
 *     one.
 *
 * Icons a pack does not define keep the built-in artwork, so a small pack that
 * tweaks three icons is a complete, valid slot.
 *
 * The map (icon name -> SVG markup) is encrypted with the account's identity key
 * before it is stored; the server only ever holds ciphertext and never sees the
 * artwork. Applying a pack mutates the sprite in place, so everything already on
 * screen — old and new messages alike — redraws with the pack.
 *
 * Settings tab is box-app only (like the Connection tab): a browser has no
 * business storing an icon set that only the desktop/mobile shell can apply.
 */
(function () {
    'use strict';

    // Largest ciphertext one slot may store. This is the SAME number (and the
    // same units — the encrypted string the server receives) as
    // MAX_ICON_SLOT_B64 in server/src/handlers.rs; when the two drifted, the
    // page's own limit was *larger* than the server's, so a pack could pass every
    // check here and still be rejected with a 413 that nothing looked at. The
    // result was "the icon is there until I switch slots, then it is gone".
    var MAX_SLOT_CIPHERTEXT = 4 * 1024 * 1024;
    var DEFAULT_GRID_ICON = 'file';
    var SVG_NS = 'http://www.w3.org/2000/svg';

    var _slots = null;          // last /api/user-icons/slots response
    var _defaults = {};         // name -> { inner, viewBox } of the built-in symbol
    var _applied = {};          // name -> markup currently in the sprite
    var _draft = null;          // working map while a slot is being edited
    var _draftSlot = 0;
    var _container = null;

    // ── sprite access ────────────────────────────────────────────────────

    /** Every icon name the app knows, straight from the sprite (source of truth). */
    function iconNames() {
        var out = [];
        document.querySelectorAll('symbol[id^="icon-"]').forEach(function (s) {
            var n = s.id.slice(5);
            if (out.indexOf(n) === -1) out.push(n);
        });
        return out;
    }

    function symbolFor(name) {
        return document.getElementById('icon-' + name);
    }

    function rememberDefault(name) {
        var sym = symbolFor(name);
        if (!sym || _defaults[name]) return;
        _defaults[name] = { inner: sym.innerHTML, viewBox: sym.getAttribute('viewBox') };
    }

    /** Put the built-in artwork back for one icon (or all of them). */
    function restore(name) {
        var names = name ? [name] : Object.keys(_defaults);
        names.forEach(function (n) {
            var sym = symbolFor(n);
            var d = _defaults[n];
            if (!sym || !d) return;
            sym.innerHTML = d.inner;
            if (d.viewBox) sym.setAttribute('viewBox', d.viewBox);
            delete _applied[n];
        });
    }

    // ── sanitising ───────────────────────────────────────────────────────
    // A pack is markup chosen by the user that ends up inside the app's own DOM,
    // so it is filtered before it is stored or applied: no scripts, no event
    // handlers, no foreignObject, no javascript: or remote URLs. Icons are
    // shapes — anything in that list is either an attack or a mistake.
    function sanitize(markup) {
        if (!markup) return '';
        var clean = String(markup)
            .replace(/<\s*script[\s\S]*?<\s*\/\s*script\s*>/gi, '')
            .replace(/<\s*script[^>]*\/?\s*>/gi, '')
            .replace(/<\s*foreignObject[\s\S]*?<\s*\/\s*foreignObject\s*>/gi, '')
            .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
            .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
            .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
            // href/xlink:href only survive for inline data: images (a PNG icon).
            .replace(/(xlink:href|href)\s*=\s*"(?!#|data:)[^"]*"/gi, '')
            .replace(/(xlink:href|href)\s*=\s*'(?!#|data:)[^']*'/gi, '')
            .replace(/javascript:/gi, '');
        return clean.trim();
    }

    // ── pack parsing ─────────────────────────────────────────────────────

    /**
     * Turn an uploaded SVG into { name: { inner, viewBox } }.
     * Accepts, in this order:
     *   - <symbol id="icon-copy">…</symbol>        (a sprite, the native shape)
     *   - <symbol id="copy">…</symbol>             (prefix optional)
     *   - top-level <g|path|circle… id="copy">     (an "icons.svg" of loose ids)
     */
    function parsePack(text) {
        var doc;
        try {
            doc = new DOMParser().parseFromString(text, 'image/svg+xml');
        } catch (_) {
            return { icons: {}, error: 'That file is not readable as SVG.' };
        }
        if (!doc || doc.getElementsByTagName('parsererror').length) {
            return { icons: {}, error: 'That file is not valid SVG.' };
        }
        var root = doc.documentElement;
        var rootViewBox = (root && root.getAttribute && root.getAttribute('viewBox')) || null;
        var icons = {};

        function add(rawId, markup, viewBox) {
            if (!rawId) return;
            var name = String(rawId).trim().replace(/^icon-/, '');
            if (!name || !/^[a-z0-9_-]+$/i.test(name)) return;
            var clean = sanitize(markup);
            if (!clean) return;
            icons[name] = { inner: clean, viewBox: viewBox || rootViewBox || null };
        }

        // 1. <symbol>s, wherever they are nested (symbols are the sprite shape).
        Array.prototype.forEach.call(doc.getElementsByTagName('symbol'), function (sym) {
            add(sym.getAttribute('id'), sym.innerHTML, sym.getAttribute('viewBox'));
        });
        // 2. Loose top-level children with an id (an "icons.svg" file).
        if (root) {
            Array.prototype.forEach.call(root.children, function (child) {
                if (child.tagName && child.tagName.toLowerCase() === 'symbol') return;
                var id = child.getAttribute && child.getAttribute('id');
                if (id) add(id, child.outerHTML, rootViewBox);
            });
        }
        // 3. <g id="…"> groups deeper in the tree.
        Array.prototype.forEach.call(doc.getElementsByTagName('g'), function (g) {
            var id = g.getAttribute('id');
            if (id && !icons[id.replace(/^icon-/, '')]) add(id, g.outerHTML, rootViewBox);
        });

        if (!Object.keys(icons).length) {
            return {
                icons: {},
                error: 'No named icons found. Give each shape an id (in a sprite: ' +
                    '<symbol id="copy">…</symbol>).',
            };
        }
        return { icons: icons };
    }

    // ── picture icons: moveable 1:1 crop ─────────────────────────────────
    //
    // A picture used as an icon is expressed as an SVG <image> over the ORIGINAL
    // bytes, with the symbol's viewBox set to the chosen square of the picture.
    // That is deliberate: rasterising the crop through a canvas would flatten an
    // animated GIF to its first frame, so the crop is geometry (viewBox), not
    // pixels, and the icon keeps whatever the file does — animation included.
    // Nothing is resampled to a fixed size either; the square IS the icon's
    // coordinate space, so the picture is never squashed to fit.

    /** Turn a picture + a square crop (natural pixels) into a pack entry. */
    function imageEntry(href, natW, natH, x, y, size) {
        x = Math.max(0, Math.min(Math.round(x), Math.max(0, natW - 1)));
        y = Math.max(0, Math.min(Math.round(y), Math.max(0, natH - 1)));
        size = Math.max(1, Math.min(Math.round(size), natW - x, natH - y));
        return {
            inner: '<image href="' + href + '" x="0" y="0" width="' + natW + '" height="' + natH + '" ' +
                'preserveAspectRatio="none"/>',
            viewBox: x + ' ' + y + ' ' + size + ' ' + size,
        };
    }

    /** Read a picture and open the crop step; cb receives an entry or null. */
    function openIconImageCrop(file, name, cb) {
        var reader = new FileReader();
        reader.onerror = function () { cb(null); };
        reader.onload = function () {
            var href = reader.result;
            var probe = new Image();
            probe.onerror = function () { cb(null); };
            probe.onload = function () {
                if (!probe.naturalWidth || !probe.naturalHeight) { cb(null); return; }
                buildCrop(href, probe.naturalWidth, probe.naturalHeight, name, cb);
            };
            probe.src = href;
        };
        reader.readAsDataURL(file);
    }

    /** The crop step itself: drag the square, drag its corner to resize. */
    function buildCrop(href, natW, natH, name, cb) {
        // Fit the picture into the dialog, allowing a modest upscale so a small
        // image is still comfortable to crop precisely.
        var maxW = Math.min(520, Math.max(200, window.innerWidth * 0.8));
        var maxH = Math.min(520, Math.max(200, window.innerHeight * 0.6));
        var scale = Math.min(maxW / natW, maxH / natH, 4);
        var dispW = Math.max(1, Math.round(natW * scale));
        var dispH = Math.max(1, Math.round(natH * scale));

        var root = el('div', 'position:fixed;inset:0;background:rgba(0,0,0,0.82);z-index:99999;' +
            'display:flex;align-items:center;justify-content:center;padding:18px;box-sizing:border-box');
        var panel = el('div', 'background:#12121f;border:1px solid #2a2a4a;border-radius:12px;padding:18px;' +
            'max-width:min(620px,96vw);max-height:96vh;overflow:auto;box-sizing:border-box;text-align:center');
        panel.appendChild(el('h4', 'margin:0 0 6px;color:var(--text-primary,#e6e6f0);font-size:15px',
            'Crop this icon to a square'));
        panel.appendChild(el('p', 'margin:0 0 12px;font-size:12px;line-height:1.45;color:var(--text-muted,#8a8aa0)',
            'Drag the square to choose the part to keep, and drag its corner to resize. The icon keeps exactly this ' +
            'square and the picture is never squashed or re-encoded — so an animated GIF stays animated.'));

        var frame = el('div', 'position:relative;display:inline-block;overflow:hidden;border-radius:8px;background:#111;line-height:0;' +
            'touch-action:none');
        frame.style.width = dispW + 'px';
        frame.style.height = dispH + 'px';
        var imgEl = document.createElement('img');
        imgEl.src = href;
        imgEl.draggable = false;
        imgEl.style.cssText = 'display:block;width:' + dispW + 'px;height:' + dispH + 'px;user-select:none;pointer-events:none';
        frame.appendChild(imgEl);

        var crop = el('div', 'position:absolute;box-sizing:border-box;border:2px solid #4fc3f7;' +
            'box-shadow:0 0 0 9999px rgba(0,0,0,0.5);cursor:move;touch-action:none');
        var handle = el('div', 'position:absolute;right:-7px;bottom:-7px;width:14px;height:14px;background:#4fc3f7;' +
            'border:1px solid #fff;border-radius:3px;cursor:nwse-resize;touch-action:none');
        crop.setAttribute('data-icon-crop-box', '');
        crop.appendChild(handle);
        frame.appendChild(crop);
        panel.appendChild(frame);

        var size = Math.max(16, Math.min(dispW, dispH));
        var left = Math.round((dispW - size) / 2);
        var top = Math.round((dispH - size) / 2);
        function place() {
            crop.style.left = left + 'px';
            crop.style.top = top + 'px';
            crop.style.width = size + 'px';
            crop.style.height = size + 'px';
        }
        place();

        var mode = null, sx = 0, sy = 0, sl = 0, st = 0, ss = 0;
        function down(which) {
            return function (ev) {
                mode = which;
                sx = ev.clientX; sy = ev.clientY;
                sl = left; st = top; ss = size;
                ev.preventDefault();
                ev.stopPropagation();
            };
        }
        function move(ev) {
            if (!mode) return;
            var dx = ev.clientX - sx;
            var dy = ev.clientY - sy;
            if (mode === 'move') {
                left = Math.max(0, Math.min(dispW - size, Math.round(sl + dx)));
                top = Math.max(0, Math.min(dispH - size, Math.round(st + dy)));
            } else {
                // One drag axis drives both edges so the box stays square.
                var maxSize = Math.min(dispW - left, dispH - top);
                size = Math.max(16, Math.min(maxSize, Math.round(ss + Math.max(dx, dy))));
            }
            place();
            ev.preventDefault();
        }
        function up() { mode = null; }
        crop.addEventListener('pointerdown', down('move'));
        handle.addEventListener('pointerdown', down('resize'));
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);

        var actions = el('div', 'display:flex;gap:8px;justify-content:flex-end;margin-top:14px');
        var cancel = el('button', BTN + 'border:1px solid #444;background:transparent;color:#bbb', 'Cancel');
        var apply = el('button', BTN + 'border:none;background:linear-gradient(135deg,#4fc3f7,#29b6f6);color:#fff', 'Use this square');
        root.setAttribute('data-icon-crop', '');
        cancel.setAttribute('data-icon-crop-cancel', '');
        apply.setAttribute('data-icon-crop-apply', '');
        actions.appendChild(cancel);
        actions.appendChild(apply);
        panel.appendChild(actions);
        root.appendChild(panel);
        document.body.appendChild(root);

        function close() {
            window.removeEventListener('pointermove', move);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            if (root.parentNode) root.parentNode.removeChild(root);
        }
        apply.addEventListener('click', function () {
            // Display pixels -> natural pixels (the inverse of the fit scale).
            var s = natW / dispW;
            close();
            cb(imageEntry(href, natW, natH, left * s, top * s, size * s));
        });
        cancel.addEventListener('click', function () { close(); cb(null); });
    }

    // ── applying ─────────────────────────────────────────────────────────

    /**
     * Apply a pack to the live sprite. Every icon the map does not mention is
     * restored to the built-in artwork first, so switching slots or clearing one
     * never leaves half of the previous pack behind.
     */
    function applyMap(map) {
        map = map || {};
        Object.keys(_applied).forEach(function (n) { if (!map[n]) restore(n); });
        iconNames().forEach(function (name) {
            var entry = map[name];
            if (!entry || !entry.inner) return;
            var sym = symbolFor(name);
            if (!sym) return;                        // a pack entry for an icon that no longer exists
            rememberDefault(name);
            sym.innerHTML = sanitize(entry.inner);
            if (entry.viewBox) sym.setAttribute('viewBox', entry.viewBox);
            _applied[name] = entry;
        });
        return Object.keys(_applied).length;
    }

    function resetToBuiltIn() {
        restore();
        return 0;
    }

    // ── encryption + server I/O (same scheme as the CSS slots) ───────────

    function encKey() {
        var kp = (window.E2ECrypto && E2ECrypto.getIdentityKeyPair) ? E2ECrypto.getIdentityKeyPair() : null;
        return kp ? kp.privateKey : null;
    }

    function encryptMap(map) {
        var json = JSON.stringify(map);
        var key = encKey();
        if (!key) throw new Error('No identity key — sign in again to store icon packs.');
        var out = E2ECrypto.aeadEncrypt(json, key);
        return { encrypted_icons: out.ciphertext, nonce: out.nonce };
    }

    function decryptMap(encrypted, nonce) {
        if (!encrypted) return {};
        var key = encKey();
        if (!key || !nonce) return {};
        var pt = E2ECrypto.aeadDecrypt(encrypted, key, nonce);
        var text = (typeof pt === 'string') ? pt : new TextDecoder().decode(pt);
        var parsed = JSON.parse(text);
        if (!parsed || typeof parsed !== 'object') return {};
        // Never trust a stored pack blindly: everything goes through sanitize on
        // the way into the DOM anyway, but drop junk shapes here too.
        var clean = {};
        Object.keys(parsed).forEach(function (k) {
            var e = parsed[k];
            if (e && typeof e.inner === 'string' && sanitize(e.inner)) {
                clean[k] = { inner: sanitize(e.inner), viewBox: e.viewBox || null };
            }
        });
        return clean;
    }

    function fetchSlots(force) {
        if (_slots && !force) return Promise.resolve(_slots);
        return authFetch('/api/user-icons/slots').then(function (r) { return r.json(); }).then(function (data) {
            _slots = data;
            return data;
        });
    }

    function slotMap(slot) {
        if (!_slots) return {};
        var s = slot === 1 ? _slots.slot1 : _slots.slot2;
        if (!s || !s.encrypted_icons) return {};
        try {
            return decryptMap(s.encrypted_icons, s.nonce);
        } catch (_) {
            return {};
        }
    }

    /** Human-readable size, for the messages a user has to act on. */
    function kb(bytes) {
        return Math.round(bytes / 1024) + ' KB';
    }

    /**
     * The server's own `{error: "…"}` text for a failed response, so the reason
     * shown is the reason that happened ("icon pack too large (6110 KiB; the
     * limit is 4096 KiB)") rather than a generic failure.
     */
    function httpError(r, what) {
        return r.json().then(function (body) {
            return (body && body.error) || '';
        }).catch(function () { return ''; }).then(function (detail) {
            throw new Error(detail || what + ' failed (HTTP ' + r.status + ')')
        });
    }

    /**
     * Store one slot's map, then make it active.
     *
     * Every failure is a rejection with a message that says what to do about it:
     * the previous revision fired this request and never looked at the response,
     * so a slot the server refused (413 above all) was reported as "Saved to slot
     * 1 and applied", the local draft was thrown away, and the icons vanished at
     * the next render — which for a picture icon is the next slot switch.
     */
    function saveSlot(slot, map) {
        return Promise.resolve().then(function () {
            var enc = encryptMap(map);
            if (enc.encrypted_icons.length > MAX_SLOT_CIPHERTEXT) {
                throw new Error('That pack is ' + kb(enc.encrypted_icons.length) + ' once encrypted, and one icon slot '
                    + 'can hold ' + kb(MAX_SLOT_CIPHERTEXT) + '. A picture icon is stored whole (so an animated one '
                    + 'keeps animating), which is what makes this big: crop the animation tighter, shorten it, or use '
                    + 'an .svg for that icon.');
            }
            return { enc: enc, bytes: enc.encrypted_icons.length };
        }).then(function (prepared) {
            return authFetch('/api/user-icons/slot/' + slot, {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(prepared.enc),
            }).then(function (r) {
                if (!r.ok) return httpError(r, 'Saving the pack');
                _slots = null;
                return setActive(slot).then(function () { return prepared.bytes; });
            });
        });
    }

    function clearSlot(slot) {
        return authFetch('/api/user-icons/slot/' + slot, { method: 'DELETE' }).then(function () {
            _slots = null;
        });
    }

    function setActive(slot) {
        return authFetch('/api/user-icons/active', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ active_slot: slot }),
        }).then(function (r) {
            _slots = null;
            if (!r.ok) return httpError(r, 'Switching icons');
            return r;
        });
    }

    // ── boot ─────────────────────────────────────────────────────────────

    /**
     * Load the account's active pack and apply it. Called after sign-in; a
     * failure here is never fatal to the app — the built-in icons stay on screen.
     */
    function init() {
        if (!window.authFetch || !window.E2ECrypto) return Promise.resolve(0);
        return fetchSlots().then(function (data) {
            var active = data && data.active_slot ? data.active_slot : 0;
            if (!active) { resetToBuiltIn(); return 0; }
            var map = slotMap(active);
            if (!Object.keys(map).length) { resetToBuiltIn(); return 0; }
            return applyMap(map);
        }).catch(function () { return 0; });
    }

    // ── settings tab ─────────────────────────────────────────────────────

    function el(tag, style, html) {
        var e = document.createElement(tag);
        if (style) e.style.cssText = style;
        if (html != null) e.innerHTML = html;
        return e;
    }

    var BTN = 'padding:8px 14px;border-radius:8px;font-size:13px;font-weight:600;cursor:pointer;';

    function renderTab(container) {
        _container = container;
        container.innerHTML = '<div style="text-align:center;padding:20px;color:var(--text-muted);font-size:13px">Loading icon packs…</div>';
        fetchSlots(true).then(function (data) {
            renderTabWith(container, data);
        }).catch(function () {
            container.innerHTML = '<div style="color:var(--danger,#ed4245);font-size:13px">Could not load icon packs.</div>';
        });
    }

    function renderTabWith(container, data) {
        var active = data.active_slot || 0;
        var count1 = Object.keys(slotMap(1)).length;
        var count2 = Object.keys(slotMap(2)).length;
        var editing = parseInt(localStorage.getItem('iconEditingSlot') || '0', 10);
        if (editing !== 1 && editing !== 2) editing = active === 1 || active === 2 ? active : 1;
        _draftSlot = editing;
        // The draft is what the grid edits; it starts from the slot's saved map.
        try {
            _draft = JSON.parse(localStorage.getItem('iconDraft_' + editing) || 'null') || null;
        } catch (_) { _draft = null; }
        if (!_draft) _draft = slotMap(editing);
        var names = iconNames();

        container.innerHTML = '';

        // ── slot selector ──
        var head = el('div', 'margin-bottom:14px');
        head.appendChild(el('h4', 'margin:0 0 4px;color:var(--text-primary)', 'Icon source'));
        head.appendChild(el('p', 'margin:0 0 10px;font-size:12px;color:var(--text-muted)',
            'Built-in icons, or one of your two encrypted icon packs. A pack only replaces the icons it ' +
            'defines — everything else keeps the built-in artwork. Packs are stored encrypted on your server.'));
        var row = el('div', 'display:flex;gap:8px;flex-wrap:wrap');
        var cards = [
            { id: 0, label: 'Built-in', desc: 'App default icons', colour: '#666' },
            { id: 1, label: 'Slot 1', desc: count1 ? count1 + ' custom icon(s)' : 'Empty slot', colour: '#4fc3f7' },
            { id: 2, label: 'Slot 2', desc: count2 ? count2 + ' custom icon(s)' : 'Empty slot', colour: '#7c4dff' },
        ];
        cards.forEach(function (c) {
            var isActive = active === c.id;
            var isEditing = editing === c.id;
            var card = el('div',
                'cursor:pointer;padding:10px 16px;border-radius:8px;min-width:120px;text-align:center;transition:all .2s;' +
                'border:2px solid ' + (isActive ? c.colour : (isEditing ? '#888' : '#333')) + ';' +
                'background:' + (isActive ? c.colour + '22' : '#1a1a2e') + ';' +
                'opacity:' + (!isActive && c.id > 0 && !(c.id === 1 ? count1 : count2) ? '0.55' : '1'));
            card.innerHTML = '<div style="color:' + (isActive ? c.colour : '#ccc') + ';font-weight:600;font-size:13px">' +
                window.escapeHtml(c.label) + (isActive ? ' ✓' : '') + '</div>' +
                '<div style="color:#888;font-size:10px">' + window.escapeHtml(c.desc) + '</div>';
            card.title = isActive ? 'Active — click to keep editing' : 'Click to activate and edit';
            card.addEventListener('click', function () {
                if (c.id === 0) {
                    // Built-in: activate it and drop any draft for the old slot.
                    localStorage.removeItem('iconEditingSlot');
                    localStorage.removeItem('iconDraft_1');
                    localStorage.removeItem('iconDraft_2');
                    resetToBuiltIn();
                    setActive(0).then(function () { renderTab(container); })
                        .catch(function (e) { note('Using the built-in icons here, but the server was not told: ' + e.message, true); });
                    return;
                }
                localStorage.setItem('iconEditingSlot', String(c.id));
                if (active !== c.id) {
                    // Switching slots applies that slot immediately (the CSS tab
                    // behaves the same way) — the draft survives for the other one.
                    var map = slotMap(c.id);
                    applyMap(map);
                    setActive(c.id).then(function () { renderTab(container); })
                        .catch(function (e) { note('Slot ' + c.id + ' is applied here, but the server was not told: ' + e.message, true); });
                } else {
                    renderTab(container);
                }
            });
            row.appendChild(card);
        });
        head.appendChild(row);
        container.appendChild(head);

        // ── actions ──
        var actions = el('div', 'display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px');
        var upload = el('button', BTN + 'border:none;background:linear-gradient(135deg,#4fc3f7,#29b6f6);color:#fff',
            icon('upload') + ' Upload icon pack (.svg)');
        var download = el('button', BTN + 'border:2px solid #7c4dff;background:rgba(124,77,255,0.1);color:#b388ff',
            icon('download') + ' Download pack');
        var save = el('button', BTN + 'border:none;background:linear-gradient(135deg,#4fc3f7,#29b6f6);color:#fff',
            icon('check') + ' Save &amp; apply to Slot ' + editing);
        var clear = el('button', BTN + 'border:2px solid #f44336;background:rgba(244,67,54,0.1);color:#f44336',
            icon('trash') + ' Clear Slot ' + editing);
        var reset = el('button', BTN + 'border:2px solid #888;background:rgba(255,255,255,0.05);color:#ccc',
            icon('reverse') + ' Discard changes');
        actions.appendChild(upload);
        actions.appendChild(save);
        actions.appendChild(download);
        actions.appendChild(clear);
        actions.appendChild(reset);
        container.appendChild(actions);

        var packInput = document.createElement('input');
        packInput.type = 'file';
        packInput.accept = '.svg,image/svg+xml';
        packInput.style.display = 'none';
        container.appendChild(packInput);
        var singleInput = document.createElement('input');
        singleInput.type = 'file';
        singleInput.accept = '.svg,image/svg+xml,image/png,image/webp,image/gif,image/jpeg';
        singleInput.style.display = 'none';
        container.appendChild(singleInput);

        var status = el('div', 'font-size:12px;color:var(--text-muted);margin:0 0 10px;min-height:16px');
        // An id, not a style-attribute selector: every async handler here re-renders
        // the tab, and writing to a detached node is how a successful-looking
        // message goes missing.
        status.id = 'icon-pack-status';
        container.appendChild(status);

        var hint = el('div', 'font-size:11px;color:var(--text-muted);margin:0 0 10px;line-height:1.45',
            'Click an icon and pick a picture (PNG, JPEG, WebP or an animated GIF) and you are asked to crop it to a ' +
            'square first; an animated GIF keeps animating. Or pick an .svg to replace just that icon.');
        container.appendChild(hint);

        var customCount = Object.keys(_draft).length;
        status.textContent = 'Slot ' + editing + ' draft: ' + customCount + ' of ' + names.length +
            ' icons customised' + (active === editing ? ' (live)' : ' (not active yet)') +
            '. Click an icon below to replace just that one.';
        if (_draftNotStored) {
            status.style.color = 'var(--danger,#ed4245)';
            status.textContent += ' This draft is too large to keep on this device between reloads —' +
                ' press "Save & apply" now to store it on the server.';
        }
        if (_flash) {
            status.style.color = _flash.error ? 'var(--danger,#ed4245)' : 'var(--accent,#4fc3f7)';
            status.textContent = _flash.msg;
            _flash = null;
        }

        /** Say something in the status line, whichever render is current. */
        function note(msg, isError) {
            var st = document.getElementById('icon-pack-status');
            if (!st) return;
            st.style.color = isError ? 'var(--danger,#ed4245)' : 'var(--accent,#4fc3f7)';
            st.textContent = msg;
        }

        // ── icon grid ──
        var grid = el('div', 'display:grid;grid-template-columns:repeat(auto-fill,minmax(84px,1fr));gap:8px');
        names.forEach(function (name) {
            var entry = _draft[name];
            var cell = el('div',
                'padding:8px 4px;border-radius:8px;text-align:center;cursor:pointer;border:1px solid ' +
                (entry ? '#4fc3f7' : 'var(--bg-border,#333)') + ';background:' +
                (entry ? 'rgba(79,195,247,0.08)' : 'var(--bg-secondary,#1a1a2e)'));
            cell.title = entry ? name + ' — customised (click to replace)' : name + ' — click to upload a replacement';
            cell.innerHTML = '<div style="height:24px">' + icon(name, 22) + '</div>' +
                '<div style="font-size:10px;color:#888;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' +
                window.escapeHtml(name) + '</div>' +
                (entry ? '<div style="font-size:9px;color:#4fc3f7">custom</div>'
                       : '<div style="font-size:9px;color:#555">built-in</div>');
            if (entry) {
                var x = el('button', 'margin-top:2px;font-size:9px;padding:0 4px;border-radius:4px;border:1px solid #555;' +
                    'background:transparent;color:#aaa;cursor:pointer', 'reset');
                x.title = 'Remove this override (back to the built-in icon)';
                x.addEventListener('click', function (ev) {
                    ev.stopPropagation();
                    delete _draft[name];
                    stashDraft();
                    renderTab(container);
                });
                cell.appendChild(x);
            }
            cell.addEventListener('click', function () {
                singleInput.dataset.iconName = name;
                singleInput.value = '';
                singleInput.click();
            });
            grid.appendChild(cell);
        });
        container.appendChild(grid);

        // ── wiring ──
        upload.addEventListener('click', function () { packInput.value = ''; packInput.click(); });

        packInput.addEventListener('change', function () {
            var file = packInput.files && packInput.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function () {
                var parsed = parsePack(reader.result);
                if (parsed.error) { status.style.color = 'var(--danger,#ed4245)'; status.textContent = parsed.error; return; }
                var known = iconNames();
                var added = 0, unknown = [];
                Object.keys(parsed.icons).forEach(function (name) {
                    if (known.indexOf(name) === -1) { unknown.push(name); return; }
                    _draft[name] = parsed.icons[name];
                    added++;
                });
                stashDraft();
                var msg = 'Pack loaded: ' + added + ' icon(s) will be replaced.';
                if (unknown.length) msg += ' Ignored (no such icon in this app): ' + unknown.slice(0, 6).join(', ') +
                    (unknown.length > 6 ? '…' : '') + '.';
                msg += ' Press "Save & apply" to store it.';
                flash(msg, !added);
                renderTab(container);
            };
            reader.onerror = function () { status.style.color = 'var(--danger,#ed4245)'; status.textContent = 'Could not read that file.'; };
            reader.readAsText(file);
        });

        singleInput.addEventListener('change', function () {
            var file = singleInput.files && singleInput.files[0];
            var name = singleInput.dataset.iconName;
            if (!file || !name) return;
            var isSvg = /svg/i.test(file.type) || /\.svg$/i.test(file.name);
            if (!isSvg) {
                // A picture gets the moveable 1:1 crop before it becomes an icon
                // (an SVG is already a shape and needs none).
                openIconImageCrop(file, name, function (entry) {
                    if (!entry) { status.textContent = 'Could not read that image.'; return; }
                    _draft[name] = entry;
                    stashDraft();
                    renderTab(container);
                });
                return;
            }
            var reader = new FileReader();
            reader.onload = function () {
                var parsed = parsePack(reader.result);
                if (parsed.error) { status.style.color = 'var(--danger,#ed4245)'; status.textContent = parsed.error; return; }
                // A one-icon file usually carries the name in its id; otherwise the
                // icon the user clicked wins, which is what they meant.
                var entry = parsed.icons[name] || parsed.icons[Object.keys(parsed.icons)[0]];
                if (!entry) { status.style.color = 'var(--danger,#ed4245)'; status.textContent = 'That SVG has no drawable content.'; return; }
                _draft[name] = entry;
                stashDraft();
                renderTab(container);
            };
            reader.readAsText(file);
        });

        save.addEventListener('click', function () {
            save.textContent = 'Saving…';
            save.disabled = true;
            // The draft is only discarded once the SERVER took it (the promise
            // resolves after `setActive` succeeded) — a failure keeps it in memory
            // and in localStorage so the icons are still there to fix and retry.
            saveSlot(editing, _draft).then(function (bytes) {
                localStorage.removeItem('iconDraft_' + editing);
                localStorage.setItem('iconEditingSlot', String(editing));
                applyMap(_draft);
                flash('Saved to slot ' + editing + ' and applied (' + kb(bytes) + ' encrypted).');
                renderTab(container);
            }).catch(function (e) {
                status.style.color = 'var(--danger,#ed4245)';
                status.textContent = 'Save failed: ' + (e && e.message ? e.message : 'unknown error');
                save.disabled = false;
                save.textContent = 'Save & apply to Slot ' + editing;
            });
        });

        clear.addEventListener('click', function () {
            clearSlot(editing).then(function () {
                localStorage.removeItem('iconDraft_' + editing);
                if ((_slots && _slots.active_slot) === editing || active === editing) {
                    setActive(0).catch(function () {});
                }
                _draft = {};
                resetToBuiltIn();
                renderTab(container);
            });
        });

        reset.addEventListener('click', function () {
            localStorage.removeItem('iconDraft_' + editing);
            _draft = slotMap(editing);
            renderTab(container);
        });

        download.addEventListener('click', function () {
            var parts = ['<svg xmlns="http://www.w3.org/2000/svg">'];
            Object.keys(_draft).forEach(function (n) {
                var e = _draft[n];
                parts.push('<symbol id="icon-' + n + '" viewBox="' + (e.viewBox || '0 0 24 24') + '">' + e.inner + '</symbol>');
            });
            parts.push('</svg>');
            var blob = new Blob([parts.join('\n')], { type: 'image/svg+xml' });
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url;
            a.download = 'e2e-chat-icons-slot' + editing + '.svg';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
        });

        // Live preview while editing: the grid above is drawn from the sprite, so
        // an unsaved draft is previewed as soon as it is built by applying it.
        if (editing === active) applyMap(_draft);
    }

    /**
     * A message for the status line of the *next* render.
     *
     * Needed because every handler here ends by re-rendering the tab, and that
     * render is asynchronous (`fetchSlots(true)`): writing straight to the status
     * element after calling `renderTab()` writes into a node that is about to be
     * thrown away, so a successful save announced itself and then showed the
     * draft line instead. The message is consumed by the render it belongs to.
     */
    var _flash = null;
    function flash(msg, isError) { _flash = { msg: msg, error: !!isError }; }

    /**
     * Keep the working map across tab re-renders and reloads.
     *
     * localStorage is a 5 MB budget and a picture icon is a whole base64 data
     * URL, so a big pack (or two of them, one per slot) can genuinely not fit —
     * and that used to be a silent `catch {}`, which reads exactly like "my icons
     * disappeared". The failure is now remembered and shown next to the grid,
     * where "press Save & apply now" is the fix.
     */
    var _draftNotStored = false;
    function stashDraft() {
        try {
            localStorage.setItem('iconDraft_' + _draftSlot, JSON.stringify(_draft));
            _draftNotStored = false;
            return true;
        } catch (_) {
            _draftNotStored = true;
            return false;
        }
    }

    // `icon()` lives in index.html and returns markup, not a node; the tab needs
    // nodes, so wrapping keeps the sprite as the single source of every icon.
    function icon(name, size) {
        var s = size || 16;
        return '<svg class="ui-icon" width="' + s + '" height="' + s + '" aria-hidden="true">' +
            '<use href="#icon-' + (symbolFor(name) ? name : DEFAULT_GRID_ICON) + '"/></svg>';
    }

    window.IconPacks = {
        init: init,
        renderTab: renderTab,
        applyMap: applyMap,
        resetToBuiltIn: resetToBuiltIn,
        parsePack: parsePack,
        sanitize: sanitize,
        iconNames: iconNames,
        applied: function () { return Object.keys(_applied); },
    };
})();
