import { describe, expect, it, beforeEach, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { LanguageProvider } from '@/shared/i18n';
import { useLayoutTabs, getStageTabsSnapshot, setStageTabsSnapshot, clearStageTabsSnapshot, stageSnapshotGeneration } from './useAbasLayout';
import type { PromptHandle } from '@/shared/components/PromptDialog';

const handle = (answer: string | null) => ({ ask: vi.fn().mockResolvedValue(answer) });

describe('useLayoutTabs save', () => {
  beforeEach(() => localStorage.clear());

  it('asks for an empty name while the tab carries the generated default label', async () => {
    localStorage.setItem('openvms.lang', 'pt-BR');
    const api = { saveLayout: vi.fn().mockResolvedValue({ id: 'l1', name: 'Aeroporto' }) };
    const dlg = handle('Aeroporto');
    const { result } = renderHook(
      () => useLayoutTabs({ api, dlg: dlg as unknown as PromptHandle }),
      { wrapper: LanguageProvider },
    );
    expect(result.current.tabs[0].name).toBe('Novo layout 1');
    await act(async () => { await result.current.save(result.current.tabs[0]); });
    expect(dlg.ask.mock.calls[0][2]).toBe('');
  });

  it('keeps a name the operator already typed', async () => {
    const api = { saveLayout: vi.fn().mockResolvedValue({ id: 'l2', name: 'Aeroporto' }) };
    const dlg = handle('Aeroporto');
    const { result } = renderHook(
      () => useLayoutTabs({ api, dlg: dlg as unknown as PromptHandle }),
      { wrapper: LanguageProvider },
    );
    await act(async () => { await result.current.save({ ...result.current.tabs[0], name: 'Aeroporto' }); });
    expect(dlg.ask.mock.calls[0][2]).toBe('Aeroporto');
  });
});

// The shared registry is the videowall identity of BOTH modes (spec 2026-10-27, section 6.1).
describe('shared stage tabs registry', () => {
  beforeEach(() => { clearStageTabsSnapshot(); });

  it('starts empty', () => { expect(getStageTabsSnapshot()).toBeNull(); });

  it('set/get round-trips tabs and activeKey', () => {
    setStageTabsSnapshot({ tabs: [{ key: 'n1', id: null, name: 'A', cells: [], dirty: true }], activeKey: 'n1' });
    expect(getStageTabsSnapshot()!.tabs[0].dirty).toBe(true);
    expect(getStageTabsSnapshot()!.activeKey).toBe('n1');
  });

  it('clear nulls the snapshot and bumps the generation (logout guard)', () => {
    const g0 = stageSnapshotGeneration();
    setStageTabsSnapshot({ tabs: [], activeKey: 'x' });
    clearStageTabsSnapshot();
    expect(getStageTabsSnapshot()).toBeNull();
    expect(stageSnapshotGeneration()).toBeGreaterThan(g0);
  });
});
