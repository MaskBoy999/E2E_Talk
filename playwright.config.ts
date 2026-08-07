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
        command: 'cd server && cargo run 2>&1',
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
            AUTH_PARAMS_IP_MAX: '100000',
            HMAC_KEY_IP_MAX: '100000',
        },
    },
});
