// spec 2026-10-30 (servidor-porta-login-modal 3.1/3.2 + memoria-conexao-independente 3.1):
// memoria de conexao com ESCOPO por formulario e montagem da base. O scheme e sempre o da
// pagina; Server e so host/IP. Nada de heuristica: sem scheme, o valor inteiro e o host.
export const SERVER_HOST_KEY = 'openvms.server';  // era a URL inteira no login; hoje so o host
export const SERVER_PORT_KEY = 'openvms.port';

export type ConnectionMemory = { hostKey: string; portKey: string };
export const LOGIN_MEMORY: ConnectionMemory = { hostKey: SERVER_HOST_KEY, portKey: SERVER_PORT_KEY };
// spec 2026-10-30 (memoria-conexao-independente): par proprio da modal — ela nunca le nem escreve
// as chaves do login, e vice-versa.
export const MODAL_MEMORY: ConnectionMemory = { hostKey: 'openvms.serverModal', portKey: 'openvms.portModal' };

export function splitServerValue(valor: string): { host: string; port: string } {
  if (/^https?:\/\//i.test(valor)) {
    try {
      const u = new URL(valor);
      return { host: u.hostname, port: u.port };
    } catch { return { host: valor, port: '' }; }
  }
  return { host: valor, port: '' };
}

export function buildBase(scheme: string, host: string, port: string): string {
  return `${scheme}//${host}${port ? ':' + port : ''}`;
}

export function readLastConnection(mem: ConnectionMemory = LOGIN_MEMORY): { host: string; port: string } {
  const saved = splitServerValue(localStorage.getItem(mem.hostKey) ?? '');
  return {
    host: saved.host || window.location.hostname,
    port: localStorage.getItem(mem.portKey) || saved.port || window.location.port,
  };
}

export function readLastBase(): string {
  // consumidor (App.tsx restore/footer): a base do LOGIN; '' sem memoria de login.
  if (!localStorage.getItem(LOGIN_MEMORY.hostKey)) return '';
  const l = readLastConnection(LOGIN_MEMORY);
  return buildBase(window.location.protocol, l.host, l.port);
}

// SEM default de escopo: a memoria compartilhada nasceu de escopo implicito (spec
// 2026-10-30 memoria-conexao-independente, 3.1) — a assinatura nao permite repeti-lo.
export function saveLastConnection(mem: ConnectionMemory, host: string, port: string): void {
  try {
    localStorage.setItem(mem.hostKey, host);
    localStorage.setItem(mem.portKey, port);
  } catch { /* storage cheio/bloqueado: so esta sessao (mesma regra de useServers.writeBases) */ }
}
