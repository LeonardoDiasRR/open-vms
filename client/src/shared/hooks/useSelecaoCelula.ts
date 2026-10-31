import { useCallback, useEffect, useRef, useState } from 'react';

// spec 2026-10-18 (4.2) + spec 2026-10-18-celula-maximizada-60 (3.2): this is the Live tab
// behavior, extracted without change. `id` draws the border; `expanded` changes the size and only
// applies to that id.
// spec 2026-10-18 (1s wait, cell size): NO size change is immediate. The click puts the border
// up at once and schedules the size for SIZE_WAIT_MS after the LAST click; each click on the
// marked cell flips the scheduled size and restarts the wait (2 quick clicks = stable size, and the
// native `dblclick` of fullscreen lands on the same element). Fullscreen: entering cancels the
// schedule, leaving collapses the selected cell at once, and a click from inside schedules nothing.
// Amendment 2026-10-18 (operator): "Nx way" — 300 ms, the value measured from NX's ClickInstrument
// (rea-nx/analysis/03-click-atrasado-celula.md: startTimer(0x12c) on the workbench left click).
export const SIZE_WAIT_MS = 300;
export type Selection = { id: string | null; expanded: boolean };
export const NO_SELECTION: Selection = { id: null, expanded: false };

export function useCellSelection(initial: Selection = NO_SELECTION) {
  const [selection, setSelection] = useState<Selection>(initial);
  // the ref mirror of the committed selection: timers and listeners read the current state without
  // recreating themselves
  const selectionRef = useRef(selection);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scheduled = useRef(false);

  const apply = useCallback((s: Selection) => { selectionRef.current = s; setSelection(s); }, []);

  const cancel = useCallback(() => {
    if (timer.current !== null) { clearTimeout(timer.current); timer.current = null; }
  }, []);

  const schedule = useCallback((target: boolean) => {
    cancel();
    scheduled.current = target;
    timer.current = setTimeout(() => {
      timer.current = null;
      const s = selectionRef.current;
      if (s.id !== null) apply({ id: s.id, expanded: target });
    }, SIZE_WAIT_MS);
  }, [apply, cancel]);

  // The click on the cell: border immediately; the size follows the wait. On the marked cell each
  // click flips the scheduled value (without a pending one, it starts from the current size); on
  // another cell the old pending dies with its border. With no selection the `document` listener
  // does not re-render the grid.
  const clickCell = useCallback((id: string) => {
    if (document.fullscreenElement) return;   // rule 7: during fullscreen nothing is scheduled
    const s = selectionRef.current;
    if (s.id !== id) {
      apply({ id, expanded: false });
      schedule(true);
      return;
    }
    schedule(!(timer.current !== null ? scheduled.current : s.expanded));
  }, [schedule, apply]);

  const clearSelection = useCallback(() => { cancel(); apply(NO_SELECTION); }, [apply, cancel]);

  // A click anywhere in the app clears it, with three exceptions: inside a `.stage-cell` (the click
  // cycle continues), inside `.rightpanel.ptz` (the joystick does not drop the selection) and inside
  // `.sheet` (spec 2026-10-19 selecao-sheet-tela-cheia-flutuante, B1: play/speed/timeline/date on
  // the sheet do not drop the track border). Leaving also clears the pending flag (rule 3).
  useEffect(() => {
    function onOutside(e: MouseEvent) {
      const target = e.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.closest('.stage-cell, .rightpanel.ptz, .sheet')) return;
      if (selectionRef.current.id !== null) clearSelection();
    }
    document.addEventListener('click', onOutside);
    return () => document.removeEventListener('click', onOutside);
  }, [clearSelection]);

  // Fullscreen (rules 5 and 6): entering cancels the pending size; leaving collapses the selected
  // cell at once.
  useEffect(() => {
    function onFullscreenChange() {
      cancel();
      if (document.fullscreenElement) return;
      const s = selectionRef.current;
      if (s.id !== null && s.expanded) apply({ id: s.id, expanded: false });
    }
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, [apply, cancel]);

  // the pending size does not survive unmount (switching tabs cancels the wait; spec, accepted costs)
  useEffect(() => () => { cancel(); }, [cancel]);

  return { selection, clickCell, clearSelection };
}
