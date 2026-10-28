import { useState } from 'react';
import { addCameras, newCellId } from '@/shared/domain/stage';
import type { ApiClient } from '@/shared/utils/api';
import type { PromptHandle } from '@/shared/components/PromptDialog';
import type { ItemMenu } from '@/shared/ui/CameraMenu';
import type { OpenRequest, LayoutToOpen } from '@/shared/domain/pedidoAbrir';
import type { StageCell } from '@/shared/ui/StagePalco';
import { useT } from '@/shared/i18n';

// spec 2026-10-18 (videowall recording tabs, section 6.1): the tab state that used to live inside
// LiveView moved into this hook. "Live" and "Recording" use the SAME code — the invariant that
// behavior cannot diverge (section 2 of the spec) is guaranteed by construction, not by copying.
// The snapshot stays LOCAL to each page (one saves its own fields); the hook only receives the
// initial state through `initial` and returns `tabs`/`activeKey` for the page to snapshot.
export type Cell = StageCell;
export type Tab = { key: string; id: string | null; name: string; cells: Cell[]; dirty: boolean };
export type TabMenu = { key: string; x: number; y: number };
export type InitialTabs = { tabs: Tab[]; activeKey: string } | null;

// `tabSeq` is MODULE state (it already was in LiveView): the counter survives a tab switch during
// the session and dies with the reload. The "New Layout N" label belongs to both modes.
let tabSeq = 0;
export const newTab = (name: (n: number) => string): Tab => {
  const n = ++tabSeq;
  return { key: `n${n}`, id: null, name: name(n), cells: [], dirty: false };
};

type Api = Pick<ApiClient, 'saveLayout'>;

