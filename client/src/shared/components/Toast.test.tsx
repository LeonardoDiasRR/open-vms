import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { Toasts, useToasts } from './Toast';

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
});
