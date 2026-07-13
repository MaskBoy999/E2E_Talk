# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dm.spec.ts >> Direct Messages >> a declined friend request can be sent again
- Location: tests\dm.spec.ts:306:9

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
  5   | test.describe('Direct Messages', () => {
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
  15  |         return await page.evaluate(() => ({
  16  |             token: localStorage.getItem('token'),
  17  |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  18  |         }));
  19  |     }
  20  | 
  21  |     async function becomeFriends(page1: any, page2: any, token1: string, token2: string) {
  22  |         // Get user2's friend code from localStorage (stored during registration)
  23  |         const me2_code = await page2.evaluate(() => localStorage.getItem('e2e_friend_code'));
  24  | 
  25  |         // User1 sends friend request
  26  |         const fr = await page1.request.post(`${BASE}/api/friends/request`, {
  27  |             headers: { Authorization: `Bearer ${token1}`, 'Content-Type': 'application/json' },
  28  |             data: { friend_code: me2_code },
  29  |         });
  30  |         expect(fr.ok()).toBeTruthy();
  31  | 
  32  |         // User2 accepts
  33  |         const incoming = await (await page2.request.get(`${BASE}/api/friends/requests/incoming`, {
  34  |             headers: { Authorization: `Bearer ${token2}` },
  35  |         })).json();
  36  |         expect(Array.isArray(incoming)).toBe(true);
  37  |         expect(incoming.length).toBe(1);
  38  |         const acc = await page2.request.post(`${BASE}/api/friends/requests/accept`, {
  39  |             headers: { Authorization: `Bearer ${token2}`, 'Content-Type': 'application/json' },
  40  |             data: { request_id: incoming[0].id },
  41  |         });
  42  |         expect(acc.ok()).toBeTruthy();
  43  |     }
  44  | 
  45  |     async function createDmViaApi(page: any, page2: any, token1: string, user2: string): Promise<{dmChannelId: string, userId2: string}> {
  46  |         // Look up user2 by username
  47  |         const userData = await (await page.request.get(`${BASE}/api/user/${user2}`, {
  48  |             headers: { Authorization: `Bearer ${token1}` },
  49  |         })).json();
  50  | 
  51  |         // Create DM channel
  52  |         const dm = await page.request.post(`${BASE}/api/dm/${userData.id}`, {
  53  |             headers: { Authorization: `Bearer ${token1}` },
  54  |         });
  55  |         expect(dm.ok()).toBeTruthy();
  56  |         const dmChannel = await dm.json();
  57  |         return { dmChannelId: dmChannel.id, userId2: userData.id };
  58  |     }
  59  | 
  60  |     test('direct messages: user registration + DM creation works', async ({ page, context }) => {
  61  |         const ts = Date.now();
  62  |         const user1 = 'dmuser1_' + ts;
  63  |         const user2 = 'dmuser2_' + ts;
  64  | 
  65  |         const body1 = await registerUser(page, user1);
  66  |         expect(body1.token).toBeTruthy();
  67  | 
  68  |         const ctx2 = await context.browser()!.newContext();
  69  |         const page2 = await ctx2.newPage();
  70  |         const body2 = await registerUser(page2, user2);
  71  |         expect(body2.token).toBeTruthy();
  72  | 
  73  |         // DM should not exist yet
  74  |         const preCheck = await (await page.request.get(`${BASE}/api/dm/conversations`, {
  75  |             headers: { Authorization: `Bearer ${body1.token}` },
  76  |         })).json();
  77  |         expect(Array.isArray(preCheck)).toBe(true);
  78  |         expect(preCheck.length).toBe(0);
  79  | 
  80  |         await becomeFriends(page, page2, body1.token, body2.token);
  81  | 
  82  |         // DM should now auto-exist after accepting friend request
  83  |         await page.goto(`${BASE}/index.html`);
  84  |         await page.waitForSelector('#dm-strip-btn');
  85  |         await page.click('#dm-strip-btn');
  86  |         await page.waitForTimeout(1500);
  87  | 
  88  |         await page.waitForSelector('.dm-item', { timeout: 5000 });
  89  |         const dmItemText = await page.locator('.dm-item').first().textContent();
  90  |         expect(dmItemText).toContain(user2);
  91  | 
  92  |         await page2.close();
  93  |         await ctx2.close();
  94  |     });
  95  | 
  96  |     test('direct messages: send and receive encrypted message', async ({ page, context }) => {
  97  |         const ts = Date.now();
  98  |         const user1 = 'alice_' + ts;
  99  |         const user2 = 'bob_' + ts;
  100 | 
  101 |         const body1 = await registerUser(page, user1);
  102 |         expect(body1.token).toBeTruthy();
  103 | 
  104 |         const ctx2 = await context.browser()!.newContext();
  105 |         const page2 = await ctx2.newPage();
  106 |         const body2 = await registerUser(page2, user2);
  107 |         expect(body2.token).toBeTruthy();
  108 | 
```