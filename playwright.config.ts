import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 30000,
    retries: 0,
    use: {
        baseURL: 'https://localhost:3443',
        headless: true,
        ignoreHTTPSErrors: true,
    },
    webServer: {
        command: 'call scripts\kill-server.bat & cd server && cargo run 2>&1',
        port: 3443,
        reuseExistingServer: true,
        timeout: 120000,
    },
});