export function useLayoutTabs({ api, onLayoutsChanged, dlg, initial = null }: {
  api: Api;
  onLayoutsChanged?: () => void;
  dlg: PromptHandle;
  initial?: InitialTabs;
}) {
  const { t } = useT();
  const createTab = () => newTab((n) => t('layouts.tab_new', { n }));
  const [tabs, setTabs] = useState<Tab[]>(() => initial?.tabs ?? [createTab()]);
  // The initial key is the one of the tab created in the first useState. `tabSeq` is MODULE state:
  // on the second mount (logout -> login) the tab is born with another key, and a fixed activeKey
  // ('n1') stopped matching any tab — the openRequest effect could not find the active tab and the
  // double click/Open stopped putting the camera on the stage (defect measured on 2026-10-17, in
  // the App test).
  const [activeKey, setActiveKey] = useState<string>(() => initial?.activeKey ?? tabs[0].key);
  const [menu, setMenu] = useState<TabMenu | null>(null); // {key, x, y}
  const [error, setError] = useState<string | null>(null);

  const active = tabs.find((a) => a.key === activeKey) || tabs[0];

  function patchTab(key: string, p: Partial<Tab>) {
    setTabs((as) => as.map((a) => (a.key === key ? { ...a, ...p } : a)));
  }

  function openLayout(layout: LayoutToOpen) {
    const existing = tabs.find((a) => a.id === layout.id);
    if (existing) { setActiveKey(existing.key); return; }
    const tab: Tab = { key: `l${layout.id}`, id: layout.id, name: layout.name,
      cells: (layout.cells || []).map((c) => ({ ...c })), dirty: false };
    setTabs((as) => [...as, tab]);
    setActiveKey(tab.key);
  }

  // request from the tree ("Open"/double click/drag/"New"/camera): {new} creates a tab; {cameras}
  // enters the active tab; a layout opens/focuses a tab. addCameras returns the SAME list when
  // nothing enters: without that the tab would become dirty (and the X would start asking) for a
  // double click on a camera already on the wall.
  function handleRequest(request: OpenRequest) {
    if (!request) return;
    if ('new' in request && request.new) { const a = createTab(); setTabs((as) => [...as, a]); setActiveKey(a.key); }
    else if ('cameras' in request && request.cameras) {
      setTabs((as) => as.map((a) => {
        if (a.key !== activeKey) return a;
        const cells = addCameras(a.cells, request.cameras, newCellId);
        return cells === a.cells ? a : { ...a, cells, dirty: true };
      }));
    } else if ('id' in request) openLayout(request);
  }

  // The default label is translated, so the check compares the tab name against the label the tab was
  // born with (key `n<seq>`). Comparing against the English text broke the pt-BR UI on 2026-10-25.
  const isDefaultName = (tab: Tab) => tab.key.startsWith('n')
    && tab.name === t('layouts.tab_new', { n: Number(tab.key.slice(1)) });

  async function save(tab: Tab) {
    const name = await dlg.ask(t('layouts.name'), t('shared.name'), isDefaultName(tab) ? '' : tab.name);
    if (!name || !name.trim()) return;
    setError(null);
    try {
      const saved = await api.saveLayout({ id: tab.id || undefined, name: name.trim(), cells: tab.cells });
      patchTab(tab.key, { id: saved.id, name: saved.name, dirty: false });
      onLayoutsChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : t('layouts.save_failed')); }
  }

  async function rename(tab: Tab) {
    const name = await dlg.ask(t('layouts.tab_rename'), t('shared.name'), tab.name);
    if (!name || name.trim() === tab.name) return;
    setError(null);
    try {
      const saved = await api.saveLayout({ id: tab.id, name: name.trim(), cells: tab.cells });
      patchTab(tab.key, { id: saved.id, name: saved.name, dirty: false });
      onLayoutsChanged?.();
    } catch (e) { setError(e instanceof Error ? e.message : t('layouts.rename_failed')); }
  }

  // closes any tab: never asks (spec 2026-10-16); the last one becomes a new tab;
  // focus on the first (left), like NX
  function closeTab(key: string) {
    const tab = tabs.find((a) => a.key === key);
    if (!tab) return;
    setTabs((as) => {
      const rest = as.filter((a) => a.key !== key);
      if (!rest.length) { const a = createTab(); setActiveKey(a.key); return [a]; }
      setActiveKey(rest[0].key);
      return rest;
    });
  }

  const menuItems: ItemMenu[] = [{ id: 'save', label: t('layouts.save') }];
  if (menu && tabs.find((a) => a.key === menu.key)?.id) menuItems.push({ id: 'rename', label: t('layouts.rename') });
  menuItems.push({ id: 'close', label: t('layouts.close'), danger: true });

  async function handleMenu(id: string) {
    const tab = tabs.find((a) => a.key === menu?.key);
    setMenu(null);
    if (!tab) return;
    if (id === 'save') await save(tab);
    else if (id === 'rename') await rename(tab);
    else if (id === 'close') closeTab(tab.key);
  }

  return {
    tabs, active, activeKey, setActiveKey, patchTab,
    newTab: createTab, openLayout, closeTab, save, rename, handleRequest,
    error, menu, openMenu: (key: string, x: number, y: number) => setMenu({ key, x, y }),
    closeMenu: () => setMenu(null), menuItems, handleMenu,
  };
}

// spec 2026-10-27 (shared videowall): the tabs snapshot used to be one module copy PER PAGE, which
// is why switching Live/Archive lost the stage. The registry below is the single videowall state;
// each page keeps only its own operational fields in its own snapshot. The generation is the
// logout guard copied from the Archive pattern: a clear must beat a late write from a dying instance.
let stageTabsSnapshot: { tabs: Tab[]; activeKey: string } | null = null;
let stageGeneration = 0;
export function getStageTabsSnapshot(): { tabs: Tab[]; activeKey: string } | null { return stageTabsSnapshot; }
export function setStageTabsSnapshot(s: { tabs: Tab[]; activeKey: string }): void { stageTabsSnapshot = s; }
export function clearStageTabsSnapshot(): void { stageTabsSnapshot = null; stageGeneration++; }
export function stageSnapshotGeneration(): number { return stageGeneration; }
