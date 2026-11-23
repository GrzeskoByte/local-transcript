import { expect, test } from './fixtures';
import type { Page, Route } from '@playwright/test';

/**
 * Server edition (docs/SERVER.md): the built bundle served with
 * `<meta name="lt-edition" content="server">`, every `/api/*` call answered
 * by an in-memory fake server (cookie = a flag, CSRF checked on writes).
 * Recording runs through the browser's MediaRecorder with the fake mic; chunks
 * and meetings go to the fake server's commands.
 */
test.use({ e2eDefaults: false });

interface Fake {
  signedIn: boolean;
  role: 'admin' | 'member';
  csrf: string;
  meetings: Map<string, Record<string, unknown>>;
  segments: Map<string, Record<string, unknown>>;
  files: Map<string, string>;
  meta: Map<string, string>;
  settings: Record<string, unknown>;
  invokes: string[];
  badCsrf: string[];
  logoutRedirect?: string;
  /** Last body PUT to /api/admin/settings. */
  savedAdminSettings?: Record<string, unknown>;
  models: boolean;
}

const CSRF = 'csrf-token-1';

function user(role: 'admin' | 'member') {
  return { id: `u-${role}`, email: `${role}@example.com`, name: role === 'admin' ? 'Ada Admin' : 'Mia Member', role, auth: 'local' };
}

