import { test, expect } from '@playwright/test';

// Helper: register a user and return credentials
async function registerUser(page: any, username: string, password: string) {
    username = username + '_' + Date.now().toString(36);
    await page.goto('https://localhost:3443/login.html');
    await page.waitForSelector('#show-register');
    await page.click('#show-register');
    await page.fill('#register-username', username);
    await page.fill('#register-password', password);
    await page.fill('#register-confirm-password', password);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 10000 });
}

// Helper: create a server and get invite code.
//
// The "+" in the server rail opens the *choice* modal first (Create or Join) and
// only then the create form — this helper used to expect `#create-server-modal`
// to appear directly, so every test below it failed on a click that was working
// exactly as designed (the app's own suite reaches `#choice-create-server`).
async function createServer(page: any, serverName: string) {
    await page.click('#add-server-btn');
    await page.waitForSelector('#server-choice-modal', { state: 'visible' });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'visible' });
    await page.fill('#new-server-name', serverName);
    await page.click('#confirm-create-server');
    await page.waitForTimeout(1000);
    // Creating a server is not the same as being *in* one: the composer (and
    // therefore `#attach-btn` and the upload modal this suite is about) only
    // exists once a channel is open. Every test below used to look for those
    // controls with no channel selected, which is why they all timed out on a
    // button that was simply not on screen.
    // The rail and the channel list arrive over the socket, so wait for the new
    // server to be *rendered* before clicking it, and for its channels (which
    // load after the server) before clicking one.
    await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 15000 });
    await page.waitForTimeout(800);
    await page.evaluate(() => {
        const icons = document.querySelectorAll('.server-icon:not(.add-server)');
        if (icons.length) (icons[icons.length - 1] as HTMLElement).click();
    });
    await page.waitForSelector('.channel-item', { timeout: 15000 });
    await page.evaluate(() => {
        const ch = document.querySelector('.channel-item') as HTMLElement | null;
        if (ch) ch.click();
    });
    await page.waitForSelector('#attach-btn', { state: 'visible', timeout: 15000 });
}

