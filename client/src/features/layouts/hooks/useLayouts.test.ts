import { describe, expect, it, vi } from 'vitest';
import { createElement, type ReactNode } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ApiClient } from '@/shared/utils/api';
import { LanguageProvider, useT } from '@/shared/i18n';
import { useLayouts, layoutMenuItems } from './useLayouts';
import { makeCan } from '@/shared/domain/capabilities';
import type { PromptHandle } from '@/shared/components/PromptDialog';

// ponytail: the hook receives the api as a parameter; the module mock guarantees no test here
// touches the real network of the HTTP client.
vi.mock('@/shared/utils/api', () => ({ ApiClient: vi.fn() }));

const wrapper = ({ children }: { children: ReactNode }) => createElement(LanguageProvider, null, children);
const labels = () => renderHook(() => useT(), { wrapper }).result.current;
const layout = { id: 'l1', name: 'Mural da entrada' };
const fakeApi = (layouts: () => Promise<{ id: string; name: string }[]>): Pick<ApiClient, 'layouts' | 'saveLayout' | 'deleteLayouts'> => ({
  layouts,
  saveLayout: async (l) => ({ id: l.id ?? 'novo', name: l.name }),
  deleteLayouts: async (ids) => ({ deleted: ids }),
});

describe('useLayouts', () => {
  it('without an api it stays empty and with no open request', () => {
    const { result } = renderHook(() => useLayouts(null), { wrapper });
    expect(result.current.layouts).toEqual([]);
    expect(result.current.openRequest).toBeNull();
  });

  it('fetches the layouts on the first tick', async () => {
    const { result } = renderHook(() => useLayouts(fakeApi(async () => [layout])), { wrapper });
    await waitFor(() => expect(result.current.layouts.map((l) => l.name)).toEqual(['Mural da entrada']));
    expect(result.current.openRequest).toBeNull();
  });

  it('empty response and legitimate response: the list follows the server', async () => {
    let response: { id: string; name: string }[] = [layout];
    const { result } = renderHook(() => useLayouts(fakeApi(async () => response)), { wrapper });
    await waitFor(() => expect(result.current.layouts).toHaveLength(1));
    response = [];
    await act(async () => { await result.current.refreshLayouts(); });
    expect(result.current.layouts).toEqual([]);
  });

  it('openOnStage stores the request and consumeRequest clears it', async () => {
    const { result } = renderHook(() => useLayouts(fakeApi(async () => [])), { wrapper });
    result.current.openOnStage({ id: 'l1', name: 'Mural' });
    await waitFor(() => expect(result.current.openRequest).toEqual({ id: 'l1', name: 'Mural' }));
    result.current.consumeRequest();
    await waitFor(() => expect(result.current.openRequest).toBeNull());
  });

  it('the batch menu only shows with more than one layout marked', () => {
    const one = [{ kind: 'layout', id: 'l1' }];
    expect(layoutMenuItems({ kind: 'layout', id: 'l1' }, one, labels()).map((i) => i.id))
      .toEqual(['layout-open', 'layout-rename', 'layout-delete']);
    expect(layoutMenuItems({ kind: 'layout', id: 'l1' }, [...one, { kind: 'layout', id: 'l2' }], labels()).map((i) => i.id))
      .toEqual(['layout-rename-batch', 'layout-delete-batch']);
  });

  // phase 4.3: rename/delete = POST/DELETE /layouts (POLICY camera.manage.global). Without the
  // capability only the read-only "open" survives; the batch menu (both items gated) empties out.
  it('4.3: without camera.manage.global only "open" stays; the batch menu empties; with it, unchanged', () => {
    const L = (id: string) => ({ kind: 'layout', id });
    const one = [L('l1')];
    const noCap = makeCan([]);
    const withCap = makeCan(['camera.manage.global']);
    expect(layoutMenuItems(L('l1'), one, labels(), noCap).map((i) => i.id)).toEqual(['layout-open']);
    expect(layoutMenuItems(L('l1'), [...one, L('l2')], labels(), noCap)).toEqual([]);
    // with the capability: identical to the old behavior (the default without `can` is the case above)
    expect(layoutMenuItems(L('l1'), one, labels(), withCap).map((i) => i.id))
      .toEqual(['layout-open', 'layout-rename', 'layout-delete']);
    expect(layoutMenuItems(L('l1'), [...one, L('l2')], labels(), withCap).map((i) => i.id))
      .toEqual(['layout-rename-batch', 'layout-delete-batch']);
  });
});

// (spec promptdialog) fake dlg: resolves what the test tells it to, no JSX
function mkDlg(name: string | null, confirmed: boolean): PromptHandle {
  return {
    request: null, setRequest: () => {},
    ask: vi.fn(async () => name),
    confirm: vi.fn(async () => confirmed),
  } as unknown as PromptHandle;
}

describe('handleLayoutAction via the dialog (spec promptdialog)', () => {
  const mkApi = () => ({
    layouts: async () => [{ id: 'l1', name: 'A', cells: [] }],
    saveLayout: vi.fn(async () => ({ id: 'l1', name: 'B', cells: [] })),
    deleteLayouts: vi.fn(async () => ({ deleted: ['l1'] })),
  });
  it('layout-rename uses dlg.ask and saves the new name', async () => {
    const apiL = mkApi();
    const { result } = renderHook(() => useLayouts(apiL), { wrapper });
    await waitFor(() => expect(result.current.layouts.length).toBe(1));
    let r: boolean | undefined;
    await act(async () => { r = await result.current.handleLayoutAction('layout-rename', { id: 'l1' }, [], () => {}, mkDlg('B', true)); });
    expect(r).toBe(true);
    expect(apiL.saveLayout).toHaveBeenCalledWith({ id: 'l1', name: 'B', cells: [] });
  });
  it('layout-delete cancelled does not delete', async () => {
    const apiL = mkApi();
    const { result } = renderHook(() => useLayouts(apiL), { wrapper });
    await waitFor(() => expect(result.current.layouts.length).toBe(1));
    await act(async () => { await result.current.handleLayoutAction('layout-delete', { id: 'l1' }, [], () => {}, mkDlg(null, false)); });
    expect(apiL.deleteLayouts).not.toHaveBeenCalled();
  });
});
