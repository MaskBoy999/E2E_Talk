/**
 * Offline speech recognition worker for live captions.
 *
 * Runs the bundled whisper models (`static/vendor/asr/`, vendored by
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
 *   { type: 'warm', device?, model? }                  start loading a model
 *   { type: 'transcribe', id, speaker, audio, sampleRate, language?, model?, device? }
 *        audio is a Float32Array (transferred) of 16 kHz mono PCM.
 *        `language` omitted/empty means "detect it" (whisper's own first pass).
 *   { type: 'bench', id, engine, model?, audio, sampleRate, runs? }
 *        time N decodes of the same window on one engine
 * Worker -> main thread:
 *   { type: 'ready', device, model, threads, isolated }   what is actually running
 *   { type: 'result', id, speaker, text, language? }
 *   { type: 'bench-result', id, engine, model, timings, median, error? }
 *   { type: 'error', id?, message }
 *
 * ===== WHY 30-SECOND WINDOWS =====
 *
 * Whisper is a *long-form* model: it was trained on 30-second mel spectrograms,
 * and its encoder always runs on the full 30-second frame regardless of how much
 * audio was actually passed in. Feeding it isolated 5-second slices therefore
 * cost nearly the same encoder time per slice while throwing away 25 seconds of
 * context per decode — which is exactly what made the old captions wrong so
 * often: no context for homophones, no context to finish a sentence, and a hard
 * chop every 5 seconds mid-word. The main thread now hands this worker a rolling
 * 30-second window (stride 5 s, de-duplicated against what was already shown),
 * and `chunk_length_s`/`stride_length_s` below keep the same behaviour if a
 * window ever exceeds 30 s.
 *
 * ===== ENGINE (cpu vs gpu) =====
 *
 * `device` is 'wasm' (the default) or 'webgpu' — the Settings → Live Captions
 * switch. WebGPU is *asked for*, never assumed: the pipeline is built and if
 * that fails for any reason (no WebGPU in the webview, no driver, the card
 * refuses an int8 model, a driver crash) the same model is built on the CPU
 * again and the worker reports which engine it actually got. A caption that is
 * a little late beats a spinner.
 *
 * The wasm backend runs MULTI-THREADED when the page is cross-origin isolated.
 * The app's own server sends `Cross-Origin-Opener-Policy: same-origin` and
 * `Cross-Origin-Embedder-Policy: require-corp` on every static response, which
 * makes SharedArrayBuffer available inside this worker — so threading is on, and
 * `threads` in every message says how many threads the run actually got. If the
 * threaded build cannot start for any reason the model is rebuilt with one
 * thread rather than leaving captions dead.
 */
import * as transformers from '/vendor/asr/transformers.min.js';

const { pipeline, env } = transformers;

// Local-only, always. Both of these are read at load time inside the library.
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = '/vendor/asr/';
// The model is bundled with the app and served from the app's own origin, so
// the browser Cache API buys nothing — it only copies ~80 MB into storage on
// first run for no benefit.
env.useBrowserCache = false;
// The wasm backend is served by the app's own server as well.
env.backends.onnx.wasm.wasmPaths = '/vendor/asr/';

const SAMPLE_RATE = 16000;
// Whisper's own window. Nothing longer is ever handed to the model: the main
// thread keeps a rolling window of exactly this length.
const CHUNK_SECONDS = 30;
// How much of a longer input the library overlaps when it has to split one up.
const STRIDE_SECONDS = 5;

// The two vendored models. The directory names are the pipeline ids, so they
// must match the directories tools/fetch-asr-assets.mjs writes.
const MODELS = { tiny: 'whisper-tiny', base: 'whisper-base' };
function modelId(name) { return MODELS[name] || MODELS.tiny; }

/** Cross-origin isolation is what makes SharedArrayBuffer (and threads) legal. */
function isolated() {
  try { return self.crossOriginIsolated === true; } catch (_) { return false; }
}
function cores() {
  try { return (self.navigator && self.navigator.hardwareConcurrency) || 1; } catch (_) { return 1; }
}
// Four is where the per-window return flattens out and where a phone's big.LITTLE
// cluster starts to lose to the scheduler; one thread is the floor.
function threadCount() { return isolated() ? Math.max(1, Math.min(4, cores())) : 1; }

