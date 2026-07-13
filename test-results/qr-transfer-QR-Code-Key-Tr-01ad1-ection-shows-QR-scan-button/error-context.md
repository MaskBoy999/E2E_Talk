# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: qr-transfer.spec.ts >> QR Code Key Transfer >> connect with key section shows QR scan button
- Location: tests\qr-transfer.spec.ts:80:9

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
  8   |         await page.goto(`${BASE}/login.html`);
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
> 81  |         await page.goto(`${BASE}/login.html`);
      |                    ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
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
  109 | 
  110 |         await registerUser(page, user2);
  111 | 
  112 |         await page.evaluate(() => {
  113 |             localStorage.removeItem('token');
  114 |             localStorage.removeItem('user');
  115 |         });
  116 | 
  117 |         await page.goto(`${BASE}/login.html`);
  118 |         await page.click('#show-connect-key');
  119 |         await page.waitForSelector('#connect-key-section', { state: 'visible', timeout: 5000 });
  120 | 
  121 |         await page.fill('#connect-username', user1);
  122 |         await page.fill('#connect-password', 'password123');
  123 |         await page.fill('#connect-key-input', user1Key);
  124 | 
  125 |         await page.click('#connect-key-btn');
  126 |         await page.waitForURL('**/index.html', { timeout: 10000 });
  127 | 
  128 |         const currentToken = await page.evaluate(() => localStorage.getItem('token'));
  129 |         expect(currentToken).toBeTruthy();
  130 | 
  131 |         const restoredKey = await page.evaluate(() => {
  132 |             return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().privateKey);
  133 |         });
  134 |         expect(restoredKey).toBe(user1Key);
  135 |     });
  136 | 
  137 |     test('connect with key shows error for invalid key', async ({ page }) => {
  138 |         const ts = Date.now();
  139 |         const username = 'qr_invalid_' + ts;
  140 | 
  141 |         await registerUser(page, username);
  142 | 
  143 |         await page.evaluate(() => {
  144 |             localStorage.removeItem('token');
  145 |             localStorage.removeItem('user');
  146 |         });
  147 | 
  148 |         await page.goto(`${BASE}/login.html`);
  149 |         await page.click('#show-connect-key');
  150 |         await page.waitForSelector('#connect-key-section', { state: 'visible', timeout: 5000 });
  151 | 
  152 |         await page.fill('#connect-username', username);
  153 |         await page.fill('#connect-password', 'password123');
  154 |         await page.fill('#connect-key-input', 'not-a-valid-base64-key');
  155 | 
  156 |         await page.click('#connect-key-btn');
  157 |         await page.waitForTimeout(1000);
  158 | 
  159 |         const errorDiv = page.locator('#connect-key-error');
  160 |         await expect(errorDiv).toBeVisible();
  161 |         await expect(errorDiv).toContainText('Invalid key format');
  162 |     });
  163 | 
  164 |     test('connect with key shows error for wrong account key', async ({ page }) => {
  165 |         const ts = Date.now();
  166 |         const user1 = 'qr_wrong1_' + ts;
  167 |         const user2 = 'qr_wrong2_' + ts;
  168 | 
  169 |         await registerUser(page, user1);
  170 | 
  171 |         await page.evaluate(() => {
  172 |             localStorage.removeItem('token');
  173 |             localStorage.removeItem('user');
  174 |         });
  175 | 
  176 |         await registerUser(page, user2);
  177 |         const user2Key = await page.evaluate(() => {
  178 |             return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().privateKey);
  179 |         });
  180 | 
  181 |         await page.evaluate(() => {
```