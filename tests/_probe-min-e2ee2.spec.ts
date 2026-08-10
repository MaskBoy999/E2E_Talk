import { test, expect } from '@playwright/test';

// Definitive minimal E2EE test with the REAL worker file and a REAL connected
// 2-peer call (not just offers). Counters + SDP from both sides.
test('minimal real-worker 2-peer E2EE: does the encrypt extmap appear, and do transforms run both ways?', async ({ browser }) => {
    const ctxA = await browser.newContext();
    const ctxB = await browser.newContext();
    const pageA = await ctxA.newPage();
    const pageB = await ctxB.newPage();
    await pageA.goto('https://127.0.0.1:3443/login.html');
    await pageB.goto('https://127.0.0.1:3443/login.html');
    await pageA.waitForSelector('#show-register');
    await pageB.waitForSelector('#show-register');

    // Load the real worker on both pages, and a fake mic.
    for (const page of [pageA, pageB]) {
        await page.evaluate(async () => {
            (window as any).__e2eeWorker = new Worker('/e2ee-worker.js');
            const ac = new AudioContext();
            const osc = ac.createOscillator();
            osc.frequency.value = 440;
            const dest = ac.createMediaStreamDestination();
            osc.connect(dest);
            osc.start();
            (window as any).__osc = osc;
            (window as any).__micStream = dest.stream;
            await new Promise((r) => setTimeout(r, 300));
        });
    }

    // A creates peer + offer with sender transform set before createOffer
    const aSetup = await pageA.evaluate(async () => {
        const w = (window as any).__e2eeWorker;
        const pc = new RTCPeerConnection({ iceServers: [] });
        (window as any).__pcA = pc;
        const sender = pc.addTrack((window as any).__micStream.getAudioTracks()[0], (window as any).__micStream);
        sender.transform = new RTCRtpScriptTransform(w, { operation: 'encrypt', key: 'test-key' });
        await new Promise((r) => setTimeout(r, 500));
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        await new Promise((resolve) => {
            pc.onicecandidate = (e: any) => { if (!e.candidate) resolve(null); };
            setTimeout(resolve, 1500);
        });
        return { sdp: pc.localDescription!.sdp };
    });

    const offerSdp = aSetup.sdp;
    console.log('=====REAL-WORKER: A offer hasEncrypt=====', offerSdp.includes('rtp-hdrext:encrypt'), '| any encrypt string:', /encrypt/i.test(offerSdp));
    const encLines = offerSdp.split('\n').filter((l: string) => /encrypt/i.test(l));
    if (encLines.length) console.log('=====REAL-WORKER: A offer encrypt lines=====', JSON.stringify(encLines));
    console.log('=====REAL-WORKER: A offer audio m-line=====\n' + offerSdp.split('\n').filter((l: string) => l.startsWith('m=audio') || l.startsWith('a=extmap') || l.startsWith('a=rtpmap') || l.startsWith('a=ssrc') || l.startsWith('a=msid') || l.startsWith('a=mid')).join('\n'));

    // B answers
    const bSetup = await pageB.evaluate(async (offer) => {
        const w = (window as any).__e2eeWorker;
        const pc = new RTCPeerConnection({ iceServers: [] });
        (window as any).__pcB = pc;
        const sender = pc.addTrack((window as any).__micStream.getAudioTracks()[0], (window as any).__micStream);
        sender.transform = new RTCRtpScriptTransform(w, { operation: 'encrypt', key: 'test-key' });
        pc.ontrack = (e: any) => {
            try { e.receiver.transform = new RTCRtpScriptTransform(w, { operation: 'decrypt', key: 'test-key' }); } catch (_) {}
        };
        await pc.setRemoteDescription({ type: 'offer', sdp: offer });
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await new Promise((resolve) => {
            pc.onicecandidate = (e: any) => { if (!e.candidate) resolve(null); };
            setTimeout(resolve, 1500);
        });
        return { sdp: pc.localDescription!.sdp };
    }, offerSdp);

    // A applies the answer
    await pageA.evaluate(async (ans) => {
        const pc = (window as any).__pcA;
        pc.ontrack = (e: any) => {
            try { e.receiver.transform = new RTCRtpScriptTransform((window as any).__e2eeWorker, { operation: 'decrypt', key: 'test-key' }); } catch (_) {}
        };
        await pc.setRemoteDescription({ type: 'answer', sdp: ans });
    }, bSetup.sdp);

    const answerSdp = bSetup.sdp;
    console.log('=====REAL-WORKER: B answer hasEncrypt=====', answerSdp.includes('rtp-hdrext:encrypt'), '| any encrypt string:', /encrypt/i.test(answerSdp));

    // Wait for connection + let audio flow
    await pageA.waitForFunction(() => (window as any).__pcA && (window as any).__pcA.connectionState === 'connected', undefined, { timeout: 15000 });
    await pageB.waitForFunction(() => (window as any).__pcB && (window as any).__pcB.connectionState === 'connected', undefined, { timeout: 15000 });
    await pageA.waitForTimeout(3000);

    // Check transforms actually run — instrument via a proxy on each side.
    const counters = await pageA.evaluate(async () => {
        const pc = (window as any).__pcA;
        const stats = await pc.getStats();
        let out = { audioSent: 0, audioRecv: 0, framesEnc: 0, framesDec: 0, packetsIn: 0 };
        stats.forEach((r: any) => {
            if (r.type === 'outbound-rtp' && r.kind === 'audio') { out.audioSent = r.packetsSent || 0; out.framesEnc = r.framesEncoded || 0; }
            if (r.type === 'inbound-rtp' && r.kind === 'audio') { out.audioRecv = r.packetsReceived || 0; out.framesDec = r.framesDecoded || 0; out.packetsIn = r.packetsReceived || 0; }
        });
        return out;
    });
    const countersB = await pageB.evaluate(async () => {
        const pc = (window as any).__pcB;
        const stats = await pc.getStats();
        let out = { audioSent: 0, audioRecv: 0, framesEnc: 0, framesDec: 0, packetsIn: 0 };
        stats.forEach((r: any) => {
            if (r.type === 'outbound-rtp' && r.kind === 'audio') { out.audioSent = r.packetsSent || 0; out.framesEnc = r.framesEncoded || 0; }
            if (r.type === 'inbound-rtp' && r.kind === 'audio') { out.audioRecv = r.packetsReceived || 0; out.framesDec = r.framesDecoded || 0; out.packetsIn = r.packetsReceived || 0; }
        });
        return out;
    });
    console.log('=====REAL-WORKER: A stats=====', JSON.stringify(counters));
    console.log('=====REAL-WORKER: B stats=====', JSON.stringify(countersB));

    // Transform presence on each side
    const txA = await pageA.evaluate(() => {
        const pc = (window as any).__pcA;
        return {
            senders: pc.getSenders().map((s: any) => !!s.transform),
            receivers: pc.getReceivers().map((r: any) => !!r.transform),
        };
    });
    const txB = await pageB.evaluate(() => {
        const pc = (window as any).__pcB;
        return {
            senders: pc.getSenders().map((s: any) => !!s.transform),
            receivers: pc.getReceivers().map((r: any) => !!r.transform),
        };
    });
    console.log('=====REAL-WORKER: A transforms=====', JSON.stringify(txA));
    console.log('=====REAL-WORKER: B transforms=====', JSON.stringify(txB));

    expect(true).toBe(true);
});
