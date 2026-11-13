import { useCallback, useEffect, useMemo, useState } from 'react';
import { ApiClient } from '@/shared/utils/api';
import { useT } from '@/shared/i18n';

// Registry de servidores (spec 2026-10-30, 5.1 + spec 2026-11-12 "extras persistentes"). A sessao do
// login fica intocada: o primario É o `session.api`; os extras sao logins proprios do operador (D4).
// Persistencia TOTAL (2026-11-12: a decisao D3 de 2026-10-30 foi REVERTIDA) — base, token e alias
// vivem no localStorage do navegador: a entrada so sai pelo disconnectServer, nunca por logoff,
// aba morta ou token expirado.
export const SERVERS_KEY = 'openvms.servers';           // localStorage: string[] com as bases dos extras
export const SERVER_NAMES_KEY = 'openvms.serverNames';  // localStorage: { [base]: alias }
export const serverTokenKey = (base: string) => `openvms.server.${base}.token`;

export type ServerEntry = {
  id: string;      // base URL sem barra final (a mesma do ApiClient)
  label: string;   // alias quando existe; senao o hostname da base
  primary: boolean;
  online: boolean; // o hook nao conhece o poll: o App mescla o `ok` aqui (spec 5.5)
  api: ApiClient;
};

// Migracao de mao unica (spec 3.1): ate 2026-11-12 os valores moravam no sessionStorage, que morre
// com a aba. A primeira leitura move para o localStorage e apaga a origem; depois disso o
// sessionStorage nao e mais lido para estas chaves.
const migrateLegacy = (key: string): string | null => {
  const here = localStorage.getItem(key);
  if (here !== null) return here;
  const legacy = sessionStorage.getItem(key);
  if (legacy === null) return null;
  localStorage.setItem(key, legacy); sessionStorage.removeItem(key);
  return legacy;
};

const readBases = (): string[] => {
  try {
    const v = JSON.parse(migrateLegacy(SERVERS_KEY) ?? '[]');
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : [];
  } catch { return []; }
};
const writeBases = (bases: string[]) => {
  try { localStorage.setItem(SERVERS_KEY, JSON.stringify(bases)); } catch { /* storage cheio/bloqueado: so esta sessao */ }
};
const readToken = (base: string): string | null => migrateLegacy(serverTokenKey(base));
const writeToken = (base: string, token: string) => {
  try { localStorage.setItem(serverTokenKey(base), token); } catch { /* mesma regra de writeBases */ }
};
const dropToken = (base: string) => {
  localStorage.removeItem(serverTokenKey(base)); sessionStorage.removeItem(serverTokenKey(base));
};
const readNames = (): Record<string, string> => {
  try {
    const v = JSON.parse(localStorage.getItem(SERVER_NAMES_KEY) ?? '{}');
    return v && typeof v === 'object' ? v as Record<string, string> : {};
  } catch { return {}; }
};
const hostname = (base: string) => { try { return new URL(base).hostname; } catch { return base; } };