const json = (route: Route, body: unknown, status = 200): Promise<void> =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function fakeServer(page: Page, init: Partial<Fake> = {}): Promise<Fake> {
  const fake: Fake = {
    signedIn: false,
    role: 'member',
    csrf: CSRF,
    meetings: new Map(),
    segments: new Map(),
    files: new Map(),
    meta: new Map(),
    settings: {},
    invokes: [],
    badCsrf: [],
    models: false,
    ...init,
  };

  // The server injects the edition marker when it serves `/`.
  await page.route(
    (url) => url.pathname === '/' || url.pathname === '/index.html',
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace('<head>', '<head><meta name="lt-edition" content="server">');
      await route.fulfill({ response, body });
    },
  );

  const status = () => ({
    available: true,
    backend: 'whisper-cli',
    binaryPath: '/opt/lt/bin/whisper-cli',
    version: '1.8',
    engines: ['whisper-cli'],
    acceleration: 'CPU',
    gpu: { available: false, active: false, backend: null, devices: [], hint: null },
    modelDir: '/data/models',
    installHint: null,
    recommendedModel: 'large-v3-turbo-q5_0',
    models: [
      {
        name: 'large-v3-turbo-q5_0', engine: 'whisper', installed: fake.models, downloadable: true, path: null,
        sizeBytes: 574_000_000, accuracy: 4, recommended: true, detail: 'quantised',
      },
    ],
  });

  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const { pathname, searchParams } = new URL(req.url());
    const method = req.method();
    const header = (name: string) => req.headers()[name.toLowerCase()];

    if (pathname === '/api/auth/config') return json(route, { localLogin: true, sso: { name: 'Keycloak' }, inviteOnly: true });
    if (pathname === '/api/auth/login' && method === 'POST') {
      const body = req.postDataJSON() as { email: string; password: string };
      if (body.password !== 'correct horse') return json(route, { error: 'Wrong e-mail or password.' }, 401);
      fake.signedIn = true;
      fake.role = body.email.startsWith('admin') ? 'admin' : 'member';
      return json(route, { user: user(fake.role) });
    }
    if (!fake.signedIn) return json(route, { error: 'Sign in first.' }, 401);

    if (pathname === '/api/me') {
      return json(route, {
        user: user(fake.role),
        csrf: fake.csrf,
        capabilities: ['native_settings_load', 'native_settings_set', 'native_asr_status', 'native_recording_write', 'server_db_get'],
      });
    }
    if (method !== 'GET' && header('x-lt-csrf') !== fake.csrf) {
      fake.badCsrf.push(pathname);
      return json(route, { error: 'CSRF token missing or wrong.' }, 403);
    }
    if (pathname === '/api/auth/logout') {
      fake.signedIn = false;
      return json(route, fake.logoutRedirect ? { redirect: fake.logoutRedirect } : {});
    }
    if (pathname === '/api/me/usage') return json(route, { bytes: 4_200_000, quotaBytes: 100_000_000 });
    if (pathname === '/api/me/sessions') {
      return json(route, [
        { id: 'aaaaaaaaaaaa', userAgent: 'Chrome on Linux', createdAt: 1_700_000_000, lastSeenAt: 1_700_000_100, current: true },
        { id: 'bbbbbbbbbbbb', userAgent: 'Firefox on macOS', createdAt: 1_700_000_000, lastSeenAt: 1_700_000_200 },
      ]);
    }
    if (pathname.startsWith('/api/admin/')) {
      if (fake.role !== 'admin') return json(route, { error: 'Administrators only.' }, 403);
      if (pathname === '/api/admin/users') {
        return json(route, [
          { id: 'u-admin', email: 'admin@example.com', name: 'Ada Admin', role: 'admin', auth: 'local', disabled: false, createdAt: 1, lastLoginAt: 2, bytes: 1000 },
          { id: 'u-mia', email: 'mia@example.com', name: 'Mia Member', role: 'member', auth: 'local', disabled: false, createdAt: 1, lastLoginAt: null, bytes: 5_000_000 },
        ]);
      }
      if (pathname === '/api/admin/invites' && method === 'POST') {
        return json(route, { url: '/invite/tok-abc', expiresAt: 1_800_000_000 });
      }
      if (pathname === '/api/admin/invites') return json(route, []);
      if (pathname === '/api/admin/settings' && method === 'PUT') {
        fake.savedAdminSettings = req.postDataJSON() as Record<string, unknown>;
        return json(route, null);
      }
      if (pathname === '/api/admin/settings') {
        return json(route, {
          localLogin: true,
          oidc: { issuer: 'https://sso.example.com', clientId: 'lt', clientSecretSet: true, scopes: ['openid', 'email', 'profile'], providerName: 'Keycloak', adminGroup: 'lt-admins', allowedGroups: [], allowedDomains: ['example.com'] },
          locked: ['oidc.issuer'],
        });
      }
      if (pathname === '/api/admin/audit') {
        return json(route, [{ id: 1, at: 1_700_000_000, userId: 'u-mia', actorId: 'u-admin', action: 'user.disable', detail: 'mia@example.com' },
          { id: 2, at: 1_700_000_001, userId: 'u-mia', actorId: 'u-admin', action: 'user.role', detail: { from: 'member', to: 'admin', groups: ['a', 'b'] } },
        ]);
      }
    }

    if (pathname.startsWith('/api/invoke/')) {
      const cmd = decodeURIComponent(pathname.slice('/api/invoke/'.length));
      fake.invokes.push(cmd);
      const args = (req.postDataJSON() ?? {}) as Record<string, unknown>;
      switch (cmd) {
        case 'native_settings_load': return json(route, fake.settings);
        case 'native_settings_set': fake.settings[args.key as string] = args.value; return json(route, null);
        case 'native_asr_status': return json(route, status());
        case 'server_db_get_all': {
          const store = args.store === 'meetings' ? fake.meetings : args.store === 'segments' ? fake.segments : new Map();
          return json(route, [...store.values()]);
        }
        case 'server_db_get': return json(route, fake.meetings.get(args.key as string) ?? null);
        case 'server_db_get_by_index':
          return json(route, [...fake.segments.values()].filter((s) => s.meetingId === args.key));
        case 'server_db_put': {
          const value = args.value as Record<string, unknown>;
          if (args.store === 'meetings') fake.meetings.set(value.id as string, value);
          else if (args.store === 'segments') fake.segments.set(value.id as string, value);
          return json(route, null);
        }
        case 'server_db_put_if_exists': {
          const value = args.value as Record<string, unknown>;
          const has = fake.meetings.has(value.id as string);
          if (has) fake.meetings.set(value.id as string, value);
          return json(route, has);
        }
        case 'server_db_patch': {
          const current = fake.meetings.get(args.key as string);
          if (!current) return json(route, null);
          const merged = { ...current, ...(args.patch as Record<string, unknown>) };
          fake.meetings.set(args.key as string, merged);
          return json(route, merged);
        }
        case 'server_db_put_if_unchanged': {
          const value = args.value as Record<string, unknown>;
          const current = fake.meetings.get(value.id as string);
          const same = JSON.stringify(current) === JSON.stringify(args.expected);
          if (same) fake.meetings.set(value.id as string, value);
          return json(route, same);
        }
        case 'server_db_delete_meeting': fake.meetings.delete(args.id as string); return json(route, null);
        case 'native_recording_write': {
          const r = args.request as { meetingId: string; track: string; name: string; dataBase64: string };
          fake.files.set(`${r.meetingId}/${r.track}/${r.name}`, r.dataBase64);
          return json(route, null);
        }
        case 'native_recording_write_meta': fake.meta.set(args.meetingId as string, args.meta as string); return json(route, null);
        case 'native_recording_read_meta': return json(route, fake.meta.get(args.meetingId as string) ?? null);
        case 'native_recording_list': {
          const tracks = new Map<string, string[]>();
          for (const key of fake.files.keys()) {
            const [mid, track, name] = key.split('/') as [string, string, string];
            if (mid === args.meetingId) tracks.set(track, [...(tracks.get(track) ?? []), name].sort());
          }
          return json(route, [...tracks].map(([track, chunks]) => ({ track, chunks })));
        }
        default: return json(route, null);
      }
    }
    void searchParams;
    return json(route, { error: `unhandled ${method} ${pathname}` }, 404);
  });
  return fake;
}

