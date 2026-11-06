// Camada de copia para a area de transferencia, com a MESMA escada do CameraSettingsModal:
// navigator.clipboard so existe em contexto seguro; o deploy interno e HTTP puro, entao o fallback
// execCommand e obrigatorio, nao defensivo. O transporte entra por parametro porque em jsdom
// navigator.clipboard nao existe e document.execCommand e undefined — sem injecao nao haveria como
// testar nenhum dos dois caminhos.
export type TransporteCopiar = (texto: string) => Promise<void>;

const transportePadrao: TransporteCopiar = async (texto) => {
  try {
    await navigator.clipboard.writeText(texto);
    return;
  } catch { /* contexto inseguro (HTTP) ou negado: cai no execCommand */ }
  const area = document.createElement('textarea');
  area.value = texto;
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand('copy');
  area.remove();
  if (!ok) throw new Error('copy_refused');
};

export async function copiarTexto(texto: string, transporte: TransporteCopiar = transportePadrao): Promise<boolean> {
  try {
    await transporte(texto);
    return true;
  } catch {
    return false; // quem chama decide a mensagem; a senha continua legivel no campo
  }
}
