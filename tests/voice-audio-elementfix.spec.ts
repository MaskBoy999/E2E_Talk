import { test } from '@playwright/test';

// PROPOSED FIX VALIDATION: replace the app's AudioContext node chain for
// remote audio with per-member <audio> elements (volume = element.volume),
// while KEEPING a dead-end AudioContext analyser for local-mic speaking
// detection. Does remote audio still decode with both present?
// Fake device (loud tone) so decode is measurable.

const BASE = 'https://localhost:3443';

test.use({
    headless: false,
    launchOptions: {
        executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
        args: [
            '--use-fake-device-for-media-stream',
            '--use-fake-ui-for-media-stream',
            '--autoplay-policy=no-user-gesture-required',
        ],
    },
});

test('audio-element remote sink + analyser ctx for local mic', async ({ browser }) => {
    test.setTimeout(90000);
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto(`${BASE}/login.html`);

    const result = await page.evaluate(async () => {
        const AC = window.AudioContext || (window as any).webkitAudioContext;
        const pc1 = new RTCPeerConnection();
        const pc2 = new RTCPeerConnection();

        // App behavior: AudioContext created at PAGE INIT, before any mic.
        const side = new AC();

        const sendStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        pc1.addTrack(sendStream.getAudioTracks()[0], sendStream);

        // Local mic (receiver) + speaking-detection analyser in that context
        const recvMic = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        const analyser = side.createAnalyser();
        const s2 = side.createMediaStreamSource(recvMic);
        s2.connect(analyser); // dead end, like the app's speaking detection
        // poll it like the app does
        const buf = new Uint8Array(analyser.fftSize);
        const poll = setInterval(() => { try { analyser.getByteTimeDomainData(buf); } catch (_) {} }, 120);

        // Remote audio sink: <audio> element with volume (per-member volume)
        const audioEl = document.createElement('audio');
        audioEl.autoplay = true;
        audioEl.muted = false;
        audioEl.volume = 1; // per-member volume 100%
        document.body.appendChild(audioEl);
        pc2.ontrack = (e: any) => {
            if (e.track.kind !== 'audio') return;
            audioEl.srcObject = e.streams[0] || new MediaStream([e.track]);
            audioEl.play().catch(() => {});
        };
        pc2.onicecandidate = (e: any) => { if (e.candidate) pc1.addIceCandidate(e.candidate).catch(() => {}); };
        pc1.onicecandidate = (e: any) => { if (e.candidate) pc2.addIceCandidate(e.candidate).catch(() => {}); };

        const offer = await pc1.createOffer();
        await pc1.setLocalDescription(offer);
        await pc2.setRemoteDescription(offer);
        const answer = await pc2.createAnswer();
        await pc2.setLocalDescription(answer);
        await pc1.setRemoteDescription(answer);
        await new Promise((r) => setTimeout(r, 7000));
        clearInterval(poll);

        const stats: any = {};
        const report = await pc2.getStats();
        report.forEach((s: any) => {
            if (s.type === 'inbound-rtp' && s.kind === 'audio') {
                stats.samples = s.totalSamplesReceived;
                stats.packets = s.packetsReceived;
                stats.energy = s.totalAudioEnergy;
                stats.jitterEmitted = s.jitterBufferEmittedCount;
            }
        });
        return { ...stats, ctx: side.state, elVolume: audioEl.volume };
    });

    console.log('=====ELEMENT SINK + ANALYSER CTX=====\n' + JSON.stringify(result, null, 2));
});
