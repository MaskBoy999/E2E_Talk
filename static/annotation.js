// =====================================================================
// annotation.js — Screen Share Annotation Overlay
//
// Lets participants draw on top of remote screen shares. Annotations are
// ephemeral (not saved) and broadcast in real-time via the existing voice
// WebSocket. The screen sharer can disable annotation per-user.
// =====================================================================
(function () {
    'use strict';

    var _annotationEnabled = false;   // Is annotation mode active for this viewer?
    var _annotationPenActive = false;  // Is the user currently drawing?
    var _annotationColor = '#ff0000';  // Drawing color
    var _annotationSize = 3;           // Line width
    var _annotationTool = 'pen';       // 'pen' or 'eraser'
    var _annotationCanvases = {};      // uid -> canvas element
    var _annotationDisableMap = {};    // uid -> true (sharer disabled annotation for this user)
    var _currentPath = null;           // Current stroke being drawn
    var _annotationOverlay = {};       // uid -> {canvas, ctx, paths:[]}

    // Expose to voice.js and chat.js
    window.ScreenAnnotation = {
        init: init,
        toggleAnnotationMode: toggleAnnotationMode,
        isActive: function () { return _annotationEnabled; },
        isDisabledFor: function (uid) { return !!_annotationDisableMap[uid]; },
        setDisabledFor: function (uid, disabled) {
            if (disabled) _annotationDisableMap[uid] = true;
            else delete _annotationDisableMap[uid];
        },
        clearCanvas: clearCanvas,
        clearAll: clearAll,
        setColor: function (c) { _annotationColor = c; },
        setSize: function (s) { _annotationSize = s; },
        setTool: function (t) { _annotationTool = t; },
        getTool: function () { return _annotationTool; },
        getColor: function () { return _annotationColor; },
        getSize: function () { return _annotationSize; },
        renderOverlay: renderOverlayForVideo,
        sendAnnotation: sendAnnotationData,
        handleAnnotation: handleAnnotationData,
        handleClear: handleClearData,
        handleDisabled: handleDisabledData,
        sendDisable: sendDisableData,
        cleanup: cleanup,
    };

    function init() {
        // Nothing special needed — overlays are created on demand
    }

    // Toggle annotation mode on/off for the viewer
    function toggleAnnotationMode() {
        _annotationEnabled = !_annotationEnabled;
        // Update all existing screen overlays
        document.querySelectorAll('.remote-video-tile[data-kind="screen"]').forEach(function (video) {
            var uid = video.dataset.uid;
            if (uid && uid !== getSelfId()) {
                if (_annotationEnabled) {
                    renderOverlayForVideo(video, uid);
                } else {
                    removeOverlayForUid(uid);
                }
            }
        });
        return _annotationEnabled;
    }

    // Full cleanup: disable mode, clear all annotations, remove all overlays.
    // Called on fullscreen exit, screenshare unload, or annotation close.
    function cleanup() {
        if (_annotationPenActive && _currentPath) {
            _annotationPenActive = false;
            _currentPath = null;
        }
        if (_annotationEnabled) {
            _annotationEnabled = false;
            clearAll();
        }
        Object.keys(_annotationCanvases).forEach(function (uid) {
            removeOverlayForUid(uid);
        });
        _annotationTool = 'pen';
        _annotationColor = '#ff0000';
        _annotationSize = 3;
        // Remove any toolbar the voice.js may have injected
        var tb = document.querySelector('.annotation-toolbar');
        if (tb) tb.remove();
        var ab = document.querySelector('.annotation-activate-btn');
        if (ab) ab.remove();
    }

    // Render (or update) the annotation canvas overlay on top of a screen video
    function renderOverlayForVideo(video, uid) {
        if (!video || !uid) return;
        // Don't annotate self
        if (uid === getSelfId()) return;
        // Don't create overlay if annotation is disabled for this user
        if (_annotationDisableMap[uid]) {
            removeOverlayForUid(uid);
            return;
        }
        if (!_annotationEnabled) {
            removeOverlayForUid(uid);
            return;
        }

        // Create or reuse canvas — always append to document.body with
        // position:fixed so it paints ABOVE the fullscreen flex wrapper
        // (flex children with transforms create stacking contexts that
        // defeat z-index on sibling absolute elements).
        var canvas = _annotationCanvases[uid];
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.className = 'annotation-overlay';
            canvas.dataset.uid = uid;
            // Fixed overlay covers the whole viewport; z-index above everything
            canvas.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:999999;cursor:crosshair;pointer-events:auto;display:block;';
            document.body.appendChild(canvas);
            _annotationCanvases[uid] = canvas;
            _annotationOverlay[uid] = { canvas: canvas, ctx: canvas.getContext('2d'), paths: [] };
        }

        // Size the canvas pixel buffer to match the video display area
        function resizeCanvas() {
            if (!canvas || !video) return;
            var w = video.clientWidth || video.videoWidth || window.innerWidth || 640;
            var h = video.clientHeight || video.videoHeight || window.innerHeight || 360;
            // Only resize (which clears the buffer) when dimensions actually change
            if (w > 0 && h > 0 && (canvas.width !== w || canvas.height !== h)) {
                canvas.width = w;
                canvas.height = h;
            }
            redrawCanvas(uid);
        }
        resizeCanvas();
        // Resize observer for dynamic resizing
        if (window.ResizeObserver && !canvas._resizeObs) {
            canvas._resizeObs = new ResizeObserver(resizeCanvas);
            canvas._resizeObs.observe(video);
        }

        // Position the canvas to exactly overlay the video element
        function positionCanvas() {
            if (!canvas || !video) return;
            var r = video.getBoundingClientRect();
            canvas.style.position = 'fixed';
            canvas.style.left = r.left + 'px';
            canvas.style.top = r.top + 'px';
            canvas.style.width = r.width + 'px';
            canvas.style.height = r.height + 'px';
        }
        positionCanvas();
        if (window.ResizeObserver && !canvas._posObs) {
            canvas._posObs = new ResizeObserver(positionCanvas);
            canvas._posObs.observe(video);
        }

        // Enable pointer events and draw handlers
        canvas.style.pointerEvents = 'auto';
        _setupDrawHandlers(canvas, uid);
    }

    function removeOverlayForUid(uid) {
        var canvas = _annotationCanvases[uid];
        if (canvas) {
            if (canvas._resizeObs) canvas._resizeObs.disconnect();
            if (canvas._posObs) canvas._posObs.disconnect();
            canvas.remove();
            delete _annotationCanvases[uid];
            delete _annotationOverlay[uid];
        }
    }

    function _setupDrawHandlers(canvas, uid) {
        if (canvas._drawHandlersAttached) return;
        canvas._drawHandlersAttached = true;

        function getPos(e) {
            var rect = canvas.getBoundingClientRect();
            var x = (e.clientX - rect.left) / rect.width;
            var y = (e.clientY - rect.top) / rect.height;
            return { x: x, y: y };
        }

        canvas.addEventListener('mousedown', function (e) {
            if (!_annotationEnabled) return;
            // Temporarily hide canvas to find what's underneath
            canvas.style.pointerEvents = 'none';
            var underEl = document.elementFromPoint(e.clientX, e.clientY);
            canvas.style.pointerEvents = 'auto';
            // If click is on toolbar / activate button, let it through
            if (underEl && underEl.closest && (underEl.closest('.annotation-toolbar') || underEl.closest('.annotation-activate-btn'))) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            _annotationPenActive = true;
            var pos = getPos(e);
            _currentPath = {
                points: [pos],
                color: _annotationTool === 'eraser' ? 'eraser' : _annotationColor,
                size: _annotationTool === 'eraser' ? _annotationSize * 5 : _annotationSize,
                tool: _annotationTool,
            };
        });

        canvas.addEventListener('mousemove', function (e) {
            if (!_annotationPenActive || !_currentPath) return;
            e.preventDefault();
            var pos = getPos(e);
            _currentPath.points.push(pos);
            // Draw the latest segment immediately for responsiveness
            var overlay = _annotationOverlay[uid];
            if (overlay) {
                var ctx = overlay.ctx;
                var pts = _currentPath.points;
                if (pts.length >= 2) {
                    var a = pts[pts.length - 2];
                    var b = pts[pts.length - 1];
                    var cw = canvas.width;
                    var ch = canvas.height;
                    if (_currentPath.tool === 'eraser') {
                        ctx.save();
                        ctx.globalCompositeOperation = 'destination-out';
                        ctx.beginPath();
                        ctx.moveTo(a.x * cw, a.y * ch);
                        ctx.lineTo(b.x * cw, b.y * ch);
                        ctx.lineWidth = _currentPath.size * 2;
                        ctx.lineCap = 'round';
                        ctx.stroke();
                        ctx.restore();
                    } else {
                        ctx.beginPath();
                        ctx.moveTo(a.x * cw, a.y * ch);
                        ctx.lineTo(b.x * cw, b.y * ch);
                        ctx.strokeStyle = _currentPath.color;
                        ctx.lineWidth = _currentPath.size;
                        ctx.lineCap = 'round';
                        ctx.stroke();
                    }
                }
            }
        });

        canvas.addEventListener('mouseup', function (e) {
            if (!_annotationPenActive || !_currentPath) return;
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
            _annotationPenActive = false;
            // Store the path
            var overlay = _annotationOverlay[uid];
            if (overlay) overlay.paths.push(_currentPath);
            // Broadcast to other participants
            sendAnnotationData(uid, _currentPath);
            _currentPath = null;
        });

        // Also block click so the video's click→fullscreen toggle doesn't fire
        canvas.addEventListener('click', function (e) {
            if (!_annotationEnabled) return;
            // Let toolbar clicks through
            canvas.style.pointerEvents = 'none';
            var underEl = document.elementFromPoint(e.clientX, e.clientY);
            canvas.style.pointerEvents = 'auto';
            if (underEl && underEl.closest && (underEl.closest('.annotation-toolbar') || underEl.closest('.annotation-activate-btn'))) {
                return;
            }
            e.preventDefault();
            e.stopPropagation();
            e.stopImmediatePropagation();
        });

        canvas.addEventListener('mouseleave', function (e) {
            if (_annotationPenActive && _currentPath) {
                // Finish the stroke
                var overlay = _annotationOverlay[uid];
                if (overlay) overlay.paths.push(_currentPath);
                sendAnnotationData(uid, _currentPath);
                _currentPath = null;
            }
            _annotationPenActive = false;
        });
    }

    // Redraw all stored paths on a canvas
    function redrawCanvas(uid) {
        var overlay = _annotationOverlay[uid];
        if (!overlay) return;
        var canvas = overlay.canvas;
        var ctx = overlay.ctx;
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        overlay.paths.forEach(function (path) {
            if (path.points.length < 2) {
                // Single dot
                if (path.tool === 'eraser') return;
                var p = path.points[0];
                ctx.beginPath();
                ctx.arc(p.x * canvas.width, p.y * canvas.height, path.size / 2, 0, Math.PI * 2);
                ctx.fillStyle = path.color;
                ctx.fill();
                return;
            }
            if (path.tool === 'eraser') {
                ctx.save();
                ctx.globalCompositeOperation = 'destination-out';
                ctx.lineWidth = path.size * 2;
                ctx.lineCap = 'round';
                for (var i = 1; i < path.points.length; i++) {
                    var a = path.points[i - 1];
                    var b = path.points[i];
                    ctx.beginPath();
                    ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
                    ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
                    ctx.stroke();
                }
                ctx.restore();
            } else {
                ctx.beginPath();
                ctx.strokeStyle = path.color;
                ctx.lineWidth = path.size;
                ctx.lineCap = 'round';
                var p0 = path.points[0];
                ctx.moveTo(p0.x * canvas.width, p0.y * canvas.height);
                for (var j = 1; j < path.points.length; j++) {
                    var p1 = path.points[j];
                    ctx.lineTo(p1.x * canvas.width, p1.y * canvas.height);
                }
                ctx.stroke();
            }
        });
    }

    // Clear annotation canvas for a specific user
    function clearCanvas(uid) {
        var overlay = _annotationOverlay[uid];
        if (overlay) {
            overlay.paths = [];
            var canvas = overlay.canvas;
            overlay.ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
        // Broadcast clear
        if (typeof ws !== 'undefined' && ws && ws.readyState === WebSocket.OPEN) {
            try {
                var msg = {
                    type: 'voice_annotation_clear',
                    target_uid: uid,
                };
                var room = _getRoomContext();
                if (room.room_type) msg.room_type = room.room_type;
                if (room.channel_id) msg.channel_id = room.channel_id;
                if (room.dm_channel_id) msg.dm_channel_id = room.dm_channel_id;
                ws.send(JSON.stringify(msg));
            } catch (_) {}
        }
    }

    // Clear all annotation canvases
    function clearAll() {
        Object.keys(_annotationOverlay).forEach(function (uid) {
            clearCanvas(uid);
        });
    }

    // Get room context from VoiceManager for annotation messages
    function _getRoomContext() {
        var ctx = {};
        if (typeof VoiceManager !== 'undefined' && VoiceManager.getRoomContext) {
            ctx = VoiceManager.getRoomContext() || {};
        }
        return ctx;
    }

    // Send annotation data over voice WebSocket
    function sendAnnotationData(targetUid, path) {
        if (typeof ws === 'undefined' || !ws || ws.readyState !== WebSocket.OPEN) return;
        try {
            // Downsample points to reduce bandwidth (keep every Nth point)
            var sampled = path.points;
            if (sampled.length > 50) {
                var step = Math.ceil(sampled.length / 50);
                var tmp = [sampled[0]];
                for (var i = step; i < sampled.length; i += step) tmp.push(sampled[i]);
                if (tmp[tmp.length - 1] !== sampled[sampled.length - 1]) tmp.push(sampled[sampled.length - 1]);
                sampled = tmp;
            }
            var msg = {
                type: 'voice_annotation',
                target_uid: targetUid,
                path: {
                    points: sampled,
                    color: path.color,
                    size: path.size,
                    tool: path.tool,
                },
            };
            var room = _getRoomContext();
            if (room.room_type) msg.room_type = room.room_type;
            if (room.channel_id) msg.channel_id = room.channel_id;
            if (room.dm_channel_id) msg.dm_channel_id = room.dm_channel_id;
            ws.send(JSON.stringify(msg));
        } catch (_) {}
    }

    // Handle incoming annotation data from other participants
    function handleAnnotationData(data) {
        var uid = data.sender_uid || data.from;
        var targetUid = data.target_uid;
        var path = data.path;
        if (!uid || !targetUid || !path || !path.points) return;
        // Find the video element for the target screen
        var video = document.querySelector('.remote-video-tile[data-uid="' + targetUid + '"][data-kind="screen"]');
        if (!video) return;
        // Ensure overlay exists
        if (!_annotationOverlay[targetUid]) {
            renderOverlayForVideo(video, targetUid);
        }
        var overlay = _annotationOverlay[targetUid];
        if (!overlay) return;
        overlay.paths.push(path);
        // Redraw
        redrawCanvas(targetUid);
    }

    // Handle clear annotation from other participants
    function handleClearData(data) {
        var targetUid = data.target_uid;
        if (!targetUid) return;
        var overlay = _annotationOverlay[targetUid];
        if (overlay) {
            overlay.paths = [];
            var canvas = overlay.canvas;
            overlay.ctx.clearRect(0, 0, canvas.width, canvas.height);
        }
    }

    // Handle annotation disabled/enabled notification from sharer
    function handleDisabledData(data) {
        var sharerUid = data.sharer_uid;
        var disabled = data.disabled;
        if (!sharerUid) return;
        _annotationDisableMap[sharerUid] = !!disabled;
        if (disabled) {
            // Remove overlay for this sharer's screen
            removeOverlayForUid(sharerUid);
            // Show toast
            if (typeof showToast === 'function') showToast('Annotation disabled by screen sharer');
        }
    }

    // Send annotation disable/enable to a specific user (sharer only)
    function sendDisableData(targetUserId, disabled) {
        if (typeof ws === 'undefined' || !ws || ws.readyState !== WebSocket.OPEN) return;
        try {
            var msg = {
                type: 'voice_annotation_disable',
                target_user_id: targetUserId,
                disabled: !!disabled,
            };
            var room = _getRoomContext();
            if (room.room_type) msg.room_type = room.room_type;
            if (room.channel_id) msg.channel_id = room.channel_id;
            if (room.dm_channel_id) msg.dm_channel_id = room.dm_channel_id;
            ws.send(JSON.stringify(msg));
        } catch (_) {}
    }

    // Helper: getSelfId (borrow from voice.js scope if available)
    function getSelfId() {
        try {
            if (typeof window.getSelfId === 'function') return window.getSelfId();
        } catch (_) {}
        try {
            var u = JSON.parse(localStorage.getItem('user') || '{}');
            return u.id || null;
        } catch (_) { return null; }
    }
})();
