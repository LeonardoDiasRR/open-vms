import { useEffect, useRef } from 'react';
import { useEsc } from '@/shared/hooks/useEsc';
import { useT } from '@/shared/i18n';

// User dropdown (spec 2026-10-18). Replaces the old topbar items (URL, name/profile, Events,
// Administration, Log out): name+profile in the header, "Settings" in place of the Administration
// button (profile gate belongs to the App; the server checks again) and "Log out" = logout.
// The panel anchors on its own wrapper. Closes on Esc (useEsc stack — AdminModal uses the same
// stack and stays on top) and on an outside click (CameraMenu's mousedown pattern).
type Props = {
  open: boolean;
  user: string;
  profile: string;
  canConfigure: boolean;
  onToggle: () => void;
  onConfig: () => void;
  onExit: () => void;
  onClose: () => void;
};

const svgProps = {
  viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2,
  strokeLinecap: 'round', strokeLinejoin: 'round', width: 16, height: 16, 'aria-hidden': true,
} as const;

const UserIcon = () => (
  <svg {...svgProps}><path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" /></svg>
);

export default function UserMenu({ open, user, profile, canConfigure,
  onToggle, onConfig, onExit, onClose }: Props) {
  const { t } = useT();
  const ref = useRef<HTMLDivElement>(null);
  useEsc(onClose);
  useEffect(() => {
    if (!open) return;
    const outside = (e: MouseEvent) => {
      if (!ref.current || !ref.current.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', outside);
    return () => document.removeEventListener('mousedown', outside);
  }, [open, onClose]);

  return (
    <div className="user-menu-wrap" ref={ref}>
      <button type="button" className="user-menu-btn" aria-label={t('topbar.user_menu')}
        title={t('topbar.user_menu')} aria-haspopup="menu" aria-expanded={open} onClick={onToggle}>
        <UserIcon />
      </button>
      {open && (
        <div className="user-menu" role="menu">
          <div className="user-menu-head">
            <div><UserIcon />{user}</div>
            <div className="muted">
              <svg {...svgProps}><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M7 9h6M7 13h10M7 17h4" /></svg>
              {profile}
            </div>
          </div>
          {canConfigure && (
            <button type="button" role="menuitem" className="user-menu-item" onClick={onConfig}>
              <svg {...svgProps}><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9 17 7M7 17l-2.1 2.1" /></svg>
              {t('topbar.settings')}
            </button>
          )}
          <button type="button" role="menuitem" className="user-menu-item" onClick={onExit}>
            <svg {...svgProps}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></svg>
            {t('topbar.logout')}
          </button>
        </div>
      )}
    </div>
  );
}
