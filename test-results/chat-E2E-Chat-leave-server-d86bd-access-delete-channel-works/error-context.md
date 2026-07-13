# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: chat.spec.ts >> E2E Chat >> leave server removes access, delete channel works
- Location: tests\chat.spec.ts:695:9

# Error details

```
Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
Call log:
  - navigating to "http://localhost:3000/login.html", waiting until "load"

```

# Test source

```ts
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
  679 |         await page.waitForTimeout(2000);
  680 | 
  681 |         // User1 sends another message with the rotated key
  682 |         await input1.fill('After kick');
  683 |         await page.click('#send-btn');
  684 |         await page.waitForTimeout(2000);
  685 | 
  686 |         // User1 should see both messages
  687 |         const user1Msgs = await page.locator('.message .text').allTextContents();
  688 |         expect(user1Msgs).toContain('Before kick');
  689 |         expect(user1Msgs).toContain('After kick');
  690 | 
  691 |         await page2.close();
  692 |         await ctx2.close();
  693 |     });
  694 | 
  695 |     test('leave server removes access, delete channel works', async ({ page, context }) => {
  696 |         const ts = Date.now();
  697 |         const user1 = 'leaveowner_' + ts;
  698 |         const user2 = 'leaver_' + ts;
  699 | 
  700 |         // Register user1
> 701 |         await page.goto(`${BASE}/login.html`);
      |                    ^ Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000/login.html
  702 |         await page.click('#show-register');
  703 |         await page.fill('#register-username', user1);
  704 |         await page.fill('#register-password', 'password123');
  705 |         await page.click('#register-form button[type="submit"]');
  706 |         await page.waitForURL('**/index.html', { timeout: 10000 });
  707 |         const body1 = await page.evaluate(() => ({
  708 |             token: localStorage.getItem('token'),
  709 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  710 |         }));
  711 | 
  712 |         // Register user2
  713 |         const ctx2 = await context.browser()!.newContext();
  714 |         const page2 = await ctx2.newPage();
  715 |         await page2.goto(`${BASE}/login.html`);
  716 |         await page2.waitForTimeout(1000);
  717 |         await page2.click('#show-register');
  718 |         await page2.fill('#register-username', user2);
  719 |         await page2.fill('#register-password', 'password123');
  720 |         await page2.click('#register-form button[type="submit"]');
  721 |         await page2.waitForURL('**/index.html', { timeout: 10000 });
  722 |         const body2 = await page2.evaluate(() => ({
  723 |             token: localStorage.getItem('token'),
  724 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  725 |         }));
  726 | 
  727 |         // User1 creates server, uploads key
  728 |         const inviteCode3 = generateCode(8);
  729 |         const srv = await page.request.post(`${BASE}/api/servers`, {
  730 |             headers: { Authorization: `Bearer ${body1.token}` },
  731 |             data: { name: 'Leave Test', invite_code_hash: sha256Hex(inviteCode3) },
  732 |         });
  733 |         const server = await srv.json();
  734 |         await page.evaluate(async ({ serverId, userId }) => {
  735 |             const serverKey = E2ECrypto.generateServerKey();
  736 |             E2ECrypto.saveServerKey(serverId, serverKey);
  737 |             const identity = E2ECrypto.getIdentityKeyPair();
  738 |             const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, identity.publicKey);
  739 |             await fetch(`/api/servers/${serverId}/keys`, {
  740 |                 method: 'POST',
  741 |                 headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
  742 |                 body: JSON.stringify({ user_id: userId, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
  743 |             });
  744 |         }, { serverId: server.id, userId: body1.user.id });
  745 | 
  746 |         // User2 joins, gets key
  747 |         const invRes = await page.request.post(`${BASE}/api/servers/${server.id}/invite`, {
  748 |             headers: { Authorization: `Bearer ${body1.token}`, 'Content-Type': 'application/json' },
  749 |             data: { invite_code_hash: sha256Hex(inviteCode3) },
  750 |         });
  751 |         const invite = await invRes.json();
  752 |         expect(invite.ok).toBeTruthy();
  753 |         await page2.request.post(`${BASE}/api/invites/join`, {
  754 |             headers: { Authorization: `Bearer ${body2.token}` },
  755 |             data: { code: inviteCode3 },
  756 |         });
  757 |         const user2PubKey = await page2.evaluate(() => E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey));
  758 |         await page.evaluate(async ({ serverId, user2Id, user2PubKey }) => {
  759 |             const serverKey = E2ECrypto.getServerKey(serverId);
  760 |             const recipientPub = new Uint8Array(E2ECrypto.base64ToArrayBuffer(user2PubKey));
  761 |             const encrypted = E2ECrypto.envelopeEncryptRaw(serverKey, recipientPub);
  762 |             await fetch(`/api/servers/${serverId}/keys`, {
  763 |                 method: 'POST',
  764 |                 headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
  765 |                 body: JSON.stringify({ user_id: user2Id, encrypted_key: encrypted.ciphertext, sender_public_key: encrypted.ephemeralPublicKey, nonce: encrypted.nonce }),
  766 |             });
  767 |         }, { serverId: server.id, user2Id: body2.user.id, user2PubKey });
  768 | 
  769 |         // User1 creates a second channel
  770 |         await page.evaluate(async (serverId) => {
  771 |             await fetch(`/api/servers/${serverId}/channels`, {
  772 |                 method: 'POST',
  773 |                 headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + localStorage.getItem('token') },
  774 |                 body: JSON.stringify({ name: 'delete-me' }),
  775 |             });
  776 |         }, server.id);
  777 |         await page.waitForTimeout(500);
  778 | 
  779 |         // User1 loads chat, verifies both channels exist
  780 |         await page.goto(`${BASE}/index.html`);
  781 |         await page.waitForSelector('.server-icon:not(.add-server)', { timeout: 10000 });
  782 |         await page.click('.server-icon:not(.add-server)');
  783 |         await page.waitForSelector('.channel-item', { timeout: 10000 });
  784 |         const channelsBefore = await page.locator('.channel-item span').allTextContents();
  785 |         expect(channelsBefore.some(c => c.includes('delete-me'))).toBeTruthy();
  786 | 
  787 |         // User1 deletes the channel via API
  788 |         const chRes = await page.request.get(`${BASE}/api/servers/${server.id}/channels`, {
  789 |             headers: { Authorization: `Bearer ${body1.token}` },
  790 |         });
  791 |         const channels = await chRes.json();
  792 |         const deleteMe = channels.find(c => c.name === 'delete-me');
  793 |         expect(deleteMe).toBeTruthy();
  794 | 
  795 |         const delRes = await page.request.delete(`${BASE}/api/channels/${deleteMe.id}`, {
  796 |             headers: { Authorization: `Bearer ${body1.token}` },
  797 |         });
  798 |         expect(delRes.ok()).toBeTruthy();
  799 | 
  800 |         // Reload and verify channel is gone
  801 |         await page.reload();
```