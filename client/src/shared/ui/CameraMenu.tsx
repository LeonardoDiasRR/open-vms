import { useEffect, useRef } from 'react';

// Sidebar dropdown (NX pattern): fixed on screen, opened to the LEFT of the "..." (the CSS uses
// translateX(-100%)), and closes on Esc and on an outside click. The component only renders —
// the App decides what each item does.
export type ItemMenu = { id: string; label: string; danger?: boolean };

type Props = {
  x: number;
  y: number;
  items: ItemMenu[];
  onPick: (id: string) => void;
  onClose: () => void;
};

export default function CameraMenu({ x, y, items, onPick, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const outside = (e: MouseEvent) => { if (!ref.current || !ref.current.contains(e.target as Node)) onClose(); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', outside);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', outside);
      document.removeEventListener('keydown', esc);
    };
  }, [onClose]);
  // M3: the menu opens with focus on the first item (the keyboard does not stay on the trigger) and
  // the arrows walk between items, wrapping at the ends. Enter fires through the native <button>;
  // Escape already closes above.
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
  }, []);

  const arrows = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const buttons = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button'));
    const i = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = e.key === 'ArrowDown' ? 1 : -1;
    buttons[(i + step + buttons.length) % buttons.length]?.focus();
  };
  // Invariant (spec 2026-10-19, destructive item always last): a `danger` item is NEVER drawn
  // before a harmless one. Stable partition: the builder's order holds inside each group. No builder
  // knows the rule; the initial focus and the arrows operate on the drawn order.
  const ordered = [...items.filter((it) => !it.danger), ...items.filter((it) => it.danger)];
  return (
    <div className="cam-menu" ref={ref} style={{ left: x, top: y }} role="menu" onKeyDown={arrows}>
      {ordered.map((it) => (
        <button
          key={it.id}
          type="button"
          role="menuitem"
          className={`cam-menu-item${it.danger ? ' danger' : ''}`}
          onClick={() => onPick(it.id)}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}
