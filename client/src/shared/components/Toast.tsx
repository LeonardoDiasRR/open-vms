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
  return (
    <div className="fixed right-4 bottom-4 z-[60] flex flex-col gap-2" role="status" aria-live="polite">
      {notices.map((a) => (
        <div key={a.id}
          className={`rounded-md border bg-card px-3 py-2 text-xs shadow-xs ${a.kind === 'error' ? 'border-destructive text-destructive' : 'border-border text-foreground'}`}>
          {a.text}
        </div>
      ))}
    </div>
  );
}
