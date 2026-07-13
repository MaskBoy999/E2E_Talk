# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: qr-transfer.spec.ts >> QR Code Key Transfer >> QR code dismissed when user clicks cancel
- Location: tests\qr-transfer.spec.ts:61:9

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
Call log:
  - navigating to "http://localhost:3000/login.html", waiting until "load"

```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | 
  3   | const BASE = 'http://localhost:3000';
  4   | 
  5   | test.describe('QR Code Key Transfer', () => {
  6   | 
  7   |     async function registerUser(page: any, username: string) {
> 8   |         await page.goto(`${BASE}/login.html`);
      |                    ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
  9   |         await page.waitForSelector('#show-register');
  10  |         await page.click('#show-register');
  11  |         await page.fill('#register-username', username);
  12  |         await page.fill('#register-password', 'password123');
  13  |         await page.click('#register-form button[type="submit"]');
  14  |         await page.waitForURL('**/index.html', { timeout: 10000 });
  15  |         await page.waitForSelector('#settings-btn', { state: 'visible', timeout: 10000 });
  16  |         return await page.evaluate(() => ({
  17  |             token: localStorage.getItem('token'),
  18  |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  19  |         }));
  20  |     }
  21  | 
  22  |     test('settings modal shows QR code section', async ({ page }) => {
  23  |         const ts = Date.now();
  24  |         const body = await registerUser(page, 'qr_settings_' + ts);
  25  |         expect(body.token).toBeTruthy();
  26  | 
  27  |         await page.click('#settings-btn');
  28  |         await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
  29  | 
  30  |         const qrSection = page.locator('#qr-code-container');
  31  |         await expect(qrSection).toBeVisible();
  32  | 
  33  |         const showQrBtn = page.locator('#show-qr-btn');
  34  |         await expect(showQrBtn).toBeVisible();
  35  |         await expect(showQrBtn).toContainText('Show QR Code');
  36  |     });
  37  | 
  38  |     test('QR code displays after confirmation dialog', async ({ page }) => {
  39  |         const ts = Date.now();
  40  |         const body = await registerUser(page, 'qr_display_' + ts);
  41  |         expect(body.token).toBeTruthy();
  42  | 
  43  |         await page.click('#settings-btn');
  44  |         await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
  45  | 
  46  |         page.on('dialog', async dialog => {
  47  |             expect(dialog.type()).toBe('confirm');
  48  |             await dialog.accept();
  49  |         });
  50  | 
  51  |         await page.click('#show-qr-btn');
  52  |         await page.waitForTimeout(500);
  53  | 
  54  |         const qrDisplay = page.locator('#qr-code-display');
  55  |         await expect(qrDisplay).toBeVisible();
  56  | 
  57  |         const svgElement = page.locator('#qr-code-canvas svg');
  58  |         await expect(svgElement).toBeVisible();
  59  |     });
  60  | 
  61  |     test('QR code dismissed when user clicks cancel', async ({ page }) => {
  62  |         const ts = Date.now();
  63  |         const body = await registerUser(page, 'qr_cancel_' + ts);
  64  |         expect(body.token).toBeTruthy();
  65  | 
  66  |         await page.click('#settings-btn');
  67  |         await page.waitForSelector('#settings-modal', { state: 'visible', timeout: 5000 });
  68  | 
  69  |         page.on('dialog', async dialog => {
  70  |             await dialog.dismiss();
  71  |         });
  72  | 
  73  |         await page.click('#show-qr-btn');
  74  |         await page.waitForTimeout(500);
  75  | 
  76  |         const placeholder = page.locator('#qr-code-placeholder');
  77  |         await expect(placeholder).toBeVisible();
  78  |     });
  79  | 
  80  |     test('connect with key section shows QR scan button', async ({ page }) => {
  81  |         await page.goto(`${BASE}/login.html`);
  82  | 
  83  |         await page.click('#show-connect-key');
  84  |         await page.waitForSelector('#connect-key-section', { state: 'visible', timeout: 5000 });
  85  | 
  86  |         const scanBtn = page.locator('#scan-qr-btn');
  87  |         await expect(scanBtn).toBeVisible();
  88  | 
  89  |         const scannerSection = page.locator('#qr-scanner-section');
  90  |         await expect(scannerSection).toBeHidden();
  91  |     });
  92  | 
  93  |     test('connect with key form accepts pasted key', async ({ page }) => {
  94  |         const ts = Date.now();
  95  |         const user1 = 'qr_connect1_' + ts;
  96  |         const user2 = 'qr_connect2_' + ts;
  97  | 
  98  |         const body1 = await registerUser(page, user1);
  99  |         expect(body1.token).toBeTruthy();
  100 | 
  101 |         const user1Key = await page.evaluate(() => {
  102 |             return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().privateKey);
  103 |         });
  104 | 
  105 |         await page.evaluate(() => {
  106 |             localStorage.removeItem('token');
  107 |             localStorage.removeItem('user');
  108 |         });
```