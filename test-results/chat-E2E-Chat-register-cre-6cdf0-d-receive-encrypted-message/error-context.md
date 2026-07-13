# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat.spec.ts >> E2E Chat >> register, create server, send and receive encrypted message
- Location: tests\chat.spec.ts:24:9

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
Call log:
  - navigating to "http://localhost:3000/login.html", waiting until "load"

```

# Test source

```ts
  1   | import { test, expect } from '@playwright/test';
  2   | import { createHash } from 'crypto';
  3   | 
  4   | const BASE = 'http://localhost:3000';
  5   | 
  6   | function sha256Hex(data: string): string {
  7   |     return createHash('sha256').update(data).digest('hex');
  8   | }
  9   | 
  10  | function generateCode(len: number): string {
  11  |     const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  12  |     let code = '';
  13  |     for (let i = 0; i < len; i++) code += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  14  |     return code;
  15  | }
  16  | 
  17  | test.describe('E2E Chat', () => {
  18  | 
  19  |     test('login page loads', async ({ page }) => {
  20  |         await page.goto(`${BASE}/login.html`);
  21  |         await expect(page.locator('h1').first()).toContainText('E2E Chat');
  22  |     });
  23  | 
  24  |     test('register, create server, send and receive encrypted message', async ({ page, context }) => {
  25  |         const ts = Date.now();
  26  |         const user1 = 'alice_' + ts;
  27  |         const user2 = 'bob_' + ts;
  28  | 
  29  |         // Register user1 via browser to get identity keys
> 30  |         await page.goto(`${BASE}/login.html`);
      |                    ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
  31  |         await page.click('#show-register');
  32  |         await page.fill('#register-username', user1);
  33  |         await page.fill('#register-password', 'password123');
  34  |         await page.click('#register-form button[type="submit"]');
  35  |         await page.waitForURL('**/index.html', { timeout: 10000 });
  36  | 
  37  |         const body1 = await page.evaluate(() => ({
  38  |             token: localStorage.getItem('token'),
  39  |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  40  |         }));
  41  |         expect(body1.token).toBeTruthy();
  42  | 
  43  |         // Register user2 via separate browser context
  44  |         const ctx2 = await context.browser()!.newContext();
  45  |         const page2reg = await ctx2.newPage();
  46  |         await page2reg.goto(`${BASE}/login.html`);
  47  |         await page2reg.waitForTimeout(1000);
  48  |         await page2reg.click('#show-register');
  49  |         await page2reg.fill('#register-username', user2);
  50  |         await page2reg.fill('#register-password', 'password123');
  51  |         await page2reg.click('#register-form button[type="submit"]');
  52  |         await page2reg.waitForURL('**/index.html', { timeout: 10000 });
  53  | 
  54  |         const body2 = await page2reg.evaluate(() => ({
  55  |             token: localStorage.getItem('token'),
  56  |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  57  |         }));
  58  |         expect(body2.token).toBeTruthy();
  59  | 
  60  |         // Get user2's actual public key from their browser context
  61  |         const user2PubKeyB64 = await page2reg.evaluate(() => {
  62  |             return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey);
  63  |         });
  64  | 
  65  |         // User1 creates a server through the API
  66  |         const inviteCode1 = generateCode(8);
  67  |         const srv = await page.request.post(`${BASE}/api/servers`, {
  68  |             headers: { Authorization: `Bearer ${body1.token}` },
  69  |             data: { name: 'Test Server', invite_code_hash: sha256Hex(inviteCode1) },
  70  |         });
  71  |         const server = await srv.json();
  72  |         expect(server.id).toBeTruthy();
  73  | 
  74  |         // Generate server key and upload encrypted key for user1
  75  |         await page.evaluate(async ({ serverId, userId }) => {
  76  |             const serverKey = E2ECrypto.generateServerKey();
  77  |             E2ECrypto.saveServerKey(serverId, serverKey);
  78  |             const identity = E2ECrypto.getIdentityKeyPair();
  79  |             const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
  80  |             await fetch(`/api/servers/${serverId}/keys`, {
  81  |                 method: 'POST',
  82  |                 headers: {
  83  |                     'Content-Type': 'application/json',
  84  |                     'Authorization': 'Bearer ' + localStorage.getItem('token'),
  85  |                 },
  86  |                 body: JSON.stringify({
  87  |                     user_id: userId,
  88  |                     encrypted_key: encrypted.ciphertext,
  89  |                     sender_public_key: encrypted.ephemeralPublicKey,
  90  |                     nonce: encrypted.nonce,
  91  |                 }),
  92  |             });
  93  |         }, { serverId: server.id, userId: body1.user.id });
  94  | 
  95  |         // Get invite code
  96  |         const invRes = await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
  97  |             headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
  98  |             data: { invite_code_hash: sha256Hex(inviteCode1) },
  99  |         });
  100 |         const invite = await invRes.json();
  101 |         expect(invite.ok).toBeTruthy();
  102 | 
  103 |         // User2 joins
  104 |         const joinRes = await page.request.post(`${BASE}/api/invites/join`, {
  105 |             headers: { Authorization: `Bearer ${body2.token}` },
  106 |             data: { code: inviteCode1 },
  107 |         });
  108 |         const joined = await joinRes.json();
  109 |         expect(joined.id).toBe(server.id);
  110 | 
  111 |         // Upload encrypted server key for user2
  112 |         await page.evaluate(async ({ serverId, user2Id, user2PubKey }) => {
  113 |             const serverKey = E2ECrypto.getServerKey(serverId);
  114 |             const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKey));
  115 |             const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
  116 |             await fetch(`/api/servers/${serverId}/keys`, {
  117 |                 method: 'POST',
  118 |                 headers: {
  119 |                     'Content-Type': 'application/json',
  120 |                     'Authorization': 'Bearer ' + localStorage.getItem('token'),
  121 |                 },
  122 |                 body: JSON.stringify({
  123 |                     user_id: user2Id,
  124 |                     encrypted_key: encrypted.ciphertext,
  125 |                     sender_public_key: encrypted.ephemeralPublicKey,
  126 |                     nonce: encrypted.nonce,
  127 |                 }),
  128 |             });
  129 |         }, { serverId: server.id, user2Id: body2.user.id, user2PubKey: user2PubKeyB64 });
  130 | 
```