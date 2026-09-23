import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Startup-path guards for the native Android plugin (`tauri-plugin-call-service`).
 *
 * These are source-level assertions rather than browser tests on purpose: every
 * failure they describe happens *before* any page loads, on a device, in a
 * minified release build — which is the worst possible combination to debug.
 * Each one is written from a failure that actually shipped:
 *
 *  * A `registerForActivityResult` call inside the plugin took the whole app
 *    down on launch. It is only legal while the activity is *before* STARTED,
 *    but a Kotlin plugin is constructed by Rust once the activity is already
 *    running and RESUMED, so the call throws out of the constructor. Nothing in
 *    this plugin may register a launcher; Tauri's `PluginManager` already
 *    registers its own ones from `onActivityCreate`, which is early enough.
 *
 *  * Rust finds the plugin class by *name* (`find_class("com/e2echat/…")`) and
 *    then invokes `@Command` / `@ActivityCallback` methods reflectively. R8 sees
 *    no references at all, so without explicit keep rules a minified release can
 *    rename the class — and the app dies while building the plugin, while a
 *    debug build works perfectly.
 *
 *  * The activity-callback name is a plain string on one side and a method name
 *    on the other. Renaming either half breaks the link *silently*: the picker
 *    still opens, the result is simply never delivered, and the page's promise
 *    never settles.
 */

const ROOT = path.join(__dirname, '..');
const PLUGIN_DIR = path.join(
    ROOT,
    'src-tauri',
    'plugins',
    'call-service',
    'android'
);
const KOTLIN_DIR = path.join(
    PLUGIN_DIR,
    'src',
    'main',
    'java',
    'com',
    'e2echat',
    'callservice'
);

/**
 * Kotlin source with comments removed. These guards are about code, and the
 * files deliberately *document* the hazards they forbid — a naive regex would
 * match the explanation and fail the very check it describes.
 */
