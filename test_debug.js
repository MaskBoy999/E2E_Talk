const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const errors = [];
  page.on('console', msg => { if (msg.type() === 'error') errors.push(msg.text()); });
  page.on('pageerror', err => errors.push('PAGE_ERROR: ' + err.message));
  
  await page.goto('http://localhost:3000/login.html');
  await page.click('#show-register');
  await page.fill('#register-username', 'testdebug2');
  await page.fill('#register-password', 'password123');
  await page.click('#register-form button[type="submit"]');
  
  try { await page.waitForURL('**/index.html', { timeout: 10000 }); } catch(e) { console.log('NO REDIRECT'); }
  await page.waitForTimeout(3000);
  
  const icons = await page.locator('.server-icon').count();
  console.log('SERVER ICONS:', icons);
  console.log('ERRORS:', JSON.stringify(errors));
  
  await browser.close();
})();
