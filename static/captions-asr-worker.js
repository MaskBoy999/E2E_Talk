/**
 * Offline speech recognition worker for live captions.
 *
 * Runs the bundled whisper model (`static/vendor/asr/`, vendored by
 * tools/fetch-asr-assets.mjs) entirely inside the webview: no network, no
 * third-party service, nothing that touches decrypted call audio ever leaves
 * the device. That is the whole reason this file exists as a worker rather than
 * as a call to an API.
 *
 * Loaded as a MODULE worker (`new Worker(url, { type: 'module' })`) because the
 * transformers.js bundle is an ES module; `env.allowRemoteModels = false` and
 * `env.localModelPath` pin every read to /vendor/asr/, so a tampered page
 * setting cannot make it fetch a model from somewhere else.
 *
 * Protocol (main thread -> worker):
 *   { type: 'warm' }                                   start loading the model
 *   { type: 'transcribe', id, speaker, audio, sampleRate, language? }
 *        audio is a Float32Array (transferred) of 16 kHz mono PCM
 * Worker -> main thread:
 *   { type: 'ready' }
 *   { type: 'result', id, speaker, text }
 *   { type: 'error', id?, message }
 */
import * as transformers from '/vendor/asr/transformers.min.js';

const { pipeline, env } = transformers;

// Local-only, always. Both of these are read at load time inside the library.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/vendor/asr/';
// The model is bundled with the app and served from the app's own origin, so
// the browser Cache API buys nothing — it only copies ~70 MB into storage on
// first run for no benefit.
env.useBrowserCache = false;
// The wasm backend is served by the app's own server as well.
env.backends.onnx.wasm.wasmPaths = '/vendor/asr/';
// No SharedArrayBuffer without cross-origin isolation (the server does not send
// COOP/COEP, and adding them would break other cross-origin loads), so the
// model runs single-threaded via the asyncify build. Slower, still fast enough
// for 5-second windows.
env.backends.onnx.wasm.numThreads = 1;

const MODEL = 'whisper-tiny';
const SAMPLE_RATE = 16000;
// Whisper's own "nothing was said" artefacts. The energy gate in captions.js
// already drops silent windows, so these only ever show up on noise.
const NON_SPEECH = [
    '[blank_audio]', '[silence]', '[music]', '[applause]', '[laughter]',
    '(silence)', '[ silence ]', 'you', 'thank you.', 'thanks for watching!',
    'subtitles by the amara.org community', 'please subscribe!',
];

let transcriber = null;
let loading = null;
let loadingError = null;

function loadModel() {
    if (!loading) {
        loading = pipeline('automatic-speech-recognition', MODEL, {
            device: 'wasm',
            // int8 weights: the whole model is ~44 MB on disk instead of ~150 MB.
            // Keep this a plain 'q8' string rather than the per-component object
            // form; q8 is exactly what the bundled *_quantized.onnx files are.
            dtype: 'q8',
            // Deliberately NO progress_callback. When one is supplied this
            // vendored transformers build abandons `response.arrayBuffer()` for
            // its streaming reader, which never settles here — the model
            // downloads in full and then `pipeline()` hangs forever, so captions
            // sat on "Loading the offline speech model…" and never started. The
            // UI shows that same loading state until this promise resolves.
        }).then(function (pipe) {
            transcriber = pipe;
            try { self.postMessage({ type: 'ready' }); } catch (_) {}
            return pipe;
        }).catch(function (e) {
            loadingError = (e && e.message) ? e.message : String(e);
            loading = null;
            throw e;
        });
    }
    return loading;
}

function clean(text) {
    var t = String(text || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    var lower = t.toLowerCase();
    for (var i = 0; i < NON_SPEECH.length; i++) {
        if (lower === NON_SPEECH[i]) return '';
    }
    // A window of silence often decodes to "(...)" or a bare bracketed token.
    if (/^[(\[{][^)\]}]*[)\]}]+$/.test(t)) return '';
    return t;
}

function resampleTo16k(input, inRate) {
    if (!inRate || inRate === SAMPLE_RATE) return input;
    var ratio = inRate / SAMPLE_RATE;
    var outLen = Math.floor(input.length / ratio);
    var out = new Float32Array(outLen);
    // Simple box-average decimation. Speech recognition is robust to this and
    // it is far cheaper than a windowed-sinc filter, which matters when this
    // runs on a phone while a call is in progress.
    for (var i = 0; i < outLen; i++) {
        var start = Math.floor(i * ratio);
        var end = Math.min(input.length, Math.floor((i + 1) * ratio));
        var sum = 0;
        for (var j = start; j < end; j++) sum += input[j];
        out[i] = end > start ? sum / (end - start) : 0;
    }
    return out;
}

self.onmessage = async function (ev) {
    var msg = ev && ev.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'warm') {
        try {
            await loadModel();
        } catch (e) {
            try { self.postMessage({ type: 'error', message: loadingError || 'model load failed' }); } catch (_) {}
        }
        return;
    }

    if (msg.type === 'transcribe') {
        var id = msg.id;
        var speaker = msg.speaker || '';
        try {
            var pipe = await loadModel();
            var audio = msg.audio;
            if (!(audio instanceof Float32Array)) audio = new Float32Array(audio || 0);
            audio = resampleTo16k(audio, msg.sampleRate || SAMPLE_RATE);
            if (audio.length < SAMPLE_RATE * 0.3) {
                // Under 300 ms is not an utterance, it is a click.
                self.postMessage({ type: 'result', id: id, speaker: speaker, text: '' });
                return;
            }
            var opts = { task: 'transcribe' };
            // Pin the language once the caller has decided (the first window
            // auto-detects): re-detecting per window makes the text flip between
            // languages mid-sentence.
            if (msg.language) opts.language = msg.language;
            var out = await pipe(audio, opts);
            var text = clean(out && out.text);
            self.postMessage({ type: 'result', id: id, speaker: speaker, text: text, language: out && out.language });
        } catch (e) {
            self.postMessage({
                type: 'error',
                id: id,
                message: (e && e.message) ? e.message : String(e),
            });
        }
        return;
    }
};
