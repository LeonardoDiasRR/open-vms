import { renderHook, act } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it } from 'vitest';
import { LanguageProvider, useT } from './index';
import type { MessageKey } from './en';

const wrapper = ({ children }: { children: ReactNode }) => (
  <LanguageProvider>{children}</LanguageProvider>
);

const renderT = () => renderHook(() => useT(), { wrapper });

describe('useT', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.lang = '';
  });

  it('defaults to pt-BR', () => {
    const { result } = renderT();
    expect(result.current.lang).toBe('pt-BR');
    expect(result.current.locale).toBe('pt-BR');
    expect(result.current.t('app.mode.live')).toBe('Ao vivo');
  });

  it('reads the stored language', () => {
    localStorage.setItem('openvms.lang', 'pt-BR');
    const { result } = renderT();
    expect(result.current.lang).toBe('pt-BR');
    expect(result.current.t('app.mode.live')).toBe('Ao vivo');
  });

  it('falls back to pt-BR on an invalid value', () => {
    localStorage.setItem('openvms.lang', 'fr');
    const { result } = renderT();
    expect(result.current.lang).toBe('pt-BR');
    expect(result.current.t('app.mode.live')).toBe('Ao vivo');
  });

  it('interpolates variables and returns the key when missing', () => {
    localStorage.setItem('openvms.lang', 'en');
    const { result } = renderT();
    expect(result.current.t('app.server', { host: 'ovms' })).toBe('Server: ovms');
    expect(result.current.t('nope.missing' as MessageKey)).toBe('nope.missing');
  });

  it('picks singular and plural shapes in tn', () => {
    localStorage.setItem('openvms.lang', 'en');
    const { result } = renderT();
    expect(result.current.tn('app.camera_count', 1)).toBe('1 camera');
    expect(result.current.tn('app.camera_count', 2)).toBe('2 cameras');
  });

  it('persists the language and syncs <html lang>', () => {
    localStorage.setItem('openvms.lang', 'en');
    const { result } = renderT();
    act(() => result.current.setLang('pt-BR'));
    expect(localStorage.getItem('openvms.lang')).toBe('pt-BR');
    expect(document.documentElement.lang).toBe('pt-BR');
    expect(result.current.t('app.mode.live')).toBe('Ao vivo');
  });
});
