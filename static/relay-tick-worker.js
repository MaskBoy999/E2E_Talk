// relay-tick-worker.js
// A tiny clock for the relay video loops.
//
// Chrome clamps setTimeout/setInterval on a HIDDEN page to ~1/s (and to
// 1/minute after the page has been backgrounded for a while), which used to
// collapse relayed video to 1 fps. Timer tasks inside a dedicated worker are
// not subject to that page-level clamp, and — unlike the MessageChannel
// busy-spin this replaces — the worker does not peg the main thread, so it
// cannot starve the audio relay.
//
// Message in:  { cmd: 'start', ms }  |  { cmd: 'stop' }
// Message out: 'tick'
var timer = null;

self.onmessage = function (e) {
    var data = e.data || {};
    if (data.cmd === 'start') {
        if (timer) clearInterval(timer);
        var ms = Math.max(5, data.ms || 25);
        timer = setInterval(function () { self.postMessage('tick'); }, ms);
    } else if (data.cmd === 'stop') {
        if (timer) clearInterval(timer);
        timer = null;
    }
};
