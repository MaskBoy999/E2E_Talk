# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dm.spec.ts >> Direct Messages >> direct messages: user registration + DM creation works
- Location: tests\dm.spec.ts:8:9

# Error details

```
Test timeout of 30000ms exceeded.
```

```
Error: page.waitForSelector: Test timeout of 30000ms exceeded.
Call log:
  - waiting for locator('.dm-item') to be visible

```

# Page snapshot

```yaml
- generic [ref=e1]:
  - generic [ref=e2]:
    - generic [ref=e3]:
      - generic "Direct Messages" [ref=e4]:
        - img [ref=e5]
      - button "+" [ref=e7] [cursor=pointer]
    - generic [ref=e8]:
      - heading "Direct Messages" [level=2] [ref=e10]
      - generic [ref=e11]:
        - button "+ New Message" [ref=e12]
        - generic [ref=e14]: No conversations yet
      - generic [ref=e15]:
        - generic [ref=e16]: dmuser1_1783852615614
        - generic [ref=e17]:
          - link "Admin" [ref=e18] [cursor=pointer]:
            - /url: admin.html
          - button "Logout" [ref=e19] [cursor=pointer]
    - generic [ref=e20]:
      - generic [ref=e21]:
        - heading "Select a conversation" [level=3] [ref=e22]
        - button "☰" [ref=e23] [cursor=pointer]
      - generic [ref=e24]:
        - generic [ref=e26]: Select a conversation to start chatting
        - generic:
          - generic:
            - button "×"
      - generic [ref=e27]:
        - textbox "Type a message..." [disabled] [ref=e28]
        - button "Send" [disabled] [ref=e29]
  - generic [ref=e31]:
    - textbox "Enter username" [ref=e32]: dmuser2_1783852615614
    - generic [ref=e33]: Failed to start DM
    - generic [ref=e34]:
      - button "Cancel" [ref=e35] [cursor=pointer]
      - button "Start Chat" [active] [ref=e36] [cursor=pointer]
```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import { type BrowserContext } from '@playwright/test';
  3   | 
  4   | const BASE = 'http://localhost:3000';
  5   | 
  6   | test.describe('Direct Messages', () => {
  7   | 
  8   |     test('direct messages: user registration + DM creation works', async ({ page, context }) => {
  9   |         const ts = Date.now();
  10  |         const user1 = 'dmuser1_' + ts;
  11  |         const user2 = 'dmuser2_' + ts;
  12  | 
  13  |         // Register user1 to get identity key
  14  |         await page.goto(`${BASE}/login.html`);
  15  |         await page.click('#show-register');
  16  |         await page.fill('#register-username', user1);
  17  |         await page.fill('#register-password', 'password123');
  18  |         await page.click('#register-form button[type="submit"]');
  19  |         await page.waitForURL('**/index.html', { timeout: 10000 });
  20  |         const body1 = await page.evaluate(() => ({
  21  |             token: localStorage.getItem('token'),
  22  |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  23  |             identityKey: E2ECrypto.getIdentityKeyPair(),
  24  |         }));
  25  |         expect(body1.token).toBeTruthy();
  26  | 
  27  |         // Register user2 in separate browser context
  28  |         const ctx2 = await context.browser()!.newContext();
  29  |         const page2 = await ctx2.newPage();
  30  |         await page2.goto(`${BASE}/login.html`);
  31  |         await page2.waitForTimeout(1000);
  32  |         await page2.click('#show-register');
  33  |         await page2.fill('#register-username', user2);
  34  |         await page2.fill('#register-password', 'password123');
  35  |         await page2.click('#register-form button[type="submit"]');
  36  |         await page2.waitForURL('**/index.html', { timeout: 10000 });
  37  |         const body2 = await page2.evaluate(() => ({
  38  |             token: localStorage.getItem('token'),
  39  |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  40  |             identityKey: E2ECrypto.getIdentityKeyPair(),
  41  |         }));
  42  |         expect(body2.token).toBeTruthy();
  43  | 
  44  |         // Extract user2's public key from the browser context
  45  |         const user2PubKeyB64 = await page2.evaluate(() => {
  46  |             return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey);
  47  |         });
  48  | 
  49  |         // User1 visits the DM view via the DM strip
  50  |         await page.goto(`${BASE}/index.html`);
  51  |         await page.waitForSelector('#dm-strip-btn');
  52  |         await page.click('#dm-strip-btn');
  53  |         await page.waitForSelector('.dm-list', { timeout: 2000 });
  54  | 
  55  |         // New DM starts search for user2
  56  |         await page.click('#new-dm-btn');
  57  |         await page.waitForSelector('#dm-search-modal', { timeout: 2000 });
  58  |         await page.fill('#dm-username-input', user2);
  59  |         await page.click('#confirm-dm-search');
  60  |         await page.waitForTimeout(2000);
  61  | 
  62  |         // Should show DM channel with user2
> 63  |         await page.waitForSelector('.dm-item');
      |                    ^ Error: page.waitForSelector: Test timeout of 30000ms exceeded.
  64  |         const dmItemText = await page.locator('.dm-item').first().textContent();
  65  |         expect(dmItemText).toContain(user2);
  66  | 
  67  |         await page2.close();
  68  |         await ctx2.close();
  69  |     });
  70  | 
  71  |     test('direct messages: send and receive encrypted message', async ({ page, context }) => {
  72  |         const ts = Date.now();
  73  |         const user1 = 'alice_' + ts;
  74  |         const user2 = 'bob_' + ts;
  75  | 
  76  |         // Register user1
  77  |         await page.goto(`${BASE}/login.html`);
  78  |         await page.click('#show-register');
  79  |         await page.fill('#register-username', user1);
  80  |         await page.fill('#register-password', 'password123');
  81  |         await page.click('#register-form button[type="submit"]');
  82  |         await page.waitForURL('**/index.html', { timeout: 10000 });
  83  |         const body1 = await page.evaluate(() => ({
  84  |             token: localStorage.getItem('token'),
  85  |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  86  |         }));
  87  | 
  88  |         // Register user2 in a separate context (already-authed pages redirect away from login)
  89  |         const ctx2 = await context.browser()!.newContext();
  90  |         const page2 = await ctx2.newPage();
  91  |         await page2.goto(`${BASE}/login.html`);
  92  |         await page2.waitForTimeout(1000);
  93  |         await page2.click('#show-register');
  94  |         await page2.fill('#register-username', user2);
  95  |         await page2.fill('#register-password', 'password123');
  96  |         await page2.click('#register-form button[type="submit"]');
  97  |         await page2.waitForURL('**/index.html', { timeout: 10000 });
  98  |         const body2 = await page2.evaluate(() => ({
  99  |             token: localStorage.getItem('token'),
  100 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  101 |         }));
  102 |         expect(body2.token).toBeTruthy();
  103 | 
  104 |         // User1 creates DM with user2
  105 |         await page.goto(`${BASE}/index.html`);
  106 |         await page.click('#dm-strip-btn');
  107 |         await page.waitForSelector('#dm-list', { timeout: 2000 });
  108 |         await page.click('#new-dm-btn');
  109 |         await page.waitForSelector('#dm-search-modal', { timeout: 2000 });
  110 |         await page.fill('#dm-username-input', user2);
  111 |         await page.click('#confirm-dm-search');
  112 |         await page.waitForTimeout(2000);
  113 | 
  114 |         // Send message from user1 to user2
  115 |         await page.fill('#message-input', 'Hello from DM, user2!');
  116 |         await page.click('#send-btn');
  117 |         await page.waitForTimeout(1000);
  118 | 
  119 |         // User2 should see the message in their DM view
  120 |         await page2.goto(`${BASE}/index.html`);
  121 |         await page2.click('#dm-strip-btn');
  122 |         await page2.waitForSelector('.dm-item');
  123 |         await page2.click('.dm-item');
  124 | 
  125 |         // Wait for message to appear and decrypt
  126 |         await page2.waitForSelector('.text');
  127 |         await page2.waitForTimeout(2000);
  128 | 
  129 |         // Verify the message was received and can be decrypted
  130 |         const messageText = await page2.locator('.text').first().textContent();
  131 |         expect(messageText).toContain('Hello from DM, user2!');
  132 |         expect(messageText).not.toContain('encrypted');
  133 | 
  134 |         await page2.close();
  135 |         await ctx2.close();
  136 |     });
  137 | 
  138 |     test('direct messages: encrypted storage verification', async ({ page, context }) => {
  139 |         const ts = Date.now();
  140 |         const user1 = 'ctuser1_' + ts;
  141 |         const user2 = 'ctuser2_' + ts;
  142 | 
  143 |         // Register user1
  144 |         await page.goto(`${BASE}/login.html`);
  145 |         await page.click('#show-register');
  146 |         await page.fill('#register-username', user1);
  147 |         await page.fill('#register-password', 'password123');
  148 |         await page.click('#register-form button[type="submit"]');
  149 |         await page.waitForURL('**/index.html', { timeout: 10000 });
  150 |         const body1 = await page.evaluate(() => ({
  151 |             token: localStorage.getItem('token'),
  152 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  153 |         }));
  154 | 
  155 |         // Register user2 in a separate context
  156 |         const ctx2 = await context.browser()!.newContext();
  157 |         const page2 = await ctx2.newPage();
  158 |         await page2.goto(`${BASE}/login.html`);
  159 |         await page2.waitForTimeout(1000);
  160 |         await page2.click('#show-register');
  161 |         await page2.fill('#register-username', user2);
  162 |         await page2.fill('#register-password', 'password123');
  163 |         await page2.click('#register-form button[type="submit"]');
```