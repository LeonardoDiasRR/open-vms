import { describe, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import UserMenu from './UserMenu';
import { LanguageProvider } from '@/shared/i18n';

// spec 2026-10-19: the menu labels come from the dictionary — the provider mounts with the default (en).
const renderiza = (props: Partial<ComponentProps<typeof UserMenu>> = {}) =>
  render(<LanguageProvider>
    <UserMenu open user="operador" profile="operator" canConfigure={false}
      onToggle={() => {}} onConfig={() => {}} onExit={() => {}} onClose={() => {}} {...props} />
  </LanguageProvider>);

describe('UserMenu (spec 2026-10-18)', () => {
  it('o botão-âncora existe com nome acessível; fechado, não há menu', () => {
    renderiza({ open: false });
    expect(screen.getByLabelText('User menu')).toBeInTheDocument();
    expect(screen.queryByRole('menu')).toBeNull();
  });

  it('aberto: nome e perfil no cabeçalho e os itens na ordem Settings, Log out', () => {
    renderiza({ canConfigure: true });
    const head = document.querySelector('.user-menu-head')!;
    expect(head.textContent).toContain('operador');
    expect(head.textContent).toContain('operator');
    // header order (spec section 7): name BEFORE the profile (user and profile are distinct here)
    expect(head.textContent!.indexOf('operador')).toBeLessThan(head.textContent!.indexOf('operator'));
    const itens = screen.getAllByRole('menuitem');
    expect(itens.map((b) => b.textContent)).toEqual(['Settings', 'Log out']);
  });

  it('não-admin: sem Settings; Log out continua lá', () => {
    renderiza({ canConfigure: false });
    expect(screen.queryByRole('menuitem', { name: 'Settings' })).toBeNull();
    expect(screen.getByRole('menuitem', { name: 'Log out' })).toBeInTheDocument();
  });

  it('cada item chama o seu handler', () => {
    const onConfig = vi.fn(); const onExit = vi.fn();
    renderiza({ canConfigure: true, onConfig, onExit });
    fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Log out' }));
    expect(onConfig).toHaveBeenCalledTimes(1);
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('Escape chama onClose', () => {
    const onClose = vi.fn();
    renderiza({ onClose });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('mousedown fora fecha; dentro não', () => {
    const onClose = vi.fn();
    renderiza({ onClose });
    fireEvent.mouseDown(screen.getByRole('menuitem', { name: 'Log out' }));
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.mouseDown(document.body);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('the click on the button calls onToggle', () => {
    const onToggle = vi.fn();
    renderiza({ onToggle });
    fireEvent.click(screen.getByLabelText('User menu'));
    expect(onToggle).toHaveBeenCalledTimes(1);
  });
});
