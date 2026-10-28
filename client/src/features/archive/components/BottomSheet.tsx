import TimelineGlobal from './TimelineGlobal';
import { SPEEDS } from './PlayerGravacao';
import type { GlobalClock } from '../hooks/useRelogioGlobal';
import type { Segment } from '../services/faixas';
import { useT } from '@/shared/i18n';

// spec 2026-10-19 (recording-sheet-datepicker): row 1 = commands on the left, clock in the centre,
// date picker on the right (D1). Expanded = only the 24 h timeline; the monthly calendar is dead
// (D2); changing the day only happens through the date picker or by dragging the timeline (D3).
// `selected` is the camera of the cell marked in the video wall: its track gets a border (D5). No
// other control lives here (D2).

type Props = {
  clock: GlobalClock;
  open: boolean;
  onToggleOpen: () => void;
  day: number;                          // epoch of the local 00:00 of the displayed day
  onDay: (midnight: number) => void;
  cameras: { id: string; name: string }[];
  coverage: Record<string, Segment[]>;
  selected?: string | null;             // id of the camera selected on the stage (spec 2026-10-19, D5)
  onExport?: () => void;                // spec 2026-10-19 (video-export): open the export modal
};

const hms = (ts: number) => new Date(ts * 1000).toTimeString().slice(0, 8);

// LOCAL date in YYYY-MM-DD. Never toISOString(): at UTC-04, between 20:00 and 23:59 local the UTC
// date is already the next day (spec 4.1).
const formatDate = (ep: number) => {
  const d = new Date(ep * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function BottomSheet({ clock, open, onToggleOpen, day, onDay, cameras, coverage, selected = null, onExport }: Props) {
  const { t } = useT();
  return (
    <div className={`sheet${open ? ' sheet-aberto' : ''}`}>
      {/* spec 2026-10-19 (sheet-arrow-strip): the strip replaces the row-1 button (F1); a single
          arrow, rotated by CSS in the open state (F2). */}
      <div className="sheet-faixa" role="button" tabIndex={0}
        aria-label={open ? t('archive.close_options') : t('archive.more_options')}
        onClick={onToggleOpen}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onToggleOpen(); } }}>
        <svg viewBox="0 0 24 12" aria-hidden="true"><path d="M3 9 L12 3 L21 9" /></svg>
      </div>
      <div className="sheet-linha">
        <div className="sheet-acoes">
          <button type="button" aria-label={clock.playing ? t('archive.pause') : t('archive.play')} title={clock.playing ? t('archive.pause') : t('archive.play')} onClick={clock.toggle}>
            {clock.playing ? '❚❚' : '▶'}
          </button>
          {SPEEDS.map((v) => (
            <button key={v} type="button" aria-pressed={clock.speed === v}
              title={`${t('archive.speed')} ${v}×`} onClick={() => clock.setSpeed(v)}>{v}×</button>
          ))}
        </div>
        <span className="sheet-relogio">{hms(clock.instant)}</span>
        <input type="date" value={formatDate(day)} onChange={(e) => {
          const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(e.target.value);
          if (!m) return;                       // empty or off-format: keeps the current day (spec 4.1)
          onDay(Math.floor(new Date(+m[1], +m[2] - 1, +m[3], 0, 0, 0, 0).getTime() / 1000));
        }} />
        {/* spec 2026-10-19 (video-export, section 4): Export to the right of the calendar (literal
            request). The sheet stays DUMB: it only notifies the owner; it opens no modal and knows
            nothing about export. Task 4.5: no handler => no button (viewer without camera.manage). */}
        {onExport && <button type="button" onClick={onExport}>{t('archive.export')}</button>}
      </div>
      {open && (
        <TimelineGlobal midnight={day} cameras={cameras} coverage={coverage}
          instant={clock.instant} onSeek={clock.seek} selected={selected} />
      )}
    </div>
  );
}