// `sessionApi` e o api da sessao do login (null antes do login/depois do logout). Sem primario nao
// se monta nada (5.1) — o storage fica INTACTO: os extras voltam no proximo login.
export function useServers(sessionApi: ApiClient | null) {
  const { t } = useT();
  const [extras, setExtras] = useState<Record<string, ApiClient>>({}); // base -> cliente (token pode estar morto: o poll decide o online)
  const [names, setNames] = useState<Record<string, string>>(readNames);
  const primaryBase = sessionApi?.base ?? null;

  // Boot-restore (spec 3.2, D3 revertida): TODA base salva monta, com token ou sem. A existencia nao
  // passa mais pelo me(): token morto fica na arvore como offline (o poll do App diz o ok) e volta
  // com "Reconectar". A base só sai daqui pelo disconnectServer.
  useEffect(() => {
    if (!sessionApi) { setExtras({}); return; }
    const mounted: Record<string, ApiClient> = {};
    for (const base of readBases()) {
      if (base === sessionApi.base) continue; // o primario e a propria sessao, nao e extra
      const api = new ApiClient(base);
      const token = readToken(base);
      if (token) api.token = token;
      mounted[base] = api;
    }
    setExtras(mounted);
  }, [sessionApi]);

  // Login imediato ao adicionar (D3 de 2026-10-30). Retorna a mensagem de erro (o modal mostra
  // inline) ou null.
  const addServer = useCallback(async (base: string, user: string, password: string): Promise<string | null> => {
    const clean = base.replace(/\/$/, '');
    if (!/^https?:\/\//.test(clean)) return t('servers.connect_failed');
    if (clean === primaryBase || readBases().includes(clean)) return t('servers.already_connected');
    const api = new ApiClient(clean);
    try { await api.login(user, password); }
    catch (e) { return e instanceof Error && e.message ? e.message : t('servers.connect_failed'); }
    writeToken(clean, api.token ?? '');
    writeBases([...readBases(), clean]);
    setExtras((cur) => ({ ...cur, [clean]: api }));
    return null;
  }, [primaryBase, t]);

  // Reconexao (spec 3.4): login numa base JA registrada; sucesso sobrescreve o token morto.
  // Falha devolve a mensagem sem tocar no token salvo — a entrada offline continua na arvore.
  const reconnectServer = useCallback(async (base: string, user: string, password: string): Promise<string | null> => {
    const api = new ApiClient(base);
    try { await api.login(user, password); }
    catch (e) { return e instanceof Error && e.message ? e.message : t('servers.connect_failed'); }
    writeToken(base, api.token ?? '');
    setExtras((cur) => ({ ...cur, [base]: api }));
    return null;
  }, [t]);

  // Remover = a UNICA saida (spec 3.5). Primeiro dispara o logout REMOTO (signOut mata a sessao no
  // servidor; o logout local deixaria o orfao vivo ate o TTL absoluto); depois purga o local.
  const disconnectServer = useCallback((base: string) => {
    extras[base]?.signOut?.().catch(() => {}); // servidor inalcancavel: a purga local acontece mesmo assim
    dropToken(base);
    writeBases(readBases().filter((b) => b !== base));
    setNames((cur) => {
      if (!(base in cur)) return cur;
      const next = { ...cur }; delete next[base];
      localStorage.setItem(SERVER_NAMES_KEY, JSON.stringify(next));
      return next;
    });
    setExtras((cur) => { const next = { ...cur }; delete next[base]; return next; });
  }, [extras]);

  const renameServer = useCallback((base: string, alias: string) => {
    setNames((cur) => {
      const next = { ...cur, [base]: alias };
      localStorage.setItem(SERVER_NAMES_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  // Logout do App (spec 3.3): limpa so a memoria. Base, token e alias sao preferencia do navegador:
  // voltam inteiros no proximo login do primario (efeito de restore acima).
  const reset = useCallback(() => { setExtras({}); }, []);

  const servers: ServerEntry[] = useMemo(() => (primaryBase && sessionApi ? [
    { id: primaryBase, label: names[primaryBase] ?? hostname(primaryBase), primary: true, online: true, api: sessionApi },
    ...Object.keys(extras).map((base) => ({
      id: base, label: names[base] ?? hostname(base), primary: false, online: true, api: extras[base],
    })),
  ] : []), [primaryBase, sessionApi, extras, names]);

  // Fallback no primario: id desconhecido/ausente nunca deixa um consumidor sem api (spec 5.6).
  const apiFor = useCallback((serverId?: string | null): ApiClient =>
    (serverId ? (serverId === primaryBase ? sessionApi : extras[serverId]) : null) ?? sessionApi!,
  [primaryBase, sessionApi, extras]);

  return { servers, addServer, reconnectServer, disconnectServer, renameServer, reset, apiFor };
}