function setThreads(n) {
  env.backends.onnx.wasm.numThreads = n;
  return n;
}
let threads = setThreads(threadCount());

// Whisper's own "nothing was said" artefacts. The energy gate in captions.js
// already drops silent windows, so these only ever show up on noise.
const NON_SPEECH = [
    '[blank_audio]', '[silence]', '[music]', '[applause]', '[laughter]',
    '(silence)', '[ silence ]', 'you', 'thank you.', 'thanks for watching!',
    'subtitles by the amara.org community', 'please subscribe!',
];

let current = null;          // { key, pipe } — the model/engine loaded right now
let loading = null;          // the in-flight load, so concurrent calls share it
let loadingKey = '';
let loadingError = null;
let engine = 'wasm';         // the device the loaded model actually runs on
let model = MODELS.tiny;     // the model id the loaded pipeline is running

function keyOf(modelIdValue, device) { return modelIdValue + ':' + device; }

function build(modelIdValue, device) {
  return pipeline('automatic-speech-recognition', modelIdValue, {
    device: device,
    // int8 weights: whisper-base is ~80 MB on disk instead of ~290 MB. Keep
    // this a plain 'q8' string rather than the per-component object form; q8 is
    // exactly what the bundled *_quantized.onnx files are.
    dtype: 'q8',
    // Deliberately NO progress_callback. When one is supplied this vendored
    // transformers build abandons `response.arrayBuffer()` for its streaming
    // reader, which never settles here — the model downloads in full and then
    // `pipeline()` hangs forever, so captions sat on "Loading the offline
    // speech model…" and never started.
  });
}

/** Build a pipeline, giving up the multi-threaded build rather than everything. */
function buildWithFallback(modelIdValue, device) {
  return build(modelIdValue, device).catch(function (e) {
    if (threads === 1) throw e;
    // A webview can be cross-origin isolated and still refuse the threaded wasm
    // build (an old ort-web build, a blocked worker, a strict memory limit).
    // One thread is slow but it captions; a dead worker captions nothing.
    console.warn('captions: the multi-threaded wasm build failed, falling back to one thread:', e && (e.message || e));
    threads = setThreads(1);
    return build(modelIdValue, device);
  });
}

function load(modelName, wantDevice) {
  const modelIdValue = modelId(modelName);
  const device = wantDevice === 'webgpu' ? 'webgpu' : 'wasm';
  const key = keyOf(modelIdValue, device);
  if (current && current.key === key) return Promise.resolve(current.pipe);
  if (loading && loadingKey === key) return loading;

  const attempt = device === 'webgpu'
      ? buildWithFallback(modelIdValue, 'webgpu').then(function (pipe) {
          engine = 'webgpu';
          return pipe;
      }, function (e) {
          // The honest fallback: say why, then do the work on the CPU. The
          // wasm backend is vendored next to the model, so this is always
          // available (it is what runs when the switch is off).
          console.warn('captions: WebGPU was requested but refused, using the CPU instead:', e && (e.message || e));
          return buildWithFallback(modelIdValue, 'wasm').then(function (pipe) { engine = 'wasm'; return pipe; });
      })
      : buildWithFallback(modelIdValue, 'wasm').then(function (pipe) { engine = 'wasm'; return pipe; });

  loadingKey = key;
  loading = attempt.then(function (pipe) {
    var previous = current;
    current = { key: key, pipe: pipe };
    model = modelIdValue;
    // Release the pipeline this one replaced. Rebuilding happens when the model
    // or the engine changes (a settings action), and keeping whisper-tiny's
    // session alive next to whisper-base's is ~80 MB of weights plus a second
    // wasm heap — on a phone that is the difference between captions and a tab
    // crash. Nothing else can be holding it: a rebuild is only ever asked for by
    // a new request.
    if (previous && previous.key !== key && previous.pipe && previous.pipe.dispose) {
      try { previous.pipe.dispose(); } catch (_) {}
    }
    loading = null;
    loadingKey = '';
    try {
      self.postMessage({ type: 'ready', device: engine, model: model, threads: threads, isolated: isolated() });
    } catch (_) {}
    return pipe;
  }).catch(function (e) {
    loadingError = (e && e.message) ? e.message : String(e);
    loading = null;
    loadingKey = '';
    throw e;
  });
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
    if (/^[(\[{][^)\]}]*[)\]}]$/.test(t)) return '';
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

