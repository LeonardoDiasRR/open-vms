import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Toasts, useToasts } from './Toast';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// jsdom nao aplica folha de estilo nem modelo de layout, entao a ancora e pinada como TEXTO do
// styles.css, no idioma de `divisor.test.ts`. O seletor do bloco e unico no arquivo.
const css = readFileSync(join(process.cwd(), 'src', 'styles.css'), 'utf8');
const block = (sel: string) =>
  new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{([^}]*)\\}').exec(css)?.[1] ?? '';

function Bench() {
  const { notices, notify } = useToasts();
  return (
    <>
      <button onClick={() => notify('salvo')}>ok</button>
      <button onClick={() => notify('falhou', 'error')}>error</button>
      <button onClick={() => notify('aviso 1')}>n1</button>
      <button onClick={() => notify('aviso 2')}>n2</button>
      <button onClick={() => notify('aviso 3')}>n3</button>
      <button onClick={() => notify('aviso 4')}>n4</button>
      <Toasts notices={notices} />
    </>
  );
}

const click = (name: string) => fireEvent.click(screen.getByRole('button', { name }));
const advance = (ms: number) => act(() => { vi.advanceTimersByTime(ms); });

describe('Toast', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('the element is a live region with role status', () => {
    const { container } = render(<Bench />);
    const region = container.querySelector('[role="status"]')!;
    expect(region.getAttribute('aria-live')).toBe('polite');
  });

  it('notifies and disappears on its own at the success time (2600 ms)', () => {
    render(<Bench />);
    click('ok');
    expect(screen.getByText('salvo')).toBeInTheDocument();
    advance(2599);
    expect(screen.getByText('salvo')).toBeInTheDocument();
    advance(1);
    expect(screen.queryByText('salvo')).toBeNull();
  });

  it('the error stays longer: 6000 ms', () => {
    render(<Bench />);
    click('error');
    advance(2600);
    expect(screen.getByText('falhou')).toBeInTheDocument();
    advance(3400);
    expect(screen.queryByText('falhou')).toBeNull();
  });

  it('stacks at most 3 notices, newest to oldest', () => {
    render(<Bench />);
    for (const n of ['n1', 'n2', 'n3', 'n4']) click(n);
    expect(screen.queryByText('aviso 1')).toBeNull();
    expect(screen.getByText('aviso 2')).toBeInTheDocument();
    expect(screen.getByText('aviso 4')).toBeInTheDocument();
  });

  it('the same text does not appear twice', () => {
    render(<Bench />);
    click('ok'); click('ok');
    expect(screen.getAllByText('salvo').length).toBe(1);
  });

  it('nasce na area util, abaixo do header e a esquerda do painel direito', () => {
    const { container } = render(<Bench />);
    const classes = container.querySelector('[role="status"]')!.className.split(/\s+/);
    expect(classes).toContain('fixed');
    // o canto da janela (2026-11-06 de manha) nao pode sobreviver: a ancora passou a viver so no CSS
    for (const antiga of ['top-4', 'right-4', 'bottom-4']) expect(classes).not.toContain(antiga);
    const bloco = block('.nx-toast');
    expect(bloco).toMatch(/top:\s*calc\(var\(--alt-topbar,\s*0px\)/);
    expect(bloco).toMatch(/right:\s*calc\(var\(--col-dir,\s*0px\)/);
    expect(bloco).toMatch(/max-width:\s*calc\(100vw/);
    expect(bloco).toContain('pointer-events: none');
  });

  it('nenhuma var() da ancora do toast esta sem fallback', () => {
    // uma calc() com var() sem valor invalida a DECLARACAO inteira: fora do .shell (pagina /design)
    // o browser descartaria o `right` e o aviso puleria para a esquerda da tela (spec 3.2, medido).
    // Mira so as declaracoes da ANCORA: `z-index: var(--z-toast)` e legitimo sem fallback porque
    // --z-toast vive no :root (global), nao no .shell — emenda E1.
    const ancora = block('.nx-toast').split(';').filter((d) => /^\s*(top|right|max-width)\s*:/.test(d));
    expect(ancora.length, 'as tres declaracoes da ancora existem').toBe(3);
    const semFallback = ancora
      .flatMap((d) => [...d.matchAll(/var\((--[\w-]+)([^)]*)\)/g)])
      .filter((m) => !m[2].trim());
    expect(semFallback.map((m) => m[1])).toEqual([]);
  });

  it('a ancora le a altura do header da mesma fonte que o grid', () => {
    // se alguem voltar a escrever `40px` no grid-template-rows, o aviso fica flutuando na altura
    // errada sem nenhum teste vermelho (spec 4.3).
    const shell = block('.shell');
    expect(shell).toMatch(/--alt-topbar:\s*40px/);
    expect(shell).toMatch(/grid-template-rows:\s*var\(--alt-topbar\)\s+1fr\s+24px/);
  });

  it('o aviso mais novo fica no topo da pilha, encostado no canto', () => {
    render(<Bench />);
    for (const n of ['n1', 'n2', 'n3']) click(n);
    const itens = Array.from(document.querySelectorAll('.nx-toast > div'));
    expect(itens.map((e) => e.textContent?.trim())).toEqual([
      'aviso 3',
      'aviso 2',
      'aviso 1',
    ]);
  });
});
