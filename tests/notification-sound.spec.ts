import { test, expect } from '@playwright/test';
import { createHash } from 'crypto';

const BASE = 'https://localhost:3443';

function makeMinimalWav(): Buffer {
    const sampleRate = 8000;
    const duration = 0.3;
    const numSamples = Math.floor(sampleRate * duration);
    const dataSize = numSamples;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + dataSize, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(sampleRate, 28);
    header.writeUInt16LE(1, 32);
    header.writeUInt16LE(8, 34);
    header.write('data', 36);
    header.writeUInt32LE(dataSize, 40);
    const data = Buffer.alloc(dataSize, 128);
    return Buffer.concat([header, data]);
}

test.describe('Notification Sound', () => {

    test('upload + test sound plays custom sound, not default fallback', async ({ page }) => {
        const ts = Date.now();
        const username = 'ns_alice_' + ts;

        const consoleMsgs: string[] = [];
        page.on('console', msg => consoleMsgs.push(msg.text()));
        page.on('pageerror', err => consoleMsgs.push('PAGE_ERROR: ' + err.message));

        // Register
        await page.goto(`${BASE}/login.html`);
        await page.click('#show-register');
        await page.fill('#register-username', username);
        await page.fill('#register-password', 'password123');
        await page.click('#register-form button[type="submit"]');
        await page.waitForURL('**/index.html', { timeout: 15000 });
        await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });

        // Open settings → Notifications tab
        await page.click('#settings-btn');
        await page.waitForTimeout(500);
        await page.click('.settings-tab[data-tab="notification-settings"]');
        await page.waitForTimeout(300);

        // Upload WAV
        const wavBuffer = makeMinimalWav();
        await page.locator('#notif-sound-input').setInputFiles({
            name: 'test.wav',
            mimeType: 'audio/wav',
            buffer: wavBuffer,
        });
        await page.waitForTimeout(1000);

        // Verify upload success
        await expect(page.locator('#notif-sound-file-name')).toBeVisible();
        const fileNameText = await page.locator('#notif-sound-file-name').textContent();
        expect(fileNameText).toContain('test.wav');

        // Click Test Sound
        await page.click('#notif-sound-test-btn');
        await page.waitForTimeout(2000);

        // Debug: log console messages
        for (const m of consoleMsgs) console.log('  [CONSOLE]', m);

        // CRITICAL: playDefaultChime must NOT have been called
        const defaultCalls = consoleMsgs.filter(m => m.includes('Default chime'));
        expect(defaultCalls.length).toBe(0, 'Custom sound should play, not default chime. Console: ' + consoleMsgs.join(' | '));
    });

});
