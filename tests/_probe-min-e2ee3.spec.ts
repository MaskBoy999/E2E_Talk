import { test, expect } from '@playwright/test';

// Definitive: which transforms ACTUALLY run in a minimal 2-peer E2EE call
// (real worker, connected, audio flowing). Chrome's autoplay policy suspends
// AudioContext created without a gesture — we resume it via a click so audio
// really flows, then measure both directions' enc/dec via worker counters.
const COUNTER_WORKER = `
let enc = 0, dec = 0, encA = 0, decA = 0;
addEventListener('rtctransform', (e) => {
    const t = e.transformer;
    const op = t.options ? t.options.operation : '?';
    const reader = t.readable.getReader();
    const writer = t.writable.getWriter();
    (async () => {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (op === 'encrypt') { enc++; encA++; }
            else { dec++; decA++; }
            await writer.write(value);
        }
    })();
});
setInterval(() => { self.postMessage({ type: 'c', enc, dec, encA, decA }); }, 500);
`;

test('minimal 2-peer: measure which direction transforms run', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto('https://127.0.0.1:3443/login.html');
    await pageB.goto('https://127.0.0.1:3443/login.html');
    await pageA.waitForSelector('#show-register');
    await pageB.waitForSelector('#show-register');

    for (const page of [pageA, pageB]) {
        await page.evaluate((code) => {
            const blob = new Blob([code], { type: 'application/javascript' });
            (window as any).__e2eeWorker = new Worker(URL.createObjectURL(blob));
            const ac = new AudioContext();
            (window as any).__ac = ac;
            const osc = ac.createOscillator();
            osc.frequency.value = 440;
            const dest = ac.createMediaStreamDestination();
            osc.connect(dest);
            osc.start();
            (window as any).__osc = osc;
            (window as any).__micStream = dest.stream;
            (window as any).__counters = { enc: 0, dec: 0 };
            (window as any).__e2eeWorker.onmessage = (m: any) => { if (m.data && m.data.type === 'c') (window as any).__counters = m.data; };
        }, COUNTER_WORKER);
        // Resume the AudioContext via a real click (autoplay policy)
        await page.click('#show-register');
        await page.evaluate(() => { (window as any).__ac.resume().catch(() => {}); });
    }

    // A offers with sender.transform set before createOffer
    const aSetup = await pageA.evaluate(async () => {
        const w = (window as any).__e2eeWorker;
        const pc = new RTCPeerConnection({ iceServers: [] });
        (window as any).__pcA = pc;
        const sender = pc.addTrack((window as any).__micStream.getAudioTracks()[0], (window as any).__micStream);
        sender.transform = new RTCRtpScriptTransform(w, { operation: 'encrypt', key: 'k' });
        await new Promise((r) => setTimeout(r, 400));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise((resolve) => {
            pc.onicecandidate = (e: any) => { if (!e.candidate) resolve(null); };
            setTimeout(resolve, 1500);
        });
        return { sdp: pc.localDescription!.sdp };
    });

    // B answers, sets sender.transform BEFORE createAnswer, receiver at ontrack
    const bSetup = await pageB.evaluate(async (offer) => {
        const w = (window as any).__e2eeWorker;
        const pc = new RTCPeerConnection({ iceServers: [] });
        (window as any).__pcB = pc;
        const sender = pc.addTrack((window as any).__micStream.getAudioTracks()[0], (window as any).__micStream);
        sender.transform = new RTCRtpScriptTransform(w, { operation: 'encrypt', key: 'k' });
        pc.ontrack = (e: any) => {
            try { e.receiver.transform = new RTCRtpScriptTransform(w, { operation: 'decrypt', key: 'k' }); } catch (_) {}
        };
        await pc.setRemoteDescription({ type: 'offer', sdp: offer });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await new Promise((resolve) => {
            pc.onicecandidate = (e: any) => { if (!e.candidate) resolve(null); };
            setTimeout(resolve, 1500);
        });
        return { sdp: pc.localDescription!.sdp };
    }, aSetup.sdp);

    // A applies the answer, receiver transform at ontrack
    await pageA.evaluate(async (ans) => {
        const pc = (window as any).__pcA;
        pc.ontrack = (e: any) => {
            try { e.receiver.transform = new RTCRtpScriptTransform((window as any).__e2eeWorker, { operation: 'decrypt', key: 'k' }); } catch (_) {}
        };
        await pc.setRemoteDescription({ type: 'answer', sdp: ans });
    }, bSetup.sdp);

    await pageA.waitForFunction(() => (window as any).__pcA && (window as any).__pcA.connectionState === 'connected', undefined, { timeout: 15000 });
    await pageB.waitForFunction(() => (window as any).__pcB && (window as any).__pcB.connectionState === 'connected', undefined, { timeout: 15000 });
    await pageA.waitForTimeout(4000);

    const cA = await pageA.evaluate(() => (window as any).__counters);
    const cB = await pageB.evaluate(() => (window as any).__counters);
    console.log('=====DIRECTION COUNTERS=====');
    console.log('A worker (initiator):', JSON.stringify(cA));
    console.log('B worker (acceptor):', JSON.stringify(cB));
    console.log('Interpretation: A.enc runs = A→B encrypted; B.dec runs = A→B decrypted. B.enc runs = B→A encrypted; A.dec runs = B→A decrypted.');

    // Real SDP extmap check
    const sdpA = await pageA.evaluate(() => (window as any).__pcA.localDescription!.sdp);
    const sdpB = await pageB.evaluate(() => (window as any).__pcB.localDescription!.sdp);
    console.log('A sdp hasEncrypt:', sdpA.includes('encrypt'), '| B sdp hasEncrypt:', sdpB.includes('encrypt'));

    expect(true).toBe(true);
});