async function signIn(page: Page, email: string): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('region', { name: 'Sign in' })).toBeVisible();
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Password').fill('correct horse');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
}

test('signed-out visitors get the sign-in screen; wrong password is explained; sign in opens Home', async ({ page }) => {
  await fakeServer(page);
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  // The configured single sign-on provider is offered next to the local form.
  await expect(page.getByRole('link', { name: 'Sign in with Keycloak' })).toHaveAttribute('href', '/auth/oidc/start');
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);

  await page.getByLabel('E-mail').fill('mia@example.com');
  await page.getByLabel('Password').fill('nope');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Wrong e-mail or password.');

  await page.getByLabel('Password').fill('correct horse');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mia Member' })).toBeVisible();
  await expect(page.locator('.footer-band')).toHaveText('Your recordings and transcripts stay on this server; only you can open them.');
});

test('an expired session (401) returns to the sign-in screen', async ({ page }) => {
  const fake = await fakeServer(page, { signedIn: true });
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
  // Any call now answers 401: the app drops back to the sign-in screen.
  fake.signedIn = false;
  // The 401 reloads the page (no state of the old session survives), which can cut this call short.
  await page
    .evaluate(() => {
      window.location.hash = '#/library';
    })
    .catch(() => undefined);
  await expect(page.getByRole('region', { name: 'Sign in' })).toBeVisible();
});

test('the invite link opens the accept screen', async ({ page }) => {
  const fake = await fakeServer(page);
  let accepted: unknown = null;
  await page.route('**/api/auth/invite/accept', async (route) => {
    accepted = route.request().postDataJSON();
    fake.signedIn = true;
    await json(route, { user: user('member') });
  });
  await page.goto('/#/invite/tok-abc');
  await expect(page.getByRole('region', { name: 'Accept invite' })).toBeVisible();
  const create = page.getByRole('button', { name: 'Create account' });
  await expect(create).toBeDisabled();
  await page.getByLabel('Your name').fill('New Person');
  await page.getByLabel('Password', { exact: true }).fill('long enough pw');
  await page.getByLabel('Password again').fill('different');
  await expect(page.getByRole('alert')).toContainText('do not match');
  await page.getByLabel('Password again').fill('long enough pw');
  await expect(create).toBeEnabled();
  await create.click();
  await expect.poll(() => accepted).toEqual({ token: 'tok-abc', name: 'New Person', password: 'long enough pw' });
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
});

