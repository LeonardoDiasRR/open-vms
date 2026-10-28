import type { MouseEvent } from 'react';
import { useT } from '@/shared/i18n';

// spec 2026-10-18 (videowall recording tabs, section 6.2): the tab bar that lived in LiveView moved
// here. Markup, classes and behavior IDENTICAL to today's: tab, dirty `*`, X that closes without
// asking, `.stage-erro` and the contextmenu that delegates opening the menu to the page.
// The existing CSS (.stage-tabs, .stage-tab, .stage-tab-x, .stage-erro) does not change.
export type Tab = { key: string; name: string; dirty: boolean };

type Props = {
  tabs: Tab[];
  activeKey: string;
  onSwitch: (key: string) => void;
  onClose: (key: string) => void;
  error?: string | null;
  onOpenMenu: (key: string, x: number, y: number) => void;
};

export default function StageTabs({ tabs, activeKey, onSwitch, onClose, error = null, onOpenMenu }: Props) {
  const { t } = useT();
  function handleContextMenu(e: MouseEvent<HTMLDivElement>) {
    const tab = e.target instanceof HTMLElement ? e.target.closest('[data-tab]') : null;
    if (!(tab instanceof HTMLElement)) return;
    e.preventDefault();
    onOpenMenu(tab.dataset.tab ?? '', e.clientX, e.clientY);
  }

  return (
    <div className="stage-tabs" onContextMenu={handleContextMenu}>
      {tabs.map((a) => (
        <div key={a.key} data-tab={a.key}
          className={`stage-tab${a.key === activeKey ? ' active' : ''}`}
          onClick={() => onSwitch(a.key)}>
          <span>{a.name}{a.dirty ? ' *' : ''}</span>
          <button className="stage-tab-x" title={t('shared.close')}
            onClick={(e) => { e.stopPropagation(); onClose(a.key); }}>✕</button>
        </div>
      ))}
      {error && <span className="stage-erro">{error}</span>}
    </div>
  );
}
