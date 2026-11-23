/** Typed wrappers for the server edition's account/admin endpoints (docs/SERVER.md). */
import { useSyncExternalStore } from 'react';
import { serverApi } from '../../../platform/server-bridge';
import {
  loadServerSession,
  serverSession,
  serverSessionVersion,
  setServerSession,
  subscribeServerSession,
  type ServerSession,
  type ServerUser,
} from '../../../platform/server';
import { resetNativeSettingsCache } from '../../../platform/native-settings';

/** The signed-in session; re-renders when it changes. */
export function useServerSession(): ServerSession | null {
  useSyncExternalStore(subscribeServerSession, serverSessionVersion);
  return serverSession();
}

export interface AuthConfig {
  localLogin: boolean;
  sso: { name: string } | null;
  inviteOnly: boolean;
}

export const fetchAuthConfig = (): Promise<AuthConfig> =>
  serverApi<AuthConfig>('GET', '/api/auth/config', undefined, { auth: false });

/** Local sign-in; resolves once the session (user + CSRF token) is loaded. */
export async function signIn(email: string, password: string): Promise<ServerSession> {
  await serverApi<{ user: ServerUser }>('POST', '/api/auth/login', { email, password }, { auth: false });
  return openSession();
}

export async function acceptInvite(token: string, name: string, password: string): Promise<ServerSession> {
  await serverApi<{ user: ServerUser }>('POST', '/api/auth/invite/accept', { token, name, password }, { auth: false });
  return openSession();
}

async function openSession(): Promise<ServerSession> {
  resetNativeSettingsCache();
  const session = await loadServerSession();
  if (!session) throw new Error('The server did not start a session. Check that cookies are allowed.');
  return session;
}

/** Forget the session locally (after sign-out / account deletion). */
export function endSession(): void {
  resetNativeSettingsCache();
  setServerSession(null);
}

/** Sign out; follows the provider's end-session URL when the server sends one. */
export async function signOut(): Promise<void> {
  let redirect: string | undefined;
  try {
    const reply = await serverApi<{ redirect?: string } | null>('POST', '/api/auth/logout');
    redirect = reply?.redirect;
  } catch {
    // Already signed out (401) or the server is unreachable: leave anyway.
  }
  endSession();
  if (redirect) window.location.assign(redirect);
  else window.location.hash = '#/signin';
}

// ---- own account ----------------------------------------------------------

export interface ServerSessionRow {
  id: string;
  userAgent?: string;
  createdAt?: number | string;
  lastSeenAt?: number | string;
  expiresAt?: number | string;
  current?: boolean;
}
export interface Usage {
  bytes: number;
  quotaBytes: number;
}

export const changePassword = (current: string, next: string): Promise<void> =>
  serverApi<void>('POST', '/api/me/password', { current, next });
export const listSessions = (): Promise<ServerSessionRow[]> => serverApi<ServerSessionRow[]>('GET', '/api/me/sessions');
export const revokeSession = (id: string): Promise<void> =>
  serverApi<void>('DELETE', `/api/me/sessions/${encodeURIComponent(id)}`);
export const fetchUsage = (): Promise<Usage> => serverApi<Usage>('GET', '/api/me/usage');
export const deleteOwnAccount = (confirm: string): Promise<void> => serverApi<void>('DELETE', '/api/me', { confirm });

// ---- admin ---------------------------------------------------------------

export interface AdminUser {
  id: string;
  email: string;
  name: string;
  role: 'admin' | 'member';
  auth: 'local' | 'oidc';
  disabled: boolean;
  createdAt?: number | string;
  lastLoginAt?: number | string | null;
  bytes: number;
}
export interface InviteRow {
  id: string;
  email: string;
  role: 'admin' | 'member';
  expiresAt?: number | string;
  usedAt?: number | string | null;
}
export interface AdminSettings {
  localLogin: boolean;
  oidc: {
    issuer: string;
    clientId: string;
    clientSecretSet: boolean;
    scopes: string;
    providerName: string;
    adminGroup: string;
    allowedGroups: string[] | string;
    allowedDomains: string[] | string;
  };
  locked: string[];
}
export interface AuditRow {
  id: number;
  at: number | string;
  userId?: string | null;
  actorId?: string | null;
  action: string;
  /** Free-form JSON the server attached to the entry (never meeting content). */
  detail?: unknown;
}

export const listUsers = (): Promise<AdminUser[]> => serverApi<AdminUser[]>('GET', '/api/admin/users');
export const patchUser = (id: string, patch: Partial<Pick<AdminUser, 'role' | 'disabled' | 'name'>>): Promise<void> =>
  serverApi<void>('PATCH', `/api/admin/users/${encodeURIComponent(id)}`, patch);
export const deleteUser = (id: string): Promise<void> =>
  serverApi<void>('DELETE', `/api/admin/users/${encodeURIComponent(id)}`);
export const createInvite = (email: string, role: 'admin' | 'member'): Promise<{ url: string; expiresAt: number | string }> =>
  serverApi('POST', '/api/admin/invites', { email, role });
export const listInvites = (): Promise<InviteRow[]> => serverApi<InviteRow[]>('GET', '/api/admin/invites');
export const deleteInvite = (id: string): Promise<void> =>
  serverApi<void>('DELETE', `/api/admin/invites/${encodeURIComponent(id)}`);
export const fetchAdminSettings = (): Promise<AdminSettings> => serverApi<AdminSettings>('GET', '/api/admin/settings');
export const saveAdminSettings = (body: unknown): Promise<void> => serverApi<void>('PUT', '/api/admin/settings', body);
export const testOidc = (): Promise<{ ok: boolean; issuer?: string; error?: string }> =>
  serverApi('POST', '/api/admin/oidc/test');
export const fetchAudit = (limit = 200): Promise<AuditRow[]> => serverApi<AuditRow[]>('GET', `/api/admin/audit?limit=${limit}`);

/** Timestamps arrive as unix seconds, milliseconds or ISO strings. */
export function formatWhen(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const ms = typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(value);
  if (!Number.isFinite(ms)) return String(value);
  return new Date(ms).toLocaleString();
}

/** Absolute URL for an invite link the server returned (it may be a path). */
export function absoluteUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : new URL(url, window.location.origin).toString();
}
