import { describe, expect, it } from 'vitest';
import { mergeTail, type Segment } from './faixas';

const S = (a: number, b: number): Segment => ({ start_ts: a, end_ts: b });

describe('mergeTail (spec 2026-10-20 borda, D3, emenda E8)', () => {
  it('mantém a cabeça antiga e funde o tail contíguo', () => {
    const prev = [S(0, 100), S(200, 300)];
    const out = mergeTail(prev, [S(300, 420)]);
    expect(out).toEqual([S(0, 100), S(200, 420)]);
  });

  it('preserva o segmento de prev que cruza a janela do rabo e coalesce com o tail', () => {
    // continuous day: prev covers up to "now". the tail (only the window) cannot erase the morning
    const out = mergeTail([S(0, 400)], [S(300, 420)]);
    expect(out).toEqual([S(0, 420)]);
  });

  it('caso real do dia contínuo: [08:00,12:00] + rabo cresce e o histórico fica', () => {
    const out = mergeTail([S(28800, 43200)], [S(42330, 43230)]);
    expect(out).toEqual([S(28800, 43230)]);
  });

  it('coalesce segmentos adjacentes do rabo (mesma regra de runs)', () => {
    const out = mergeTail([], [S(300, 360), S(360, 420), S(500, 560)]);
    expect(out).toEqual([S(300, 420), S(500, 560)]);
  });

  it('mantém buraco real entre prev e tail sem coalescer', () => {
    const out = mergeTail([S(0, 100)], [S(200, 300)]);
    expect(out).toEqual([S(0, 100), S(200, 300)]);
  });

  it('devolve referências novas (arrays e objetos) e não toca no prev', () => {
    const prev = [S(0, 100)];
    const out = mergeTail(prev, [S(200, 300)]);
    expect(out).not.toBe(prev);
    expect(out[0]).not.toBe(prev[0]);
    expect(prev).toEqual([S(0, 100)]);
  });
});
