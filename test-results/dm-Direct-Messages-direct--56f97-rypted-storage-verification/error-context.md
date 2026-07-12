# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: dm.spec.ts >> Direct Messages >> direct messages: encrypted storage verification
- Location: tests\dm.spec.ts:138:9

# Error details

```
Error: expect(received).toBeGreaterThanOrEqual(expected)

Expected: >= 1
Received:    0
```

# Page snapshot

```yaml
- generic [ref=e2]:
  - generic [ref=e3]:
    - generic "Direct Messages" [ref=e4]:
      - img [ref=e5]
    - button "+" [ref=e7] [cursor=pointer]
  - generic [ref=e8]:
    - heading "Direct Messages" [level=2] [ref=e10]
    - generic [ref=e11]:
      - button "+ New Message" [ref=e12]
      - generic [ref=e14] [cursor=pointer]:
        - generic [ref=e15]: C
        - generic [ref=e17]: ctuser2_1783851484589
    - generic [ref=e18]:
      - generic [ref=e19]: ctuser1_1783851484589
      - generic [ref=e20]:
        - link "Admin" [ref=e21] [cursor=pointer]:
          - /url: admin.html
        - button "Logout" [ref=e22] [cursor=pointer]
  - generic [ref=e23]:
    - generic [ref=e24]:
      - heading "ctuser2_1783851484589" [level=3] [ref=e25]
      - button "☰" [ref=e26] [cursor=pointer]
    - generic [ref=e27]:
      - generic [ref=e29]: No messages yet. Say hello!
      - generic:
        - generic:
          - button "×"
    - generic [ref=e30]:
      - textbox "Type a message..." [ref=e31]: Secret DM message
      - button "Send" [active] [ref=e32] [cursor=pointer]
```

# Test source

```ts
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
  164 |         await page2.waitForURL('**/index.html', { timeout: 10000 });
  165 |         const body2 = await page2.evaluate(() => ({
  166 |             token: localStorage.getItem('token'),
  167 |             user: JSON.parse(localStorage.getItem('user') || '{}'),
  168 |         }));
  169 | 
  170 |         // User2's identity key
  171 |         const user2IdentityKey = await page2.evaluate(() => {
  172 |             return E2ECrypto.arrayBufferToBase64(E2ECrypto.getIdentityKeyPair().publicKey);
  173 |         });
  174 | 
  175 |         // User1 creates DM with user2
  176 |         await page.goto(`${BASE}/index.html`);
  177 |         await page.click('#dm-strip-btn');
  178 |         await page.waitForSelector('#dm-list', { timeout: 2000 });
  179 |         await page.click('#new-dm-btn');
  180 |         await page.waitForSelector('#dm-search-modal', { timeout: 2000 });
  181 |         await page.fill('#dm-username-input', user2);
  182 |         await page.click('#confirm-dm-search');
  183 |         await page.waitForTimeout(2000);
  184 | 
  185 |         // Send a message
  186 |         await page.fill('#message-input', 'Secret DM message');
  187 |         await page.click('#send-btn');
  188 |         await page.waitForTimeout(1000);
  189 | 
  190 |         // Verify the message is stored encrypted on the server (via API)
  191 |         const convRes = await page.request.get(`${BASE}/api/dm/conversations`, {
  192 |             headers: { Authorization: `Bearer ${body1.token}` },
  193 |         });
  194 |         const conversations = await convRes.json();
  195 |         expect(Array.isArray(conversations)).toBe(true);
  196 |         expect(conversations.length).toBeGreaterThanOrEqual(1);
  197 |         const dmChannelId = conversations[0].dm_channel_id;
  198 | 
  199 |         const msgsRes = await page.request.get(`${BASE}/api/dm/${dmChannelId}/messages`, {
  200 |             headers: { Authorization: `Bearer ${body1.token}` },
  201 |         });
  202 |         const msgs = await msgsRes.json();
> 203 |         expect(msgs.length).toBeGreaterThanOrEqual(1);
      |                             ^ Error: expect(received).toBeGreaterThanOrEqual(expected)
  204 |         for (const m of msgs) {
  205 |             expect(m).toHaveProperty('encrypted_content');
  206 |             expect(m).toHaveProperty('nonce');
  207 |             expect(m).not.toHaveProperty('content');
  208 |             expect(m.encrypted_content.length).toBeGreaterThan(0);
  209 |         }
  210 | 
  211 |         await page2.close();
  212 |         await ctx2.close();
  213 |     });
  214 | });
  215 | 
```