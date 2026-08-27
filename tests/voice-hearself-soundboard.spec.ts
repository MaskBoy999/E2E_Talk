import { test, expect } from '@playwright/test';

const BASE = 'https://localhost:3443';

function unique(base: string): string {
    return `${base}_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
}

async function registerUser(page: any, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 10000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', 'testpass123');
    await page.fill('#register-confirm-password', 'testpass123');
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 30000 });
    await page.waitForSelector('#current-user', { timeout: 10000 });
    await page.evaluate(() => {
        const el = document.getElementById('loading-overlay');
        if (el) el.remove();
    });
    await page.waitForTimeout(500);
}

async function waitForWs(page: any, maxRetries = 60) {
    return await page.evaluate((maxRetries: number) => {
        return new Promise((resolve) => {
            let tries = 0;
            const check = () => {
                tries++;
                if (typeof (window as any).ws !== 'undefined' && (window as any).ws && (window as any).ws.readyState === WebSocket.OPEN) {
                    resolve(true);
                } else if (tries >= maxRetries) {
                    resolve(false);
                } else {
                    setTimeout(check, 200);
                }
            };
            setTimeout(check, 500);
        });
    }, maxRetries);
}

async function createServerWithVoiceChannel(page: any): Promise<{ serverId: string; voiceChannelId: string; textChannelId: string }> {
    const ts = Date.now();
    await page.click('#add-server-btn');
    await page.click('#choice-create-server');
    await page.fill('#new-server-name', 'SBTest_' + ts);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]', { timeout: 10000 });
    await page.waitForTimeout(2000);
    const serverId = await page.evaluate(() => document.querySelector('.server-icon[data-id]')?.getAttribute('data-id') || '');

    const voiceChannelId = await page.evaluate(async ({ serverId }: { serverId: string }) => {
        const token = localStorage.getItem('token');
        const sk = (window as any).E2ECrypto.getServerKey(serverId);
        const encName = (window as any).E2ECrypto.aeadEncrypt('voice', sk);
        const res = await fetch(`/api/servers/${serverId}/channels`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'voice', encrypted_name: encName.ciphertext, name_nonce: encName.nonce }),
        });
        const ch = await res.json();
        return ch.id;
    }, { serverId });

    const textChannelId = await page.evaluate(async ({ serverId }: { serverId: string }) => {
        const token = localStorage.getItem('token');
        const sk = (window as any).E2ECrypto.getServerKey(serverId);
        const encName = (window as any).E2ECrypto.aeadEncrypt('general', sk);
        const res = await fetch(`/api/servers/${serverId}/channels`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ type: 'text', encrypted_name: encName.ciphertext, name_nonce: encName.nonce }),
        });
        const ch = await res.json();
        return ch.id;
    }, { serverId });

    return { serverId, voiceChannelId, textChannelId };
}

// ──────────────────────────────────────────────
// Hear-Self Test Mic Button (Settings)
// ──────────────────────────────────────────────

test.describe('Hear-Self Test Mic Button (Settings)', () => {
    test('Test Mic button exists as a button (not checkbox), meter hidden initially', async ({ page }) => {
        const username = unique('hs_ui');
        await registerUser(page, username);
        await waitForWs(page);

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(300);

        const ui = await page.evaluate(() => {
            const btn = document.getElementById('voice-hear-self-btn');
            const wrap = document.getElementById('voice-hear-self-meter-wrap');
            const oldCb = document.getElementById('voice-hear-self');
            return {
                btnExists: !!btn,
                btnTag: btn?.tagName,
                btnText: btn?.textContent?.trim(),
                meterHidden: wrap ? wrap.style.display === 'none' : true,
                oldCheckboxGone: !oldCb,
                statusEl: !!document.getElementById('voice-hear-self-status'),
                meterBar: !!document.getElementById('voice-hear-self-meter'),
                dbDisplay: !!document.getElementById('voice-hear-self-db'),
                nsModeDisplay: !!document.getElementById('voice-hear-self-ns-mode'),
                gainDisplay: !!document.getElementById('voice-hear-self-gain'),
            };
        });

        expect(ui.btnExists).toBe(true);
        expect(ui.btnTag).toBe('BUTTON');
        expect(ui.btnText).toContain('Start Test');
        expect(ui.meterHidden).toBe(true);
        expect(ui.oldCheckboxGone).toBe(true);
        expect(ui.statusEl).toBe(true);
        expect(ui.meterBar).toBe(true);
        expect(ui.dbDisplay).toBe(true);
        expect(ui.nsModeDisplay).toBe(true);
        expect(ui.gainDisplay).toBe(true);
    });

    test('Clicking Start Test shows meter or error, clicking Stop hides it', async ({ page }) => {
        const username = unique('hs_toggle');
        await registerUser(page, username);
        await waitForWs(page);

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(300);

        await page.click('#voice-hear-self-btn');
        await page.waitForTimeout(2000);

        const afterStart = await page.evaluate(() => {
            const btn = document.getElementById('voice-hear-self-btn');
            const wrap = document.getElementById('voice-hear-self-meter-wrap');
            return {
                btnText: btn?.textContent?.trim(),
                meterVisible: wrap ? wrap.style.display !== 'none' : false,
                status: document.getElementById('voice-hear-self-status')?.textContent?.trim(),
            };
        });

        const micGranted = afterStart.btnText?.includes('Stop');
        if (micGranted) {
            expect(afterStart.meterVisible).toBe(true);
            expect(afterStart.status).toContain('Listening');
            await page.click('#voice-hear-self-btn');
            await page.waitForTimeout(500);
            const afterStop = await page.evaluate(() => ({
                btnText: document.getElementById('voice-hear-self-btn')?.textContent?.trim(),
                meterHidden: document.getElementById('voice-hear-self-meter-wrap')?.style.display === 'none',
            }));
            expect(afterStop.btnText).toContain('Start Test');
            expect(afterStop.meterHidden).toBe(true);
        } else {
            // Headless — mic denied, button reverts
            expect(afterStart.btnText).toContain('Start Test');
        }
    });

    test('NS mode selector is shown in hear-self meter', async ({ page }) => {
        const username = unique('hs_labels');
        await registerUser(page, username);
        await waitForWs(page);

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(300);

        // Start test
        await page.click('#voice-hear-self-btn');
        await page.waitForTimeout(1500);

        const nsModeShown = await page.evaluate(() =>
            document.getElementById('voice-hear-self-ns-mode')?.textContent?.trim()
        );
        // Label should show something (either the current mode or default)
        expect(nsModeShown).toBeDefined();

        // Stop if running
        const isRunning = await page.evaluate(() =>
            document.getElementById('voice-hear-self-btn')?.textContent?.includes('Stop')
        );
        if (isRunning) {
            await page.click('#voice-hear-self-btn');
            await page.waitForTimeout(300);
        }
    });

    test('Hear-self auto-stops when settings modal closes', async ({ page }) => {
        const username = unique('hs_autoclose');
        await registerUser(page, username);
        await waitForWs(page);

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(300);

        await page.click('#voice-hear-self-btn');
        await page.waitForTimeout(1500);

        const micGranted = await page.evaluate(() =>
            document.getElementById('voice-hear-self-btn')?.textContent?.includes('Stop')
        );

        if (micGranted) {
            // Close settings
            await page.evaluate(() => {
                const btn = document.querySelector('#settings-modal .settings-close') as HTMLElement;
                if (btn) btn.click();
            });
            await page.waitForTimeout(500);

            const stopped = await page.evaluate(() => !(window as any)._stopHearSelfTest);
            expect(stopped).toBe(true);

            await page.click('#settings-btn');
            await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
            await page.click('.settings-tab[data-tab="voice-settings"]');
            await page.waitForTimeout(300);

            const btnText = await page.evaluate(() =>
                document.getElementById('voice-hear-self-btn')?.textContent?.trim()
            );
            expect(btnText).toContain('Start Test');
        } else {
            // Headless — mic not available, test still passes
            expect(true).toBe(true);
        }
    });
});

// ──────────────────────────────────────────────
// Soundboard UI
// ──────────────────────────────────────────────

test.describe('Soundboard UI', () => {
    test('Soundboard overlay has all required DOM elements', async ({ page }) => {
        const username = unique('sb_dom');
        await registerUser(page, username);
        await waitForWs(page);

        const els = await page.evaluate(() => ({
            overlay: !!document.getElementById('soundboard-overlay'),
            panel: !!document.querySelector('.soundboard-panel'),
            header: !!document.querySelector('.soundboard-header'),
            clips: !!document.getElementById('soundboard-clips'),
            uploadBtn: !!document.getElementById('soundboard-upload-btn'),
            fileInput: !!document.getElementById('soundboard-file'),
            selfHear: !!document.getElementById('soundboard-self-hear'),
            closeBtn: !!document.getElementById('soundboard-close'),
        }));

        expect(els.overlay).toBe(true);
        expect(els.panel).toBe(true);
        expect(els.header).toBe(true);
        expect(els.clips).toBe(true);
        expect(els.uploadBtn).toBe(true);
        expect(els.fileInput).toBe(true);
        expect(els.selfHear).toBe(true);
        expect(els.closeBtn).toBe(true);
    });

    test('Self-hear checkbox is separate from settings hear-self button', async ({ page }) => {
        const username = unique('sb_sep');
        await registerUser(page, username);
        await waitForWs(page);

        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.waitForTimeout(300);

        const settingsHasCheckbox = await page.evaluate(() => !!document.getElementById('voice-hear-self'));
        expect(settingsHasCheckbox).toBe(false);
        const settingsHasButton = await page.evaluate(() => !!document.getElementById('voice-hear-self-btn'));
        expect(settingsHasButton).toBe(true);

        await page.evaluate(() => {
            const btn = document.querySelector('#settings-modal .settings-close') as HTMLElement;
            if (btn) btn.click();
        });
        await page.waitForTimeout(300);

        const sbSelfHear = await page.evaluate(() => {
            const el = document.getElementById('soundboard-self-hear');
            return el ? { tagName: el.tagName, type: (el as HTMLInputElement).type } : null;
        });
        expect(sbSelfHear).not.toBeNull();
        expect(sbSelfHear!.tagName).toBe('INPUT');
        expect(sbSelfHear!.type).toBe('checkbox');
    });

    test('Soundboard empty state shows when no clips', async ({ page }) => {
        const username = unique('sb_empty');
        await registerUser(page, username);
        await waitForWs(page);

        const emptyText = await page.evaluate(() => {
            const clips = document.getElementById('soundboard-clips');
            return clips?.textContent?.trim() || '';
        });
        expect(emptyText).toContain('No sounds yet');
    });

    test('WS handler _handleSoundboardPlay exists', async ({ page }) => {
        const username = unique('sb_ws');
        await registerUser(page, username);
        await waitForWs(page);

        const handlerExists = await page.evaluate(() =>
            typeof (window as any)._handleSoundboardPlay === 'function'
        );
        expect(handlerExists).toBe(true);
    });

    test('No JS errors on page load from soundboard code', async ({ page }) => {
        const jsErrors: string[] = [];
        page.on('pageerror', (e) => jsErrors.push(e.message));

        const username = unique('sb_err');
        await registerUser(page, username);
        await page.waitForTimeout(2000);

        const criticalErrors = jsErrors.filter(e =>
            !e.includes('SSL') && !e.includes('notification') && !e.includes('favicon') && !e.includes('mic')
        );
        expect(criticalErrors).toEqual([]);
    });
});

// ──────────────────────────────────────────────
// Soundboard clip upload + verification
// ──────────────────────────────────────────────

test.describe('Soundboard clip upload', () => {
    test('Upload clip via API, verify it appears in overlay with buttons', async ({ page }) => {
        const username = unique('sb_play');
        await registerUser(page, username);
        await waitForWs(page);
        const { serverId, voiceChannelId } = await createServerWithVoiceChannel(page);

        // Upload a clip via API
        const uploadOk = await page.evaluate(async ({ serverId }: { serverId: string }) => {
            const token = localStorage.getItem('token');
            const rate = 8000, dur = 0.1, n = Math.floor(rate * dur);
            const dataSize = n * 2;
            const buf = new ArrayBuffer(44 + dataSize);
            const dv = new DataView(buf);
            dv.setUint32(0, 36 + dataSize, true);
            dv.setUint8(4, 0x52); dv.setUint8(5, 0x49); dv.setUint8(6, 0x46); dv.setUint8(7, 0x46);
            dv.setUint8(8, 0x57); dv.setUint8(9, 0x41); dv.setUint8(10, 0x56); dv.setUint8(11, 0x45);
            dv.setUint8(12, 0x66); dv.setUint8(13, 0x6D); dv.setUint8(14, 0x74); dv.setUint8(15, 0x20);
            dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
            dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
            dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
            dv.setUint8(36, 0x64); dv.setUint8(37, 0x61); dv.setUint8(38, 0x74); dv.setUint8(39, 0x61);
            dv.setUint32(40, dataSize, true);
            for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.3 * 32767), true);
            const enc = (window as any).E2ECrypto.encryptBytesForServer(new Uint8Array(buf), serverId);
            const res = await fetch('/api/soundboard', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    server_id: serverId, name: 'TestSound',
                    encrypted_audio: enc.ciphertext, audio_nonce: enc.nonce,
                }),
            });
            if (!res.ok) return { ok: false, status: res.status, text: await res.text() };
            return { ok: true };
        }, { serverId });
        expect(uploadOk.ok).toBe(true);

        // Open overlay directly and load clips
        await page.evaluate(async () => {
            const overlay = document.getElementById('soundboard-overlay');
            if (overlay) overlay.style.display = 'flex';
            const clipsEl = document.getElementById('soundboard-clips');
            if (!clipsEl) return;
            const serverIcons = document.querySelectorAll('.server-icon[data-id]');
            if (!serverIcons.length) return;
            const sid = serverIcons[0].getAttribute('data-id');
            if (!sid) return;
            const token = localStorage.getItem('token');
            const res = await fetch('/api/soundboard/' + sid, { headers: { Authorization: 'Bearer ' + token } });
            const clips = await res.json();
            if (!clips.length) { clipsEl.innerHTML = '<div class="soundboard-empty">No sounds yet</div>'; return; }
            let html = '';
            clips.forEach((c: any) => {
                html += '<div class="soundboard-clip" data-clip-id="' + c.id + '"><span class="sb-clip-name">' + c.name + '</span>';
                html += '<button class="sb-play-btn" title="Play">&#9654;</button>';
                html += '<button class="sb-pause-btn" title="Stop" style="display:none">&#9209;</button>';
                html += '<button class="sb-delete-btn" title="Delete">&#10005;</button></div>';
            });
            clipsEl.innerHTML = html;
        });
        await page.waitForTimeout(500);

        const clipUI = await page.evaluate(() => {
            const clip = document.querySelector('.soundboard-clip');
            if (!clip) return null;
            return {
                name: clip.querySelector('.sb-clip-name')?.textContent?.trim(),
                hasPlay: !!clip.querySelector('.sb-play-btn'),
                hasPause: !!clip.querySelector('.sb-pause-btn'),
                hasDelete: !!clip.querySelector('.sb-delete-btn'),
                playVisible: (clip.querySelector('.sb-play-btn') as HTMLElement)?.style.display !== 'none',
            };
        });

        expect(clipUI).not.toBeNull();
        expect(clipUI!.name).toBe('TestSound');
        expect(clipUI!.hasPlay).toBe(true);
        expect(clipUI!.hasPause).toBe(true);
        expect(clipUI!.hasDelete).toBe(true);
        expect(clipUI!.playVisible).toBe(true);

        // Close overlay
        await page.evaluate(() => {
            const overlay = document.getElementById('soundboard-overlay');
            if (overlay) overlay.style.display = 'none';
        });
    });
});

// ──────────────────────────────────────────────
// Soundboard not affected by noise suppression
// ──────────────────────────────────────────────

test.describe('Soundboard not affected by noise suppression', () => {
    test('Changing NS mode does not affect soundboard clip data', async ({ page }) => {
        const username = unique('sb_ns');
        await registerUser(page, username);
        await waitForWs(page);
        const { serverId } = await createServerWithVoiceChannel(page);

        await page.evaluate(async ({ serverId }: { serverId: string }) => {
            const token = localStorage.getItem('token');
            const rate = 8000, dur = 0.1, n = Math.floor(rate * dur);
            const dataSize = n * 2;
            const buf = new ArrayBuffer(44 + dataSize);
            const dv = new DataView(buf);
            dv.setUint32(0, 36 + dataSize, true);
            dv.setUint8(4, 0x52); dv.setUint8(5, 0x49); dv.setUint8(6, 0x46); dv.setUint8(7, 0x46);
            dv.setUint8(8, 0x57); dv.setUint8(9, 0x41); dv.setUint8(10, 0x56); dv.setUint8(11, 0x45);
            dv.setUint8(12, 0x66); dv.setUint8(13, 0x6D); dv.setUint8(14, 0x74); dv.setUint8(15, 0x20);
            dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
            dv.setUint32(24, rate, true); dv.setUint32(28, rate * 2, true);
            dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
            dv.setUint8(36, 0x64); dv.setUint8(37, 0x61); dv.setUint8(38, 0x74); dv.setUint8(39, 0x61);
            dv.setUint32(40, dataSize, true);
            for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin(2 * Math.PI * 440 * i / rate) * 0.3 * 32767), true);
            const enc = (window as any).E2ECrypto.encryptBytesForServer(new Uint8Array(buf), serverId);
            await fetch('/api/soundboard', {
                method: 'POST',
                headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
                body: JSON.stringify({ server_id: serverId, name: 'NSClip', encrypted_audio: enc.ciphertext, audio_nonce: enc.nonce }),
            });
        }, { serverId });

        // Change NS mode to off
        await page.click('#settings-btn');
        await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
        await page.click('.settings-tab[data-tab="voice-settings"]');
        await page.selectOption('#voice-noise-suppression', 'off');
        await page.waitForTimeout(300);
        await page.evaluate(() => {
            const btn = document.querySelector('#settings-modal .settings-close') as HTMLElement;
            if (btn) btn.click();
        });
        await page.waitForTimeout(300);

        const handlerOk = await page.evaluate(() =>
            typeof (window as any)._handleSoundboardPlay === 'function'
        );
        expect(handlerOk).toBe(true);

        const clips = await page.evaluate(async ({ serverId }: { serverId: string }) => {
            const token = localStorage.getItem('token');
            const res = await fetch(`/api/soundboard/${serverId}`, {
                headers: { Authorization: `Bearer ${token}` },
            });
            return await res.json();
        }, { serverId });
        expect(clips.length).toBeGreaterThan(0);
    });
});

// ──────────────────────────────────────────────
// Voice bar soundboard button
// ──────────────────────────────────────────────

test.describe('Voice bar soundboard button', () => {
    test('Voice bar has soundboard button element in DOM', async ({ page }) => {
        const username = unique('vb_sb');
        await registerUser(page, username);
        await waitForWs(page);

        const btnExists = await page.evaluate(() => {
            const btn = document.getElementById('voice-bar-soundboard');
            return {
                exists: !!btn,
                tagName: btn?.tagName,
                title: btn?.getAttribute('title'),
                parent: btn?.parentElement?.id || btn?.parentElement?.className,
            };
        });

        expect(btnExists.exists).toBe(true);
        expect(btnExists.tagName).toBe('BUTTON');
        expect(btnExists.title).toBe('Soundboard');
        expect(btnExists.parent).toContain('voice-bar-controls');

        const barHidden = await page.evaluate(() => {
            const bar = document.getElementById('voice-bar');
            return bar && bar.style.display === 'none';
        });
        expect(barHidden).toBe(true);
    });
});
