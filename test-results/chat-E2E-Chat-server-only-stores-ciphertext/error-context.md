# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat.spec.ts >> E2E Chat >> server only stores ciphertext
- Location: tests\chat.spec.ts:400:9

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
Call log:
  - navigating to "http://localhost:3000/login.html", waiting until "load"

```

# Test source

```ts
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
  335 |         await page.goto(`${BASE}/login.html`);
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
> 404 |         await page.goto(`${BASE}/login.html`);
      |                    ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
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
  436 |             await fetch(`/api/servers/${serverId}/keys`, {
  437 |                 method: 'POST',
  438 |                 headers: {
  439 |                     'Content-Type': 'application/json',
  440 |                     'Authorization': 'Bearer ' + localStorage.getItem('token'),
  441 |                 },
  442 |                 body: JSON.stringify({
  443 |                     user_id: userId,
  444 |                     encrypted_key: encrypted.ciphertext,
  445 |                     sender_public_key: encrypted.ephemeralPublicKey,
  446 |                     nonce: encrypted.nonce,
  447 |                 }),
  448 |             });
  449 |         }, { serverId: server.id, userId: body.user.id });
  450 | 
  451 |         await page.goto(`${BASE}/index.html`);
  452 |         await page.waitForSelector('.server-icon', { timeout: 10000 });
  453 |         await page.click('.server-icon:not(.add-server)');
  454 |         await page.waitForSelector('.channel-item', { timeout: 10000 });
  455 |         await page.click('.channel-item >> nth=0');
  456 |         await page.waitForTimeout(500);
  457 | 
  458 |         const input = page.locator('#message-input');
  459 |         await expect(input).toBeEnabled({ timeout: 5000 });
  460 |         await input.fill('Server should not read this');
  461 |         await page.click('#send-btn');
  462 |         await page.waitForTimeout(1500);
  463 | 
  464 |         // Verify server only stores ciphertext
  465 |         const msgsRes = await page.request.get(`${BASE}/api/channels/${channelId}/messages`, {
  466 |             headers: { Authorization: `Bearer ${body.token}` },
  467 |         });
  468 |         const msgs = await msgsRes.json();
  469 |         expect(msgs.length).toBeGreaterThanOrEqual(1);
  470 |         for (const m of msgs) {
  471 |             expect(m).toHaveProperty('encrypted_content');
  472 |             expect(m).toHaveProperty('nonce');
  473 |             expect(m).not.toHaveProperty('content');
  474 |         }
  475 |     });
  476 | 
  477 |     test('admin panel loads and shows all data tabs', async ({ page }) => {
  478 |         await page.goto(`${BASE}/admin.html`);
  479 |         await expect(page.locator('h1').first()).toBeVisible({ timeout: 5000 });
  480 |     });
  481 | 
  482 |     test('admin panel: create user, verify in all tabs, delete with cascade', async ({ page }) => {
  483 |         const ts = Date.now();
  484 |         const username = 'admintest_' + ts;
  485 | 
  486 |         // Register a user first so there's data to see
  487 |         await page.goto(`${BASE}/login.html`);
  488 |         await page.click('#show-register');
  489 |         await page.fill('#register-username', username);
  490 |         await page.fill('#register-password', 'password123');
  491 |         await page.click('#register-form button[type="submit"]');
  492 |         await page.waitForURL('**/index.html', { timeout: 10000 });
  493 | 
  494 |         const body = await page.evaluate(() => ({
  495 |             token: localStorage.getItem('token'),
  496 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  497 |         }));
  498 | 
  499 |         // Create a server with this user
  500 |         await page.request.post(`${BASE}/api/servers`, {
  501 |             headers: { Authorization: `Bearer ${body.token}` },
  502 |             data: { name: 'Admin Test Server ' + ts, invite_code_hash: sha256Hex(generateCode(8)) },
  503 |         });
  504 | 
```