import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import DiscoveryResults from '../components/ResultadosDescoberta';
import { EXAMPLES, HIDDEN_PORT, defaultChannels, deviceBody, expandRange, isAdded, isCameraIneligible, invalidOctets, maskIp, parseAddress, resultsForScan, subnetEnd } from '../services/addDevice';
import type { ApiClient } from '@/shared/utils/api';
import type { Channel, DeviceChannels, Discovery } from '@/shared/utils/api';
import type { ChannelState } from '../components/ResultadosDescoberta';
import { useEsc } from '@/shared/hooks/useEsc';
import { useModalFocus } from '@/shared/hooks/useFocoModal';
import { useT } from '@/shared/i18n';
import { InputSenha } from '@/shared/ui/input-senha';

// The fetch/API error is an Error with .status glued on by hand (see api.ts), with no type of its own:
// the status comes out by narrowing, not by cast (same shape as LoginPage).
function errorMessage(e: unknown, fallback: string) {
  const status = typeof e === 'object' && e !== null && 'status' in e ? Number(e.status) : 0;
  const message = e instanceof Error ? e.message : '';
  return status ? `${status}: ${message}` : (message || fallback);
}

type TabId = 'known' | 'subnet';

// Form fields and the typed credential (the password lives only in the state; the server seals it in
// the vault).
type Fields = { address: string; port: string; useDefault: boolean; start: string; end: string };
type Credentials = { login: string; password: string };
// Asynchronous scan state: the poll swaps the object on every tick (and restarts the effect timer).
type ScanJob = { id: string; state: string; error?: string; found?: number };
type RowState = { state: 'adding' | 'ok' | 'error'; message?: string };
// Body of POST /api/v1/discovery/scan.
type ScanBody = { kind: 'scan'; scope: { ips: string[]; ports?: number[] }; credential?: { username: string; password: string } };

// The wizard uses only these five methods of the api.
type Api = Pick<ApiClient, 'startScan' | 'scanStatus' | 'discoveryResults' | 'addCamera' | 'deviceChannels'>;

type Props = { api: Api; onClose: () => void };

