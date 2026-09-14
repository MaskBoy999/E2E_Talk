// AudioWorkletProcessor for relay audio CAPTURE (sender side).
// Captures mic audio on the audio thread and writes to a SharedArrayBuffer
// so the main thread can encrypt and send without timing pressure.
// This eliminates the sample-skip bug inherent to ScriptProcessorNode.
class RelayCaptureProcessor extends AudioWorkletProcessor {
    constructor(options) {
        super();

        // SharedArrayBuffer layout (same as receiver but reversed roles):
        //   Int32[0] = writePos  (worklet writes, main thread reads)
        //   Int32[1] = readPos   (main thread writes, worklet reads)
        //   Float32[2..] = ring buffer samples
        this._sharedBuf = null;
        this._sharedInt = null;
        this._sharedFloat = null;
        this._sharedRingLen = 0;
        this._alive = true;

        if (options && options.processorOptions && options.processorOptions.sharedBuffer) {
            this._setupSharedBuffer(options.processorOptions.sharedBuffer);
        }

        this.port.onmessage = (e) => {
            if (e.data && e.data.type === 'stop') {
                this._alive = false;
                return;
            }
            if (e.data && e.data.type === 'sharedBuffer' && e.data.sharedBuffer) {
                this._setupSharedBuffer(e.data.sharedBuffer);
            }
        };
    }

    _setupSharedBuffer(sharedBuffer) {
        this._sharedBuf = sharedBuffer;
        this._sharedInt = new Int32Array(sharedBuffer);
        this._sharedFloat = new Float32Array(sharedBuffer, 8);
        this._sharedRingLen = this._sharedFloat.length;
        Atomics.store(this._sharedInt, 0, 0); // writePos
        Atomics.store(this._sharedInt, 1, 0); // readPos
    }

    process(inputs, outputs) {
        if (!this._alive) return false;
        if (!this._sharedBuf) return true;

        const input = inputs[0];
        if (!input || !input[0]) return true;
        const inputData = input[0]; // mono channel
        const len = inputData.length;

        const writePos = Atomics.load(this._sharedInt, 0);
        const readPos = Atomics.load(this._sharedInt, 1);
        const ringLen = this._sharedRingLen;
        const avail = (writePos - readPos + ringLen) % ringLen;
        const free = ringLen - avail;

        if (len > free) return true; // drop if full

        for (let i = 0; i < len; i++) {
            this._sharedFloat[(writePos + i) % ringLen] = inputData[i];
        }
        Atomics.store(this._sharedInt, 0, (writePos + len) % ringLen);

        return true;
    }
}

registerProcessor('relay-capture-processor', RelayCaptureProcessor);
