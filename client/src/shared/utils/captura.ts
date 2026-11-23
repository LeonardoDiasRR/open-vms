// Captura de frame do video da celula (spec 2026-11-23, printscreen). Sem rede: o frame ja esta na
// tela (WebRTC via srcObject, que NAO taint o canvas). Duas funcoes puras de DOM, testaveis em jsdom.

// O canvas e do tamanho NATIVO do stream (videoWidth), nao do box de CSS: o JPEG sai com a resolucao
// real do que a camera entrega no perfil exibido. null = sem frame (ainda): o chamador mostra a faixa
// de erro em vez de baixar um canvas preto.
export function capturarFrame(video: HTMLVideoElement | null): string | null {
  if (!video || video.readyState < 2 || video.videoWidth === 0 || video.videoHeight === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null; // jsdom sem canvas e browsers raros: mesmo contrato do "sem frame"
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.92);
}

// Nome do arquivo: camera sanitizada + timestamp local. A sanitizacao e uma regra de caminho, nao de
// gosto: tudo que nao e [A-Za-z0-9_-] vira '_', sequencias colapsam, sem '_' nas pontas. Um '/' que
// sobrevivesse criaria pasta no download do operador; acento vira '_' porque o destino e desconhecido.
// Nome que sanitiza para vazio (ex.: '???') recebe 'camera'.
export function nomeCaptura(nomeCamera: string, d: Date): string {
  const nome = nomeCamera.replace(/[^A-Za-z0-9_-]+/g, '_').replace(/^_+|_+$/g, '') || 'camera';
  const p = (n: number) => String(n).padStart(2, '0');
  const ts = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  return `${nome}_${ts}.jpg`;
}
