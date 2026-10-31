import { useImperativeHandle, useRef, type Ref } from 'react';
import { ARROW_THRESHOLD_PX, DRAG_RADIUS, fixedRectangle } from '@/features/live/services/ptz';
import type { PtzHint } from '@/features/live/hooks/usePtz';

// Option A of the spec (section 5, English wording). Switching to the Nx literals (`Moving...`,
// `Zooming in...`, `Zooming out...`) is editing THIS map — nothing else depends on the words.
// TODO(i18n): no `live.ptz.moving|zoom_in|zoom_out` keys in en.ts yet (task 6.2).
const ACTIONS: Record<PtzHint, { text: string; icon: string; circle: boolean }> = {
  moving: { text: 'Moving', icon: '✥', circle: false },
  'zoom-in': { text: 'Zooming in', icon: '+', circle: true },
  'zoom-out': { text: 'Zooming out', icon: '−', circle: true },
};

export type OverlayPtzHandle = {
  show: (x: number, y: number) => void;
  update: (x: number, y: number) => void;
  hide: () => void;
  // Area selection rectangle (spec 2026-10-18). Same technique as the arrow: geometry by inline style,
  // no `setState` per pointermove — the video must not re-render mid-gesture.
  startSelection: (x: number, y: number, width: number, height: number) => void;
  extend: (x: number, y: number) => void;
  clearSelection: () => void;
};

// The target and the arrow live OUTSIDE React state on purpose: the position enters by inline style
// written into the DOM by the `handle`. One `setState` per pointermove would re-render the cell (and the
// <video>) dozens of times per second — and item 11 of the acceptance forbids it.
export default function OverlayPtz({ hint, ref }: { hint: PtzHint | null; ref?: Ref<OverlayPtzHandle> }) {
  const root = useRef<HTMLDivElement>(null);
  const tail = useRef<HTMLSpanElement>(null);
  const arrow = useRef<HTMLSpanElement>(null);
  const tip = useRef<HTMLSpanElement>(null);
  const origin = useRef({ x: 0, y: 0 });
  const selection = useRef<HTMLDivElement>(null);
  const selectionOrigin = useRef({ x: 0, y: 0 });
  const circle = useRef<HTMLSpanElement>(null);
  const selectionSize = useRef({ w: 0, h: 0 });

  useImperativeHandle(ref, () => ({
    show(x, y) {
      origin.current = { x, y };
      const el = root.current;
      if (!el) return;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.display = 'block';
      if (arrow.current) arrow.current.style.display = 'none';
      if (tip.current) tip.current.style.display = 'none';
    },
    update(x, y) {
      const dx = x - origin.current.x;
      const dy = y - origin.current.y;
      const distance = Math.hypot(dx, dy);
      const length = Math.min(distance, DRAG_RADIUS);
      const visible = distance >= ARROW_THRESHOLD_PX;
      const angle = (Math.atan2(dy, dx) * 180) / Math.PI;
      if (tail.current) tail.current.style.transform = `rotate(${angle}deg)`;
      if (arrow.current) {
        arrow.current.style.width = `${length}px`;
        arrow.current.style.display = visible ? 'block' : 'none';
      }
      if (tip.current) {
        tip.current.style.left = `${length}px`;
        tip.current.style.display = visible ? 'block' : 'none';
      }
    },
    hide() {
      const el = root.current;
      if (el) el.style.display = 'none';
    },
    startSelection(x, y, width, height) {
      selectionOrigin.current = { x, y };
      selectionSize.current = { w: width, h: height };
      if (circle.current) circle.current.style.display = 'none';
      const el = selection.current;
      if (!el) return;
      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
      el.style.width = '0px';
      el.style.height = '0px';
      el.style.display = 'block';
    },
    extend(x, y) {
      const el = selection.current;
      if (!el) return;
      // Nx parity (spec 2026-10-19): the same helper that produces the payload draws the rectangle —
      // locked to the box aspect, centered on the midpoint, clamped inside it
      const o = selectionOrigin.current;
      const { w, h } = selectionSize.current;
      const r = fixedRectangle({ x0: o.x, y0: o.y, x1: x, y1: y, width: w, height: h });
      el.style.left = `${r.x0}px`;
      el.style.top = `${r.y0}px`;
      el.style.width = `${r.x1 - r.x0}px`;
      el.style.height = `${r.y1 - r.y0}px`;
      // hollow circle in the center (Nx's addEllipse): diameter = 15% of the shortest side, floor 16 px
      const c = circle.current;
      if (c) {
        const d = Math.max(16, 0.15 * Math.min(r.x1 - r.x0, r.y1 - r.y0));
        c.style.width = `${d}px`;
        c.style.height = `${d}px`;
        c.style.left = `${(r.x1 - r.x0 - d) / 2}px`;
        c.style.top = `${(r.y1 - r.y0 - d) / 2}px`;
        c.style.display = 'block';
      }
    },
    clearSelection() {
      const el = selection.current;
      if (el) el.style.display = 'none';
    },
  }), []);

  const action = hint ? ACTIONS[hint] : null;

  // The strip is a SIBLING of the overlay, not a child: the .ptz-overlay is a zero-size element at the
  // CLICK POINT, so it would be the containing block of the strip and the CSS `left/bottom: 16px` would
  // anchor it 16 px from the click, in the middle of the image. As a sibling it anchors on `.cell-quadro`
  // (position: relative).
  return (
    <>
      {/* Area selection rectangle (spec 2026-10-18): its own layer with the SAME z-index as the arrow
          overlay and without pointer. The four "L" corners sit OUTSIDE the rectangle (12 px, 2 px thick)
          and are what delimits the area over bright video — the 18% fill disappears on white. */}
      <div className="ptz-selecao" ref={selection} aria-hidden="true" style={{ display: 'none' }}>
        <span className="ptz-selecao-canto" data-canto="tl" />
        <span className="ptz-selecao-canto" data-canto="tr" />
        <span className="ptz-selecao-canto" data-canto="bl" />
        <span className="ptz-selecao-canto" data-canto="br" />
        {/* Hollow center circle (Nx's addEllipse). ponytail: the inline `display: none` is what the test
            reads before the first drag — jsdom does not apply the sheet, only the inline style. */}
        <span className="ptz-selecao-circulo" ref={circle} style={{ display: 'none' }} />
      </div>
      <div className="ptz-overlay" ref={root} aria-hidden="true" style={{ display: 'none' }}>
        <span className="ptz-alvo" />
        <span className="ptz-rasteira" ref={tail}>
          <span className="ptz-seta" ref={arrow} />
          <span className="ptz-ponta" ref={tip} />
        </span>
      </div>
      {action && (
        <div className="ptz-aviso" aria-hidden="true">
          <span className={`ptz-aviso-icone${action.circle ? ' circulo' : ''}`}>{action.icon}</span>
          <span>
            {action.text}
            <span className="ptz-pontos">
              <span className="ptz-ponto">.</span>
              <span className="ptz-ponto">.</span>
              <span className="ptz-ponto">.</span>
            </span>
          </span>
        </div>
      )}
    </>
  );
}
