const { chromium } = require('@playwright/test');
(async () => {
    const b = await chromium.launch({ headless: true });
    const ctx = await b.newContext({ ignoreHTTPSErrors: true });
    const p = await ctx.newPage();
    const pageErrors = [];
    const consoleLogs = [];
    p.on('pageerror', e => pageErrors.push(e.message.substring(0, 500)));
    p.on('console', msg => consoleLogs.push(msg.type() + ': ' + msg.text().substring(0, 200)));

    await p.goto('https://localhost:3443/login.html', { timeout: 15000 });
    
    const reg = await p.evaluate(async () => {
        const r = await fetch('/api/register', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({username:'btntest_'+Date.now(),password:'test1234'}) });
        const t = await r.text();
        try { return JSON.parse(t); } catch(e) { return {error: 'parse_fail', raw: t.substring(0,200)}; }
    });
    console.log('Register:', JSON.stringify(reg).substring(0, 300));

    if (reg.token) {
        await p.evaluate(async (data) => {
            localStorage.setItem('token', data.token);
            localStorage.setItem('user', JSON.stringify(data.user));
        }, reg);
        await p.goto('https://localhost:3443/', { timeout: 15000 });
        await p.waitForTimeout(5000);

        console.log('Page errors:', JSON.stringify(pageErrors));
        console.log('Console:', JSON.stringify(consoleLogs.slice(0, 20)));

        const state = await p.evaluate(() => {
            return {
                hasChatJs: typeof loadDmConversations === 'function',
                hasE2ECrypto: typeof E2ECrypto !== 'undefined',
                dmSidebar: !!document.getElementById('dm-sidebar'),
                myFriendCodeEl: !!document.getElementById('my-friend-code'),
                myFriendCodeText: document.getElementById('my-friend-code')?.textContent || null,
                toggleBtn: !!document.getElementById('toggle-friend-code-btn'),
                copyBtn: !!document.getElementById('copy-friend-code-btn'),
                addFriendBtn: !!document.getElementById('add-friend-btn'),
                getBtn: !!document.getElementById('get-friend-code-btn'),
                regenBtn: !!document.getElementById('regen-friend-code-btn'),
                friendCodeInput: !!document.getElementById('friend-code-input'),
                dmStripVisible: document.getElementById('dm-strip')?.style?.display || 'default',
                viewMode: typeof viewMode !== 'undefined' ? viewMode : 'undef',
                serversCount: typeof servers !== 'undefined' ? (Array.isArray(servers) ? servers.length : 'not-array') : 'undef',
            };
        });
        console.log('State:', JSON.stringify(state, null, 2));
    }

    await b.close();
})();
