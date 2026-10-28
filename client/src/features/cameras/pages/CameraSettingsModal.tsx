import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import ManufacturerModal from '../components/ManufacturerModal';
import { useEsc } from '@/shared/hooks/useEsc';
import type { PromptHandle } from '@/shared/components/PromptDialog';
import { useModalFocus } from '@/shared/hooks/useFocoModal';
import { useT } from '@/shared/i18n';

const DASH = '\u2014';

// The fetch/API error is an Error with .status glued on by hand (see api.ts), with no type of its own:
// the status comes out by narrowing, not by cast (same shape as ArchiveView/AddDeviceWizard).
const statusOf = (e: unknown): number =>
  typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number' ? e.status : 0;
const errorMessage = (e: unknown, fallback: string) => (e instanceof Error && e.message) || fallback;

// GET /cameras/:id/config — the read the modal displays (onvif/rtsp/profiles come from the server).
type Onvif = { model?: string; firmware?: string; mac?: string };
type Profile = { name: string; width?: number; height?: number };
type RecordingMode = 'continuous' | 'motion';
type Config = {
  id: string;
  name: string;
  state?: string;
  recording?: boolean;
  recording_blocked?: boolean;
  recording_mode?: RecordingMode;
  motion_sensitivity?: number;
  manufacturer?: string;
  manufacturer_source?: string;
  synced_at?: string;
  onvif?: Onvif;
  onvif_error?: string;
  addresses?: { ip: string }[];
  rtsp?: { primary?: string; secondary?: string };
  profiles?: Profile[];
};

// spec 2026-10-26 (save button): the manufacturer the operator picked/probed but did NOT save yet.
// Last action wins: a fresh probe replaces a manual pick and vice-versa (spec 4.2).
type PendingManufacturer = { source: 'manual'; name: string } | { source: 'onvif' } | null;

// What the modal uses from the HTTP client. cameraOnvifRefresh accepts the probe body (read-only
// server read); setCameraOptions is the single PATCH carrying the three draft fields (plan E2).
type Api = {
  cameraConfig(id: string): Promise<Config>;
  cameraOnvifRefresh(id: string, body?: { probe?: boolean }): Promise<Config>;
  cameraBrands(): Promise<{ name: string }[]>;
  setCameraManufacturer(id: string, name: string): Promise<Config>;
  setCameraOptions(id: string, body: { recording?: boolean; recording_mode?: RecordingMode; motion_sensitivity?: number; ativa?: boolean }): Promise<Config>;
};

type Props = {
  api: Api;
  dlg: PromptHandle;
  // plan 2026-10-27 (camera ativa): absent `ativa` = active; only `ativa === false` means inactive.
  camera: { id: string; name: string; ativa?: boolean };
  onClose: () => void;
  reStreaming?: string | null;
  canEdit?: boolean;
};

// baseline readers: the normalization the server already applies, reused for the dirty comparison
const baseRecording = (c: Config) => c.recording === true;
const baseMode = (c: Config): RecordingMode => (c.recording_mode === 'motion' ? 'motion' : 'continuous');
const baseSens = (c: Config) => (Number.isInteger(c.motion_sensitivity) ? c.motion_sensitivity! : 5);