test('record → stop saves the meeting and its chunks on the server, with the CSRF token', async ({ page }) => {
  test.setTimeout(60_000);
  const fake = await fakeServer(page);
  await signIn(page, 'mia@example.com');
  await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();

  await page.locator('#meeting-title').fill('Server standup');
  await page.getByRole('button', { name: /Start recording/ }).click();
  await expect(page.getByLabel('Recording in progress')).toBeVisible();
  // Chunks go to the server, not to "this device".
  await expect(page.locator('.saved-note')).toContainText('saved on this server');
  await expect(page.locator('.saved-note')).not.toContainText('this device');
  await page.waitForTimeout(6_500);
  await page.getByRole('button', { name: '■ Stop & save' }).click();
  await page.getByRole('button', { name: 'Yes, stop & save' }).click();
  await expect(page).toHaveURL(/#\/(meeting|wrapup)\//);

  await expect.poll(() => [...fake.meetings.values()].map((m) => m.title)).toContain('Server standup');
  expect([...fake.files.keys()].length).toBeGreaterThanOrEqual(2);
  expect(fake.meta.size).toBe(1);
  // The browser recorder was used: nothing native/desktop-only was called.
  expect(fake.invokes.filter((c) => /recorder|system_audio|audio_diag|level_monitor|native_update|native_log|storage_dir/.test(c))).toEqual([]);
  expect(fake.badCsrf).toEqual([]);

  // The library lists it from the server.
  await page.reload();
  await page.getByRole('button', { name: 'Library' }).click();
  await expect(page.getByText('Server standup').first()).toBeVisible();
});

test('members are told to ask an administrator for models', async ({ page }) => {
  await fakeServer(page);
  await signIn(page, 'mia@example.com');
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.getByText('Ask your administrator to install it').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Download', exact: true })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'GPU acceleration' })).toHaveCount(0);
  // Home: no "Set up transcription" button either.
  await page.getByRole('button', { name: 'Home' }).click();
  await expect(page.getByText('Ask your administrator to install models.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Set up transcription' })).toHaveCount(0);
});

test('admin sections are visible to an admin and absent for a member', async ({ page }) => {
  await fakeServer(page);
  await signIn(page, 'mia@example.com');
  await page.goto('/#/settings/account');
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  await expect(nav.getByRole('button', { name: /^Account/ })).toBeVisible();
  await expect(nav.getByRole('button', { name: /^Users/ })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: /^Sign-in/ })).toHaveCount(0);
  await expect(nav.getByRole('button', { name: /^Audit log/ })).toHaveCount(0);
  await page.goto('/#/settings/users');
  await expect(page.getByRole('region', { name: 'Users' })).toHaveCount(0);
});

test('admin: users, invite link, sign-in settings and audit log', async ({ page }) => {
  const fake = await fakeServer(page);
  await signIn(page, 'admin@example.com');
  await page.goto('/#/settings/users');
  const nav = page.getByRole('navigation', { name: 'Settings sections' });
  for (const name of ['Account', 'Users', 'Sign-in', 'Audit log']) await expect(nav.getByRole('button', { name, exact: false }).filter({ hasText: new RegExp(`^${name}`) })).toBeVisible();

  const table = page.getByRole('table', { name: 'Accounts' });
  await expect(table).toContainText('mia@example.com');
  await expect(table).toContainText('5 MB');
  // You cannot demote or disable yourself.
  await expect(page.getByLabel('Role of admin@example.com')).toBeDisabled();

  await page.getByLabel('Invite e-mail').fill('new@example.com');
  await page.getByRole('button', { name: 'Create invite link' }).click();
  await expect(page.getByRole('status', { name: 'Invite link' })).toContainText('/invite/tok-abc');
  await expect(page.getByRole('button', { name: 'Copy invite link' })).toBeVisible();

  await nav.getByRole('button', { name: /^Sign-in/ }).click();
  await expect(page.getByLabel('Issuer URL')).toBeDisabled(); // locked by the server's environment
  await expect(page.getByLabel('Client ID')).toHaveValue('lt');
  // The server sends scopes as a list: shown space-separated, saved as a list again.
  await expect(page.getByLabel('Scopes')).toHaveValue('openid email profile');
  await page.getByLabel('Scopes').fill('openid  email groups\n');
  await page.getByRole('button', { name: /^Save/ }).click();
  await expect.poll(() => (fake.savedAdminSettings?.oidc as { scopes?: unknown } | undefined)?.scopes).toEqual(['openid', 'email', 'groups']);
  const secret = page.getByLabel('Client secret');
  await expect(secret).toHaveValue(''); // write-only
  await expect(secret).toHaveAttribute('placeholder', /Set/);

  await nav.getByRole('button', { name: /^Audit log/ }).click();
  const audit = page.getByRole('table', { name: 'Audit entries' });
  await expect(audit).toContainText('user.disable');
  // An object `detail` is shown as text, not [object Object] (and does not crash the page).
  await expect(audit).toContainText('from: member, to: admin, groups: ["a","b"]');
  await expect(audit).not.toContainText('[object Object]');
  expect(fake.badCsrf).toEqual([]);
});

