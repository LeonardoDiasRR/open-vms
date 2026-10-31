import { useEffect, useState, type RefObject } from 'react';

// spec 2026-10-18 (4.3): native fullscreen, ONE cell scope. The explicit ESC guarantees the exit
// in contexts that intercept the key; `fullscreenchange` keeps the state truthful when the operator
// leaves through the browser gesture.
export function useFullscreen(ref: RefObject<HTMLElement | null>) {
  const [isFullscreen, setIsFullscreen] = useState(false);

  useEffect(() => {
    const h = () => setIsFullscreen(document.fullscreenElement === ref.current);
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    };
    document.addEventListener('fullscreenchange', h);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('fullscreenchange', h); document.removeEventListener('keydown', esc); };
  }, [ref]);

  function toggleFullscreen() {
    if (document.fullscreenElement === ref.current) document.exitFullscreen().catch(() => {});
    else ref.current?.requestFullscreen?.().catch(() => {});
  }

  return { isFullscreen, toggleFullscreen };
}
