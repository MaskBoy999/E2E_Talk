# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat.spec.ts >> E2E Chat >> reload preserves decrypted messages
- Location: tests\chat.spec.ts:331:9

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
Call log:
  - navigating to "http://localhost:3000/login.html", waiting until "load"

```

# Test source

```ts
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
  280 |         // === Both users select a channel and send messages ===
  281 |         // User1 clicks general
  282 |         const user1Channels = await page.locator('.channel-item').allTextContents();
  283 |         console.log('User1 channels:', user1Channels);
  284 |         if (user1Channels.some(c => c.includes('general'))) {
  285 |             await page.locator('.channel-item', { hasText: 'general' }).click();
  286 |         } else {
  287 |             await page.locator('.channel-item >> nth=0').click();
  288 |         }
  289 |         await page.waitForTimeout(1000);
  290 | 
  291 |         // User2 clicks general
  292 |         if (user2CanDecrypt && user2Channels.some(c => c.includes('general'))) {
  293 |             await page2reg.locator('.channel-item', { hasText: 'general' }).click();
  294 |         } else if (user2CanDecrypt) {
  295 |             await page2reg.locator('.channel-item >> nth=0').click();
  296 |         }
  297 |         await page2reg.waitForTimeout(1500);
  298 | 
  299 |         // User1 sends message
  300 |         if (user2CanDecrypt) {
  301 |             const input1 = page.locator('#message-input');
  302 |             await expect(input1).toBeEnabled({ timeout: 5000 });
  303 |             await input1.fill('Hello from UI Alice!');
  304 |             await page.click('#send-btn');
  305 |             await page.waitForTimeout(2000);
  306 | 
  307 |             // User2 should see the decrypted message
  308 |             const user2Msgs = await page2reg.locator('.message .text').allTextContents();
  309 |             console.log('User2 messages:', user2Msgs);
  310 |             expect(user2Msgs.some(t => t === 'Hello from UI Alice!')).toBeTruthy();
  311 | 
  312 |             // User2 replies
  313 |             const input2 = page2reg.locator('#message-input');
  314 |             await expect(input2).toBeEnabled({ timeout: 5000 });
  315 |             await input2.fill('Hello from UI Bob!');
  316 |             await page2reg.click('#send-btn');
  317 |             await page2reg.waitForTimeout(2000);
  318 | 
  319 |             // User1 should see the reply
  320 |             const user1Msgs = await page.locator('.message .text').allTextContents();
  321 |             console.log('User1 messages:', user1Msgs);
  322 |             expect(user1Msgs.some(t => t === 'Hello from UI Bob!')).toBeTruthy();
  323 |         } else {
  324 |             throw new Error('User2 could not decrypt server key via UI flow');
  325 |         }
  326 | 
  327 |         await page2reg.close();
  328 |         await ctx2.close();
  329 |     });
  330 | 
  331 |     test('reload preserves decrypted messages', async ({ page }) => {
  332 |         const ts = Date.now();
  333 |         const username = 'reload_' + ts;
  334 | 
> 335 |         await page.goto(`${BASE}/login.html`);
      |                    ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
  336 |         await page.click('#show-register');
  337 |         await page.fill('#register-username', username);
  338 |         await page.fill('#register-password', 'password123');
  339 |         await page.click('#register-form button[type="submit"]');
  340 |         await page.waitForURL('**/index.html', { timeout: 10000 });
  341 | 
  342 |         const body = await page.evaluate(() => ({
  343 |             token: localStorage.getItem('token'),
  344 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  345 |         }));
  346 | 
  347 |         // Create server
  348 |         const srv = await page.request.post(`${BASE}/api/servers`, {
  349 |             headers: { Authorization: `Bearer ${body.token}` },
  350 |             data: { name: 'Reload Server', invite_code_hash: sha256Hex(generateCode(8)) },
  351 |         });
  352 |         const server = await srv.json();
  353 | 
  354 |         // Generate server key
  355 |         await page.evaluate(async ({ serverId, userId }) => {
  356 |             const serverKey = E2ECrypto.generateServerKey();
  357 |             E2ECrypto.saveServerKey(serverId, serverKey);
  358 |             const identity = E2ECrypto.getIdentityKeyPair();
  359 |             const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
  360 |             await fetch(`/api/servers/${serverId}/keys`, {
  361 |                 method: 'POST',
  362 |                 headers: {
  363 |                     'Content-Type': 'application/json',
  364 |                     'Authorization': 'Bearer ' + localStorage.getItem('token'),
  365 |                 },
  366 |                 body: JSON.stringify({
  367 |                     user_id: userId,
  368 |                     encrypted_key: encrypted.ciphertext,
  369 |                     sender_public_key: encrypted.ephemeralPublicKey,
  370 |                     nonce: encrypted.nonce,
  371 |                 }),
  372 |             });
  373 |         }, { serverId: server.id, userId: body.user.id });
  374 | 
  375 |         await page.goto(`${BASE}/index.html`);
  376 |         await page.waitForSelector('.server-icon', { timeout: 10000 });
  377 |         await page.click('.server-icon:not(.add-server)');
  378 |         await page.waitForSelector('.channel-item', { timeout: 10000 });
  379 |         await page.click('.channel-item >> nth=0');
  380 |         await page.waitForTimeout(500);
  381 | 
  382 |         const input = page.locator('#message-input');
  383 |         await expect(input).toBeEnabled({ timeout: 5000 });
  384 |         await input.fill('Persistent!');
  385 |         await page.click('#send-btn');
  386 |         await page.waitForTimeout(1500);
  387 | 
  388 |         expect(await page.locator('.message .text').allTextContents()).toContainEqual('Persistent!');
  389 | 
  390 |         await page.reload();
  391 |         await page.waitForSelector('.server-icon', { timeout: 10000 });
  392 |         await page.click('.server-icon:not(.add-server)');
  393 |         await page.waitForSelector('.channel-item', { timeout: 10000 });
  394 |         await page.click('.channel-item >> nth=0');
  395 |         await page.waitForTimeout(1500);
  396 | 
  397 |         expect(await page.locator('.message .text').allTextContents()).toContainEqual('Persistent!');
  398 |     });
  399 | 
  400 |     test('server only stores ciphertext', async ({ page }) => {
  401 |         const ts = Date.now();
  402 |         const username = 'ct_' + ts;
  403 | 
  404 |         await page.goto(`${BASE}/login.html`);
  405 |         await page.click('#show-register');
  406 |         await page.fill('#register-username', username);
  407 |         await page.fill('#register-password', 'password123');
  408 |         await page.click('#register-form button[type="submit"]');
  409 |         await page.waitForURL('**/index.html', { timeout: 10000 });
  410 | 
  411 |         const body = await page.evaluate(() => ({
  412 |             token: localStorage.getItem('token'),
  413 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  414 |         }));
  415 | 
  416 |         // Create server
  417 |         const srv = await page.request.post(`${BASE}/api/servers`, {
  418 |             headers: { Authorization: `Bearer ${body.token}` },
  419 |             data: { name: 'CT Server', invite_code_hash: sha256Hex(generateCode(8)) },
  420 |         });
  421 |         const server = await srv.json();
  422 | 
  423 |         // Get channel
  424 |         const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
  425 |             headers: { Authorization: `Bearer ${body.token}` },
  426 |         });
  427 |         const channels = await chRes.json();
  428 |         const channelId = channels[0].id;
  429 | 
  430 |         // Generate server key
  431 |         await page.evaluate(async ({ serverId, userId }) => {
  432 |             const serverKey = E2ECrypto.generateServerKey();
  433 |             E2ECrypto.saveServerKey(serverId, serverKey);
  434 |             const identity = E2ECrypto.getIdentityKeyPair();
  435 |             const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
```