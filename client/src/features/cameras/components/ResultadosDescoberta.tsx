import { Fragment } from 'react';
import type { ReactNode } from 'react';
import type { Channel, Discovery } from '@/shared/utils/api';
import EmptyState from '@/shared/components/EstadoVazio';
import { useT } from '@/shared/i18n';
import { HIDDEN_PORT, isAdded, isCameraIneligible } from '../services/addDevice';

// The results window of the search: the table of what the CURRENT scan found and the empty state
// while there is nothing. It has no state of its own — the owner (AddDeviceWizard) passes
// results/selected/row and receives the marks through onSelect.

// Channel checklist state of ONE candidate (the owner is AddDeviceWizard, as with `row`).
export type ChannelState = { loading?: boolean; error?: string; list?: Channel[]; marked: number[] };

// Situation of a table row; it is not state, it is what the adder wrote for the discovery.
type RowState = { state: 'adding' | 'ok' | 'error'; message?: string };

type Props = {
  results: Discovery[];
  selected: Record<string, boolean>;
  onSelect: (selected: Record<string, boolean>) => void;
  rows: Record<string, RowState>;
  busy: boolean;
  scanning: boolean;
  job: { found?: number } | null;
  channels?: Record<string, ChannelState>;
  canOpenChannels?: boolean;
  onOpenChannels?: (r: Discovery) => void;
  onToggleChannel?: (id: string, channel: number, marked: boolean) => void;
};

// spec 2026-10-16: the status comes from the server GATE (it is not a UI heuristic). Without a status
// the cell stays empty — a candidate recorded before the gate does not invent a label.
export default function DiscoveryResults({ results, selected, onSelect, rows, busy, scanning, job, channels, canOpenChannels, onOpenChannels, onToggleChannel }: Props) {
  const { t, tn } = useT();
  // The protocol labels are proper nouns and stay literal; the two credential reasons come from the
  // dictionary. The keys are the server's WIRE values (server/lib/camera-gate.js): the pt names died in
  // the 2026-10-19 nomenclature migration, and a stale key left the STATUS cell empty.
  const statusLabel: Record<string, string> = {
    verified: 'ONVIF',
    credential_required: t('cameras.discovery.credentials_required'),
    invalid_credential: t('cameras.discovery.credentials_invalid'),
    rtsp: 'RTSP',
  };
  const notAdded = results.filter((r) => !isAdded(r));
  // ineligible ones (the gate proved they cannot work) enter no selection, not even the header one
  const eligible = notAdded.filter((r) => !isCameraIneligible(r.status));
  const rowLabel = (id: string): ReactNode => {
    const row = rows[id];
    if (!row) return '';
    // M2: error is always icon + text (never the color alone)
    if (row.state === 'error') return <span className="nx-erro">✕ error: {row.message}</span>;
    return row.state;
  };
  return (
    <div className="nx-results">
      {results.length ? (
        <table className="nx-table">
          <thead>
            <tr>
              <th>{t('cameras.discovery.address_column')}</th>
              <th>{t('cameras.discovery.model')}</th>
              <th>{t('cameras.discovery.status')}</th>
              <th className="nx-col-situacao">{tn('cameras.discovery.device_count', results.length)}, {tn('cameras.discovery.new_count', notAdded.length)}</th>
              <th className="nx-col-sel">
                <input type="checkbox" aria-label={t('cameras.discovery.select_all')} disabled={!eligible.length}
                  checked={!!eligible.length && eligible.every((r) => selected[r.id])}
                  onChange={(e) => onSelect(e.target.checked ? Object.fromEntries(eligible.map((r): [string, boolean] => [r.id, true])) : {})} />
              </th>
            </tr>
          </thead>
          <tbody>
            {results.map((r) => {
              const added = isAdded(r);
              const ineligible = isCameraIneligible(r.status);
              return (
                <Fragment key={r.id}>
                <tr className={added ? 'nx-row-added' : undefined}>
                  <td>
                    {canOpenChannels && !added && (r.videoSources ?? 0) >= 2 && (
                      <button type="button" className="nx-canais-toggle"
                        // missing key: cameras.discovery.channels_of ({ip})
                        aria-label={`Channels of ${r.ip}`}
                        title={`Channels of ${r.ip}`} aria-expanded={!!channels?.[r.id]?.list}
                        onClick={() => onOpenChannels?.(r)}>
                        {channels?.[r.id]?.loading ? '…' : (channels?.[r.id]?.list ? '▾' : '▸')}
                      </button>
                    )}
                    {r.ip}:{(r.openPorts || [])[0] || HIDDEN_PORT}
                  </td>
                  <td>{[r.manufacturer, r.model].filter(Boolean).join(' ') || r.name || HIDDEN_PORT}</td>
                  <td>{statusLabel[r.status ?? ''] || ''}</td>
                  {/* missing key: cameras.discovery.added */}
                  <td className="nx-col-situacao">{added ? '✓ Added' : rowLabel(r.id)}</td>
                  <td className="nx-col-sel">
                    <input type="checkbox" checked={!!selected[r.id]} disabled={added || busy || ineligible}
                      // missing key: cameras.discovery.select_one ({ip})
                      aria-label={`Select ${r.ip}`}
                      onChange={(e) => onSelect({ ...selected, [r.id]: e.target.checked })} />
                  </td>
                </tr>
                {channels?.[r.id]?.list && (
                  <tr key={`${r.id}-channels`} className="nx-canais">
                    <td colSpan={5}>
                      {channels[r.id].error && <p className="nx-erro">✕ {channels[r.id].error}</p>}
                      <ul className="nx-canais-lista">
                        {channels[r.id].list!.map((c) => (
                          <li key={c.channel}>
                            <label>
                              <input type="checkbox" checked={channels[r.id].marked.includes(c.channel)}
                                onChange={(e) => onToggleChannel?.(r.id, c.channel, e.target.checked)} />
                              {t('cameras.discovery.channel')} {c.channel}
                            </label>
                            {/* missing key: cameras.discovery.no_stream */}
                            {!c.has_stream && <span className="nx-canais-aviso">no stream</span>}
                          </li>
                        ))}
                      </ul>
                    </td>
                  </tr>
                )}
                </Fragment>
              );
            })}
          </tbody>
        </table>
      ) : (
        <EmptyState className="nx-empty" message={scanning ? t('cameras.discovery.scanning_hint') : (!job ? t('cameras.discovery.hint') : (job.found === 0 ? t('cameras.discovery.no_response') : t('cameras.discovery.none')))}
          icon={
            <svg viewBox="0 0 64 48" fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" aria-hidden="true">
              <path d="M8 16h30a4 4 0 0 1 4 4v20H8z" />
              <rect x="42" y="14" width="14" height="8" rx="2" />
              <circle cx="23" cy="30" r="7" /><circle cx="23" cy="30" r="3" />
            </svg>
          } />
      )}
    </div>
  );
}
