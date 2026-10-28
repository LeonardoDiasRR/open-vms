import { useEffect, useRef } from 'react';

// Handler stack: only the TOP modal closes on ESC. Needed because CameraSettingsModal opens the
// ManufacturerModal on top of it (measured 2026-10-17) — with one listener per modal, a single ESC
// would close both at once.
const stack: Array<() => void> = [];
let listening = false;

function listener(e: KeyboardEvent) {
  if (e.key !== 'Escape') return;
  stack[stack.length - 1]?.();
}

export function useEsc(onClose: () => void) {
  const ref = useRef(onClose);
  ref.current = onClose;
  useEffect(() => {
    const h = () => ref.current();
    stack.push(h);
    if (!listening) { document.addEventListener('keydown', listener); listening = true; }
    return () => {
      const i = stack.lastIndexOf(h);
      if (i >= 0) stack.splice(i, 1);
      if (!stack.length && listening) { document.removeEventListener('keydown', listener); listening = false; }
    };
  }, []);
}
