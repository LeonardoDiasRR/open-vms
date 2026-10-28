import { describe, expect, it, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { usePanels, clampWidth, maxWidth, MIN_WIDTH, DEFAULT_WIDTH } from './usePaineis';

describe('usePanels', () => {
  beforeEach(() => localStorage.clear());

  it('starts with the left open and the right closed when there is no saved preference', () => {
    const { result } = renderHook(() => usePanels());
    expect(result.current.collapsed).toEqual({ left: false, right: true });
  });

  it('toggles one side without touching the other and stores the preference', () => {
    const { result } = renderHook(() => usePanels());
    act(() => result.current.toggle('left'));
    expect(result.current.collapsed).toEqual({ left: true, right: true });
    expect(JSON.parse(localStorage.getItem('openvms.panels') as string)).toEqual({ left: true, right: true });
    act(() => result.current.toggle('left'));
    expect(result.current.collapsed.left).toBe(false);
  });

  it('restores the saved preference', () => {
    localStorage.setItem('openvms.panels', JSON.stringify({ left: true, right: true }));
    const { result } = renderHook(() => usePanels());
    expect(result.current.collapsed).toEqual({ left: true, right: true });
  });

  it('ignores a corrupted value and falls back to the default', () => {
    localStorage.setItem('openvms.panels', '{lixo');
    const { result } = renderHook(() => usePanels());
    expect(result.current.collapsed).toEqual({ left: false, right: true });
  });
});

// spec 2026-10-17 (item 1.2): the dragged width lives in the SAME localStorage object as the
// collapsed flags, in two separate keys (leftWidth/rightWidth). The two reads are independent:
// losing the width cannot lose the collapse preference, and vice versa.
describe('panel widths (item 1.2)', () => {
  beforeEach(() => localStorage.clear());

  it('with no saved width no key is born: CSS answers with 220/260', () => {
    const { result } = renderHook(() => usePanels());
    expect(result.current.widths).toEqual({});
    expect(DEFAULT_WIDTH).toEqual({ left: 220, right: 260 });
  });

  it('clampWidth pins both ends and the ceiling is 40% of the window', () => {
    expect(clampWidth(10, 1000)).toBe(MIN_WIDTH);
    expect(clampWidth(300, 1000)).toBe(300);           // inside the range it passes through
    expect(clampWidth(9999, 1000)).toBe(maxWidth(1000));
    expect(maxWidth(1000)).toBe(400);                   // 40% of 1000: the stage keeps 600
    expect(clampWidth(300.6, 1000)).toBe(301);          // integer px: the CSS variable gets no fraction
  });

  it('reads the saved width and discards the one outside the limits', () => {
    localStorage.setItem('openvms.panels', JSON.stringify({ left: false, right: true, leftWidth: 300, rightWidth: 10 }));
    const { result } = renderHook(() => usePanels());
    expect(result.current.widths.left).toBe(300);
    expect(result.current.widths.right).toBeUndefined();
    // reading the width does not touch the collapse flags
    expect(result.current.collapsed).toEqual({ left: false, right: true });
  });

  it('defensive read: garbage, string and value above the ceiling fall back to the default', () => {
    localStorage.setItem('openvms.panels', '{lixo');
    expect(renderHook(() => usePanels()).result.current.widths).toEqual({});
    localStorage.setItem('openvms.panels', JSON.stringify({ leftWidth: '300', rightWidth: null }));
    expect(renderHook(() => usePanels()).result.current.widths).toEqual({});
    localStorage.setItem('openvms.panels', JSON.stringify({ leftWidth: 99999 }));
    expect(renderHook(() => usePanels()).result.current.widths).toEqual({});
  });

  it('setWidth stores the new key and OPENS the panel; reset deletes only the width key', () => {
    localStorage.setItem('openvms.panels', JSON.stringify({ left: true, right: true }));
    const { result } = renderHook(() => usePanels());
    act(() => result.current.setWidth('left', 320));
    expect(result.current.widths.left).toBe(320);
    // dragging with the panel collapsed EXPANDS it (spec 1.2)
    expect(result.current.collapsed).toEqual({ left: false, right: true });
    expect(JSON.parse(localStorage.getItem('openvms.panels') as string))
      .toEqual({ left: false, right: true, leftWidth: 320 });
    // double click on the handle: back to the default and DELETES the key (rightWidth was never born and does not appear)
    act(() => result.current.setWidth('left', null));
    expect(result.current.widths).toEqual({});
    expect(JSON.parse(localStorage.getItem('openvms.panels') as string)).toEqual({ left: false, right: true });
  });
});
