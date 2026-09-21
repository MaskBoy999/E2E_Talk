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