/** One decode. Long-form options: the window is the context, stride joins them. */
async function decode(pipe, audio, language) {
  var opts = {
    task: 'transcribe',
    // Whisper's trained window, plus the classic 5 s stride: on an input longer
    // than 30 s the library slides a 30 s window forward in 25 s steps and
    // stitches the overlap, so a sentence crossing a boundary still reads once.
    chunk_length_s: CHUNK_SECONDS,
    stride_length_s: STRIDE_SECONDS,
  };
  // Pin the language once the caller has decided (the first window
  // auto-detects and the caller then pins what came back): re-detecting per
  // window makes the text flip between languages mid-sentence.
  if (language) opts.language = language;
  return pipe(audio, opts);
}

self.onmessage = async function (ev) {
    var msg = ev && ev.data;
    if (!msg || !msg.type) return;

    if (msg.type === 'warm') {
        try {
            await load(msg.model, msg.device);
        } catch (e) {
            try { self.postMessage({ type: 'error', message: loadingError || 'model load failed' }); } catch (_) {}
        }
        return;
    }

    if (msg.type === 'transcribe') {
        var id = msg.id;
        var speaker = msg.speaker || '';
        try {
            var pipe = await load(msg.model, msg.device);
            var audio = msg.audio;
            if (!(audio instanceof Float32Array)) audio = new Float32Array(audio || 0);
            audio = resampleTo16k(audio, msg.sampleRate || SAMPLE_RATE);
            if (audio.length < SAMPLE_RATE * 0.3) {
                // Under 300 ms is not an utterance, it is a click.
                self.postMessage({ type: 'result', id: id, speaker: speaker, text: '' });
                return;
            }
            var out = await decode(pipe, audio, msg.language);
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

    if (msg.type === 'bench') {
        // Settings → Live Captions → Benchmark. One engine per message, so the
        // caller can run this in a throwaway worker and never disturb the model
        // that is captioning a live call.
        var bid = msg.id;
        var wantEngine = msg.engine === 'webgpu' ? 'webgpu' : 'wasm';
        var runs = Math.max(1, Math.min(10, msg.runs || 3));
        try {
            var bpipe = await load(msg.model, wantEngine);
            var baudio = msg.audio instanceof Float32Array ? msg.audio : new Float32Array(msg.audio || 0);
            baudio = resampleTo16k(baudio, msg.sampleRate || SAMPLE_RATE);
            var timings = [];
            for (var r = 0; r < runs; r++) {
                var t0 = (self.performance && self.performance.now) ? self.performance.now() : Date.now();
                await decode(bpipe, baudio, msg.language);
                var t1 = (self.performance && self.performance.now) ? self.performance.now() : Date.now();
                // The first decode includes the model's own one-off setup
                // (graph optimisations, weight upload to the GPU), which is not
                // what "how long does a window take" means. Drop it.
                if (r > 0 || runs === 1) timings.push(t1 - t0);
            }
            var sorted = timings.slice().sort(function (a, b) { return a - b; });
            self.postMessage({
                type: 'bench-result', id: bid, engine: engine, model: model,
                threads: threads, isolated: isolated(),
                audioSeconds: baudio.length / SAMPLE_RATE,
                timings: timings,
                median: sorted[Math.floor(sorted.length / 2)] || 0,
            });
        } catch (e) {
            self.postMessage({
                type: 'bench-result', id: bid, engine: wantEngine, model: modelId(msg.model),
                threads: threads, isolated: isolated(), timings: [], median: 0,
                error: (e && e.message) ? e.message : String(e),
            });
        }
        return;
    }
};
