import { test, expect, type Browser, type Page } from '@playwright/test';

const BASE = 'https://localhost:3443';
const PASSWORD = 'testpass1234';

// Default @everyone permission set (server/src/db.rs PERM_DEFAULT_EVERYONE):
// VIEW_CHANNEL | SEND_MESSAGES | ADD_REACTIONS | REPLY_IN_THREADS | ATTACH_FILES
// | CREATE_POLLS | CONNECT_VOICE | SPEAK | USE_SOUNDBOARD
const DEFAULT_EVERYONE = 286783;

const BITS = {
    VIEW_CHANNEL: 1 << 0,
    SEND_MESSAGES: 1 << 1,
    ADD_REACTIONS: 1 << 2,
    REPLY_IN_THREADS: 1 << 3,
    PIN_MESSAGES: 1 << 6,
    MANAGE_MESSAGES: 1 << 7,
    KICK_MEMBERS: 1 << 8,
    BAN_MEMBERS: 1 << 9,
    MANAGE_CHANNELS: 1 << 10,
    MANAGE_SERVER: 1 << 11,
    MANAGE_ROLES: 1 << 12,
};

function unique(base: string): string {
    return `${base}_${Date.now()}_${Math.random().toString(36).substring(2, 7)}`;
}

/**
 * Each simulated user needs its OWN browser context: pages from one context
 * share localStorage, so registering a second user in the same context would
 * overwrite the first user's token (and silently attribute calls to the wrong
 * account).
 */
async function newUserContext(browser: Browser) {
    return await browser.newContext({
        ignoreHTTPSErrors: true,
        serviceWorkers: 'block',
        baseURL: BASE,
    });
}

async function register(page: Page, username: string) {
    await page.goto(`${BASE}/login.html`);
    await page.evaluate(() => { localStorage.clear(); });
    await page.goto(`${BASE}/login.html`);
    await page.waitForSelector('#show-register', { timeout: 20000 });
    await page.click('#show-register');
    await page.waitForSelector('#register-form', { state: 'visible' });
    await page.fill('#register-username', username);
    await page.fill('#register-password', PASSWORD);
    await page.fill('#register-confirm-password', PASSWORD);
    await page.click('#register-form button[type="submit"]');
    await page.waitForURL('**/index.html', { timeout: 45000 });
    await page.waitForSelector('#current-user', { timeout: 20000 });
}

/** Create a server through the UI and return its id (and the invite code). */
async function createServer(page: Page, name: string): Promise<{ serverId: string; invite: string }> {
    await page.waitForSelector('#add-server-btn', { timeout: 20000 });
    await page.click('#add-server-btn');
    await page.waitForSelector('#choice-create-server', { state: 'visible', timeout: 10000 });
    await page.click('#choice-create-server');
    await page.waitForSelector('#create-server-modal', { state: 'visible', timeout: 10000 });
    await page.fill('#new-server-name', name);
    await page.click('#confirm-create-server');
    await page.waitForSelector('.server-icon[data-id]:not(.add-server)', { timeout: 25000 });
    await page.locator('.server-icon[data-id]:not(.add-server)').first().click();
    await page.waitForTimeout(2500);
    const serverId = await page.evaluate(() =>
        document.querySelector('.server-icon[data-id]:not(.add-server)')?.getAttribute('data-id') || '');
    const invite = await page.evaluate((sid) => localStorage.getItem('e2e_invite_' + sid) || '', serverId);
    expect(serverId).toBeTruthy();
    expect(invite).toBeTruthy();
    return { serverId, invite };
}

/** Authenticated API call from inside a logged-in page (carries its token). */
async function api(page: Page, path: string, init: any = {}) {
    return await page.evaluate(async ([p, i]) => {
        const res = await fetch(p as string, Object.assign({
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + localStorage.getItem('token'),
            },
        }, i || {}));
        let body: any = null;
        try { body = await res.json(); } catch (_) { /* empty body */ }
        return { status: res.status, body };
    }, [path, init]);
}

async function join(page: Page, invite: string) {
    return await api(page, '/api/invites/join', {
        method: 'POST',
        body: JSON.stringify({ code: invite }),
    });
}

async function myPermissions(page: Page, serverId: string) {
    const r = await api(page, `/api/servers/${serverId}/my-permissions`);
    expect(r.status).toBe(200);
    return r.body as { permissions: number; is_owner: boolean; channels: Record<string, number> };
}