test('account: usage, sessions, export link and typed-email delete confirmation', async ({ page }) => {
  await fakeServer(page);
  await signIn(page, 'mia@example.com');
  await page.goto('/#/settings/account');
  await expect(page.getByLabel('Storage used')).toContainText('4 MB');
  await expect(page.getByLabel('Storage used')).toContainText('of 100 MB');
  await expect(page.getByRole('region', { name: 'Sessions' })).toContainText('Firefox on macOS');
  await expect(page.getByRole('link', { name: 'Download' })).toHaveAttribute('href', '/api/me/export');
  await expect(page.getByRole('region', { name: 'Change password' })).toBeVisible();
  const del = page.getByRole('button', { name: 'Delete my account' });
  await expect(del).toBeDisabled();
  await page.getByLabel('Type member@example.com to confirm').fill('member@example.com');
  await expect(del).toBeEnabled();
});

test('sign out ends the session; an identity provider logout URL is followed', async ({ page }) => {
  const fake = await fakeServer(page);
  await signIn(page, 'mia@example.com');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('region', { name: 'Sign in' })).toBeVisible();
  expect(fake.signedIn).toBe(false);
  expect(fake.badCsrf).toEqual([]);

  fake.logoutRedirect = 'https://sso.example.com/logout';
  await page.route('https://sso.example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>provider logged out</h1>' }));
  await signIn(page, 'mia@example.com');
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL('https://sso.example.com/logout');
});

test('signing out while recording asks first, then stops and saves before the session ends', async ({ page }) => {
  test.setTimeout(60_000);
  const fake = await fakeServer(page);
  await signIn(page, 'mia@example.com');
  await page.locator('#meeting-title').fill('Interrupted standup');
  await page.getByRole('button', { name: /Start recording/ }).click();
  await expect(page.getByLabel('Recording in progress')).toBeVisible();
  await page.waitForTimeout(6_000);

  await page.getByRole('button', { name: 'Sign out' }).click();
  // Nothing happens until the user agrees.
  await expect(page.getByRole('group', { name: 'Stop the recording and sign out?' })).toBeVisible();
  expect(fake.signedIn).toBe(true);
  await page.getByRole('button', { name: 'Stop & sign out' }).click();

  await expect(page.getByRole('region', { name: 'Sign in' })).toBeVisible();
  expect(fake.signedIn).toBe(false);
  // The recording was stopped and saved under the account that made it.
  const saved = [...fake.meetings.values()].find((m) => m.title === 'Interrupted standup');
  expect(saved).toBeTruthy();
  expect(saved?.unfinished).not.toBe(true);
  expect(saved?.endedAt).toBeTruthy();
  expect([...fake.files.keys()].length).toBeGreaterThanOrEqual(1);
  expect(fake.badCsrf).toEqual([]);
});

test('browser prefs are keyed by account', async ({ page }) => {
  await fakeServer(page);
  await signIn(page, 'mia@example.com');
  await page.goto('/#/settings/storage');
  await page.waitForTimeout(500);
  const keys = await page.evaluate(() => Object.keys(localStorage));
  expect(keys.filter((k) => !k.startsWith('u:u-member:'))).toEqual([]);
  // A different account on the same browser starts from nothing of the first one's.
  await page.evaluate(() => localStorage.setItem('u:u-member:keep-audio', '30d'));
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('region', { name: 'Sign in' })).toBeVisible();
  await signIn(page, 'admin@example.com');
  const seen = await page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('u:u-admin:')));
  expect(seen).not.toContain('u:u-admin:keep-audio');
});
