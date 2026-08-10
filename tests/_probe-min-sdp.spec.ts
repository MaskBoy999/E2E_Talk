import { test, expect } from '@playwright/test';

// Minimal probe: does Chrome include urn:ietf:params:rtp-hdrext:encrypt in the
// SDP when we set sender.transform / receiver.transform before createOffer on
// a FRESH peer connection (no app flow involved)?
test('minimal SDP: encrypt extmap with transform set before offer', async ({ browser }) => {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('https://127.0.0.1:3443/login.html');
    await page.waitForSelector('#show-register');

    const result = await page.evaluate(async () => {
        const out: any = {};
        // Simple worker inline via blob
        const workerCode = `
            onrtctransform = (e) => {
                const t = e.transformer;
                t.reader = t.readable.getReader();
                t.writer = t.writable.getWriter();
                (async () => {
                    while (true) {
                        const { done, value } = await t.reader.read();
                        if (done) break;
                        await t.writer.write(value);
                    }
                })();
            };
        `;
        const blob = new Blob([workerCode], { type: 'application/javascript' });
        const worker = new Worker(URL.createObjectURL(blob));

        const pc = new RTCPeerConnection();
        // Fake audio track
        const ctx2 = new AudioContext();
        const osc = ctx2.createOscillator();
        const dest = ctx2.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        const track = dest.stream.getAudioTracks()[0];
        const sender = pc.addTrack(track, dest.stream);

        sender.transform = new RTCRtpScriptTransform(worker, { operation: 'encrypt', key: 'test-key' });
        await new Promise((r) => setTimeout(r, 500)); // let the transform settle
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        out.sdp = pc.localDescription.sdp;
        out.hasEncrypt = out.sdp.includes('rtp-hdrext:encrypt');
        out.transformAttached = !!sender.transform;
        // also try setting a receiver transform
        const pc2 = new RTCPeerConnection();
        const recv = pc2.addTransceiver('audio', { direction: 'recvonly' });
        recv.receiver.transform = new RTCRtpScriptTransform(worker, { operation: 'decrypt', key: 'test-key' });
        await new Promise((r) => setTimeout(r, 500));
        const offer2 = await pc2.createOffer();
        await pc2.setLocalDescription(offer2);
        out.sdp2 = pc2.localDescription.sdp;
        out.hasEncrypt2 = out.sdp2.includes('rtp-hdrext:encrypt');

        osc.stop();
        return out;
    });

    console.log('=====MINIMAL=====');
    console.log('sender offer hasEncrypt:', result.hasEncrypt, '| transform attached:', result.transformAttached);
    console.log('recvonly offer hasEncrypt:', result.hasEncrypt2);
    if (result.hasEncrypt) {
        const line = result.sdp.split('\n').find((l: string) => l.includes('encrypt'));
        console.log('encrypt line (sender):', line);
    }
    if (result.hasEncrypt2) {
        const line2 = result.sdp2.split('\n').find((l: string) => l.includes('encrypt'));
        console.log('encrypt line (recvonly):', line2);
    }
    console.log('=====END=====');
    expect(true).toBe(true);
});