// ponytail: the password lives only in the component state (the server seals it in the vault); never
// in localStorage
export default function AddDeviceWizard({ api, onClose }: Props) {
  const { t, tn } = useT();
  const [tab, setTab] = useState<TabId>('known');
  const dialogRef = useRef<HTMLDivElement>(null);
  // the focus belongs to the modal: the X and ESC already close it (wave 2); here it enters, cycles
  // and comes back
  useModalFocus(dialogRef);
  useEsc(onClose);
  const [showExamples, setShowExamples] = useState(false);
  const [fields, setFields] = useState<Fields>({ address: '', port: '554', useDefault: true, start: '0.0.0.0', end: '0.0.0.254' });
  const [credentials, setCredentials] = useState<Credentials>({ login: '', password: '' });
  const [job, setJob] = useState<ScanJob | null>(null);
  // ponytail: only the CURRENT scan fills the table; the server catalog is never listed raw
  const [scanId, setScanId] = useState<string | null>(null);
  // review round 3: the scan that OWNS the table. The results write lands only while the id it was
  // fetched for is still the current scan: the final response of scan A arriving after scan B started
  // is stale and must not show/select A's devices inside B (effect cleanup cannot guard this — the
  // fetch outlives the effect that started it)
  const scanOwner = useRef<string | null>(null);
  // review final (F1): duas requests do MESMO scan ainda competem — quem escreve e a ordem de
  // EMISSAO (seq crescente, carimbada no inicio do fetch): o snapshot 'running' emitido antes que
  // volta depois do snapshot final nao pode apagar a tabela (last-writer-wins por emissao)
  const resultsSeq = useRef(0);
  const [results, setResults] = useState<Discovery[]>([]);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<{ ok: number; fail: number } | null>(null);
  const [busy, setBusy] = useState(false);
  // Channel checklist per candidate (spec decision 4). The wizard owns the state; the results
  // component only draws it.
  const [channels, setChannels] = useState<Record<string, ChannelState>>({});

  const updateField = (k: 'address' | 'port') => (e: ChangeEvent<HTMLInputElement>) => setFields((c) => ({ ...c, [k]: e.target.value }));
  const updateCredential = (k: 'login' | 'password') => (e: ChangeEvent<HTMLInputElement>) => setCredentials((c) => ({ ...c, [k]: e.target.value }));
  // ponytail: masks 999.999.999.999 in both IP fields; only the first IP derives the last one (.254 of
  // the SAME network)
  const updateIp = (k: 'start' | 'end') => (e: ChangeEvent<HTMLInputElement>) => {
    const value = maskIp(e.target.value);
    const end = k === 'start' ? subnetEnd(value) : null;
    setFields((c) => ({ ...c, [k]: value, ...(end ? { end } : {}) }));
  };
  const invalidStartOctets = invalidOctets(fields.start);
  const invalidEndOctets = invalidOctets(fields.end);
  const scanning = job?.state === 'running';
  const notAdded = results.filter((r) => !isAdded(r));
  const selectedCandidates = results.filter((r) => selected[r.id] && !isAdded(r) && !isCameraIneligible(r.status));
  // Multi-channel with the list open and ZERO channel marked cannot go: `channels: []` would fall into
  // the single-camera path (the defect again) — the button locks and says why in the title
  const noChannelSelected = selectedCandidates.some((r) => channels[r.id]?.list && (channels[r.id]?.marked.length ?? 0) === 0);

  // ponytail: the server keeps EVERY discovery of the instance; the table shows only the current scan
  const loadResults = async (id: string | null) => {
    const seq = ++resultsSeq.current;
    const rows = resultsForScan(await api.discoveryResults(), id);
    // um scan mais novo e o response e velho: nao escreve; e dentro do scan so o ULTIMO emitido vale (F1)
    if (scanOwner.current === id && resultsSeq.current === seq) setResults(rows);
  };

  // (c1) async scan poll: every tick swaps the job object and the effect restarts the timer
  useEffect(() => {
    if (job?.state !== 'running' || !job.id) return undefined;
    const id = job.id;
    // review 2026-11-27: cancelled = efeito morto (cleanup); stopped = scan fechado visto pelo PROPRIO
    // efeito. Os dois descartam conclusoes obsoletas: o 'running' lento que chega depois de um 'done'
    // reacenderia um scan que o servidor encerrou. O stopped e setado SINCRONICAMENTE quando o state
    // terminal e visto — cobre a janela entre a resposta done e o commit, onde cancelled ainda nao existe.
    let cancelled = false;
    let stopped = false;
    let busy = false; // review final (F3): um ciclo de polling por vez; sem o cap de 60 s o acumulo de requests stalled nao teria limite
    const tick = async () => {
      // 2026-11-27: nao existe limite de tempo aqui. A conta anterior misturava o relogio do
      // navegador com o started_ts do servidor e estourava no primeiro tick quando os dois diferiam
      // mais que 60 s, apagando uma varredura que o servidor ja tinha concluido. Quem encerra o
      // scan e o state que o servidor devolve: runScan fecha em 'done' ou 'error' em todo caminho
      // (server/api/devices.js), e a faixa tem teto de 1024 IPs com timeout proprio por sonda.
      if (stopped || busy) return; // scan ja fechado neste efeito, ou o status do ciclo anterior ainda em voo (F3)
      busy = true;
      try {
        const s = await api.scanStatus(id);
        busy = false; // F3: um request de status por vez; a fase de results segue ordenada por emissor (F1)
        if (cancelled || stopped) return; // conclusao obsoleta: scan fechado, descarta
        if (s.state !== 'running') {
          // review round 2: o state terminal vale NA MESMA hora, antes de esperar as results (o
          // request separado pode travar para sempre) e com stopped fechado para ticks obsoletos
          stopped = true;
          setJob(s);
          setError(s.state === 'error' ? (s.error || t('errors.scan_failed')) : null);
        }
        // as results continuam best-effort: se cairem, o aviso diz por que; se pendurarem, o state
        // terminal ja foi aplicado e nada depende delas
        let aviso: string | null = null;
        try { await loadResults(id); } catch (e) { aviso = `warning: ${errorMessage(e, t('errors.action_failed'))}`; }
        // review final (F2): o aviso da request de results pertence ao SCAN ATUAL, nao ao efeito — a
        // request final pode falar depois do done ter desmontado o efeito. Nunca encobre o erro de
        // scan do servidor e nunca reabre polling (o setJob do estado terminal ja foi feito)
        if (scanOwner.current === id && s.state !== 'error') setError(aviso);
        if (cancelled) return;
        if (s.state === 'running' && !stopped) setJob(s);
      } catch (e) { busy = false; if (!cancelled && !stopped) setError(`warning: ${errorMessage(e, t('errors.action_failed'))}`); } // network caiu -> aviso e continua; o scan no servidor segue
    };
    const timer = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [job, api, t]);

  // "Known address" tab: NX probes the address; here the probe is the same scan, with 1 IP and the
  // calculated port
  async function search() {
    setError(null); setSummary(null); setSelected({});
    try {
      const target = parseAddress(fields.address, fields.useDefault ? null : fields.port);
      // ponytail: the scanner only accepts an IP; a hostname or a link with a name falls into the
      // server 400. The scan carries the typed credential: it is with it that the server asks the
      // model over ONVIF
      // 2026-10-30: a URL digitada vai inteira no scan (path inclusive) — so assim o gate prova a
      // credencial num servidor por caminho; IP puro no campo continua sondando a raiz como sempre.
      const body: ScanBody = { kind: 'scan', scope: { ips: [target.host], ports: [target.port],
        ...(target.scheme === 'rtsp' ? { source: target.source } : {}) } };
      if (credentials.login && credentials.password) body.credential = { username: credentials.login, password: credentials.password };
      const s = await api.startScan(body);
      scanOwner.current = s.scan_id; setScanId(s.scan_id); setResults([]);
      setJob({ ...s, id: s.scan_id });
    } catch (e) { setError(errorMessage(e, t('errors.action_failed'))); }
  }

  // "Subnet scan" tab: first IP..last IP -> list of IPs -> background scan
  async function scan() {
    setError(null); setSummary(null); setSelected({});
    try {
      const ips = expandRange(fields.start, fields.end);
      const body: ScanBody = { kind: 'scan', scope: { ips } };
      if (credentials.login && credentials.password) body.credential = { username: credentials.login, password: credentials.password };
      const s = await api.startScan(body);
      scanOwner.current = s.scan_id; setScanId(s.scan_id); setResults([]);
      setJob({ ...s, id: s.scan_id });
    } catch (e) { setError(errorMessage(e, t('errors.action_failed'))); }
  }

  // Candidate classification (spec decision 2/4): ONLY with a typed credential — without it the
  // device answers Fault and there is no channel to list. One call per opened candidate; the scan
  // does not pay for this per host (amendment E2).
  async function loadChannels(r: Discovery): Promise<DeviceChannels | null> {
    if (!credentials.login || !credentials.password) return null;
    setChannels((c) => ({ ...c, [r.id]: { ...(c[r.id] || { marked: [] }), loading: true, error: undefined } }));
    try {
      const resp = await api.deviceChannels({
        ip: r.ip, port: fields.useDefault ? null : Number(fields.port) || null,
        credential: { username: credentials.login, password: credentials.password },
      });
      setChannels((c) => ({ ...c, [r.id]: { list: resp.channels, marked: defaultChannels(resp.channels), loading: false } }));
      return resp;
    } catch (e) {
      setChannels((c) => ({ ...c, [r.id]: { ...(c[r.id] || { marked: [] }), loading: false, error: errorMessage(e, t('errors.action_failed')) } }));
      return null;
    }
  }
  const toggleChannel = (id: string, channel: number, marked: boolean) => setChannels((c) => {
    const current = c[id] || { marked: [] };
    const markedChannels = marked ? [...new Set([...current.marked, channel])] : current.marked.filter((n) => n !== channel);
    return { ...c, [id]: { ...current, marked: markedChannels } };
  });

  // body of POST /devices; with `channels` the server creates the parent device + N children in one
  // call (decision 4)
  function candidateBody(r: Discovery, marked?: number[]) {
    return { ...deviceBody({ name: undefined, address: r.ip,
      port: fields.useDefault ? null : fields.port, useDefault: fields.useDefault, login: credentials.login, password: credentials.password,
      channels: marked }),
      added_via: 'discovery' };
  }

  async function addSelected() {
    setError(null); setBusy(true); setSummary(null);
    let ok = 0, fail = 0;
    for (const r of selectedCandidates) {
      setRows((s) => ({ ...s, [r.id]: { state: 'adding' } }));
      try {
        // Multi-channel candidate the operator did NOT open: classify now and add the WHOLE DVR —
        // without this a 24-channel device would enter as ONE camera (the defect this wave fixes).
        let marked: number[] | undefined = channels[r.id]?.marked;
        if (!marked && (r.videoSources ?? 0) >= 2) {
          const resp = await loadChannels(r);
          marked = resp ? defaultChannels(resp.channels) : undefined;
        }
        // ponytail: the await keeps the POST sequential - the summary counts per request
        await api.addCamera(candidateBody(r, marked));
        ok += 1; setRows((s) => ({ ...s, [r.id]: { state: 'ok' } }));
      } catch (e) { fail += 1; setRows((s) => ({ ...s, [r.id]: { state: 'error', message: errorMessage(e, t('errors.action_failed')) } })); }
    }
    setSummary({ ok, fail }); setSelected({}); setBusy(false);
    // ponytail: re-read from the server (it is the one that marks outcome 'added'), but only what the
    // current scan found
    try { await loadResults(scanId); } catch (e) { setError(errorMessage(e, t('errors.action_failed'))); }
  }

  // ponytail: narrow Port + "Default" on the same row, like NX; both tabs use the same pair
  const portField = (
    <div className="nx-port-row">
      <label className="nx-field">
        <span className="nx-label">{t('cameras.discovery.port')}</span>
        <input className="nx-input nx-port" value={fields.useDefault ? HIDDEN_PORT : fields.port}
          disabled={fields.useDefault} onChange={updateField('port')} />
      </label>
      <label className="nx-check">
        <input type="checkbox" checked={fields.useDefault}
          onChange={(e) => setFields({ ...fields, useDefault: e.target.checked })} />{t('cameras.discovery.default_port')}
      </label>
    </div>
  );

  return (
    <div className="nx-backdrop">
      <div className="nx-dialog" role="dialog" aria-modal="true" aria-labelledby="wizard-title" ref={dialogRef}>
        <div className="nx-titlebar">
          <span className="nx-title" id="wizard-title">{t('cameras.discovery.title')}</span>
          <button className="nx-close" onClick={onClose} title={t('shared.close')}>✕</button>
        </div>

        <div className="nx-tabs">
          {([['known', t('cameras.discovery.tab_known')], ['subnet', t('cameras.discovery.tab_subnet')]] as [TabId, string][]).map(([id, label]) => (
            <button key={id} className={`nx-tab${tab === id ? ' active' : ''}`}
              onClick={() => { setTab(id); setError(null); setSummary(null); }}>{label}</button>
          ))}
        </div>

        <div className="nx-body">
          {error && <p className="nx-err">{error}</p>}
          <div className="nx-grid">
            {tab === 'known' ? (
              <>
                <label className="nx-field">
                  <span className="nx-label">{t('cameras.discovery.address')}
                    {/* pedido 2026-10-30: o popover de exemplos so aparece com o mouse (ou foco de
                        teclado) sobre o ? — nao e mais um toggle por clique que ficava aberto */}
                    <span className="nx-help" role="button" tabIndex={0} aria-label={t('cameras.discovery.examples')}
                      title={t('cameras.discovery.examples')}
                      onMouseEnter={() => setShowExamples(true)} onMouseLeave={() => setShowExamples(false)}
                      onFocus={() => setShowExamples(true)} onBlur={() => setShowExamples(false)}>?</span>
                  </span>
                  <input className="nx-input" value={fields.address} onChange={updateField('address')}
                    placeholder={t('cameras.discovery.address_placeholder')} spellCheck="false" aria-label={t('cameras.discovery.address')} />
                  {showExamples && (
                    <div className="nx-help-pop">
                      <strong>{t('cameras.discovery.examples_title')}</strong>
                      <ul>{EXAMPLES.map((x) => <li key={x}>{x}</li>)}</ul>
                    </div>
                  )}
                </label>
                {portField}
                <label className="nx-field"><span className="nx-label">{t('cameras.discovery.login')}</span>
                  <input className="nx-input" value={credentials.login} onChange={updateCredential('login')} autoComplete="off" /></label>
                <label className="nx-field"><span className="nx-label">{t('cameras.discovery.password')}</span>
                  <InputSenha>
                    <input className="nx-input" value={credentials.password} onChange={updateCredential('password')} autoComplete="new-password" aria-label={t('cameras.discovery.password')} />
                  </InputSenha></label>
              </>
            ) : (
              <>
                <label className="nx-field"><span className="nx-label">{t('cameras.discovery.first_ip')}</span>
                  <input className={`nx-input${invalidStartOctets.length ? ' nx-invalido' : ''}`} value={fields.start}
                    onChange={updateIp('start')} spellCheck="false" aria-invalid={invalidStartOctets.length > 0} />
                  {invalidStartOctets.length > 0 && <span className="nx-aviso">{t('cameras.discovery.octet_invalid', { octets: invalidStartOctets.join(', ') })}</span>}</label>
                <label className="nx-field"><span className="nx-label">{t('cameras.discovery.last_ip')}</span>
                  <input className={`nx-input${invalidEndOctets.length ? ' nx-invalido' : ''}`} value={fields.end}
                    onChange={updateIp('end')} spellCheck="false" aria-invalid={invalidEndOctets.length > 0} />
                  {invalidEndOctets.length > 0 && <span className="nx-aviso">{t('cameras.discovery.octet_invalid', { octets: invalidEndOctets.join(', ') })}</span>}</label>
                <label className="nx-field"><span className="nx-label">{t('cameras.discovery.login')}</span>
                  <input className="nx-input" value={credentials.login} onChange={updateCredential('login')} autoComplete="off" /></label>
                <label className="nx-field"><span className="nx-label">{t('cameras.discovery.password')}</span>
                  <InputSenha>
                    <input className="nx-input" value={credentials.password} onChange={updateCredential('password')} autoComplete="new-password" aria-label={t('cameras.discovery.password')} />
                  </InputSenha></label>
                {portField}
              </>
            )}
          </div>

          <div className="nx-actions nx-actions-esq">
            {tab === 'known'
              ? <button className="nx-btn" disabled={scanning || !fields.address.trim()} onClick={search}>{scanning ? t('cameras.discovery.searching') : t('cameras.discovery.search')}</button>
              : <button className="nx-btn" disabled={scanning} onClick={scan}>{scanning ? t('cameras.discovery.scanning') : t('cameras.discovery.scan')}</button>}
          </div>

          <DiscoveryResults results={results} selected={selected} onSelect={setSelected} rows={rows}
            busy={busy} scanning={scanning} job={job}
            channels={channels}
            canOpenChannels={!!credentials.login && !!credentials.password}
            onOpenChannels={loadChannels}
            onToggleChannel={toggleChannel} />
        </div>

        <div className="nx-footer">
          {/* ponytail: the button comes BEFORE the summary — this way the confirmation text is born to
              its right and does not push the button */}
          {results.length > 0 && !notAdded.length
            ? <p className="muted">{t('cameras.discovery.all_added')}</p>
            : (
              <button className="nx-btn" disabled={!selectedCandidates.length || busy || noChannelSelected} onClick={addSelected}
                title={noChannelSelected ? t('cameras.discovery.select_channel') : undefined}>
                {busy ? t('cameras.discovery.adding')
                  : (selectedCandidates.length
                    ? t(selectedCandidates.length === 1 ? 'cameras.discovery.add_count.one' : 'cameras.discovery.add_count.other', { n: selectedCandidates.length })
                    : t('cameras.discovery.add_devices'))}
              </button>
            )}
          {summary && <p className="muted">{t(summary.ok === 1 ? 'cameras.discovery.added_summary.one' : 'cameras.discovery.added_summary.other', { n: summary.ok, failed: summary.fail })}</p>}
        </div>
      </div>
    </div>
  );
}
