# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat.spec.ts >> E2E Chat >> full UI flow: create server via UI, join via invite, bidirectional messaging
- Location: tests\chat.spec.ts:173:9

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
Call log:
  - navigating to "http://localhost:3000/login.html", waiting until "load"

```

# Test source

```ts
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
  131 |         // User1 loads chat
  132 |         await page.goto(`${BASE}/index.html`);
  133 |         await page.waitForSelector('.server-icon', { timeout: 10000 });
  134 |         await page.click('.server-icon:not(.add-server)');
  135 |         await page.waitForSelector('.channel-item', { timeout: 10000 });
  136 |         await page.click('.channel-item >> nth=0');
  137 |         await page.waitForTimeout(500);
  138 | 
  139 |         // User2 loads chat with decrypted server key
  140 |         const page2 = await ctx2.newPage();
  141 |         await page2.goto(`${BASE}/index.html`);
  142 |         await page2.waitForSelector('.server-icon', { timeout: 10000 });
  143 |         await page2.click('.server-icon:not(.add-server)');
  144 |         await page2.waitForSelector('.channel-item', { timeout: 10000 });
  145 |         await page2.click('.channel-item >> nth=0');
  146 |         await page2.waitForTimeout(1500);
  147 | 
  148 |         // User1 sends encrypted message
  149 |         const input1 = page.locator('#message-input');
  150 |         await expect(input1).toBeEnabled({ timeout: 5000 });
  151 |         await input1.fill('Hello from Alice!');
  152 |         await page.click('#send-btn');
  153 |         await page.waitForTimeout(2000);
  154 | 
  155 |         // User2 sees decrypted message
  156 |         const user2Texts = await page2.locator('.message .text').allTextContents();
  157 |         expect(user2Texts.some(t => t === 'Hello from Alice!')).toBeTruthy();
  158 | 
  159 |         // User2 sends reply
  160 |         const input2 = page2.locator('#message-input');
  161 |         await input2.fill('Hello from Bob!');
  162 |         await page2.click('#send-btn');
  163 |         await page2.waitForTimeout(2000);
  164 | 
  165 |         // User1 sees decrypted reply
  166 |         const user1Texts = await page.locator('.message .text').allTextContents();
  167 |         expect(user1Texts.some(t => t === 'Hello from Bob!')).toBeTruthy();
  168 | 
  169 |         await page2.close();
  170 |         await ctx2.close();
  171 |     });
  172 | 
  173 |     test('full UI flow: create server via UI, join via invite, bidirectional messaging', async ({ page, context }) => {
  174 |         const ts = Date.now();
  175 |         const user1 = 'ui_alice_' + ts;
  176 |         const user2 = 'ui_bob_' + ts;
  177 | 
  178 |         // === User1 registers ===
> 179 |         await page.goto(`${BASE}/login.html`);
      |                    ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
  180 |         await page.click('#show-register');
  181 |         await page.fill('#register-username', user1);
  182 |         await page.fill('#register-password', 'password123');
  183 |         await page.click('#register-form button[type="submit"]');
  184 |         await page.waitForURL('**/index.html', { timeout: 10000 });
  185 | 
  186 |         const body1 = await page.evaluate(() => ({
  187 |             token: localStorage.getItem('token'),
  188 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  189 |         }));
  190 |         expect(body1.token).toBeTruthy();
  191 | 
  192 |         // === User2 registers in separate context ===
  193 |         const ctx2 = await context.browser()!.newContext();
  194 |         const page2reg = await ctx2.newPage();
  195 |         await page2reg.goto(`${BASE}/login.html`);
  196 |         await page2reg.waitForTimeout(1000);
  197 |         await page2reg.click('#show-register');
  198 |         await page2reg.fill('#register-username', user2);
  199 |         await page2reg.fill('#register-password', 'password123');
  200 |         await page2reg.click('#register-form button[type="submit"]');
  201 |         await page2reg.waitForURL('**/index.html', { timeout: 10000 });
  202 | 
  203 |         const body2 = await page2reg.evaluate(() => ({
  204 |             token: localStorage.getItem('token'),
  205 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  206 |         }));
  207 |         expect(body2.token).toBeTruthy();
  208 | 
  209 |         // === User1 creates server via UI ===
  210 |         // The "+" button opens a choice modal
  211 |         await page.click('#add-server-btn');
  212 |         await page.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
  213 |         await page.click('#choice-create-server');
  214 |         await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 5000 });
  215 |         await page.fill('#new-server-name', 'UI Test Server');
  216 |         await page.click('#confirm-create-server');
  217 |         await page.waitForTimeout(2000);
  218 | 
  219 |         // Verify server was created - should see the server icon
  220 |         await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 5000 });
  221 | 
  222 |         // Check console logs for key upload
  223 |         const createLogs: string[] = [];
  224 |         page.on('console', msg => {
  225 |             if (msg.text().includes('[E2E]')) createLogs.push(msg.text());
  226 |         });
  227 | 
  228 |         // Reload to capture logs cleanly
  229 |         await page.goto(`${BASE}/index.html`);
  230 |         await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
  231 | 
  232 |         // Click the server to trigger key check
  233 |         await page.click('.server-icon:not(.add-server)');
  234 |         await page.waitForTimeout(1500);
  235 | 
  236 |         // Check we can see channels (not "Cannot decrypt server key")
  237 |         const channelItems = await page.locator('.channel-item').allTextContents();
  238 |         console.log('Channel items:', channelItems);
  239 |         expect(channelItems.some(c => c.includes('general') || c.includes('No channels'))).toBeTruthy();
  240 | 
  241 |         // === Get invite code ===
  242 |         const serverId = await page.evaluate(() => {
  243 |             const icons = document.querySelectorAll('.server-icon:not(.add-server)');
  244 |             return (icons[0] as HTMLElement)?.dataset?.id || '';
  245 |         });
  246 |         expect(serverId).toBeTruthy();
  247 | 
  248 |         // The UI test creates server via UI which generates invite code client-side.
  249 |         // We need to get the invite code from localStorage.
  250 |         const inviteCode = await page.evaluate((sid) => localStorage.getItem('e2e_invite_' + sid), serverId);
  251 |         console.log('Invite code:', inviteCode);
  252 |         expect(inviteCode).toBeTruthy();
  253 | 
  254 |         // === User2 joins via UI ===
  255 |         await page2reg.goto(`${BASE}/index.html`);
  256 |         await page2reg.waitForSelector('.add-server', { timeout: 10000 });
  257 | 
  258 |         // Click "+" to join server - opens choice modal
  259 |         await page2reg.click('#add-server-btn');
  260 |         await page2reg.waitForSelector('#server-choice-modal', { state: 'visible', timeout: 5000 });
  261 |         await page2reg.click('#choice-join-server');
  262 |         await page2reg.waitForSelector('#join-server-modal', { state: 'visible', timeout: 5000 });
  263 |         await page2reg.fill('#invite-code-input', inviteCode!);
  264 |         await page2reg.click('#confirm-join-server');
  265 |         await page2reg.waitForTimeout(5000);
  266 | 
  267 |         // Verify user2 sees the server
  268 |         await page2reg.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
  269 | 
  270 |         // Click the server
  271 |         await page2reg.click('.server-icon:not(.add-server)');
  272 |         await page2reg.waitForTimeout(3000);
  273 | 
  274 |         // Check if user2 can see channels
  275 |         const user2Channels = await page2reg.locator('.channel-item').allTextContents();
  276 |         console.log('User2 channels:', user2Channels);
  277 |         const user2CanDecrypt = !user2Channels.some(c => c.includes('Cannot decrypt'));
  278 |         console.log('User2 can decrypt:', user2CanDecrypt);
  279 | 
```