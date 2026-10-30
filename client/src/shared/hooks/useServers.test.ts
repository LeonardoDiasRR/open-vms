import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';

const fakes = vi.hoisted(() => ({ meOk: true, loginFails: false }));

vi.mock('@/shared/utils/api', () => ({
  ApiClient: class {
    base: string;
    token: string | null = null;
    constructor(base: string) { this.base = base; }
    async login(_u: string, _p: string) {
      if (fakes.loginFails) throw Object.assign(new Error('Invalid credentials'), { status: 401 });
      this.token = 'tk-extra';
      return { token: 'tk-extra' };
    }
    async me() {
      if (!fakes.meOk) throw new Error('http 401');
      return { username: 'x', profile_id: 'p', capabilities: [] };
    }
  },
}));

import { ApiClient } from '@/shared/utils/api';
import { useServers, SERVERS_KEY, SERVER_NAMES_KEY, serverTokenKey } from './useServers';

const wrapper = ({ children }: { children: ReactNode }) => createElement(LanguageProvider, null, children);
const primary = new ApiClient('http://primary');

const EXTRA = 'http://extra:7102';

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fakes.meOk = true;
  fakes.loginFails = false;
});
afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

describe('useServers (plan 2026-10-30)', () => {
  it('the primary entry is the login api itself', () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    expect(result.current.servers).toHaveLength(1);
    expect(result.current.servers[0]).toMatchObject({ id: 'http://primary', label: 'primary', primary: true });
    expect(result.current.servers[0].api).toBe(primary);
    expect(result.current.apiFor('http://extra')).toBe(primary); // fallback: nunca api vazia
  });

  it('add with a good login stores the token, enters the list and persists the base', async () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    let msg: string | null | undefined;
    await act(async () => { msg = await result.current.addServer(EXTRA, 'u', 'p'); });
    expect(msg).toBeNull();
    expect(result.current.servers.map((s) => s.id)).toEqual(['http://primary', EXTRA]);
    expect(sessionStorage.getItem(serverTokenKey(EXTRA))).toBe('tk-extra');
    expect(JSON.parse(sessionStorage.getItem(SERVERS_KEY) ?? '[]')).toEqual([EXTRA]);
  });

  it('add with a 401 does not enter the list and returns the login error message', async () => {
    fakes.loginFails = true;
    const { result } = renderHook(() => useServers(primary), { wrapper });
    let msg: string | null | undefined;
    await act(async () => { msg = await result.current.addServer(EXTRA, 'u', 'errada'); });
    expect(msg).toContain('Invalid credentials');
    expect(result.current.servers).toHaveLength(1);
    expect(sessionStorage.getItem(SERVERS_KEY)).toBeNull();
  });

  it('duplicate base returns the already-connected message without changing state', async () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    await act(async () => { await result.current.addServer(EXTRA, 'u', 'p'); });
    let msg: string | null | undefined;
    await act(async () => { msg = await result.current.addServer(EXTRA, 'u', 'p'); });
    expect(msg).toBeTruthy(); // a tradução 'already connected' é pinada em dictionaries.test.ts
    expect(result.current.servers.filter((s) => s.id === EXTRA)).toHaveLength(1);
  });

  it('boot restore: a saved base with a valid token enters on mount', async () => {
    sessionStorage.setItem(SERVERS_KEY, JSON.stringify([EXTRA]));
    sessionStorage.setItem(serverTokenKey(EXTRA), 'tk-old');
    const { result } = renderHook(() => useServers(primary), { wrapper });
    await waitFor(() => expect(result.current.servers).toHaveLength(2));
    expect(result.current.servers[1].id).toBe(EXTRA);
  });

  it('boot restore: a dead token drops only that server and purges the token', async () => {
    fakes.meOk = false;
    sessionStorage.setItem(SERVERS_KEY, JSON.stringify([EXTRA]));
    sessionStorage.setItem(serverTokenKey(EXTRA), 'tk-dead');
    const { result } = renderHook(() => useServers(primary), { wrapper });
    await waitFor(() => expect(sessionStorage.getItem(serverTokenKey(EXTRA))).toBeNull());
    expect(result.current.servers).toHaveLength(1);
    expect(JSON.parse(sessionStorage.getItem(SERVERS_KEY) ?? '[]')).toEqual([]);
  });

  it('rename writes the alias and the label follows; the alias wins over the hostname', async () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    await act(async () => { await result.current.addServer(EXTRA, 'u', 'p'); });
    act(() => { result.current.renameServer(EXTRA, 'Portalegre'); });
    expect(result.current.servers[1].label).toBe('Portalegre'.slice(0, 10));
    expect(JSON.parse(localStorage.getItem(SERVER_NAMES_KEY) ?? '{}')).toEqual({ [EXTRA]: 'Portalegre'.slice(0, 10) });
  });

  it('disconnect removes the entry and purges token, base and alias', async () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    await act(async () => { await result.current.addServer(EXTRA, 'u', 'p'); });
    act(() => { result.current.renameServer(EXTRA, 'Galpao'); });
    act(() => { result.current.disconnectServer(EXTRA); });
    expect(result.current.servers).toHaveLength(1);
    expect(sessionStorage.getItem(serverTokenKey(EXTRA))).toBeNull();
    expect(JSON.parse(sessionStorage.getItem(SERVERS_KEY) ?? '[]')).toEqual([]);
    expect(localStorage.getItem(SERVER_NAMES_KEY)).toBe('{}');
  });

  it('reset (logout) purges the extras and their tokens but keeps the aliases', async () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    await act(async () => { await result.current.addServer(EXTRA, 'u', 'p'); });
    act(() => { result.current.renameServer(EXTRA, 'Galpao'); });
    act(() => { result.current.reset(); });
    expect(result.current.servers).toHaveLength(1);
    expect(sessionStorage.getItem(serverTokenKey(EXTRA))).toBeNull();
    expect(sessionStorage.getItem(SERVERS_KEY)).toBe('[]');
    expect(localStorage.getItem(SERVER_NAMES_KEY)).toContain('Galpao'); // preferência sobrevive
  });

  it('apiFor answers the entry of the server and falls back to the primary', async () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    await act(async () => { await result.current.addServer(EXTRA, 'u', 'p'); });
    expect(result.current.apiFor(EXTRA).base).toBe(EXTRA);
    expect(result.current.apiFor('http://ninguem')).toBe(primary);
    expect(result.current.apiFor(undefined)).toBe(primary);
  });

  it('without a session the list is empty (no extras mounted)', () => {
    sessionStorage.setItem(SERVERS_KEY, JSON.stringify([EXTRA]));
    sessionStorage.setItem(serverTokenKey(EXTRA), 'tk');
    const { result } = renderHook(() => useServers(null), { wrapper });
    expect(result.current.servers).toEqual([]);
  });
});
