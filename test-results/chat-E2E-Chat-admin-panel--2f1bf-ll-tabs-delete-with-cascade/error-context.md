# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat.spec.ts >> E2E Chat >> admin panel: create user, verify in all tabs, delete with cascade
- Location: tests\chat.spec.ts:482:9

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
Call log:
  - navigating to "http://localhost:3000/login.html", waiting until "load"

```

# Test source

```ts
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
> 487 |         await page.goto(`${BASE}/login.html`);
      |                    ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
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
  505 |         // Go to admin panel — first login sets the password, second logs in
  506 |         await page.goto(`${BASE}/admin.html`);
  507 |         await page.fill('#admin-password', 'admin');
  508 |         await page.click('#admin-login-form button[type="submit"]');
  509 |         await page.waitForTimeout(2000);
  510 |         // If panel not visible yet, password was just set — login again
  511 |         const panelVisible = await page.locator('#admin-panel').isVisible().catch(() => false);
  512 |         if (!panelVisible) {
  513 |             await page.fill('#admin-password', 'admin');
  514 |             await page.click('#admin-login-form button[type="submit"]');
  515 |         }
  516 |         await page.waitForSelector('#admin-panel', { state: 'visible', timeout: 10000 });
  517 | 
  518 |         // Verify Users tab has the user
  519 |         await page.waitForFunction(
  520 |             (name) => document.getElementById('user-list')?.textContent?.includes(name),
  521 |             username,
  522 |             { timeout: 5000 }
  523 |         );
  524 | 
  525 |         // Click Servers tab
  526 |         await page.click('[data-tab="servers"]');
  527 |         await page.waitForTimeout(500);
  528 |         const serversText = await page.locator('#tab-servers').textContent();
  529 |         expect(serversText).toContain('Admin Test Server');
  530 | 
  531 |         // Click Members tab
  532 |         await page.click('[data-tab="server-members"]');
  533 |         await page.waitForTimeout(500);
  534 |         const membersText = await page.locator('#tab-server-members').textContent();
  535 |         expect(membersText).toContain(username);
  536 | 
  537 |         // Click back to Users tab and delete
  538 |         await page.click('[data-tab="users"]');
  539 |         await page.waitForTimeout(500);
  540 | 
  541 |         // Find and click the delete button for our user specifically
  542 |         const deleteBtn = page.locator('#user-list tr', { hasText: username }).locator('button');
  543 |         await deleteBtn.click();
  544 | 
  545 |         // Confirm the modal shows cascade stats
  546 |         await page.waitForSelector('#confirm-modal', { state: 'visible', timeout: 5000 });
  547 |         const modalText = await page.locator('#confirm-modal').textContent();
  548 |         expect(modalText).toContain(username);
  549 |         expect(modalText).toContain('cascade-delete');
  550 | 
  551 |         // Click Delete to confirm
  552 |         await page.click('#confirm-delete');
  553 |         await page.waitForTimeout(2000);
  554 | 
  555 |         // Verify user is GONE from the Users tab
  556 |         const usersAfter = await page.locator('#user-list').textContent();
  557 |         expect(usersAfter).not.toContain(username);
  558 | 
  559 |         // Verify server is also GONE (cascade)
  560 |         await page.click('[data-tab="servers"]');
  561 |         await page.waitForTimeout(500);
  562 |         const serversAfter = await page.locator('#tab-servers').textContent();
  563 |         expect(serversAfter).not.toContain('Admin Test Server');
  564 | 
  565 |         // Verify member is also GONE (cascade)
  566 |         await page.click('[data-tab="server-members"]');
  567 |         await page.waitForTimeout(500);
  568 |         const membersAfter = await page.locator('#tab-server-members').textContent();
  569 |         expect(membersAfter).not.toContain(username);
  570 |     });
  571 | 
  572 |     test('kick member triggers key rotation, kicked user loses access', async ({ page, context }) => {
  573 |         const ts = Date.now();
  574 |         const user1 = 'kickowner_' + ts;
  575 |         const user2 = 'kicked_' + ts;
  576 | 
  577 |         // Register user1
  578 |         await page.goto(`${BASE}/login.html`);
  579 |         await page.click('#show-register');
  580 |         await page.fill('#register-username', user1);
  581 |         await page.fill('#register-password', 'password123');
  582 |         await page.click('#register-form button[type="submit"]');
  583 |         await page.waitForURL('**/index.html', { timeout: 10000 });
  584 |         const body1 = await page.evaluate(() => ({
  585 |             token: localStorage.getItem('token'),
  586 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  587 |         }));
```