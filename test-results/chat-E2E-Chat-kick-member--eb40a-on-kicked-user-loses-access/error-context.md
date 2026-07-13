# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat.spec.ts >> E2E Chat >> kick member triggers key rotation, kicked user loses access
- Location: tests\chat.spec.ts:572:9

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
Call log:
  - navigating to "http://localhost:3000/login.html", waiting until "load"

```

# Test source

```ts
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
> 578 |         await page.goto(`${BASE}/login.html`);
      |                    ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
  579 |         await page.click('#show-register');
  580 |         await page.fill('#register-username', user1);
  581 |         await page.fill('#register-password', 'password123');
  582 |         await page.click('#register-form button[type="submit"]');
  583 |         await page.waitForURL('**/index.html', { timeout: 10000 });
  584 |         const body1 = await page.evaluate(() => ({
  585 |             token: localStorage.getItem('token'),
  586 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  587 |         }));
  588 | 
  589 |         // Register user2 in separate context
  590 |         const ctx2 = await context.browser()!.newContext();
  591 |         const page2 = await ctx2.newPage();
  592 |         await page2.goto(`${BASE}/login.html`);
  593 |         await page2.waitForTimeout(1000);
  594 |         await page2.click('#show-register');
  595 |         await page2.fill('#register-username', user2);
  596 |         await page2.fill('#register-password', 'password123');
  597 |         await page2.click('#register-form button[type="submit"]');
  598 |         await page2.waitForURL('**/index.html', { timeout: 10000 });
  599 |         const body2 = await page2.evaluate(() => ({
  600 |             token: localStorage.getItem('token'),
  601 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  602 |         }));
  603 | 
  604 |         // User1 creates server
  605 |         const inviteCode2 = generateCode(8);
  606 |         const srv = await page.request.post(`${BASE}/api/servers`, {
  607 |             headers: { Authorization: `Bearer ${body1.token}` },
  608 |             data: { name: 'Kick Test', invite_code_hash: sha256Hex(inviteCode2) },
  609 |         });
  610 |         const server = await srv.json();
  611 | 
  612 |         // Generate and upload server key for user1
  613 |         await page.evaluate(async ({ serverId, userId }) => {
  614 |             const serverKey = E2ECrypto.generateServerKey();
  615 |             E2ECrypto.saveServerKey(serverId, serverKey);
  616 |             const identity = E2ECrypto.getIdentityKeyPair();
  617 |             const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
  618 |             await fetch(`/api/servers/${serverId}/keys`, {
  619 |                 method: 'POST',
  620 |                 headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
  621 |                 body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
  622 |             });
  623 |         }, { serverId: server.id, userId: body1.user.id });
  624 | 
  625 |         // User2 joins
  626 |         const invRes = await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
  627 |             headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
  628 |             data: { invite_code_hash: sha256Hex(inviteCode2) },
  629 |         });
  630 |         const invite = await invRes.json();
  631 |         expect(invite.ok).toBeTruthy();
  632 |         await page2.request.post(`${BASE}/api/invites/join`, {
  633 |             headers: { Authorization: `Bearer ${body2.token}` },
  634 |             data: { code: inviteCode2 },
  635 |         });
  636 | 
  637 |         // Upload key for user2
  638 |         const user2PubKey = await page2.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
  639 |         await page.evaluate(async ({ serverId, user2Id, user2PubKey }) => {
  640 |             const serverKey = E2ECrypto.getServerKey(serverId);
  641 |             const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKey));
  642 |             const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
  643 |             await fetch(`/api/servers/${serverId}/keys`, {
  644 |                 method: 'POST',
  645 |                 headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
  646 |                 body: JSON.stringify({ user_id: user2Id, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
  647 |             });
  648 |         }, { serverId: server.id, user2Id: body2.user.id, user2PubKey });
  649 | 
  650 |         // Both load chat
  651 |         await page.goto(`${BASE}/index.html`);
  652 |         await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
  653 |         await page.click('.server-icon:not(.add-server)');
  654 |         await page.waitForSelector('.channel-item', { timeout: 10000 });
  655 |         await page.click('.channel-item >> nth=0');
  656 |         await page.waitForTimeout(500);
  657 | 
  658 |         await page2.goto(`${BASE}/index.html`);
  659 |         await page2.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
  660 |         await page2.click('.server-icon:not(.add-server)');
  661 |         await page2.waitForSelector('.channel-item', { timeout: 10000 });
  662 |         await page2.click('.channel-item >> nth=0');
  663 |         await page2.waitForTimeout(1000);
  664 | 
  665 |         // User1 sends a message — user2 should see it (both have the key)
  666 |         const input1 = page.locator('#message-input');
  667 |         await expect(input1).toBeEnabled({ timeout: 5000 });
  668 |         await input1.fill('Before kick');
  669 |         await page.click('#send-btn');
  670 |         await page.waitForTimeout(2000);
  671 |         const user2MsgsBefore = await page2.locator('.message .text').allTextContents();
  672 |         expect(user2MsgsBefore).toContain('Before kick');
  673 | 
  674 |         // User1 kicks user2 via API
  675 |         await page.request.post(`${BASE}/api/servers/${server.id}/members/kick`, {
  676 |             headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
  677 |             data: { user_id: body2.user.id },
  678 |         });
```