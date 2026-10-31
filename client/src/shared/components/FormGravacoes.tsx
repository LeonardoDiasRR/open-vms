import type { CSSProperties } from 'react';
import { useT } from '@/shared/i18n';
import type { Settings } from '@/shared/utils/api';

// FormGravacoes (spec 2026-10-19 onboarding §5.4/D5, AMENDMENT E2; spec 2026-10-19 read-only root
// folder; spec 2026-10-20 §7): the PRESENTATIONAL body of the Recordings tab — read-only root folder
// with tooltip, retention and slider with chip. No state, no fetch, no button: the parent applies it
// (the tab persists on Save; the wizard sends everything on Finish). The root is not editable through
// the UI: it comes from `recordings.archive_dir` in config.yaml (see the field tooltip).
export type RecordingsValue = { s: Settings; days: string; pct: number };

export default function FormGravacoes({ value, busy, onDays, onPercent }: {
  value: RecordingsValue; busy: boolean;
  onDays: (v: string) => void; onPercent: (v: number) => void;
}) {
  const { t } = useT();
  const { s, days, pct } = value;
  const usage = s.disk.used_percent === null ? '—' : `${s.disk.used_percent}%`;
  return (
    <>
      <div className="nx-field">
        <span className="nx-label">{t('admin.recordings.root_folder')}
          <span className="nx-help" tabIndex={0} title={t('admin.recordings.root_folder_help')}
            aria-label={t('admin.recordings.change_dir_help')}>?</span>
        </span>
        <code className="nx-readonly">{s.archive_dir_effective}</code>
      </div>
      <div className="nx-port-row">
        <label className="nx-field">
          <span className="nx-label">{t('admin.recordings.retention')}</span>
          <input className="nx-input nx-port" type="number" min="1" step="1" inputMode="numeric"
            value={days} disabled={busy} onChange={(e) => onDays(e.target.value)} />
        </label>
        <span className="nx-label">{t('admin.recordings.days')}</span>
      </div>
      <div className="nx-field nx-disco-field">
        <span className="nx-label">{t('admin.recordings.disk_limit')}</span>
        <div className="nx-slider-wrap" style={{ '--pct': pct } as CSSProperties}>
          <span className="nx-slider-chip">{pct}%</span>
          <input type="range" min={1} max={100} value={pct} disabled={busy}
            onChange={(e) => onPercent(Number(e.target.value))} />
        </div>
        <span className="nx-desc">{t('admin.recordings.disk_limit_hint')}</span>
      </div>
      {s.disk.limited && (
        <p className="nx-aviso">{t('admin.recordings.disk_warning', { used: usage, max: s.disk_max_percent })}</p>
      )}
    </>
  );
}
