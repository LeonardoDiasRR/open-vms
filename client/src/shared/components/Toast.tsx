import { useCallback, useEffect, useRef, useState } from 'react';

// Ephemeral app notices (spec 2026-10-18, 4.5). Same shape as PromptDialog: a hook owns the state
// and an element mounted ONCE at the end of the App. Success disappears fast; error stays longer.
export type NoticeKind = 'ok' | 'error';
export type Notice = { id: number; text: string; kind: NoticeKind };
export type Notify = (text: string, kind?: NoticeKind) => void;

const DURATION: Record<NoticeKind, number> = { ok: 2600, error: 6000 };
const MAX = 3;
let nextId = 0;

export function useToasts(): { notices: Notice[]; notify: Notify } {
  const [notices, setNotices] = useState<Notice[]>([]);
  const timers = useRef<number[]>([]);
  useEffect(() => () => { for (const t of timers.current) window.clearTimeout(t); }, []);

  const notify = useCallback<Notify>((text, kind = 'ok') => {
    const id = ++nextId;
    // The same text does NOT stack: the password reset returns the temporary one and it must appear
    // ONCE (spec 4.3), even if the operator clicks twice. The stack keeps the last 3.
    setNotices((l) => [...l.filter((a) => a.text !== text), { id, text, kind }].slice(-MAX));
    timers.current.push(window.setTimeout(() => { setNotices((l) => l.filter((a) => a.id !== id)); }, DURATION[kind]));
  }, []);

  return { notices, notify };
}

export function Toasts({ notices }: { notices: Notice[] }) {
  // Canto: SUPERIOR DIREITO DA AREA UTIL (spec 2026-11-06). A ancora vive em `.nx-toast` no
  // styles.css, lida de --alt-topbar e --col-dir, porque o aviso nao deve cobrir header, painel
  // direito nem a alca de redimensionamento. Nenhuma classe de canto aqui: a posicao tem UMA fonte.
  // O aviso mais novo e o primeiro do DOM, entao a pilha nasce encostada no canto e cresce para
  // baixo. O array continua [mais antigo ... mais novo]: inverter o do `useToasts` mudaria o dedupe
  // e o teto de 3 por nada.
  return (
    <div className="nx-toast fixed flex flex-col gap-2" role="status" aria-live="polite">
      {[...notices].reverse().map((a) => (
        <div key={a.id}
          className={`rounded-md border bg-card px-3 py-2 text-xs shadow-xs ${a.kind === 'error' ? 'border-destructive text-destructive' : 'border-border text-foreground'}`}>
          {a.text}
        </div>
      ))}
    </div>
  );
}
