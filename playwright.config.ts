import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    timeout: 45000,
    // This dev machine is slow (multi-second TLS handshakes, 64 MiB client-side
    // Argon2id per register) — the default 4 workers starve each other and push
    // tests past the timeout. Two workers keep runs reliable without serializing.
    workers: 2,
    retries: 0,
    use: {
        baseURL: 'https://localhost:3443',
        headless: true,
        ignoreHTTPSErrors: true,
        // Service workers (the app's PWA SW) cache the app shell — in tests we
        // must ALWAYS hit the network so code fixes are actually exercised.
        serviceWorkers: 'block',
    },
    webServer: {
        command: 'cd server && cargo run --release 2>&1',
        port: 3443,
        reuseExistingServer: true,
        timeout: 120000,
        // TURN servers configured for tests (merged with process.env). The
        // client should pick these up from /api/voice/turn-config and use them
        // in RTCPeerConnection iceServers (tests/voice-turn.spec.ts).
        env: {
            TURN_URLS: 'turn:turn.example.com:3478,turns:turn.example.com:5349',
            TURN_USERNAME: 'test-turn-user',
            TURN_PASSWORD: 'test-turn-pass',
            // The suite creates dozens of users from one IP — raise the
            // friend-request AND login rate limits so tests never 429
            // mid-suite (same pattern for both).
            FRIEND_REQUEST_IP_MAX: '100000',
            FRIEND_REQUEST_USER_MAX: '100000',
            LOGIN_IP_MAX: '100000',
            LOGIN_USER_MAX: '100000',
            // Kill-switch proof attempts have their own tighter per-IP AND
            // per-account budgets; raise both so the kill-switch suite's
            // logins never 429 mid-suite.
            KILL_SWITCH_IP_MAX: '100000',
            KILL_SWITCH_USER_MAX: '100000',
            // F2: registration is now per-IP limited (account spam) — the suite
            // registers dozens of users from one IP, so raise the budget.
            REGISTER_IP_MAX: '100000',
            // 2FA code-verification shares the login limiter space; raise it so
            // the twofa suite's repeated code attempts never 429 mid-suite.
            LOGIN_2FA_IP_MAX: '100000',
            AUTH_PARAMS_IP_MAX: '100000',
            HMAC_KEY_IP_MAX: '100000',
            CLIENT_CONFIG_IP_MAX: '100000',
            // E2E message search + token-index backfill share a per-IP budget;
            // raise it so the search suite's queries never 429 mid-suite.
            SEARCH_IP_MAX: '100000',
            // Admin-login attempts share a per-IP budget; raise it for the suite
            // (admin tests + probes log in repeatedly from one machine).
            ADMIN_LOGIN_IP_MAX: '100000',
            // G2: the suite makes many authed mutations per user/IP from one
            // machine — raise the per-user + per-IP budgets and storage quota.
            MUTATION_USER_MAX: '100000',
            MUTATION_IP_MAX: '100000',
            FILE_STORAGE_QUOTA_BYTES: '100000000000',
        },
    },
});