// General tab since spec 2026-10-19; draft/save cycle since spec 2026-10-26 (save button):
// NOTHING persists on change — the switch, select and slider edit the draft, and "Save" writes.
export default function CameraSettingsModal({ api, dlg, camera, onClose, reStreaming = null, canEdit = false }: Props) {
  const { t } = useT();
  const [config, setConfig] = useState<Config | null>(null); // the BASELINE: last authoritative read
  useEsc(() => requestClose());
  const dialogRef = useRef<HTMLDivElement>(null);
  useModalFocus(dialogRef);
  const [error, setError] = useState<string | null>(null);
  const [onvifError, setOnvifError] = useState<string | null>(null);
  const [searching, setSearching] = useState(false);
  // the DRAFT (spec 4.2): seeded from the baseline once per camera, edited freely, never sent until Save
  const [recording, setRecording] = useState(false);
  const [mode, setMode] = useState<RecordingMode>('continuous');
  const [sensitivity, setSensitivity] = useState(5);
  // draft + baseline of the ativa flag (plan 2026-10-27): the camera prop seeds both; a PATCH the
  // server confirms moves the baseline to the saved draft (same save/re-seed cycle as the three fields)
  const [ativa, setAtiva] = useState(camera.ativa !== false);
  const ativaBase = useRef(camera.ativa !== false);
  const [pending, setPending] = useState<PendingManufacturer>(null);
  const [probeView, setProbeView] = useState<Config | null>(null); // display-only payload from probe:true
  const [saving, setSaving] = useState(false);
  const [recordingError, setRecordingError] = useState<string | null>(null);
  const [manufacturerOpen, setManufacturerOpen] = useState(false);
  const [copied, setCopied] = useState<string | null>(null); // 'uuid' | 're-streaming' | null

  useEffect(() => {
    let alive = true;
    api.cameraConfig(camera.id)
      .then((c: Config) => { if (alive) setConfig(c); })
      .catch((e: unknown) => { if (!alive) return;
        if (statusOf(e) === 404) { onClose(); return; } // camera deleted while the modal was opening
        setError(errorMessage(e, t('cameras.settings.load_failed'))); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, camera.id]);

  // The draft mirrors the read ONCE per camera, when the read arrives. The App re-reads the config
  // every 5 s (a new object per response): without this guard the effect re-seeded the draft and
  // threw away the operator edits — a defect already measured in this repo with the recording form.
  const seededFor = useRef<string | null>(null);
  const seedFrom = (c: Config) => {
    setRecording(baseRecording(c)); setMode(baseMode(c)); setSensitivity(baseSens(c));
  };
  // useLayoutEffect (not useEffect) on purpose: passive effects flush on a scheduler task AFTER the
  // commit that shows the loaded config. A click landing in that window had its setRecording(true)
  // overwritten by the still-pending seed (measured as a test flake at ~1/5). Layout effects flush
  // inside the commit, so the draft is seeded before the switch is clickable.
  useLayoutEffect(() => {
    if (!config || seededFor.current === camera.id) return;
    seededFor.current = camera.id;
    seedFrom(config);
  }, [config, camera.id]);

  const fieldsDirty = config !== null
    && (ativa !== ativaBase.current || recording !== baseRecording(config) || mode !== baseMode(config) || sensitivity !== baseSens(config));
  const dirty = fieldsDirty || pending !== null;

  // spec 4.4: at most one PATCH and one manufacturer write, stopping at the FIRST failure; whatever the
  // outcome the config is re-read and becomes the baseline (plan E3). The draft keeps only what was
  // NOT written: a PATCH failure leaves the three fields pending (manufacturer not attempted); a
  // manufacturer failure after a saved PATCH leaves only the manufacturer pending.
  const saveAll = async () => {
    setSaving(true); setRecordingError(null);
    let failed = false;
    let fieldsSaved = false;
    let manufacturerSaved = false;
    try {
      if (config && fieldsDirty) {
        try {
          await api.setCameraOptions(camera.id, { recording, recording_mode: mode, motion_sensitivity: sensitivity, ativa });
          fieldsSaved = true;
        } catch (e) {
          failed = true;
          setRecordingError(statusOf(e) === 409
            ? errorMessage(e, t('cameras.settings.disk_limit_error'))
            : t('cameras.settings.save_failed'));
        }
      }
      if (!failed && pending?.source === 'manual') {
        try { await api.setCameraManufacturer(camera.id, pending.name); manufacturerSaved = true; }
        catch { failed = true; setRecordingError(t('cameras.settings.save_failed')); }
      } else if (!failed && pending?.source === 'onvif') {
        try { await api.cameraOnvifRefresh(camera.id); manufacturerSaved = true; }
        catch { failed = true; setRecordingError(t('cameras.settings.save_failed')); }
      }
    } finally {
      try {
        const fresh = await api.cameraConfig(camera.id);
        setConfig(fresh); setProbeView(null);
        if (fieldsSaved || !fieldsDirty) seedFrom(fresh); // only the fields the server confirmed
        if (fieldsSaved) ativaBase.current = ativa;       // the PATCH also carried ativa (plan 4.1)
        if (manufacturerSaved) setPending(null);
      } catch { /* keep the old baseline; the error shown above stands */ }
      setSaving(false);
    }
  };

  // CTA: probes the device READ-ONLY (probe:true, server Task 1.1). The result fills the screen and
  // stays pending until Save. On failure it opens the manual choice (never invents a brand).
  const reportManufacturer = async () => {
    setSearching(true); setOnvifError(null);
    try {
      const cfg: Config = await api.cameraOnvifRefresh(camera.id, { probe: true });
      if (cfg.onvif_error) { setOnvifError(cfg.onvif_error); setManufacturerOpen(true); }
      else { setProbeView(cfg); setPending({ source: 'onvif' }); }
    } catch (e) {
      setOnvifError(errorMessage(e, t('errors.action_failed'))); setManufacturerOpen(true);
    } finally { setSearching(false); }
  };

  // what the rows display: baseline, overlaid by the probe read, overlaid by a later manual pick
  const view = pending?.source === 'manual' && (probeView || config)
    ? { ...(probeView ?? config!), manufacturer: pending.name, manufacturer_source: 'manual' }
    : (probeView ?? config);
  const onvif = view && view.onvif;
  const configValue = (v: ReactNode) => (view ? (v || DASH) : t('cameras.settings.loading'));
  const manufacturer = view && view.manufacturer
    ? view.manufacturer + (view.manufacturer_source === 'manual' ? ' (reported manually)'
      : view.synced_at ? ` (ONVIF on ${view.synced_at.slice(0, 10)})` : '')
    : null;
  const manufacturerText = manufacturer
    ? manufacturer + (pending ? ` \u00b7 ${t('cameras.settings.pending_badge')}` : '')
    : null;

  // the clipboard API requires a secure context; on internal HTTP it falls back to execCommand
  const copy = async (text: string, field: string) => {
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea');
      ta.value = text; document.body.appendChild(ta); ta.select();
      document.execCommand('copy'); ta.remove();
    }
    setCopied(field);
    // functional and per field: copying the other field before the 1.5 s does not erase the first check
    setTimeout(() => setCopied((c) => (c === field ? null : c)), 1500);
  };

  const rows: Array<[string, ReactNode]> = [
    [t('cameras.settings.name'), view ? view.name : DASH],
    [t('cameras.settings.uuid'), view ? (
      <span className="nx-uuid">
        {view.id}
        <button className="nx-copiar" onClick={() => copy(view.id, 'uuid')} title={t('cameras.settings.copy')} aria-label={t('cameras.settings.copy_uuid')}>{copied === 'uuid' ? '\u2713' : '\u29c9'}</button>
      </span>
    ) : DASH],
    ['Manufacturer', configValue(manufacturerText)],
    [t('cameras.discovery.model'), configValue(onvif && onvif.model)],
    ['Firmware', configValue(onvif && onvif.firmware)],
    ['State', view ? view.state : DASH],
    [t('cameras.settings.ip_address'), view && view.addresses && view.addresses[0] ? view.addresses[0].ip : DASH],
    ['MAC', configValue(onvif && onvif.mac)],
    [t('cameras.settings.rtsp_primary'), configValue(view && view.rtsp && view.rtsp.primary)],
    [t('cameras.settings.rtsp_secondary'), configValue(view && view.rtsp && view.rtsp.secondary)],
    [t('cameras.settings.profiles'), view && view.profiles && view.profiles.length
      ? view.profiles.map((p) => `${p.name}: ${p.width && p.height ? `${p.width}x${p.height}` : 'no resolution'}`).join(', ')
      : view ? DASH : t('cameras.settings.loading')],
  ];
  // last row, and only with re-streaming enabled on the server: the App decides that, passing null
  // when /api/v1/rtsp answers enabled:false (spec 2026-10-15, section 4.1)
  if (reStreaming) rows.push(['Re-streaming', (
    <span className="nx-uuid">
      {reStreaming}
      <button className="nx-copiar" onClick={() => copy(reStreaming, 're-streaming')}
        title={t('cameras.settings.copy')} aria-label={t('cameras.settings.copy_restream_url')}>{copied === 're-streaming' ? '\u2713' : '\u29c9'}</button>
    </span>
  )]);

  // spec 2026-10-27: closing with a draft opens the system's confirm dialog (App's PromptDialog, mounted
  // later in the tree so it stacks on top; useEsc routes ESC to the top dialog only). Cancel/ESC/✕ on
  // the confirm resolve false and keep the draft; Discard resolves true and closes.
  async function requestClose() {
    if (dirty) {
      const go = await dlg.confirm(t('cameras.settings.unsaved_title'), [t('cameras.settings.unsaved_warning')],
        { danger: true, text: t('cameras.settings.discard') });
      if (!go) return;
    }
    onClose();
  }

  return (
    <div className="nx-backdrop">
      <div className="nx-dialog" role="dialog" aria-modal="true" aria-labelledby="cfg-title" ref={dialogRef}>
        <div className="nx-titlebar">
          <span className="nx-title" id="cfg-title">{t('cameras.settings.title', { name: camera.name })}</span>
          {/* spec 2026-10-27 (modal-header-ativa v4): the active switch lives in the titlebar, right
              side, before the close button. Guarded by `config`: the title renders before the fetch,
              so the switch must not show a wrong state while the config is still loading. */}
          {config && (
            <label className="nx-check">
              <input type="checkbox" className="nx-switch" checked={ativa}
                disabled={!canEdit || saving}
                onChange={(e) => setAtiva(e.target.checked)}
                title={t('cameras.settings.camera_active')}
                aria-label={t('cameras.settings.camera_active')} />
              <span>{ativa ? t('cameras.settings.camera_active_on') : t('cameras.settings.camera_active_off')}</span>
            </label>
          )}
          <button className="nx-close" onClick={requestClose} title={t('shared.close')}>✕</button>
        </div>
        <div className="nx-body">
          {error && <p className="nx-err">{error}</p>}
          {onvifError && <p className="nx-aviso">ONVIF: {onvifError}</p>}
          {/* spec 2026-10-27 (modal-header-ativa v4): titlebar = title + active switch at the right,
              before the close button. Line 1 here = recording switch at the left, "Set manufacturer"
              at the right via .spacer-left; line 2 (nx-linha-opcoes) below is unchanged. Handlers,
              disabled rules and states are exactly the previous version's. */}
          {config && (
            <div className="nx-cta-linha nx-linha-ativa">
              <label className="nx-check">
                <input type="checkbox" className="nx-switch" checked={recording}
                  disabled={!canEdit || saving || config.recording_blocked === true || !ativa}
                  onChange={(e) => setRecording(e.target.checked)} />
                <span>{recording ? t('cameras.settings.recording_on') : t('cameras.settings.recording_off')}</span>
              </label>
              <button className="nx-btn spacer-left" disabled={searching} onClick={reportManufacturer}>
                {searching ? t('cameras.settings.searching') : t('cameras.settings.report_manufacturer')}
              </button>
            </div>
          )}
          {/* plan 2026-10-26: the recording type exists only with recording ON (prototype v2);
              sensitivity stays tied to `mode === 'motion'`. Both read the draft, nothing PATCHes here. */}
          {config && recording === true && (
            <div className="nx-cta-linha nx-linha-opcoes">
              <label className="nx-check">
                <span id="cfg-modo">{t('cameras.settings.recording_mode')}</span>
                <select className="nx-input nx-largura-auto" value={mode}
                  aria-label={t('cameras.settings.recording_mode')}
                  disabled={!canEdit || saving || !ativa}
                  onChange={(e) => setMode(e.target.value as RecordingMode)}>
                  <option value="continuous">{t('cameras.settings.recording_mode_continuous')}</option>
                  <option value="motion">{t('cameras.settings.recording_mode_motion')}</option>
                </select>
              </label>
              {mode === 'motion' && (
                <label className="nx-check">
                  <span>{t('cameras.settings.motion_sensitivity')} {sensitivity}</span>
                  <input type="range" min={1} max={9} step={1} value={sensitivity}
                    aria-label={t('cameras.settings.motion_sensitivity')}
                    disabled={!canEdit || saving || !ativa}
                    onChange={(e) => setSensitivity(Number(e.target.value))} />
                </label>
              )}
            </div>
          )}
          {config && recording === true && mode === 'motion' && (
            <p className="nx-aviso">{t('cameras.settings.motion_pre_post')}</p>
          )}
          {config?.recording_blocked === true && (
            <p className="nx-aviso">{t('cameras.settings.disk_warning')}</p>
          )}
          {recordingError && <p className="nx-err">{recordingError}</p>}
          <dl className="nx-cfg">
            {rows.map(([label, value]) => (
              <div key={label} style={{ display: 'contents' }}>
                <dt>{label}</dt><dd>{value}</dd>
              </div>
            ))}
          </dl>
          <div className="nx-actions">
            <button className="nx-btn" onClick={requestClose}>{t('cameras.settings.close')}</button>
            <button className="nx-btn" disabled={!dirty || saving || !canEdit} onClick={saveAll}>
              {saving ? t('shared.saving') : t('cameras.settings.save')}
            </button>
          </div>
        </div>
      </div>
      {manufacturerOpen && (
        <ManufacturerModal api={api} camera={camera}
          onClose={() => setManufacturerOpen(false)}
          onSelect={(name) => { setPending({ source: 'manual', name }); setProbeView(null); setManufacturerOpen(false); }} />
      )}
    </div>
  );
}
