import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';

// Registry mock: login/signOut registrados no `fakes` hoisted. O me() sumiu do fake porque o
// restore nao pergunta mais a ninguem (spec 2026-11-12: existir nao passa pelo servidor).
const fakes = vi.hoisted(() => ({ loginFails: false, signOuts: [] as string[] }));

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
    async signOut() { fakes.signOuts.push(this.base); this.token = null; }
  },
}));

import { ApiClient } from '@/shared/utils/api';
import { useServers, SERVERS_KEY, SERVER_NAMES_KEY, serverTokenKey } from './useServers';

const wrapper = ({ children }: { children: ReactNode }) => createElement(LanguageProvider, null, children);
const primary = new ApiClient('http://primary');

const EXTRA = 'http://extra:7102';
const bases = () => JSON.parse(localStorage.getItem(SERVERS_KEY) ?? 'null');

beforeEach(() => {
  sessionStorage.clear();
  localStorage.clear();
  fakes.loginFails = false;
  fakes.signOuts.length = 0;
});
afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

describe('useServers (spec 2026-11-12, extras persistentes)', () => {
  it('the primary entry is the login api itself', () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    expect(result.current.servers).toHaveLength(1);
    expect(result.current.servers[0]).toMatchObject({ id: 'http://primary', label: 'primary', primary: true });
    expect(result.current.servers[0].api).toBe(primary);
    expect(result.current.apiFor('http://extra')).toBe(primary); // fallback: nunca api vazia
  });

  it('add with a good login persists base and token in LOCAL storage (2026-11-12)', async () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    let msg: string | null | undefined;
    await act(async () => { msg = await result.current.addServer(EXTRA, 'u', 'p'); });
    expect(msg).toBeNull();
    expect(result.current.servers.map((s) => s.id)).toEqual(['http://primary', EXTRA]);
    expect(localStorage.getItem(serverTokenKey(EXTRA))).toBe('tk-extra');
    expect(bases()).toEqual([EXTRA]);
    expect(sessionStorage.getItem(SERVERS_KEY)).toBeNull(); // nao escreve mais no sessionStorage
  });

  it('add with a 401 does not enter the list and returns the login error message', async () => {
    fakes.loginFails = true;
    const { result } = renderHook(() => useServers(primary), { wrapper });
    let msg: string | null | undefined;
    await act(async () => { msg = await result.current.addServer(EXTRA, 'u', 'errada'); });
    expect(msg).toContain('Invalid credentials');
    expect(result.current.servers).toHaveLength(1);
    expect(bases()).toBeNull();
  });

  it('duplicate base returns the already-connected message without changing state', async () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    await act(async () => { await result.current.addServer(EXTRA, 'u', 'p'); });
    let msg: string | null | undefined;
    await act(async () => { msg = await result.current.addServer(EXTRA, 'u', 'p'); });
    expect(msg).toBeTruthy(); // a traducao 'already connected' e pinada em dictionaries.test.ts
    expect(result.current.servers.filter((s) => s.id === EXTRA)).toHaveLength(1);
  });

  it('boot restore: base salva com token monta na primeira leitura do localStorage', () => {
    localStorage.setItem(SERVERS_KEY, JSON.stringify([EXTRA]));
    localStorage.setItem(serverTokenKey(EXTRA), 'tk-old');
    const { result } = renderHook(() => useServers(primary), { wrapper });
    expect(result.current.servers.map((s) => s.id)).toEqual(['http://primary', EXTRA]);
    expect(result.current.servers[1].api.token).toBe('tk-old');
  });

  it('boot restore: dead token mantem a entrada e o token (especie 3.2; o antigo drop esta invertido)', () => {
    localStorage.setItem(SERVERS_KEY, JSON.stringify([EXTRA]));
    localStorage.setItem(serverTokenKey(EXTRA), 'tk-dead');
    const { result } = renderHook(() => useServers(primary), { wrapper });
    expect(result.current.servers).toHaveLength(2);                    // montada; online quem diz e o poll
    expect(localStorage.getItem(serverTokenKey(EXTRA))).toBe('tk-dead'); // token nao e purgado
    expect(bases()).toEqual([EXTRA]);                                   // base nao e expulsa
  });

  it('boot restore: base sem token tambem monta (a saida e reconectar)', () => {
    localStorage.setItem(SERVERS_KEY, JSON.stringify([EXTRA]));
    const { result } = renderHook(() => useServers(primary), { wrapper });
    expect(result.current.servers).toHaveLength(2);
    expect(result.current.servers[1].api.token).toBeNull();
  });

  it('migracao de mao unica: o que estava no sessionStorage muda para o localStorage e sumiu', () => {
    sessionStorage.setItem(SERVERS_KEY, JSON.stringify([EXTRA]));
    sessionStorage.setItem(serverTokenKey(EXTRA), 'tk-legado');
    const { result } = renderHook(() => useServers(primary), { wrapper });
    expect(result.current.servers).toHaveLength(2);
    expect(bases()).toEqual([EXTRA]);
    expect(localStorage.getItem(serverTokenKey(EXTRA))).toBe('tk-legado');
    expect(sessionStorage.getItem(SERVERS_KEY)).toBeNull();
    expect(sessionStorage.getItem(serverTokenKey(EXTRA))).toBeNull();
  });

  it('reconnect com login bom sobrescreve o token sem duplicar a base (spec 3.4)', async () => {
    localStorage.setItem(SERVERS_KEY, JSON.stringify([EXTRA]));
    localStorage.setItem(serverTokenKey(EXTRA), 'tk-dead');
    const { result } = renderHook(() => useServers(primary), { wrapper });
    let msg: string | null | undefined;
    await act(async () => { msg = await result.current.reconnectServer(EXTRA, 'u', 'nova'); });
    expect(msg).toBeNull();
    expect(localStorage.getItem(serverTokenKey(EXTRA))).toBe('tk-extra');
    expect(bases()).toEqual([EXTRA]); // nao duplica
  });

  it('reconnect com login ruim devolve a mensagem e nao toca em nada', async () => {
    localStorage.setItem(SERVERS_KEY, JSON.stringify([EXTRA]));
    localStorage.setItem(serverTokenKey(EXTRA), 'tk-dead');
    fakes.loginFails = true;
    const { result } = renderHook(() => useServers(primary), { wrapper });
    let msg: string | null | undefined;
    await act(async () => { msg = await result.current.reconnectServer(EXTRA, 'u', 'errada'); });
    expect(msg).toContain('Invalid credentials');
    expect(localStorage.getItem(serverTokenKey(EXTRA))).toBe('tk-dead');
    expect(result.current.servers).toHaveLength(2); // a entrada offline continua na arvore
  });

  it('rename writes the alias and the label follows', async () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    await act(async () => { await result.current.addServer(EXTRA, 'u', 'p'); });
    act(() => { result.current.renameServer(EXTRA, 'Portal'); });
    expect(result.current.servers[1].label).toBe('Portal');
    expect(JSON.parse(localStorage.getItem(SERVER_NAMES_KEY) ?? '{}')).toEqual({ [EXTRA]: 'Portal' });
  });

  it('disconnect e a unica saida: dispara signOut remoto e purga token, base e alias', async () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    await act(async () => { await result.current.addServer(EXTRA, 'u', 'p'); });
    act(() => { result.current.renameServer(EXTRA, 'Galpao'); });
    act(() => { result.current.disconnectServer(EXTRA); });
    expect(fakes.signOuts).toContain(EXTRA); // spec 3.5
    expect(result.current.servers).toHaveLength(1);
    expect(localStorage.getItem(serverTokenKey(EXTRA))).toBeNull();
    expect(bases()).toEqual([]);
    expect(localStorage.getItem(SERVER_NAMES_KEY)).toBe('{}');
  });

  it('reset (logout) limpa a memoria e MANTEM base, token e alias (especie 3.3; o antigo purges esta invertido)', async () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    await act(async () => { await result.current.addServer(EXTRA, 'u', 'p'); });
    act(() => { result.current.renameServer(EXTRA, 'Galpao'); });
    act(() => { result.current.reset(); });
    expect(result.current.servers).toHaveLength(1);                     // sem extras em memoria
    expect(localStorage.getItem(serverTokenKey(EXTRA))).toBe('tk-extra'); // token intocado
    expect(bases()).toEqual([EXTRA]);                                   // base sobrevive ao logoff
    expect(localStorage.getItem(SERVER_NAMES_KEY)).toContain('Galpao');  // preferencia sobrevive
  });

  it('reset seguido de novo login remonta o registro (sobrevive ao logoff)', async () => {
    const { result, rerender } = renderHook(({ api }: { api: ApiClient | null }) => useServers(api),
      { wrapper, initialProps: { api: primary } });
    await act(async () => { await result.current.addServer(EXTRA, 'u', 'p'); });
    act(() => { result.current.reset(); });                              // logoff
    rerender({ api: new ApiClient('http://primary') });                  // login novo, mesma base
    expect(result.current.servers.map((s) => s.id)).toEqual(['http://primary', EXTRA]);
  });

  it('apiFor answers the entry of the server and falls back to the primary', async () => {
    const { result } = renderHook(() => useServers(primary), { wrapper });
    await act(async () => { await result.current.addServer(EXTRA, 'u', 'p'); });
    expect(result.current.apiFor(EXTRA).base).toBe(EXTRA);
    expect(result.current.apiFor('http://ninguem')).toBe(primary);
    expect(result.current.apiFor(undefined)).toBe(primary);
  });

  it('without a session the list is empty and the storage stays intact (reforca 3.3)', () => {
    localStorage.setItem(SERVERS_KEY, JSON.stringify([EXTRA]));
    localStorage.setItem(serverTokenKey(EXTRA), 'tk');
    const { result } = renderHook(() => useServers(null), { wrapper });
    expect(result.current.servers).toEqual([]);
    expect(bases()).toEqual([EXTRA]);
    expect(localStorage.getItem(serverTokenKey(EXTRA))).toBe('tk');
  });
});
