// AudioWorkletProcessor for relay audio playback.
// Uses SharedArrayBuffer + Atomics for lock-free communication with the main thread.
// Falls back to MessagePort postMessage if SharedArrayBuffer is unavailable.
// Runs on the audio rendering thread with no shared JS heap with the main thread.
class RelayAudioProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        // SharedArrayBuffer layout (lock-free, no postMessage):
        //   Int32[0] = writePos  (main thread writes, worklet reads)
        //   Int32[1] = readPos   (worklet writes, main thread reads)
        //   Float32[2..] = ring buffer samples
        this._sharedBuf = null;
        this._sharedInt = null;
        this._sharedFloat = null;
        this._sharedRingLen = 0;

        // Internal ring buffer (fallback when SharedArrayBuffer unavailable)
        this._ring = new Float32Array(48000 * 3);
        this._writePos = 0;
        this._readPos = 0;

        this._wasSilent = true;
        this._prevTail = 0;
        this._alive = true;
        this._started = false;

        // Output quality tracking (audio thread — no races)
        this._outSamples = 0;
        this._outNonzero = 0;
        this._outSumSq = 0;
        this._outMaxAmp = 0;
        this._outPops = 0;
        this._outMaxPop = 0;

        // Accept SharedArrayBuffer via processorOptions (passed at node construction)
        if (options && options.processorOptions && options.processorOptions.sharedBuffer) {
            this._setupSharedBuffer(options.processorOptions.sharedBuffer);
        }

        this.port.onmessage = (e) => {
            if (e.data && e.data.type === 'stop') {
                this._alive = false;
                return;
            }
            if (e.data && e.data.type === 'getStats') {
                this.port.postMessage({
                    underruns: this._outPops === 0 ? 0 : this._outPops,
                    samples: this._outSamples,
                    rms: this._outNonzero > 0
                        ? Math.sqrt(this._outSumSq / this._outNonzero) : 0,
                    maxAmplitude: this._outMaxAmp,
                    pops: this._outPops,
                    maxPop: this._outMaxPop,
                });
                return;
            }
            // SharedArrayBuffer arrived from main thread
            if (e.data && e.data.type === 'sharedBuffer' && e.data.sharedBuffer) {
                this._setupSharedBuffer(e.data.sharedBuffer);
                return;
            }
            // Fallback: receive samples via postMessage (legacy path)
            if (e.data && e.data.samples && !this._sharedBuf) {
                const samples = e.data.samples;
                const ringLen = this._ring.length;
                const avail = (this._writePos - this._readPos + ringLen) % ringLen;
                const free = ringLen - avail;
                if (samples.length > free) return;
                for (let i = 0; i < samples.length; i++) {
                    this._ring[this._writePos] = samples[i];
                    this._writePos = (this._writePos + 1) % ringLen;
                }
            }
        };
    }

    _setupSharedBuffer(sharedBuffer) {
        this._sharedBuf = sharedBuffer;
        this._sharedInt = new Int32Array(sharedBuffer);
        this._sharedFloat = new Float32Array(sharedBuffer, 8);
        this._sharedRingLen = this._sharedFloat.length;
        Atomics.store(this._sharedInt, 0, 0);
        Atomics.store(this._sharedInt, 1, 0);
    }

    process(inputs, outputs) {
        if (!this._alive) return false;
        const outputData = outputs[0][0];
        const FRAME = outputData.length;
        if (this._sharedBuf) {
            return this._processShared(outputData, FRAME);
        }
        return this._processFallback(outputData, FRAME);
    }

    _processShared(outputData, FRAME) {
        const writePos = Atomics.load(this._sharedInt, 0);
        const readPos = Atomics.load(this._sharedInt, 1);
        const ringLen = this._sharedRingLen;
        const avail = (writePos - readPos + ringLen) % ringLen;

        if (!this._started) {
            if (avail < 4800) {
                outputData.fill(0);
                return true;
            }
            this._started = true;
        }

        if (avail < FRAME) {
            outputData.fill(this._prevTail);
            this._wasSilent = true;
            return true;
        }

        for (let i = 0; i < FRAME; i++) {
            outputData[i] = this._sharedFloat[(readPos + i) % ringLen];
        }
        Atomics.store(this._sharedInt, 1, (readPos + FRAME) % ringLen);

        // Eliminate pops by clamping the sample-to-sample step.
        // For any audio signal, the maximum natural step between consecutive
        // samples is bounded by the Nyquist limit. For a 440Hz sine at 48kHz,
        // max step ~ 0.058. We clamp at 0.05 to stay safely below that.
        // This turns large discontinuities into linear ramps that are inaudible.
        const MAX_STEP = 0.05;
        let prev = this._prevTail;
        for (let i = 0; i < FRAME; i++) {
            const step = outputData[i] - prev;
            if (step > MAX_STEP) {
                outputData[i] = prev + MAX_STEP;
            } else if (step < -MAX_STEP) {
                outputData[i] = prev - MAX_STEP;
            }
            prev = outputData[i];
        }

        this._wasSilent = false;

        // Track output quality (audio thread only — no races)
        for (let i = 0; i < FRAME; i++) {
            const s = outputData[i];
            const abs = s < 0 ? -s : s;
            this._outSamples++;
            if (abs > 0.001) {
                this._outNonzero++;
                this._outSumSq += s * s;
            }
            if (abs > this._outMaxAmp) this._outMaxAmp = abs;
            if (i > 0) {
                const diff = s - outputData[i - 1];
                const absDiff = diff < 0 ? -diff : diff;
                if (absDiff > this._outMaxPop) this._outMaxPop = absDiff;
                if (absDiff > 0.06) this._outPops++;
            }
        }

        this._prevTail = outputData[FRAME - 1];
        return true;
    }

    _processFallback(outputData, FRAME) {
        const ringLen = this._ring.length;
        const avail = (this._writePos - this._readPos + ringLen) % ringLen;

        if (!this._started) {
            if (avail < 12000) {
                outputData.fill(0);
                return true;
            }
            this._started = true;
        }

        if (avail < FRAME) {
            if (!this._wasSilent) {
                for (let j = 0; j < FRAME; j++) {
                    const t = 1 - (j + 1) / FRAME;
                    outputData[j] = this._prevTail * t * t * (3 - 2 * t);
                }
            } else {
                outputData.fill(0);
            }
            this._wasSilent = true;
            this._prevTail = 0;
            return true;
        }

        for (let i = 0; i < FRAME; i++) {
            outputData[i] = this._ring[this._readPos];
            this._readPos = (this._readPos + 1) % ringLen;
        }

        if (this._wasSilent) {
            this._wasSilent = false;
            for (let j = 0; j < FRAME; j++) {
                const t = (j + 1) / FRAME;
                outputData[j] *= t * t * (3 - 2 * t);
            }
        }

        for (let i = 0; i < FRAME; i++) {
            const s = outputData[i];
            const abs = s < 0 ? -s : s;
            this._outSamples++;
            if (abs > 0.001) {
                this._outNonzero++;
                this._outSumSq += s * s;
            }
            if (abs > this._outMaxAmp) this._outMaxAmp = abs;
            if (i > 0) {
                const diff = s - outputData[i - 1];
                const absDiff = diff < 0 ? -diff : diff;
                if (absDiff > this._outMaxPop) this._outMaxPop = absDiff;
                if (absDiff > 0.06) this._outPops++;
            }
        }

        this._prevTail = outputData[FRAME - 1];
        return true;
    }
}

registerProcessor('relay-audio-processor', RelayAudioProcessor);
