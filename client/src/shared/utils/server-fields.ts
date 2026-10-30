// spec 2026-10-30 (servidor-porta-login-modal, 3.1/3.2): memoria compartilhada de conexao e
// montagem da base, usadas pelo LOGIN e pela modal "Connect server" (DRY). O scheme e sempre o
// da pagina; Server e so host/IP. Nada de heuristica: sem scheme, o valor inteiro e o host.
export const SERVER_HOST_KEY = 'openvms.server';  // era a URL inteira no login; hoje so o host
export const SERVER_PORT_KEY = 'openvms.port';

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

export function readLastConnection(): { host: string; port: string } {
  const saved = splitServerValue(localStorage.getItem(SERVER_HOST_KEY) ?? '');
  return {
    host: saved.host || window.location.hostname,
    port: localStorage.getItem(SERVER_PORT_KEY) || saved.port || window.location.port,
  };
}

export function saveLastConnection(host: string, port: string): void {
  try {
    localStorage.setItem(SERVER_HOST_KEY, host);
    localStorage.setItem(SERVER_PORT_KEY, port);
  } catch { /* storage cheio/bloqueado: so esta sessao (mesma regra de useServers.writeBases) */ }
}
