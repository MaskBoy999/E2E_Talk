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
});