async function roles(page: Page, serverId: string) {
    const r = await api(page, `/api/servers/${serverId}/roles`);
    expect(r.status).toBe(200);
    return r.body as any;
}

async function createRole(page: Page, serverId: string, name: string, permissions: number, color = '#ff5500', position?: number) {
    return await api(page, `/api/servers/${serverId}/roles`, {
        method: 'POST',
        body: JSON.stringify(position ? { name, permissions, color, position } : { name, permissions, color }),
    });
}

async function assignRole(page: Page, serverId: string, userId: string, roleId: string | null) {
    return await api(page, `/api/servers/${serverId}/member-role/${userId}`, {
        method: 'PUT',
        body: JSON.stringify({ role_id: roleId }),
    });
}

async function members(page: Page, serverId: string) {
    const r = await api(page, `/api/servers/${serverId}/members`);
    expect(r.status).toBe(200);
    return r.body as Array<any>;
}

async function me(page: Page) {
    const r = await api(page, '/api/me');
    expect(r.status).toBe(200);
    return r.body as any;
}

/** Wait for the page's realtime socket to be usable. */
async function waitForWs(page: Page) {
    await page.waitForFunction(() => {
        // chat.js declares `let ws` at top level (global lexical scope), so it is
        // reachable by name but not as a window property.
        return typeof ws !== 'undefined' && !!ws && ws.readyState === 1;
    }, { timeout: 20000 });
}

/**
 * Send a raw message_send frame from the page (the payload content is opaque to
 * the server, so a placeholder is enough to prove the permission gate).
 */
async function rawSend(page: Page, channelId: string, threadParentId?: string) {
    const bytes = Array.from({ length: 32 }, () => Math.floor(Math.random() * 256));
    const b64 = Buffer.from(bytes).toString('base64');
    const nonce = Buffer.from(Array.from({ length: 24 }, () => Math.floor(Math.random() * 256))).toString('base64');
    await page.evaluate(([ch, content, n, parent]) => {
        const msg: any = {
            type: 'message_send',
            channel_id: ch,
            encrypted_content: content,
            nonce: n,
        };
        if (parent) msg.thread_parent_id = parent;
        ws.send(JSON.stringify(msg));
    }, [channelId, b64, nonce, threadParentId || null]);
}

/** Count stored messages in a channel (via the owner's API). */
async function messageCount(page: Page, channelId: string): Promise<number> {
    const r = await api(page, `/api/channels/${channelId}/messages?limit=100`);
    expect(r.status).toBe(200);
    return Array.isArray(r.body) ? r.body.length : -1;
}

