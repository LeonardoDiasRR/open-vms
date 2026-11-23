import { afterEach, describe, expect, it, vi } from 'vitest';
import { capturarFrame, nomeCaptura } from './captura';

// jsdom nao implementa canvas: getContext devolve null. O mock e ENVIRONMENT (o mesmo padrao do
// FakePc de StreamCell.test.tsx): a sonda prova o CONTRATO (dimensoes, ordem de chamada, data URL),
// nao a rasterizacao — que e do browser.
const videoPronto = (): HTMLVideoElement =>
  ({ readyState: 2, videoWidth: 640, videoHeight: 360 }) as unknown as HTMLVideoElement;

describe('capturarFrame', () => {
  afterEach(() => vi.restoreAllMocks());

  it('null sem elemento, sem frame decodificado ou sem contexto 2d', () => {
    expect(capturarFrame(null)).toBeNull();
    expect(capturarFrame({ readyState: 0, videoWidth: 640, videoHeight: 360 } as unknown as HTMLVideoElement)).toBeNull();
    expect(capturarFrame({ readyState: 2, videoWidth: 0, videoHeight: 360 } as unknown as HTMLVideoElement)).toBeNull();
    expect(capturarFrame({ readyState: 2, videoWidth: 640, videoHeight: 0 } as unknown as HTMLVideoElement)).toBeNull();
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(null);
    expect(capturarFrame(videoPronto())).toBeNull();
  });

  it('canvas na resolucao nativa, drawImage no origem, devolve o data URL JPEG', () => {
    const chamadas: Array<{ w: number; h: number; x: number; y: number }> = [];
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
      return {
        drawImage: (_v: unknown, x: number, y: number, w: number, h: number) => {
          chamadas.push({ w: this.width, h: this.height, x, y, ...( { dw: w, dh: h } ) });
        },
      } as unknown as CanvasRenderingContext2D;
    });
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockImplementation(
      (type?: string) => `data:${type ?? 'image/png'};base64,QUJD`);

    expect(capturarFrame(videoPronto())).toBe('data:image/jpeg;base64,QUJD');
    expect(chamadas).toEqual([{ w: 640, h: 360, x: 0, y: 0, dw: 640, dh: 360 }]);
  });
});

describe('nomeCaptura', () => {
  const d = new Date(2026, 10, 23, 14, 26, 39); // hora local: 2026-11-23 14:26:39

  it('nome com espaco vira underscores + timestamp AAAA-MM-DD-HHMMSS', () => {
    expect(nomeCaptura('AER BVB SAGUAO PTZ', d)).toBe('AER_BVB_SAGUAO_PTZ_2026-11-23-142639.jpg');
  });

  it('acento, barra e pontuacao viram um unico underscore; sem underscore nas pontas', () => {
    expect(nomeCaptura('Câmera / 01!', new Date(2026, 0, 5, 9, 8, 7))).toBe('C_mera_01_2026-01-05-090807.jpg');
  });

  it('nome que sanitiza para vazio recebe camera', () => {
    expect(nomeCaptura('???', d)).toBe('camera_2026-11-23-142639.jpg');
  });
});
