import { describe, expect, it, vi } from 'vitest';
import { fireEvent, renderHook } from '@testing-library/react';
import { useEsc } from './useEsc';

const esc = () => fireEvent.keyDown(document, { key: 'Escape' });

describe('useEsc', () => {
  it('calls onClose on Escape and ignores other keys', () => {
    const onClose = vi.fn();
    renderHook(() => useEsc(onClose));
    fireEvent.keyDown(document, { key: 'Enter' });
    expect(onClose).not.toHaveBeenCalled();
    esc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('releases the listener on unmount', () => {
    const onClose = vi.fn();
    const { unmount } = renderHook(() => useEsc(onClose));
    unmount();
    esc();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('with two mounted modals, only the TOP one closes (stack)', () => {
    const bottom = vi.fn(); const top = vi.fn();
    const a = renderHook(() => useEsc(bottom));
    const b = renderHook(() => useEsc(top));
    esc();
    expect(bottom).not.toHaveBeenCalled();
    expect(top).toHaveBeenCalledTimes(1);
    b.unmount();
    esc();
    expect(bottom).toHaveBeenCalledTimes(1);
    a.unmount();
  });
});
