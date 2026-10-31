import { PanelLeftClose, PanelLeftOpen, PanelRightClose, PanelRightOpen } from 'lucide-react';
import { useT } from '@/shared/i18n';

type Props = { side: 'left' | 'right'; collapsed: boolean; onToggle: () => void };

// ponytail: ONE component for both sides (F1/S5) — the side chooses the icon and the label.
// The icon announces the ACTION, not the state: open shows close, collapsed shows open
// (spec 2026-10-16, section 4).
// The noun reuses `cameras.expand/collapse`: no `shared.expand/collapse` keys exist yet.
export default function PainelAlternancia({ side, collapsed, onToggle }: Props) {
  const { t } = useT();
  const target = side === 'left' ? 'menu' : 'panel';
  const Icon = side === 'left'
    ? (collapsed ? PanelLeftOpen : PanelLeftClose)
    : (collapsed ? PanelRightOpen : PanelRightClose);
  const label = t(collapsed ? 'cameras.expand' : 'cameras.collapse', { name: target });

  return (
    <button type="button" className="painel-toggle" onClick={onToggle} aria-label={label} title={label}>
      <Icon size={16} aria-hidden="true" />
    </button>
  );
}
