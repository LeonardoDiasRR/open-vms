import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClient } from '@/shared/utils/api';
import { useT } from '@/shared/i18n';

// Registry de servidores (spec 2026-10-30, 5.1). A sessão do login fica intocada: o primário É o
// `session.api`; os extras são logins próprios do operador (D4), com token por servidor no
// sessionStorage (sobrevive ao F5 como o primário e morre com a aba — D3) e o alias no localStorage
// (preferência do navegador, nunca do backend).
export const SERVERS_KEY = 'openvms.servers';           // sessionStorage: string[] com as bases dos extras
export const SERVER_NAMES_KEY = 'openvms.serverNames';  // localStorage: { [base]: alias }
export const serverTokenKey = (base: string) => `openvms.server.${base}.token`;

export type ServerEntry = {
  id: string;      // base URL sem barra final (a mesma do ApiClient)
  label: string;   // alias quando existe; senão o hostname da base
  primary: boolean;
  online: boolean; // o hook não conhece o poll: o App mescla o `ok` aqui (spec 5.5)
  api: ApiClient;
};

const readBases = (): string[] => {
  try {
    const v = JSON.parse(sessionStorage.getItem(SERVERS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
  } catch { return []; }
};
const writeBases = (bases: string[]) => {
  try { sessionStorage.setItem(SERVERS_KEY, JSON.stringify(bases)); } catch { /* storage cheio/bloqueado: só esta sessão */ }
};
const readNames = (): Record<string, string> => {
  try {
    const v = JSON.parse(localStorage.getItem(SERVER_NAMES_KEY) ?? '{}');
    return v && typeof v === 'object' ? v as Record<string, string> : {};
  } catch { return {}; }
};
const hostname = (base: string) => { try { return new URL(base).hostname; } catch { return base; } };

// `sessionApi` é o api da sessão do login (null antes do login/depois do logout). O boot restore só
// roda com sessão: sem primário não se monta extra nenhum (spec 5.1).
export function useServers(sessionApi: ApiClient | null) {
  const { t } = useT();
  const [extras, setExtras] = useState<Record<string, ApiClient>>({}); // base -> cliente autenticado
  const [names, setNames] = useState<Record<string, string>>(readNames);
  const primaryBase = sessionApi?.base ?? null;

  // Restauração no boot: para cada base salva com token, um ApiClient + me(). A falha derruba SÓ
  // aquele servidor (token morto entre F5s), nunca a sessão do login.
  useEffect(() => {
    if (!sessionApi) { setExtras({}); return; }
    let alive = true;
    for (const base of readBases()) {
      const token = sessionStorage.getItem(serverTokenKey(base));
      if (!token) { writeBases(readBases().filter((b) => b !== base)); continue; }
      const api = new ApiClient(base);
      api.token = token;
      api.me().then(
        () => { if (alive) setExtras((cur) => ({ ...cur, [base]: api })); },
        () => {
          if (!alive) return;
          sessionStorage.removeItem(serverTokenKey(base));
          writeBases(readBases().filter((b) => b !== base));
        },
      );
    }
    return () => { alive = false; };
  }, [sessionApi]);

  // Login imediato ao adicionar (D3). Retorna a mensagem de erro (o modal mostra inline) ou null.
  const addServer = useCallback(async (base: string, user: string, password: string): Promise<string | null> => {
    const clean = base.replace(/\/$/, '');
    if (!/^https?:\/\//.test(clean)) return t('servers.connect_failed');
    if (clean === primaryBase || readBases().includes(clean)) return t('servers.already_connected');
    const api = new ApiClient(clean);
    try { await api.login(user, password); }
    catch (e) { return e instanceof Error && e.message ? e.message : t('servers.connect_failed'); }
    sessionStorage.setItem(serverTokenKey(clean), api.token ?? '');
    writeBases([...readBases(), clean]);
    setExtras((cur) => ({ ...cur, [clean]: api }));
    return null;
  }, [primaryBase, t]);

  // Remove a entrada e apaga token + alias (spec 5.4). A desconexão do PRIMÁRIO é decisão do App
  // (logout — D5); aqui só os extras somem.
  const disconnectServer = useCallback((base: string) => {
    sessionStorage.removeItem(serverTokenKey(base));
    writeBases(readBases().filter((b) => b !== base));
    setNames((cur) => {
      if (!(base in cur)) return cur;
      const next = { ...cur }; delete next[base];
      localStorage.setItem(SERVER_NAMES_KEY, JSON.stringify(next));
      return next;
    });
    setExtras((cur) => { const next = { ...cur }; delete next[base]; return next; });
  }, []);

  const renameServer = useCallback((base: string, alias: string) => {
    setNames((cur) => {
      const next = { ...cur, [base]: alias };
      localStorage.setItem(SERVER_NAMES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Logout do App: os extras e seus tokens somem; os aliases ficam (preferência do navegador, a
  // mesma regra de openvms.panels — emenda do plano).
  const reset = useCallback(() => {
    for (const base of readBases()) sessionStorage.removeItem(serverTokenKey(base));
    writeBases([]);
    setExtras({});
  }, []);

  const servers: ServerEntry[] = useMemo(() => (primaryBase && sessionApi ? [
    { id: primaryBase, label: names[primaryBase] ?? hostname(primaryBase), primary: true, online: true, api: sessionApi },
    ...Object.keys(extras).map((base) => ({
      id: base, label: names[base] ?? hostname(base), primary: false, online: true, api: extras[base],
    })),
  ] : []), [primaryBase, sessionApi, extras, names]);

  // Fallback no primário: id desconhecido/ausente nunca deixa um consumidor sem api (spec 5.6).
  const apiFor = useCallback((serverId?: string | null): ApiClient =>
    (serverId ? (serverId === primaryBase ? sessionApi : extras[serverId]) : null) ?? sessionApi!,
  [primaryBase, sessionApi, extras]);

  return { servers, addServer, disconnectServer, renameServer, reset, apiFor };
}
