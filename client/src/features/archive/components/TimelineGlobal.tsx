// A shared temporal viewport for all camera tracks. Only explicit pointer seeks update playback.
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent } from 'react';
import type { Segment } from '../services/faixas';
import { clipSegment, fullDay, normalizeWheelDelta, rulerMarks, timeAt, timeFraction, zoomViewport } from '../services/timeline-viewport';
import { useT } from '@/shared/i18n';

export type Props = {
  midnight: number;
  cameras: { id: string; name: string }[];
  coverage: Record<string, Segment[]>;
  instant: number;
  onSeek: (t: number) => void;
  selected?: string | null;   // id of the camera marked in the video wall (spec 2026-10-19, D5): border on the track
};

export default function TimelineGlobal({ midnight, cameras, coverage, instant, onSeek, selected = null }: Props) {
  const { t } = useT();
  const root = useRef<HTMLDivElement>(null);
  const ref = useRef<HTMLDivElement>(null);
  const tracks = useRef<HTMLDivElement>(null);
  const dragging = useRef<number | null>(null);
  const [window, setWindow] = useState(() => ({ midnight, view: fullDay(midnight) }));
  const [geometry, setGeometry] = useState({ width: 1000, scrollbar: 0 });
  const view = window.midnight === midnight ? window.view : fullDay(midnight);
  const marks = useMemo(() => rulerMarks(view, midnight, geometry.width), [view, midnight, geometry.width]);
  const pct = (ts: number) => `${timeFraction(ts, view) * 100}%`;

  useEffect(() => {
    dragging.current = null;
    setWindow(current => current.midnight === midnight ? current : { midnight, view: fullDay(midnight) });
  }, [midnight]);

  useLayoutEffect(() => {
    function measure() {
      if (!tracks.current || !ref.current) return;
      const scrollbar = Math.max(0, tracks.current.offsetWidth - tracks.current.clientWidth);
      const bar = tracks.current.querySelector('.trackbar');
      const width = bar?.getBoundingClientRect().width || ref.current.getBoundingClientRect().width;
      setGeometry(current => {
        const next = { width: width || current.width, scrollbar };
        return next.width === current.width && next.scrollbar === current.scrollbar ? current : next;
      });
    }
    measure();
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (root.current) observer?.observe(root.current);
    if (tracks.current) observer?.observe(tracks.current);
    const bar = tracks.current?.querySelector('.trackbar');
    if (bar) observer?.observe(bar);
    globalThis.window.addEventListener('resize', measure);
    return () => { observer?.disconnect(); globalThis.window.removeEventListener('resize', measure); };
  }, [cameras.length]);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    function wheel(event: WheelEvent) {
      if (event.ctrlKey || event.metaKey || dragging.current !== null || !Number.isFinite(event.deltaY) || !event.deltaY) return;
      if (!(event.target instanceof Element) || !event.target.closest('.regua, .trackbar, .tl-hit')) return;
      const rect = ref.current?.getBoundingClientRect();
      if (!rect?.width) return;
      const fraction = (event.clientX - rect.left) / rect.width;
      if (fraction < 0 || fraction > 1) return;
      const delta = normalizeWheelDelta(event.deltaY, event.deltaMode, Math.max(1, rect.height));
      event.preventDefault();
      setWindow(current => {
        const before = current.midnight === midnight ? current.view : fullDay(midnight);
        const next = zoomViewport(before, midnight, fraction, delta);
        return next === before && current.midnight === midnight ? current : { midnight, view: next };
      });
    }
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [midnight]);

  function seek(e: PointerEvent<HTMLDivElement>) {
    if (!ref.current) return;
    const r = ref.current.getBoundingClientRect();
    if (r.width === 0) return; // ponytail: jsdom returns a zeroed rect; never divide by 0
    const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    onSeek(Math.round(timeAt(f, view)));
  }

  function endDrag(e: PointerEvent<HTMLDivElement>) {
    dragging.current = null;
    if (e.currentTarget.hasPointerCapture?.(e.pointerId)) e.currentTarget.releasePointerCapture?.(e.pointerId);
  }

  return (
    <div className="timeline-global" ref={root}
      data-visible-start={view.start} data-visible-end={view.end}
      style={{ '--tl-scrollbar': `${geometry.scrollbar}px` } as CSSProperties}>
      <div className="tl-conteudo">
        <div className="regua">
          {marks.map(mark => {
            const x = timeFraction(mark.time, view) * geometry.width;
            const edge = x < 32 ? 'start' : geometry.width - x < 32 ? 'end' : undefined;
            return <span key={mark.time} className="marca" data-edge={edge} style={{ left: pct(mark.time) }}>
              {mark.label}
            </span>;
          })}
        </div>
        <div className="trilhas" ref={tracks}>
          {cameras.map((c) => (
            <div key={c.id} className={`trilha${c.id === selected ? ' selecionada' : ''}`} data-camera={c.id}>
              <span className="nome">{c.name}</span>
              <div className="trackbar">
                {(coverage[c.id] ?? []).map((s) => {
                  const clipped = clipSegment(s, view);
                  return clipped && <div
                    key={s.start_ts}
                    className="barra"
                    style={{ left: pct(clipped.start_ts), width: `${((clipped.end_ts - clipped.start_ts) / (view.end - view.start)) * 100}%` }}
                  />;
                })}
              </div>
            </div>
          ))}
        </div>
        <div
          className="tl-hit"
          ref={ref}
          title={t('archive.select_time')}
          // ponytail: jsdom does not implement pointer capture; ?. neither divides by zero nor blows up in a test
          onPointerDown={(e) => {
            if (e.button !== 0) return;
            dragging.current = e.pointerId;
            seek(e); e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => { if (dragging.current === e.pointerId) seek(e); }}
          onPointerUp={endDrag} onPointerCancel={endDrag} onLostPointerCapture={() => { dragging.current = null; }}
        >
          {instant >= view.start && instant <= view.end && <div className="playhead" style={{ left: pct(instant) }} />}
        </div>
      </div>
    </div>
  );
}