function code(src: string): string {
    return src
        .replace(/\/\*[\s\S]*?\*\//g, '') // block and KDoc comments
        .replace(/\/\/[^\n]*/g, ''); // line comments
}

const PLUGIN_KT = code(fs.readFileSync(path.join(KOTLIN_DIR, 'CallServicePlugin.kt'), 'utf8'));
const SCREEN_KT = code(fs.readFileSync(path.join(KOTLIN_DIR, 'ScreenCapture.kt'), 'utf8'));
const GRADLE = fs.readFileSync(path.join(PLUGIN_DIR, 'build.gradle.kts'), 'utf8');
const CONSUMER_RULES = fs.readFileSync(
    path.join(PLUGIN_DIR, 'consumer-proguard-rules.pro'),
    'utf8'
);

test.describe('Android plugin start-up safety', () => {
    test('nothing registers an activity-result launcher inside the plugin', () => {
        // The activity is RESUMED by the time this plugin is constructed, so a
        // launcher registered here throws out of the constructor: an app crash
        // on launch, not a broken screen share.
        expect(
            /\bregisterForActivityResult\b/.test(SCREEN_KT),
            'ScreenCapture.kt must not call registerForActivityResult — the plugin is built ' +
                'after the activity is RESUMED, so it throws at launch. Route the picker ' +
                'through Plugin.startActivityForResult + @ActivityCallback instead.'
        ).toBe(false);
        expect(/\bregisterForActivityResult\b/.test(PLUGIN_KT)).toBe(false);

        // A ComponentActivity cast only existed to reach that method; if it comes
        // back, so has the hazard.
        expect(/as\s+androidx\.activity\.ComponentActivity/.test(SCREEN_KT)).toBe(false);
    });

    test('constructing the plugin cannot run lifecycle-sensitive code', () => {
        expect(
            /private\s+val\s+screenCapture\s+by\s+lazy\b/.test(PLUGIN_KT),
            'screenCapture must be `by lazy` so constructing the plugin only allocates a ' +
                'reference — anything else runs on the launch path.'
        ).toBe(true);
    });

    test('the activity-callback name matches an @ActivityCallback method', () => {
        const launched = PLUGIN_KT.match(
            /startActivityForResult\(\s*invoke\s*,\s*\w+\s*,\s*"([A-Za-z0-9_]+)"\s*\)/
        );
        expect(
            launched,
            'startScreenCapture should launch the picker through startActivityForResult(…, name)'
        ).not.toBeNull();

        const callbackName = launched![1];
        // The name is looked up as `startActivityCallbackMethods[method.name]`,
        // so it must be an annotated method with the (Invoke, ActivityResult)
        // shape the handle invokes.
        const annotated = new RegExp(
            '@ActivityCallback[\\s\\S]{0,120}?fun\\s+' + callbackName + '\\s*\\(\\s*invoke\\s*:\\s*Invoke\\s*,\\s*result\\s*:\\s*ActivityResult\\s*\\)'
        );
        expect(
            annotated.test(PLUGIN_KT),
            `no @ActivityCallback fun ${callbackName}(invoke: Invoke, result: ActivityResult) found — ` +
                'the picker result would never be delivered and the JS promise would hang'
        ).toBe(true);
    });

    test('the picker result always settles the command', () => {
        // If the callback can return without resolving, `startScreenCapture`
        // never settles for the page. The callback body must resolve on both the
        // accepted and the refused path.
        const body = PLUGIN_KT.slice(PLUGIN_KT.indexOf('@ActivityCallback'));
        expect(/invoke\.resolve\(\)/.test(body)).toBe(true);
    });

    test('R8 is told to keep the plugin package', () => {
        // Rust resolves these by name; R8 cannot see the reference.
        expect(
            /-keep\s+class\s+com\.e2echat\.callservice\.\*\*\s*\{\s*\*\s*;\s*\}/.test(
                CONSUMER_RULES
            ),
            'the plugin classes are found by name at runtime, so a minified release must be ' +
                'told to keep them (otherwise the app crashes while building the plugin)'
        ).toBe(true);
    });

    test('releasing a share cannot re-enter stop() and overflow the stack', () => {
        // `stop()` calls `projection.stop()`, which invokes the registered
        // `onStop()`, which calls `stop()` again. With nothing to stop it, that
        // recursion has no base case and ends as a StackOverflowError on the
        // capture thread — an Error, so it is not catchable, and it takes the
        // whole process with it. That is the "the app closes when I stop
        // sharing" report, and both halves of the fix are pinned here.
        expect(
            /private\s+var\s+stopping\s*=\s*true/.test(SCREEN_KT),
            'teardown must be guarded by a `stopping` flag (initialised true: nothing is capturing yet)'
        ).toBe(true);
        expect(
            /if\s*\(\s*stopping\s*\)\s*return/.test(SCREEN_KT),
            'stop() must return immediately when it is already stopping, or it re-enters through onStop()'
        ).toBe(true);
        expect(
            /unregisterCallback\(/.test(SCREEN_KT),
            'the projection callback must be detached before the projection is stopped, so the platform has nothing left to call back into'
        ).toBe(true);
        // …and the guard must be cleared for the next share, otherwise screen
        // sharing would work exactly once per app run.
        expect(
            /stopping\s*=\s*false/.test(SCREEN_KT),
            'prepare() must clear the guard so a later share can start'
        ).toBe(true);
    });

    test('the capture result can never crash the process', () => {
        // This runs on the main thread as an activity-result callback. An
        // uncaught exception here is not a failed screen share, it is a crash,
        // so the body — including settling the command — has to be contained.
        const body = PLUGIN_KT.slice(PLUGIN_KT.indexOf('@ActivityCallback'));
        expect(/try\s*\{/.test(body), 'the callback body must be wrapped').toBe(true);
        expect(/catch\s*\(/.test(body), 'the callback must catch, not propagate').toBe(true);
        expect(
            /invoke\.resolve\(\)/.test(body),
            'the command must still be settled even when starting the capture failed'
        ).toBe(true);
        // Stopping is the one command that must never reject: a rejection there
        // leaves the page convinced a share is still live.
        const stopFn = PLUGIN_KT.slice(PLUGIN_KT.indexOf('fun stopScreenCapture'));
        expect(/invoke\.reject/.test(stopFn.slice(0, 400)), 'stopScreenCapture must not reject').toBe(false);
    });

    test('the projection failure names the foreground-service type', () => {
        // On API 34+ createVirtualDisplay throws SecurityException when no
        // mediaProjection-typed foreground service is running. A bare platform
        // string sends the user hunting for the wrong problem, so the type is
        // named in the message the page shows.
        expect(
            /SecurityException/.test(SCREEN_KT),
            'begin() must handle the SecurityException that API 34+ raises for a missing foreground-service type'
        ).toBe(true);
        expect(
            /mediaProjection/.test(SCREEN_KT),
            'the failure message must name the mediaProjection type'
        ).toBe(true);
    });

    test('androidx.activity is compileOnly, so the app version is not bumped', () => {
        // It is only needed for the ActivityResult *type*; the app always has
        // the artifact at runtime (Tauri's own PluginManager uses it). Declaring
        // it as `implementation` silently upgrades the version the whole app
        // resolves, and fights Gradle's consistent resolution besides.
        expect(/compileOnly\("androidx\.activity:activity:[^"]+"\)/.test(GRADLE)).toBe(true);
        expect(/implementation\("androidx\.activity:activity:/.test(GRADLE)).toBe(false);
    });
});

/**
 * Guards for the features that only exist on a phone: native picture-in-picture,
 * the notification's Decline action, and the ringer-mode gate.
 *
 * Same reasoning as above — every failure they describe is invisible until a
 * device, a release build, or a user's phone, so they are pinned in source.
 */
test.describe('native PiP, notification decline and ringer awareness', () => {
    const MANIFEST = fs.readFileSync(path.join(PLUGIN_DIR, 'src', 'main', 'AndroidManifest.xml'), 'utf8');
    const BUILD_RS = fs.readFileSync(path.join(ROOT, 'src-tauri', 'plugins', 'call-service', 'build.rs'), 'utf8');
    const DEFAULT_TOML = fs.readFileSync(
        path.join(ROOT, 'src-tauri', 'plugins', 'call-service', 'permissions', 'default.toml'),
        'utf8'
    );
    const TAURI_CONF = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'));
    const PIP_KT = code(fs.readFileSync(path.join(KOTLIN_DIR, 'Pip.kt'), 'utf8'));
    const PROFILE_KT = code(fs.readFileSync(path.join(KOTLIN_DIR, 'AudioProfile.kt'), 'utf8'));
    const NOTIFIER_KT = code(fs.readFileSync(path.join(KOTLIN_DIR, 'IncomingCallNotifier.kt'), 'utf8'));
    const VOICE_JS = fs.readFileSync(path.join(ROOT, 'static', 'voice.js'), 'utf8');

    test('the activity opts into picture-in-picture, by the identifier in use', () => {
        // `enterPictureInPictureMode` throws unless the activity declares this,
        // and the activity lives in the *generated* `gen/android/` project, which
        // is re-created by `tauri android init` — so the attribute is merged in
        // from the plugin manifest, where it survives. The declared activity name
        // must match `identifier` + `.MainActivity`, or the merger adds a second,
        // unrelated activity and nothing calls `supportsPictureInPicture`.
        const identifier = TAURI_CONF.identifier;
        expect(identifier, 'tauri.conf.json must carry the app identifier').toBeTruthy();
        expect(
            MANIFEST.includes(`android:name="${identifier}.MainActivity"`),
            `the plugin manifest must declare android:name="${identifier}.MainActivity" so the ` +
                'generated activity merges with it (rename the identifier and this must move too)'
        ).toBe(true);
        expect(
            /android:supportsPictureInPicture="true"/.test(MANIFEST),
            'without supportsPictureInPicture="true" the PiP call throws and the button does nothing'
        ).toBe(true);
    });

    test('every Kotlin command is granted, and every declared command was generated', () => {
        // A `@Command` that is missing from the ACL is not a build error: the
        // invoke just fails at runtime, on a device, with a permissions error that
        // reads like "PiP is broken" — and only the Android box has a remote-origin
        // capability to fail against, so nothing on desktop would notice either.
        const declared = Array.from(PLUGIN_KT.matchAll(/@Command\s+fun\s+(\w+)\s*\(/g)).map((m) => m[1]);
        expect(declared.length).toBeGreaterThan(5);

        const granted = Array.from(DEFAULT_TOML.matchAll(/"allow-([A-Za-z0-9_-]+)"/g)).map((m) => m[1]);
        // Both spellings are in play: the current tauri-plugin build keeps the
        // command's own casing (`allow-updateMedia`), while the permission files
        // generated by an older one are kebab-cased (`allow-incoming-call`) and
        // are kept as-is because they are what the app already grants.
        const spellings = (command: string) => [
            command,
            command.toLowerCase(),
            command.replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()),
        ];

        for (const command of declared) {
            const names = spellings(command);
            expect(
                names.some((n) => granted.includes(n)),
                `${command} is not granted by permissions/default.toml (looked for allow-${names.join(', allow-')})`
            ).toBe(true);
        }

        // And the reverse direction for the commands the build script declares:
        // each one must have actually produced its permission file. A command
        // added to build.rs but never built is the same silent runtime failure.
        const commandsDir = path.join(
            ROOT,
            'src-tauri',
            'plugins',
            'call-service',
            'permissions',
            'autogenerated',
            'commands'
        );
        const listed = Array.from(BUILD_RS.matchAll(/^\s{4}"([A-Za-z0-9_]+)",$/gm)).map((m) => m[1]);
        expect(listed.length, 'build.rs must declare commands').toBeGreaterThan(5);
        for (const command of listed) {
            expect(
                fs.existsSync(path.join(commandsDir, `${command}.toml`)),
                `${command} is declared in build.rs but has no generated permission — run ` +
                    '`cargo check --manifest-path src-tauri/plugins/call-service/Cargo.toml` and commit the result'
            ).toBe(true);
            const names = spellings(command);
            expect(
                names.some((n) => granted.includes(n)),
                `${command} was generated but is missing from permissions/default.toml`
            ).toBe(true);
        }
    });

    test('PiP never throws out of a command and never guesses at the ratio', () => {
        // `enterPictureInPictureMode` rejects an aspect ratio outside 2.39:1 …
        // 1:2.39 by throwing, and the page can only send what it measured.
        expect(/MIN_RATIO\s*=\s*0\.4/.test(PIP_KT)).toBe(true);
        expect(/MAX_RATIO\s*=\s*2\.3/.test(PIP_KT)).toBe(true);
        expect(/coerceIn\(\s*MIN_RATIO\s*,\s*MAX_RATIO\s*\)/.test(PIP_KT)).toBe(true);
        expect(/catch\s*\(e:\s*Exception\)/.test(PIP_KT)).toBe(true);
        // PiP pauses the activity, which is exactly when a callback may not run.
        expect(/isInPictureInPictureMode/.test(PIP_KT)).toBe(true);
    });

    test('the PiP window keeps the page awake, and only the page decides it is over', () => {
        // The window shows the whole *activity*, and entering PiP pauses it — and
        // wry answers a paused activity by pausing the WebView
        // (`WryActivity.onPause` → `mWebView.onPause()`). A paused WebView stops
        // laying the page out, so the page never reflows for the PiP-sized window
        // and the window shows a crop of the full-screen app: the reported "PiP
        // opens a corner of the app instead of the feed", which no page-side fix
        // could reach because the page was not running at all.
        expect(
            /registerActivityLifecycleCallbacks/.test(PIP_KT),
            'the plugin has to watch the lifecycle: nothing else tells it the window opened or closed'
        ).toBe(true);
        expect(
            /onActivityPaused/.test(PIP_KT) && /onActivityStopped/.test(PIP_KT),
            'the pause is the moment to undo the WebView pause; the stop is the moment the window is gone'
        ).toBe(true);
        expect(
            /webView\.onResume\(\)/.test(PIP_KT),
            'without resuming the WebView in the PiP window the page never lays out for it'
        ).toBe(true);
        expect(
            /webView\.onPause\(\)/.test(PIP_KT),
            'the forced resume is only for the visible window — it must be handed back'
        ).toBe(true);
        // The page must not act on the one native read available: it flips only
        // *after* the activity's pause, so it reports "not in PiP" while the window
        // is still opening. Acting on it is what stranded the app.
        expect(
            VOICE_JS.includes("_pipInvoke('pipState')"),
            'voice.js must not tear the tile down on a flag that lags the window'
        ).toBe(false);
        // Instead: enter only after the lifted tile has been painted (a paused
        // WebView never repaints, so the last painted frame is what the window
        // shows), and end the session on the viewport coming back.
        expect(
            /function _afterNextPaint\(/.test(VOICE_JS),
            'the lift has to be painted before the system is asked to shrink the window'
        ).toBe(true);
        expect(/function _androidPipWindowGone\(/.test(VOICE_JS)).toBe(true);
    });

    test('the decline reaches the page, and the plugin can still be reached by name', () => {
        // The socket — and so the call — lives in the WebView. A decline that
        // only cancels the notification is the reported bug: the caller keeps
        // ringing. So the receiver must forward it, and the plugin must hold the
        // WebView it forwards into.
        expect(
            /deliverIncomingCallDecline\s*\(/.test(NOTIFIER_KT),
            'the notification receiver must forward the decline to the plugin'
        ).toBe(true);
        expect(/CallServicePlugin\.deliverIncomingCallDecline/.test(NOTIFIER_KT)).toBe(true);
        expect(
            /override\s+fun\s+load\s*\(\s*webView:\s*WebView\s*\)/.test(PLUGIN_KT),
            'the plugin has to keep the WebView it was given, or it cannot reach the page'
        ).toBe(true);
        expect(/evaluateJavascript/.test(PLUGIN_KT)).toBe(true);
        // …and the page half the evaluateJavascript call looks for.
        expect(
            /window\.__e2eDeclineIncomingCall\s*=/.test(VOICE_JS),
            'voice.js must expose the hook the native decline calls'
        ).toBe(true);
        // The channel/browser both need it: a broadcast receiver that throws can
        // take the process with it on some OEMs.
        expect(/class\s+IncomingCallActionReceiver[\s\S]*?catch\s*\(/.test(NOTIFIER_KT)).toBe(true);
    });

    test('the ring channel carries the app\u2019s pattern and the page reads the ringer mode', () => {
        // A channel's vibration pattern is fixed at creation, so the only way for
        // the phone's buzz to match Settings → Voice → Haptics is a channel keyed
        // by the pattern (with the previous one deleted).
        expect(/CHANNEL_PREFIX\s*=\s*"e2e_incoming_call"/.test(NOTIFIER_KT)).toBe(true);
        expect(/vibrationPattern\s*=/.test(NOTIFIER_KT)).toBe(true);
        expect(/deleteNotificationChannel/.test(NOTIFIER_KT)).toBe(true);
        // The ringer mode + interruption filter the page gates its own ringtone
        // and cues on.
        expect(/RINGER_MODE_SILENT/.test(PROFILE_KT)).toBe(true);
        expect(/RINGER_MODE_VIBRATE/.test(PROFILE_KT)).toBe(true);
        expect(/currentInterruptionFilter/.test(PROFILE_KT)).toBe(true);
        expect(/window\.__e2eDeclineIncomingCall|__e2eDeclineIncomingCall/.test(VOICE_JS)).toBe(true);
        expect(/getAudioProfile/.test(VOICE_JS)).toBe(true);
    });
});
