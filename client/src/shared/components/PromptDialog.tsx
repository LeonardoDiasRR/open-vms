import { useRef, useState } from 'react';
import { useEsc } from '@/shared/hooks/useEsc';
import { useModalFocus } from '@/shared/hooks/useFocoModal';
import { useT } from '@/shared/i18n';

// Question/confirmation dialog in the nx-dialog pattern. The old form is frozen by a static test
// (shared/dialogo-invariante.test.ts). The Promise resolve lives on the request; the buttons resolve.
export type PromptRequest =
  | { id: number; type: 'ask'; title: string; label: string; initial: string; resolve: (v: string | null) => void }
  | { id: number; type: 'confirm'; title: string; lines: string[]; danger: boolean; text: string; resolve: (v: boolean) => void };

let nextId = 0;

export function usePromptDialog() {
  const { t } = useT();
  const [request, setRequest] = useState<PromptRequest | null>(null);
  return {
    request,
    setRequest,
    ask(title: string, label = t('shared.name'), initial = ''): Promise<string | null> {
      return new Promise((resolve) => setRequest({ id: ++nextId, type: 'ask', title, label, initial, resolve }));
    },
    confirm(title: string, lines: string[], opts: { danger?: boolean; text?: string } = {}): Promise<boolean> {
      return new Promise((resolve) => setRequest({ id: ++nextId, type: 'confirm', title, lines, danger: !!opts.danger, text: opts.text || t('shared.confirm'), resolve }));
    },
  };
}
export type PromptHandle = ReturnType<typeof usePromptDialog>;

export function PromptDialog({ request, onClosed }: { request: PromptRequest | null; onClosed: () => void }) {
  // key: the inner useState only matters ABOVE; without remounting per request the second dialog
  // would be born with the previous text (measured in the spec probe)
  if (!request) return null;
  return <DialogInner key={request.id} request={request} onClosed={onClosed} />;
}

function DialogInner({ request, onClosed }: { request: PromptRequest; onClosed: () => void }) {
  const { t } = useT();
  const [value, setValue] = useState(request.type === 'ask' ? request.initial : '');
  const close = (v: string | boolean | null) => { request.resolve(v as never); onClosed(); };
  // The X and ESC do the SAME thing as Cancel: discard without saving (the operator's decision).
  useEsc(() => close(request.type === 'ask' ? null : false));
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref);
  return (
    <div className="nx-backdrop">
      <div className="nx-dialog nx-dialog-menor" role="dialog" aria-modal="true" aria-labelledby="pd-titulo" ref={ref}>
        <div className="nx-titlebar">
          <span className="nx-title" id="pd-titulo">{request.title}</span>
          <button className="nx-close" onClick={() => close(request.type === 'ask' ? null : false)} title={t('shared.close')}>✕</button>
        </div>
        {request.type === 'ask' ? (
          <div className="nx-body">
            <div className="nx-field"><label className="nx-label" htmlFor="pd-input">{request.label}</label>
              <input id="pd-input" className="nx-input" autoFocus value={value}
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => { if (e.key === 'Enter' && value.trim()) close(value.trim()); }}
                onChange={(e) => setValue(e.target.value)} /></div>
          </div>
        ) : (
          <div className="nx-body">{request.lines.map((l, i) => <p key={i}>{l}</p>)}</div>
        )}
        <div className="nx-actions">
          <button className="nx-btn" onClick={() => close(request.type === 'ask' ? null : false)}>{t('shared.cancel')}</button>
          {request.type === 'confirm'
            ? <button className={request.danger ? 'nx-btn nx-btn-perigo' : 'nx-btn'} onClick={() => close(true)}>{request.text}</button>
            : <button className="nx-btn" disabled={!value.trim()} onClick={() => close(value.trim())}>{t('shared.ok')}</button>}
        </div>
      </div>
    </div>
  );
}
