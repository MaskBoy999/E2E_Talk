import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Android keeps app data out of the OS backup pipeline — but the file that has
 * to say so is generated, not committed.
 *
 * `src-tauri/gen/android/` is in `src-tauri/.gitignore` (it bakes absolute
 * machine paths into tauri.settings.gradle), so the app manifest exists only
 * after `npx tauri android init` runs — and android.yml does exactly that on
 * every CI run. That template leaves android:allowBackup unset, and Android's
 * default is TRUE, which puts /data/data/<pkg>/app_webview/ (the whole
 * encrypted localStorage) into Auto Backup, device-to-device transfer and, on
 * older builds, `adb backup`.
 *
 * So the attribute has to be applied in TWO places, and both are asserted
 * here: in the generated file when it exists (local builds), and in the
 * workflow step that injects it (every CI build — the only path that ships).
 */

const ROOT = path.join(__dirname, '..');
const WORKFLOW = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'android.yml'), 'utf8');
const GITIGNORE = fs.readFileSync(path.join(ROOT, 'src-tauri', '.gitignore'), 'utf8');
const MANIFEST_PATH = path.join(ROOT, 'src-tauri', 'gen', 'android', 'app', 'src', 'main', 'AndroidManifest.xml');

test.describe('Android app data never reaches the OS backup pipeline', () => {
    test('the Android project is gitignored, so CI must patch the generated manifest', () => {
        // If this ever stops being ignored the workflow step becomes optional —
        // but only if the committed manifest is also correct. Assert the reason
        // the injection step exists, so nobody deletes it as dead weight.
        expect(GITIGNORE).toMatch(/gen\/android\//);
        expect(WORKFLOW).toContain('tauri android init');
        expect(WORKFLOW).toContain('android:allowBackup="false"');
        expect(WORKFLOW).toContain('android:fullBackupContent="false"');
    });

    test('the injection step runs after init, before the build, and cannot no-op silently', () => {
        const initIdx = WORKFLOW.indexOf('Init Android project');
        const patchIdx = WORKFLOW.indexOf('Disable Android auto-backup of app data');
        const buildIdx = WORKFLOW.indexOf('name: Build APK');
        expect(initIdx, 'the init step exists').toBeGreaterThanOrEqual(0);
        expect(patchIdx, 'the backup-hardening step exists').toBeGreaterThan(initIdx);
        expect(buildIdx, 'hardening happens before the build').toBeGreaterThan(patchIdx);

        // A sed that matches nothing must fail the job, not ship an unpatched
        // APK: the step re-reads the file and errors if the attribute is absent,
        // and it refuses (rather than overwriting) if it is present but wrong.
        const step = WORKFLOW.slice(patchIdx, buildIdx);
        expect(step).toContain('set -euo pipefail');
        expect(step).toMatch(/if ! grep -q 'android:allowBackup="false"/);
        expect(step).toContain('::error::');
    });

    test('a generated manifest present on this machine declares it too', () => {
        // Only meaningful where `tauri android init` has been run; on a fresh
        // clone the file does not exist and the workflow step is the sole
        // enforcement, which the two tests above already cover.
        if (!fs.existsSync(MANIFEST_PATH)) return;
        const manifest = fs.readFileSync(MANIFEST_PATH, 'utf8');
        expect(manifest).toContain('android:allowBackup="false"');
        expect(manifest).toContain('android:fullBackupContent="false"');
        // Never opt back in.
        expect(manifest).not.toMatch(/android:allowBackup="true"/);
        expect(manifest).not.toMatch(/android:fullBackupContent="@xml\//);
    });
});