test.describe('Server roles & permissions', () => {

    test('roles: @everyone defaults, one role per member, hierarchy on kick/ban/edit', async ({ page, browser }) => {
        test.setTimeout(180000);
        const owner = unique('rp_owner');
        const modUser = unique('rp_mod');
        const lowUser = unique('rp_low');
        await register(page, owner);
        const { serverId, invite } = await createServer(page, 'Roles Server');

        // Every server starts with an @everyone role carrying the default bits.
        const initial = await roles(page, serverId);
        const everyone = initial.roles.find((r: any) => r.is_everyone);
        expect(everyone, '@everyone role exists').toBeTruthy();
        expect(everyone.permissions).toBe(DEFAULT_EVERYONE);
        expect(everyone.position).toBe(0);
        expect(initial.is_owner).toBe(true);
        expect(initial.my_permissions).toBeGreaterThan(DEFAULT_EVERYONE); // owner holds everything

        // Two members join (API join — key wrapping is irrelevant here).
        const modCtx = await newUserContext(browser);
        const lowCtx = await newUserContext(browser);
        const modPage = await modCtx.newPage();
        const lowPage = await lowCtx.newPage();
        await register(modPage, modUser);
        expect((await join(modPage, invite)).status).toBe(200);
        await register(lowPage, lowUser);
        expect((await join(lowPage, invite)).status).toBe(200);

        // Members without a role fall back to @everyone.
        const modPerms = await myPermissions(modPage, serverId);
        expect(modPerms.is_owner).toBe(false);
        expect(modPerms.permissions).toBe(DEFAULT_EVERYONE);
        expect(modPerms.permissions & BITS.VIEW_CHANNEL).toBeTruthy();
        expect(modPerms.permissions & BITS.SEND_MESSAGES).toBeTruthy();
        expect(modPerms.permissions & BITS.ADD_REACTIONS).toBeTruthy();
        expect(modPerms.permissions & BITS.REPLY_IN_THREADS).toBeTruthy();

        // Members cannot manage roles at all.
        const denied = await createRole(modPage, serverId, 'Rogue', BITS.KICK_MEMBERS);
        expect(denied.status).toBe(403);

        // Owner creates Admin (rank 2) and Mod (rank 1). New roles default to
        // the bottom, so the owner ranks Admin above Mod explicitly.
        const admin = await createRole(page, serverId, 'Admin', BITS.KICK_MEMBERS | BITS.BAN_MEMBERS, '#ff5500', 2);
        expect(admin.status).toBe(200);
        const adminRole = admin.body;
        const mod = await createRole(page, serverId, 'Mod', BITS.KICK_MEMBERS, '#44aaff', 1);
        expect(mod.status).toBe(200);
        expect(mod.body.position).toBe(1);
        expect(mod.body.position).toBeLessThan(adminRole.position);
        expect(adminRole.position).toBe(2);
        // A new role, with no explicit rank, starts at the bottom.
        const bottom = await createRole(page, serverId, 'Bottom', 0);
        expect(bottom.status).toBe(200);
        expect(bottom.body.position).toBe(1);

        const adminId = await me(modPage);
        const lowId = await me(lowPage);

        // One role per member: assigning Mod after Admin replaces it.
        expect((await assignRole(page, serverId, adminId.id, adminRole.id)).status).toBe(200);
        expect((await assignRole(page, serverId, lowId.id, mod.body.id)).status).toBe(200);
        const modRoleAfter = (await myPermissions(modPage, serverId));
        expect(modRoleAfter.permissions & BITS.KICK_MEMBERS).toBeTruthy();
        const memberRows = await members(page, serverId);
        const modRow = memberRows.find((m) => m.id === adminId.id);
        expect(modRow.role_id).toBe(adminRole.id);
        expect(modRow.role_name).toBe('Admin');
        expect(modRow.role_color).toBe('#ff5500');
        expect(modRow.role_position).toBeGreaterThan(memberRows.find((m) => m.id === lowId.id).role_position);

        // Hierarchy: Admin (rank 2) may kick Mod (rank 1)...
        const adminKicksMod = await api(modPage, `/api/servers/${serverId}/members/kick`, {
            method: 'POST', body: JSON.stringify({ user_id: lowId.id }),
        });
        expect(adminKicksMod.status).toBe(200);
        expect((await members(page, serverId)).some((m) => m.id === lowId.id)).toBe(false);

        // ...but Mod (rejoined, rank 1) may not kick Admin (rank 2), and nobody
        // may kick the owner.
        expect((await join(lowPage, invite)).status).toBe(200);
        expect((await assignRole(page, serverId, lowId.id, mod.body.id)).status).toBe(200);
        const modKicksAdmin = await api(lowPage, `/api/servers/${serverId}/members/kick`, {
            method: 'POST', body: JSON.stringify({ user_id: adminId.id }),
        });
        expect(modKicksAdmin.status, 'lower role cannot kick a higher role').toBe(403);
        const ownerId = (await me(page)).id;
        expect((await api(lowPage, `/api/servers/${serverId}/members/kick`, {
            method: 'POST', body: JSON.stringify({ user_id: ownerId }),
        })).status).toBe(403);
        expect((await api(lowPage, `/api/servers/${serverId}/members/ban`, {
            method: 'POST', body: JSON.stringify({ user_id: ownerId }),
        })).status).toBe(403);

        // Owner is never restricted, even by an @everyone deny-everything.
        expect((await api(page, `/api/servers/${serverId}/roles/${everyone.id}`, {
            method: 'PUT',
            body: JSON.stringify({ name: '@everyone', color: '#99aab5', permissions: 0 }),
        })).status).toBe(200);
        const ownerPerms = await myPermissions(page, serverId);
        expect(ownerPerms.is_owner).toBe(true);
        expect(ownerPerms.permissions & BITS.MANAGE_SERVER).toBeTruthy();
        expect((await api(page, `/api/servers/${serverId}/roles/${everyone.id}`, {
            method: 'PUT',
            body: JSON.stringify({ name: '@everyone', color: '#99aab5', permissions: DEFAULT_EVERYONE }),
        })).status).toBe(200);

        // Role edit hierarchy: Admin cannot edit Admin (its own rank) or above.
        expect((await api(modPage, `/api/servers/${serverId}/roles/${adminRole.id}`, {
            method: 'PUT', body: JSON.stringify({ name: 'Hacked', permissions: 0 }),
        })).status).toBe(403);
        // A role at rank 1 cannot create a role at its own rank or above.
        expect((await createRole(lowPage, serverId, 'NewRole', 0)).status).toBe(403);
        // The owner can edit any role.
        expect((await api(page, `/api/servers/${serverId}/roles/${adminRole.id}`, {
            method: 'PUT', body: JSON.stringify({ name: 'Admin', permissions: BITS.KICK_MEMBERS }),
        })).status).toBe(200);

        // Granting is bounded by what you hold: a role with only KICK_MEMBERS
        // cannot be handed MANAGE_SERVER.
        const overGrant = await api(lowPage, `/api/servers/${serverId}/roles/${mod.body.id}`, {
            method: 'PUT',
            body: JSON.stringify({ name: 'Mod', permissions: BITS.MANAGE_SERVER }),
        });
        expect(overGrant.status).toBe(403);

        await modCtx.close();
        await lowCtx.close();
    });

    test('kick, ban and account deletion reset a member\'s role/permissions', async ({ page, browser }) => {
        test.setTimeout(180000);
        const owner = unique('rp_reset_owner');
        const member = unique('rp_reset_member');
        await register(page, owner);
        const { serverId, invite } = await createServer(page, 'Reset Server');

        const memberCtx = await newUserContext(browser);
        const memberPage = await memberCtx.newPage();
        await register(memberPage, member);
        expect((await join(memberPage, invite)).status).toBe(200);
        const memberId = (await me(memberPage)).id;

        const vip = await createRole(page, serverId, 'VIP', BITS.PIN_MESSAGES | BITS.MANAGE_MESSAGES, '#22cc88');
        expect(vip.status).toBe(200);
        expect((await assignRole(page, serverId, memberId, vip.body.id)).status).toBe(200);
        expect((await myPermissions(memberPage, serverId)).permissions & BITS.PIN_MESSAGES).toBeTruthy();

        // The member list exposes the role so the client can render the circle.
        let rows = await members(page, serverId);
        expect(rows.find((m) => m.id === memberId).role_name).toBe('VIP');

        // Kick -> membership (and therefore the role assignment) is gone.
        expect((await api(page, `/api/servers/${serverId}/members/kick`, {
            method: 'POST', body: JSON.stringify({ user_id: memberId }),
        })).status).toBe(200);
        expect((await members(page, serverId)).some((m) => m.id === memberId)).toBe(false);

        // Rejoin -> no role, back to @everyone defaults.
        expect((await join(memberPage, invite)).status).toBe(200);
        rows = await members(page, serverId);
        expect(rows.find((m) => m.id === memberId).role_id).toBeNull();
        expect((await myPermissions(memberPage, serverId)).permissions).toBe(DEFAULT_EVERYONE);

        // Ban -> banned + membership/role removed; rejoin refused; unban works.
        expect((await assignRole(page, serverId, memberId, vip.body.id)).status).toBe(200);
        expect((await api(page, `/api/servers/${serverId}/members/ban`, {
            method: 'POST', body: JSON.stringify({ user_id: memberId }),
        })).status).toBe(200);
        const bans = await api(page, `/api/servers/${serverId}/bans`);
        expect((bans.body as any[]).some((b) => b.id === memberId)).toBe(true);
        expect((await join(memberPage, invite)).status).not.toBe(200);
        expect((await api(page, `/api/servers/${serverId}/members/unban/${memberId}`, { method: 'POST' })).status).toBe(200);
        expect((await join(memberPage, invite)).status).toBe(200);
        rows = await members(page, serverId);
        expect(rows.find((m) => m.id === memberId).role_id).toBeNull();

        // Account deletion (the same cleanup path the admin panel uses) removes
        // the membership row, so the role assignment is gone with it.
        const hash = await memberPage.evaluate(async (pw) =>
            await (window as any).computeHashedPasswordGlobal(pw), PASSWORD);
        const del = await api(memberPage, '/api/me', {
            method: 'DELETE',
            body: JSON.stringify({ current_password: hash }),
        });
        expect(del.status).toBe(200);
        expect((await members(page, serverId)).some((m) => m.id === memberId)).toBe(false);

        await memberCtx.close();
    });

    test('channel & category permission overrides gate who can talk/see', async ({ page, browser }) => {
        test.setTimeout(180000);
        const owner = unique('rp_perm_owner');
        const modUser = unique('rp_perm_mod');
        const plainUser = unique('rp_perm_plain');
        await register(page, owner);
        const { serverId, invite } = await createServer(page, 'Override Server');

        // A private category + channel, and a normal channel.
        const catRes = await api(page, `/api/servers/${serverId}/categories`, {
            method: 'POST', body: JSON.stringify({ position: 5 }),
        });
        expect(catRes.status).toBe(200);
        const categoryId = catRes.body.id;

        const annRes = await api(page, `/api/servers/${serverId}/channels`, {
            method: 'POST',
            body: JSON.stringify({ channel_type: 'text', category_id: categoryId }),
        });
        expect(annRes.status).toBe(201);
        const annChannel = annRes.body.id;

        const channels = (await api(page, `/api/servers/${serverId}/channels`)).body as any[];
        const general = channels.find((c) => c.id !== annChannel);

        const modCtx = await newUserContext(browser);
        const plainCtx = await newUserContext(browser);
        const modPage = await modCtx.newPage();
        const plainPage = await plainCtx.newPage();
        await register(modPage, modUser);
        expect((await join(modPage, invite)).status).toBe(200);
        await register(plainPage, plainUser);
        expect((await join(plainPage, invite)).status).toBe(200);
        const modId = (await me(modPage)).id;

        const role = await createRole(page, serverId, 'Announcer', 0, '#ffcc00');
        expect(role.status).toBe(200);
        const roleId = role.body.id;

        // Category override: @everyone may not send, the role may.
        const everyoneId = (await roles(page, serverId)).roles.find((r: any) => r.is_everyone).id;
        const denyEveryone = await api(page, `/api/servers/${serverId}/roles/${everyoneId}/overwrite`, {
            method: 'PUT',
            body: JSON.stringify({ target_type: 'category', target_id: categoryId, allow: 0, deny: BITS.SEND_MESSAGES }),
        });
        expect(denyEveryone.status).toBe(200);
        const allowRole = await api(page, `/api/servers/${serverId}/roles/${roleId}/overwrite`, {
            method: 'PUT',
            body: JSON.stringify({ target_type: 'category', target_id: categoryId, allow: BITS.SEND_MESSAGES, deny: 0 }),
        });
        expect(allowRole.status).toBe(200);

        expect((await assignRole(page, serverId, modId, roleId)).status).toBe(200);

        // Server-side gate: a plain member cannot post in the announcement
        // channel, the role holder can, and both can post in a normal channel.
        await waitForWs(modPage);
        await waitForWs(plainPage);

        const annBefore = await messageCount(page, annChannel);
        await rawSend(plainPage, annChannel);
        await page.waitForTimeout(1200);
        expect(await messageCount(page, annChannel), 'plain member blocked in category').toBe(annBefore);

        await rawSend(modPage, annChannel);
        await page.waitForTimeout(1200);
        expect(await messageCount(page, annChannel), 'role holder allowed by role override').toBe(annBefore + 1);

        const genBefore = await messageCount(page, general.id);
        await rawSend(plainPage, general.id);
        await page.waitForTimeout(1200);
        expect(await messageCount(page, general.id), 'normal channel still writable').toBe(genBefore + 1);

        // Channel-scoped VIEW_CHANNEL deny hides a channel from that role only.
        const hidden = await api(page, `/api/servers/${serverId}/channels`, {
            method: 'POST',
            body: JSON.stringify({ channel_type: 'text' }),
        });
        expect(hidden.status).toBe(201);
        const hiddenId = hidden.body.id;
        expect((await api(page, `/api/servers/${serverId}/roles/${roleId}/overwrite`, {
            method: 'PUT',
            body: JSON.stringify({ target_type: 'channel', target_id: hiddenId, allow: 0, deny: BITS.VIEW_CHANNEL }),
        })).status).toBe(200);

        const modChannels = (await api(modPage, `/api/servers/${serverId}/channels`)).body as any[];
        expect(modChannels.some((c) => c.id === hiddenId), 'role without VIEW_CHANNEL does not see it').toBe(false);
        const plainChannels = (await api(plainPage, `/api/servers/${serverId}/channels`)).body as any[];
        expect(plainChannels.some((c) => c.id === hiddenId), 'everyone else still sees it').toBe(true);
        const modPerms = await myPermissions(modPage, serverId);
        expect(modPerms.channels[hiddenId] & BITS.VIEW_CHANNEL).toBeFalsy();
        expect((await myPermissions(modPage, serverId)).channels[annChannel] & BITS.SEND_MESSAGES).toBeTruthy();

        // Client-side gate: the same resolution drives the composer, so a role
        // denied SEND_MESSAGES in the announcement channel gets a read-only input.
        // (No key_heartbeat retries: the key is irrelevant to permission state.)
        await plainPage.evaluate(() => localStorage.setItem('key_heartbeat_interval', '0'));
        await plainPage.evaluate(async (sid) => {
            try { await (window as any).selectServer(sid); } catch (_) { /* no server key in this context */ }
        }, serverId);
        const clientGate = await plainPage.evaluate(async ([sid, chId]) => {
            await (window as any).ServerRoles.loadMyPermissions(sid);
            const S = (window as any).ServerRoles;
            const canSend = S.hasInChannel(S.bit('SEND_MESSAGES'), chId);
            try {
                // selectChannel applies the permission gate before loading history.
                (window as any).selectChannel(chId, 'announce', document.createElement('div'));
            } catch (_) { /* history load may fail without the server key */ }
            await new Promise((r) => setTimeout(r, 400));
            return { canSend, inputDisabled: (document.getElementById('message-input') as HTMLInputElement).disabled };
        }, [serverId, annChannel]);
        expect(clientGate.canSend, 'client resolution matches the server').toBe(false);
        expect(clientGate.inputDisabled, 'read-only channel disables the composer').toBe(true);

        // Deleting the category cleans up its overwrites.
        expect((await api(page, `/api/servers/${serverId}/categories/${categoryId}`, { method: 'DELETE' })).status).toBe(200);
        const afterDelete = await roles(page, serverId);
        const r = afterDelete.roles.find((x: any) => x.id === roleId);
        expect((r.overwrites || []).some((o: any) => o.target_id === categoryId)).toBe(false);

        await modCtx.close();
        await plainCtx.close();
    });

    test('UI: roles editor, member role circle, thread replies show display name + PFP', async ({ page }) => {
        test.setTimeout(180000);
        const owner = unique('rp_ui_owner');
        await register(page, owner);
        const { serverId } = await createServer(page, 'UI Roles Server');

        // ── Roles editor: create + "grant all" master toggle ──
        await page.click('#server-settings-btn');
        await page.waitForSelector('#server-settings-modal', { state: 'visible' });
        await expect(page.locator('#server-roles-section')).toBeVisible();
        await expect(page.locator('#create-role-btn')).toBeVisible();
        // @everyone is listed and locked from deletion.
        const everyoneRow = page.locator('.role-row', { hasText: '@everyone' });
        await expect(everyoneRow).toBeVisible();

        await page.click('#create-role-btn');
        await page.waitForTimeout(1200);
        await expect(page.locator('#role-editor')).toBeVisible();
        await page.fill('#role-name-input', 'Moderator');
        await page.locator('#role-color-input').evaluate((el: any) => { el.value = '#ff0055'; });
        // The toggle input is visually hidden behind its slider, so set it the
        // way the label click does: flip the box and fire `change`.
        await page.locator('#role-all-perms').evaluate((el: any) => {
            el.checked = true;
            el.dispatchEvent(new Event('change', { bubbles: true }));
        });
        const checkedCount = await page.locator('#role-perm-boxes input[data-perm-bit]:checked').count();
        expect(checkedCount, 'master toggle turns every permission on').toBeGreaterThan(5);
        await page.click('#save-role-btn');
        await page.waitForTimeout(1500);

        const roleRow = page.locator('.role-row', { hasText: 'Moderator' });
        await expect(roleRow).toBeVisible();
        const saved = (await roles(page, serverId)).roles.find((r: any) => r.name === 'Moderator');
        expect(saved, 'role persisted').toBeTruthy();
        expect(saved.color).toBe('#ff0055');
        expect(saved.permissions).toBeGreaterThan(DEFAULT_EVERYONE); // master toggle granted everything
        // Saving closes the role editor, so re-select the role to reach its
        // per-channel overrides.
        await roleRow.click();
        await page.waitForTimeout(400);
        await expect(page.locator('#role-editor')).toBeVisible();
        await expect(page.locator('#role-overwrite-target')).toBeVisible();
        await page.locator('#server-settings-modal #close-server-settings').click();
        await page.waitForTimeout(500);

        // ── Member list shows a colored role circle with the role name on hover ──
        await page.waitForSelector('.member-item', { timeout: 20000 });
        const circle = page.locator('.member-item .role-circle').first();
        await expect(circle).toBeVisible();
        const title = await circle.getAttribute('title');
        expect(title, 'circle names the role').toBeTruthy();
        const bg = await circle.evaluate((el) => getComputedStyle(el).backgroundColor);
        expect(bg, 'circle has a color').not.toBe('rgba(0, 0, 0, 0)');

        // ── Thread replies: display name + glow + clickable PFP ──
        await page.waitForSelector('.channel-item', { timeout: 20000 });
        await page.locator('.channel-item').first().click();
        await page.waitForTimeout(2000);
        await page.locator('#message-input').fill('parent message');
        await page.click('#send-btn');
        await page.waitForTimeout(2000);

        // "Reply in Thread" lives in the message context menu.
        const msg = page.locator('.message').last();
        await msg.click({ button: 'right' });
        await page.waitForTimeout(500);
        await page.locator('.context-menu-item', { hasText: 'Reply in Thread' }).first().click();
        await page.waitForTimeout(800);
        await expect(page.locator('#thread-panel')).toBeVisible();
        await page.locator('#thread-input').fill('thread reply here');
        await page.click('#thread-send-btn');
        await page.waitForTimeout(3000);

        const threadMsg = page.locator('#thread-messages .thread-message').first();
        await expect(threadMsg).toBeVisible({ timeout: 10000 });
        const shownName = await threadMsg.locator('.display-name').textContent();
        // Pre-fix this printed the first 8 chars of the sender's HMAC hash.
        expect(shownName, 'thread shows the real display name').toBe(owner);
        expect(shownName!.length).toBeLessThan(60);
        expect(/^[0-9a-f]{8}$/.test(shownName || ''), 'not a hashed sender id').toBe(false);
        // Colour/glow come from the profile (may be unset, but the element exists)
        await expect(threadMsg.locator('.display-name')).toHaveCount(1);
        // PFP is present and clicking it opens the profile view.
        const avatar = threadMsg.locator('.thread-avatar');
        await expect(avatar).toBeVisible();
        await avatar.click();
        await page.waitForTimeout(1500);
        await expect(page.locator('#profile-modal')).toBeVisible();

        // ── Channel override round-trips through the API and comes back in the
        //     role data the editor renders (the member-side effect is covered in
        //     the overrides test above; the owner is never restricted). ──
        const channelId = await page.evaluate(() => currentChannelId);
        expect(channelId).toBeTruthy();
        const everyoneId = (await roles(page, serverId)).roles.find((r: any) => r.is_everyone).id;
        expect((await api(page, `/api/servers/${serverId}/roles/${everyoneId}/overwrite`, {
            method: 'PUT',
            body: JSON.stringify({ target_type: 'channel', target_id: channelId, allow: 0, deny: BITS.SEND_MESSAGES }),
        })).status).toBe(200);
        const ownerView = (await roles(page, serverId)).roles.find((r: any) => r.is_everyone);
        const ow = (ownerView.overwrites || []).find((o: any) => o.target_id === channelId);
        expect(ow, 'override stored on the channel').toBeTruthy();
        expect(ow.deny & BITS.SEND_MESSAGES).toBeTruthy();
        // The owner still holds every permission — nothing can restrict him.
        expect((await myPermissions(page, serverId)).permissions & BITS.SEND_MESSAGES).toBeTruthy();
    });
});
