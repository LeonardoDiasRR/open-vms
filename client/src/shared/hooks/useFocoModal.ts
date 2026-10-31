import { useEffect, useRef, type RefObject } from 'react';

// Modal focus (M3): goes to the first focusable, Tab/Shift+Tab cycle inside it and focus returns to
// the trigger on close. One hook for the three modals — the trap body is identical in all three.
const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useModalFocus(ref: RefObject<HTMLElement | null>) {
  const previous = useRef<HTMLElement | null>(null);
  // The content autoFocus runs on commit, before passive effects: in the effect focus is already
  // inside the modal. So the trigger is read here on render, when it still has focus.
  if (previous.current === null) previous.current = document.activeElement as HTMLElement | null;
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const focusables = () => Array.from(el.querySelectorAll<HTMLElement>(FOCUSABLE));
    // the content's own autoFocus (the PromptDialog text field) takes precedence
    if (!el.contains(document.activeElement)) (focusables()[0] ?? el).focus();
    const onTab = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onTab);
    return () => {
      document.removeEventListener('keydown', onTab);
      previous.current?.focus?.();
    };
  }, [ref]);
}
