import { useCallback, type DragEvent } from 'react';
import type { LayoutToOpen } from '@/shared/domain/pedidoAbrir';

// Drop of a LAYOUT dragged from the tree: the SINGLE contract of both tabs (spec 2026-10-18
// videowall-paridade, D1/D3). The tree only writes the id into application/x-ovms-layout
// (LayoutTree.tsx:102). A drag without that type is a camera/folder: nothing is consumed, the event
// goes on to StagePalco to position the cells. An id without a catalog entry is also consumed: that
// was the behavior of LiveView's dropLayout, and the payload must not leak to the stage.
export function useLayoutDrop(layouts: LayoutToOpen[], onOpen: (l: LayoutToOpen) => void) {
  return useCallback((e: DragEvent<HTMLDivElement>) => {
    const id = e.dataTransfer.getData('application/x-ovms-layout');
    if (!id) return;
    e.preventDefault();
    e.stopPropagation();
    const l = layouts.find((x) => x?.id === id);
    if (l) onOpen(l);
  }, [layouts, onOpen]);
}
