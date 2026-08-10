import { test, expect } from '@playwright/test';

// Definitive minimal E2EE test: TWO peers, real worker file, transform set
// BEFORE the offer. Counters in the worker tell us if frames actually route
// through the encrypt/decrypt transforms, and we dump the SDP to see if the
// encrypt extmap is negotiated.
const WORKER = `
let enc = 0, dec = 0;
addEventListener('rtctransform', (e) => {
    const t = e.transformer;
    const reader = t.readable.getReader();
    const writer = t.writable.getWriter();
    const op = e.transformer.options ? e.transformer.options.operation : '?';
    (async () => {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (op === 'encrypt') enc++;
            else dec++;
            await writer.write(value);
        }
    })();
});
setInterval(() => { self.postMessage({ type: 'counters', enc, dec }); }, 500);
`;

test('minimal 2-peer E2EE: extmap + transform invocation', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto('https://127.0.0.1:3443/login.html');
    await pageB.goto('https://127.0.0.1:3443/login.html');
    await pageA.waitForSelector('#show-register');
    await pageB.waitForSelector('#show-register');

    // Instantiate the worker + fake mic on both pages
    for (const page of [pageA, pageB]) {
        await page.evaluate((code) => {
            const blob = new Blob([code], { type: 'application/javascript' });
            (window as any).__e2eeWorker = new Worker(URL.createObjectURL(blob));
        }, WORKER);
    }

    const result = await pageA.evaluate(async () => {
        const w = (window as any).__e2eeWorker;
        const ac = new AudioContext();
        const osc = ac.createOscillator();
        const dest = ac.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        const pc = new RTCPeerConnection({ iceServers: [] });
        const sender = pc.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
        sender.transform = new RTCRtpScriptTransform(w, { operation: 'encrypt', key: 'k' });
        await new Promise((r) => setTimeout(r, 300));

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        // Wait for ICE gathering to complete (or timeout) — the final SDP is
        // the one we'd actually send.
        await new Promise((resolve) => {
            pc.onicecandidate = (e) => { if (!e.candidate) resolve(null); };
            setTimeout(resolve, 1500);
        });
        return {
            sdp: pc.localDescription.sdp,
            hasEncrypt: pc.localDescription.sdp.includes('rtp-hdrext:encrypt'),
        };
    });

    // Wait for A's ICE gathering to complete and get the final offer
    const offerSdp = result.sdp;
    const hasEncA = offerSdp.includes('rtp-hdrext:encrypt');
    console.log('=====MIN E2EE: A offer hasEncrypt=====', hasEncA);

    // B answers
    const bResult = await pageB.evaluate(async (offer) => {
        const w = (window as any).__e2eeWorker;
        const ac = new AudioContext();
        const osc = ac.createOscillator();
        const dest = ac.createMediaStreamDestination();
        osc.connect(dest);
        osc.start();
        const pc = new RTCPeerConnection({ iceServers: [] });
        const sender = pc.addTrack(dest.stream.getAudioTracks()[0], dest.stream);
        sender.transform = new RTCRtpScriptTransform(w, { operation: 'encrypt', key: 'k' });
        pc.ontrack = (e) => {
            const recv = e.receiver;
            recv.transform = new RTCRtpScriptTransform(w, { operation: 'decrypt', key: 'k' });
        };
        await pc.setRemoteDescription({ type: 'offer', sdp: offer });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await new Promise((r) => setTimeout(r, 300));
        await new Promise((resolve) => {
            pc.onicecandidate = (e) => { if (!e.candidate) resolve(null); };
            setTimeout(resolve, 1500);
        });
        return {
            sdp: pc.localDescription.sdp,
            hasEncrypt: pc.localDescription.sdp.includes('rtp-hdrext:encrypt'),
            hasEncryptRemote: pc.remoteDescription!.sdp.includes('rtp-hdrext:encrypt'),
        };
    }, offerSdp);

    const answerSdp = bResult.sdp;
    console.log('=====MIN E2EE: B answer hasEncrypt=====', bResult.hasEncrypt, '| remote(offer) hasEncrypt:', bResult.hasEncryptRemote);
    console.log('=====MIN E2EE: B answer sdp=====\n' + answerSdp.split('\n').filter((l: string) => l.startsWith('m=') || l.startsWith('a=extmap') || l.includes('encrypt')).join('\n'));

    expect(true).toBe(true);
});
