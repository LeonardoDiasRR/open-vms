import { useCallback, useEffect, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { ApiClient, Layout } from '@/shared/utils/api';
import type { OpenRequest } from '@/shared/domain/pedidoAbrir';
import type { ItemMenu } from '@/shared/ui/CameraMenu';
import type { Capability } from '@/shared/domain/capabilities';
import type { PromptHandle } from '@/shared/components/PromptDialog';
import { useT } from '@/shared/i18n';

// Selection: the menu and the batch actions only read/write {kind, id} pairs.
export type Marked = { kind: 'camera' | 'group' | 'layout'; id: string };
type Api = Pick<ApiClient, 'layouts' | 'saveLayout' | 'deleteLayouts'>;
type Translate = Pick<ReturnType<typeof useT>, 't'>;

// Saved layouts: 5s poll + the open-on-stage request the App forwards to LiveView.
export function useLayouts(api: Api | null) {
  const { t } = useT();
  const [layouts, setLayouts] = useState<Layout[]>([]);
  const [openRequest, setOpenRequest] = useState<OpenRequest>(null); // {new:true} | layout from the tree

  // ponytail: silent error — the 5s poll reconnects
  const refreshLayouts = useCallback(async () => {
    if (!api) return;
    try { setLayouts(await api.layouts()); } catch { /* the 5s poll reconnects */ }
  }, [api]);

  useEffect(() => {
    if (!api) return;
    refreshLayouts();
    const id = setInterval(refreshLayouts, 5000);
    return () => clearInterval(id);
  }, [refreshLayouts]);

  const openOnStage = useCallback((p: OpenRequest) => setOpenRequest(p), []);
  const consumeRequest = useCallback(() => setOpenRequest(null), []);

  // Layout menu actions. Returns true when the id was a layout id: in that case the action
  // already left `layouts` as the server sent it (the App only reloads the catalog for camera and
  // folder ids). The `return true` on cancelled prompts are the old `return`s from the App.
  const handleLayoutAction = useCallback(async (
    id: string,
    target: { id: string },
    marked: Marked[],
    setMarked: Dispatch<SetStateAction<Marked[]>>,
    dlg: PromptHandle,
  ): Promise<boolean> => {
    if (!api) return false;
    if (id === 'layout-new') { openOnStage({ new: true }); return true; }
    if (id === 'layout-open') { openOnStage(layouts.find((l) => l.id === target.id) ?? null); return true; }
    if (id !== 'layout-rename' && id !== 'layout-rename-batch' && id !== 'layout-delete' && id !== 'layout-delete-batch') return false;
    if (id === 'layout-rename') {
      const targetLayout = layouts.find((l) => l.id === target.id);
      if (!targetLayout) return true;
      const name = await dlg.ask(t('layouts.rename_prompt'), t('shared.name'), targetLayout.name || '');
      if (!name || name.trim() === targetLayout.name) return true;
      await api.saveLayout({ id: targetLayout.id, name: name.trim(), cells: targetLayout.cells ?? [] });
    } else if (id === 'layout-rename-batch') {
      const base = await dlg.ask(t('layouts.base_prompt'), t('shared.name'), t('layouts.name'));
      if (!base || !base.trim()) return true;
      const targets = layouts.filter((l) => marked.some((m) => m.kind === 'layout' && m.id === l.id));
      for (let i = 0; i < targets.length; i += 1) {
        await api.saveLayout({ id: targets[i].id, name: `${base.trim()}-${i + 1}`, cells: targets[i].cells ?? [] });
      }
    } else {
      const ids = id === 'layout-delete' ? [target.id] : marked.filter((x) => x.kind === 'layout').map((x) => x.id);
      const names = layouts.filter((l) => ids.includes(l.id)).map((l) => l.name);
      const confirmed = await dlg.confirm(t('shared.confirm_delete'), [t('layouts.delete_question', { n: ids.length }), ...names], { danger: true, text: t('shared.delete') });
      if (!confirmed) return true;
      await api.deleteLayouts(ids);
      setMarked((ms) => ms.filter((x) => !ids.includes(x.id)));
    }
    setLayouts(await api.layouts());
    return true;
  }, [api, layouts, openOnStage, t]);

  return { layouts, setLayouts, openRequest, openOnStage, consumeRequest, refreshLayouts, handleLayoutAction };
}

// Layout menu items: batch when the selection is layouts only (and more than one), otherwise the
// single item with open/rename/delete. (The root has no menu: the header "+" creates directly.)
// phase 4.3: rename/delete (and the batch pair) become POST/DELETE /layouts on the server — POLICY
// camera.manage.global. Open is read-only (camera.view) and stays. `can` absent = everything (default).
export function layoutMenuItems(m: { kind: string; id: string }, marked: { kind: string; id: string }[],
  { t }: Translate, can?: (cap: Capability) => boolean): ItemMenu[] {
  const canManage = !can || can('camera.manage.global');
  const batchSelected = m.kind === 'layout' && marked.length > 1
    && marked.every((x) => x.kind === 'layout') && marked.some((x) => x.id === m.id);
  if (batchSelected) return canManage ? [{ id: 'layout-rename-batch', label: t('layouts.rename_batch', { n: marked.length }) },
                             { id: 'layout-delete-batch', label: t('layouts.delete_batch', { n: marked.length }), danger: true }] : [];
  return [{ id: 'layout-open', label: t('layouts.open_in_wall') },
          ...(canManage ? [{ id: 'layout-rename', label: t('layouts.rename') },
                           { id: 'layout-delete', label: t('layouts.delete'), danger: true }] : [])];
}
