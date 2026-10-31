import { useCallback, useEffect, useState } from 'react';

const STORAGE_KEY = 'openvms.panels';

export type Side = 'left' | 'right';
type Collapsed = { left: boolean; right: boolean };
// EXPLICIT widths from the drag (spec 2026-10-17, 1.2). Absent = CSS answers: 220/260 on the
// `.shell` and 32px when the panel is collapsed.
export type Widths = { left?: number; right?: number };
type State = { collapsed: Collapsed; widths: Widths };

// ponytail: the SAME widths as the `--col-esq`/`--col-dir` variables in styles.css. Here they are
// numbers (the handle's `aria-valuenow` and the gesture's starting point); CSS does the painting.
export const DEFAULT_WIDTH: Record<Side, number> = { left: 220, right: 260 };
export const MIN_WIDTH = 160;
// Drag ceiling: 40% of the window — the stage never leaves the screen (declared risk in the spec).
export const maxWidth = (window: number) => Math.round(window * 0.4);
export const clampWidth = (px: number, window: number) =>
  Math.min(Math.max(Math.round(px), MIN_WIDTH), maxWidth(window));

// ponytail: defensive read — the key may be missing, corrupted or have an old shape.
// Any doubt falls back to the default (left open, right closed, no explicit width), the state of
// someone who never touched the button or the handle.
function read(): State {
  const defaults: State = { collapsed: { left: false, right: true }, widths: {} };
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const data = JSON.parse(raw) as Partial<{ left: boolean; right: boolean; leftWidth: number; rightWidth: number }>;
    // a width outside the limits (smaller window now, value written by hand) is not valid: the side
    // keeps the CSS default, exactly as if the key did not exist
    const width = (v: unknown): number | undefined =>
      typeof v === 'number' && Number.isFinite(v) && v >= MIN_WIDTH && v <= maxWidth(window.innerWidth) ? v : undefined;
    return {
      collapsed: { left: data.left === true, right: data.right === true },
      widths: { left: width(data.leftWidth), right: width(data.rightWidth) },
    };
  } catch {
    return defaults;
  }
}

// false = open (the name "collapsed" avoids a double negation in the consumer)
export function usePanels() {
  const [initial] = useState(read); // a single read: both things live in the SAME key object
  const [collapsed, setCollapsed] = useState<Collapsed>(initial.collapsed);
  const [widths, setWidths] = useState<Widths>(initial.widths);

  useEffect(() => {
    try {
      // ponytail: the key is ABSENT while the side was never dragged — double clicking the handle
      // returns the default precisely by deleting the key (spec 1.2)
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        left: collapsed.left, right: collapsed.right,
        ...(widths.left != null ? { leftWidth: widths.left } : {}),
        ...(widths.right != null ? { rightWidth: widths.right } : {}),
      }));
    } catch {
      // localStorage full or blocked: the preference only applies to this session
    }
  }, [collapsed, widths]);

  const toggle = useCallback((side: Side) => {
    setCollapsed((current) => ({ ...current, [side]: !current[side] }));
  }, []);

  // dragged width: `null` = reset (double click on the handle). With a number, the panel becomes
  // OPEN with that width — dragging with the panel collapsed EXPANDS and adopts the dragged value (1.2).
  const setWidth = useCallback((side: Side, px: number | null) => {
    setWidths((current) => ({ ...current, [side]: px == null ? undefined : px }));
    if (px != null) setCollapsed((current) => (current[side] ? { ...current, [side]: false } : current));
  }, []);

  return { collapsed, widths, toggle, setWidth };
}