test.describe('Media Features', () => {
    test.describe('Upload Modal - Multi-file Support', () => {
        test('file input should accept multiple files', async ({ page }) => {
            await registerUser(page, 'media_tester', 'TestPass123!');
            await createServer(page, 'Media Test Server');
            
            // Check that file input has multiple attribute
            const fileInput = page.locator('#file-input');
            await expect(fileInput).toHaveAttribute('multiple');
        });

        test('attach button should be clickable when channel is selected', async ({ page }) => {
            await registerUser(page, 'media_tester2', 'TestPass123!');
            await createServer(page, 'Media Test Server 2');
            
            // A channel should be auto-selected
            const attachBtn = page.locator('#attach-btn');
            await expect(attachBtn).toBeVisible();
            await expect(attachBtn).not.toBeDisabled();
        });

        test('upload modal should have gallery navigation elements when multiple files selected', async ({ page }) => {
            await registerUser(page, 'media_tester3', 'TestPass123!');
            await createServer(page, 'Media Test Server 3');
            
            // Listen for file chooser event
            // The "+" opens the attach menu; the file input is behind its
            // "Upload Files" entry now (the popup was added after these tests
            // were written, and they had been waiting for a chooser that the
            // button no longer opens directly).
            const fileChooserPromise = page.waitForEvent('filechooser');
            await page.click('#attach-btn');
            await page.click('.attach-popup-item[data-action="upload"]');
            const fileChooser = await fileChooserPromise;
            
            // Create test files
            await fileChooser.setFiles([
                { name: 'test1.png', mimeType: 'image/png', buffer: Buffer.from('fake-image-data-1') },
                { name: 'test2.png', mimeType: 'image/png', buffer: Buffer.from('fake-image-data-2') },
            ]);
            
            // Upload modal should appear
            const modal = page.locator('#upload-modal');
            await expect(modal).toBeVisible();
            
            // Should show file count
            const confirmBtn = page.locator('#confirm-upload');
            await expect(confirmBtn).toContainText('Upload All (2)');
        });
    });

    test.describe('Video Controls - Volume', () => {
        test('video controls should have volume slider', async ({ page }) => {
            // The controls live on the app page, which is behind the auth guard:
            // `goto(index.html)` with no session lands back on the login screen,
            // so these tests used to assert against a page with none of the
            // elements on it.
            await registerUser(page, 'media_ui', 'TestPass123!');
            
            // Volume control should exist in the HTML
            const volumeControl = page.locator('#video-controls #vc-volume').locator('..');
            await expect(volumeControl).toBeAttached();
        });

        test('volume slider should be functional', async ({ page }) => {
            // The controls live on the app page, which is behind the auth guard:
            // `goto(index.html)` with no session lands back on the login screen,
            // so these tests used to assert against a page with none of the
            // elements on it.
            await registerUser(page, 'media_ui', 'TestPass123!');
            
            const volumeSlider = page.locator('#vc-volume');
            await expect(volumeSlider).toBeAttached();
            await expect(volumeSlider).toHaveAttribute('min', '0');
            await expect(volumeSlider).toHaveAttribute('max', '100');
        });

        test('mute button should exist', async ({ page }) => {
            // The controls live on the app page, which is behind the auth guard:
            // `goto(index.html)` with no session lands back on the login screen,
            // so these tests used to assert against a page with none of the
            // elements on it.
            await registerUser(page, 'media_ui', 'TestPass123!');
            
            const muteBtn = page.locator('#vc-mute');
            await expect(muteBtn).toBeAttached();
        });
    });

    test.describe('Audio Controls', () => {
        test('audio controls should exist in the DOM', async ({ page }) => {
            // The controls live on the app page, which is behind the auth guard:
            // `goto(index.html)` with no session lands back on the login screen,
            // so these tests used to assert against a page with none of the
            // elements on it.
            await registerUser(page, 'media_ui', 'TestPass123!');
            
            const audioControls = page.locator('#audio-controls');
            await expect(audioControls).toBeAttached();
        });

        test('audio controls should have play/pause button', async ({ page }) => {
            // The controls live on the app page, which is behind the auth guard:
            // `goto(index.html)` with no session lands back on the login screen,
            // so these tests used to assert against a page with none of the
            // elements on it.
            await registerUser(page, 'media_ui', 'TestPass123!');
            
            const playPauseBtn = page.locator('#ac-play-pause');
            await expect(playPauseBtn).toBeAttached();
        });

        test('audio controls should have volume slider', async ({ page }) => {
            // The controls live on the app page, which is behind the auth guard:
            // `goto(index.html)` with no session lands back on the login screen,
            // so these tests used to assert against a page with none of the
            // elements on it.
            await registerUser(page, 'media_ui', 'TestPass123!');
            
            const volumeSlider = page.locator('#ac-volume');
            await expect(volumeSlider).toBeAttached();
            await expect(volumeSlider).toHaveAttribute('min', '0');
            await expect(volumeSlider).toHaveAttribute('max', '100');
        });

        test('audio controls should have seek bar', async ({ page }) => {
            // The controls live on the app page, which is behind the auth guard:
            // `goto(index.html)` with no session lands back on the login screen,
            // so these tests used to assert against a page with none of the
            // elements on it.
            await registerUser(page, 'media_ui', 'TestPass123!');
            
            const seekInput = page.locator('#ac-seek');
            await expect(seekInput).toBeAttached();
        });

        test('audio controls should have time display', async ({ page }) => {
            // The controls live on the app page, which is behind the auth guard:
            // `goto(index.html)` with no session lands back on the login screen,
            // so these tests used to assert against a page with none of the
            // elements on it.
            await registerUser(page, 'media_ui', 'TestPass123!');
            
            const timeDisplay = page.locator('#ac-time');
            await expect(timeDisplay).toBeAttached();
            await expect(timeDisplay).toContainText('0:00');
        });
    });

    test.describe('Media Viewer', () => {
        test('media viewer should have close button', async ({ page }) => {
            // The controls live on the app page, which is behind the auth guard:
            // `goto(index.html)` with no session lands back on the login screen,
            // so these tests used to assert against a page with none of the
            // elements on it.
            await registerUser(page, 'media_ui', 'TestPass123!');
            
            const closeBtn = page.locator('#media-viewer-close');
            await expect(closeBtn).toBeAttached();
        });

        test('media viewer should have backdrop', async ({ page }) => {
            // The controls live on the app page, which is behind the auth guard:
            // `goto(index.html)` with no session lands back on the login screen,
            // so these tests used to assert against a page with none of the
            // elements on it.
            await registerUser(page, 'media_ui', 'TestPass123!');
            
            const backdrop = page.locator('#media-viewer-backdrop');
            await expect(backdrop).toBeAttached();
        });

        test('media viewer should be hidden by default', async ({ page }) => {
            // The controls live on the app page, which is behind the auth guard:
            // `goto(index.html)` with no session lands back on the login screen,
            // so these tests used to assert against a page with none of the
            // elements on it.
            await registerUser(page, 'media_ui', 'TestPass123!');
            
            const viewer = page.locator('#media-viewer');
            await expect(viewer).toBeHidden();
        });
    });

    test.describe('Upload Preview Gallery', () => {
        test('upload modal should show gallery navigation for multiple files', async ({ page }) => {
            await registerUser(page, 'gallery_tester', 'TestPass123!');
            await createServer(page, 'Gallery Test Server');
            
            // The "+" opens the attach menu; the file input is behind its
            // "Upload Files" entry now (the popup was added after these tests
            // were written, and they had been waiting for a chooser that the
            // button no longer opens directly).
            const fileChooserPromise = page.waitForEvent('filechooser');
            await page.click('#attach-btn');
            await page.click('.attach-popup-item[data-action="upload"]');
            const fileChooser = await fileChooserPromise;
            
            await fileChooser.setFiles([
                { name: 'photo1.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-jpeg-data-1') },
                { name: 'photo2.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-jpeg-data-2') },
                { name: 'photo3.jpg', mimeType: 'image/jpeg', buffer: Buffer.from('fake-jpeg-data-3') },
            ]);
            
            // Modal should show
            const modal = page.locator('#upload-modal');
            await expect(modal).toBeVisible();
            
            // Gallery counter should show "1 / 3"
            const counter = page.locator('.gallery-counter');
            await expect(counter).toContainText('1 / 3');
            
            // Next button should be clickable
            const nextBtn = page.locator('#gallery-next');
            await expect(nextBtn).toBeVisible();
            await expect(nextBtn).toBeEnabled();
        });

        test('gallery navigation should move between files', async ({ page }) => {
            await registerUser(page, 'gallery_nav', 'TestPass123!');
            await createServer(page, 'Gallery Nav Server');
            
            // The "+" opens the attach menu; the file input is behind its
            // "Upload Files" entry now (the popup was added after these tests
            // were written, and they had been waiting for a chooser that the
            // button no longer opens directly).
            const fileChooserPromise = page.waitForEvent('filechooser');
            await page.click('#attach-btn');
            await page.click('.attach-popup-item[data-action="upload"]');
            const fileChooser = await fileChooserPromise;
            
            await fileChooser.setFiles([
                { name: 'img1.png', mimeType: 'image/png', buffer: Buffer.from('data1') },
                { name: 'img2.png', mimeType: 'image/png', buffer: Buffer.from('data2') },
            ]);
            
            const modal = page.locator('#upload-modal');
            await expect(modal).toBeVisible();
            
            // Initially on file 1
            const counter = page.locator('.gallery-counter');
            await expect(counter).toContainText('1 / 2');
            
            // Navigate to next
            await page.click('#gallery-next');
            await expect(counter).toContainText('2 / 2');
            
            // Navigate back
            await page.click('#gallery-prev');
            await expect(counter).toContainText('1 / 2');
        });

        test('gallery should disable prev button on first item', async ({ page }) => {
            await registerUser(page, 'gallery_first', 'TestPass123!');
            await createServer(page, 'Gallery First Server');
            
            // The "+" opens the attach menu; the file input is behind its
            // "Upload Files" entry now (the popup was added after these tests
            // were written, and they had been waiting for a chooser that the
            // button no longer opens directly).
            const fileChooserPromise = page.waitForEvent('filechooser');
            await page.click('#attach-btn');
            await page.click('.attach-popup-item[data-action="upload"]');
            const fileChooser = await fileChooserPromise;
            
            await fileChooser.setFiles([
                { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('a') },
                { name: 'b.png', mimeType: 'image/png', buffer: Buffer.from('b') },
            ]);
            
            // Prev button should be disabled at start
            const prevBtn = page.locator('#gallery-prev');
            await expect(prevBtn).toBeDisabled();
        });

        test('gallery should disable next button on last item', async ({ page }) => {
            await registerUser(page, 'gallery_last', 'TestPass123!');
            await createServer(page, 'Gallery Last Server');
            
            // The "+" opens the attach menu; the file input is behind its
            // "Upload Files" entry now (the popup was added after these tests
            // were written, and they had been waiting for a chooser that the
            // button no longer opens directly).
            const fileChooserPromise = page.waitForEvent('filechooser');
            await page.click('#attach-btn');
            await page.click('.attach-popup-item[data-action="upload"]');
            const fileChooser = await fileChooserPromise;
            
            await fileChooser.setFiles([
                { name: 'a.png', mimeType: 'image/png', buffer: Buffer.from('a') },
                { name: 'b.png', mimeType: 'image/png', buffer: Buffer.from('b') },
            ]);
            
            // Navigate to last
            await page.click('#gallery-next');
            
            // Next button should be disabled
            const nextBtn = page.locator('#gallery-next');
            await expect(nextBtn).toBeDisabled();
        });
    });
});
