// Shared auth helpers for specs that drive POST /api/login directly.
//
// Since finding 3 the login protocol is nonce + Ed25519 signature from the
// account's `login_public_key`. Registration and password change both require
// one, and there is no credential fallback, so a keyless account cannot log in.
// `loginBody()` reproduces the client protocol inside the page — E2ECrypto and
// libsodium are loaded there — so specs never duplicate the crypto and always
// get a fresh single-use nonce.
import type { APIResponse, Page } from '@playwright/test';

export const AUTH_BASE = 'https://localhost:3443';

/** Build a valid /api/login body (signed when the account requires it). */
export async function loginBody(
    page: Page,
    username: string,
    password: string,
    extra: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
    return page.evaluate(
        async ({ username, password, extra }) => {
            const body = await (window as any).E2ECrypto.loginRequestBody(username, password);
            return Object.assign({}, body, extra);
        },
        { username, password, extra },
    );
}

/** POST /api/login with a freshly built body (new nonce on every call). */
export async function apiLogin(
    page: Page,
    username: string,
    password: string,
    extra: Record<string, unknown> = {},
    base: string = AUTH_BASE,
): Promise<APIResponse> {
    const data = await loginBody(page, username, password, extra);
    return page.request.post(`${base}/api/login`, {
        headers: { 'Content-Type': 'application/json' },
        data,
    });
}
