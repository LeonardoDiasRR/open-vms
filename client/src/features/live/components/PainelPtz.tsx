import { useState } from 'react';
import CameraMenu, { type ItemMenu } from '@/shared/ui/CameraMenu';
import SearchField from '@/shared/ui/SearchField';
import { PromptDialog, usePromptDialog } from '@/shared/components/PromptDialog';
import { normalize } from '@/shared/domain/groups';
import { LIMIT, type Position } from '@/features/live/services/posicoes';
import { directionVector, zoomVector, type Vector } from '@/features/live/services/ptz';
import type { PtzApi } from '@/features/live/hooks/usePtz';
import { useT } from '@/shared/i18n';

// The 8 directions of the disc. `rotation` places the arrow on the circumference (the arrow turns too,
// so the triangle points outwards) and the pan/tilt pair goes into the vector.
// TODO(i18n): no `live.ptz.direction.*` keys in en.ts yet (task 6.2).
const DIRECTIONS = [
  { name: 'up', pan: 0, tilt: 1, rotation: 0 },
  { name: 'up right', pan: 1, tilt: 1, rotation: 45 },
  { name: 'right', pan: 1, tilt: 0, rotation: 90 },
  { name: 'down right', pan: 1, tilt: -1, rotation: 135 },
  { name: 'down', pan: 0, tilt: -1, rotation: 180 },
  { name: 'down left', pan: -1, tilt: -1, rotation: 225 },
  { name: 'left', pan: -1, tilt: 0, rotation: 270 },
  { name: 'up left', pan: -1, tilt: 1, rotation: 315 },
];

// The four arrows that move the joystick when it has focus.
const ARROWS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];

// Hold button: a pressed pointer moves continuously, releasing (or leaving, or cancelling) stops.
// `onClick` is NOT used: it would add a 400 ms pulse to the movement already released. Enter/Space do the
// same through the keyboard, and `preventDefault` avoids the synthetic click.
function HoldButton({ label, v, ptz, className = '', style, children }: {
  label: string; v: Vector; ptz: PtzApi; className?: string;
  style?: React.CSSProperties; children: React.ReactNode;
}) {
  // The arrows only count on the joystick (the `ptz-seta` class is what identifies the eight direction
  // buttons); on the zoom and the rest of the panel the arrow remains normal navigation. The routine is
  // the SAME as the pointer one.
  const onKeyDown = (e: React.KeyboardEvent) => {
    const joystickArrow = className.includes('ptz-seta') && ARROWS.includes(e.key);
    if (e.key === 'Enter' || e.key === ' ' || joystickArrow) { e.preventDefault(); ptz.hold(v); }
  };
  return (
    <button type="button" className={className} style={style} aria-label={label} title={label}
      onPointerDown={(e) => { e.preventDefault(); ptz.hold(v); }}
      onPointerUp={ptz.release} onPointerLeave={ptz.release} onPointerCancel={ptz.release}
      onKeyDown={onKeyDown}
      onKeyUp={ptz.release}>
      {children}
    </button>
  );
}

type Menu = { x: number; y: number } & Position;

export default function PtzPanel({ ptz }: { ptz: PtzApi }) {
  const { t } = useT();
  const [menu, setMenu] = useState<Menu | null>(null);
  const dlg = usePromptDialog();
  const list = ptz.positions;   // the list is already ours: no filter by name
  // LOCAL panel filter (spec 3.5): the sidebar filters cameras/layouts, here positions are filtered, and
  // the user does both at the same time. The panel unmounts when PTZ disarms, so the text is empty again
  // on the next arm without any extra code.
  const [filter, setFilter] = useState('');
  const query = normalize(filter.trim());
  const visible = query ? list.filter((p) => normalize(p.name).includes(query)) : list;
  const pct = Math.round(ptz.speed * 100);
  // The text of the disabled button tells the REAL CAUSE (spec 2026-10-17, section 4): the label used to
  // say "limit" even when the camera did not report absolute position — that was the operator's case.
  // TODO(i18n): no `live.ptz.saving` key in en.ts yet (task 6.2).
  const reason = ptz.saving ? 'Saving the position…'
    : ptz.positions.length >= LIMIT ? t('live.ptz.limit')
    : !(ptz.absolute.panTilt || ptz.absolute.zoom) ? t('live.ptz.no_absolute')
    : '';
  const saveLabel = reason || t('live.ptz.save_position');
  const items: ItemMenu[] = [
    { id: 'rename', label: t('live.ptz.rename') },
    { id: 'delete', label: t('live.ptz.delete'), danger: true },
  ];
  const openMenu = (e: React.MouseEvent, position: Position, fromButton: boolean) => {
    e.preventDefault();
    if (fromButton) e.stopPropagation();
    const anchor = (e.currentTarget as HTMLElement).querySelector('.cam-dots') ?? (e.currentTarget as HTMLElement);
    const r = anchor.getBoundingClientRect();
    setMenu({ x: r.right, y: r.bottom, ...position });
  };

  async function onPick(id: string) {
    const target = menu;
    setMenu(null);
    if (!target) return;
    if (id === 'rename') {
      // The name is free (spec 6.2): no default warning, just the new name.
      const name = await dlg.ask(t('live.ptz.rename_title'), t('live.ptz.name'), target.name);
      if (!name || name === target.name) return;
      await ptz.rename(target.id, name);
    } else if (id === 'delete') {
      const go = await dlg.confirm(t('live.ptz.delete_title'), [t('live.ptz.delete_question', { name: target.name })],
        { danger: true, text: t('live.ptz.delete') });
      if (go) await ptz.remove(target.id);
    }
  }

  function save() { if (ptz.canSave) void ptz.save(); }

  return (
    <div className="painel-ptz">
      {/* 1 · joystick */}
      <div className="ptz-joystick" role="group" aria-label={t('live.ptz.joystick')}>
        {DIRECTIONS.map((d) => (
          <HoldButton key={d.name} label={`Move ${d.name}`} className="ptz-seta" ptz={ptz}
            v={directionVector(d.pan, d.tilt)}
            style={{ '--giro': `${d.rotation}deg` } as React.CSSProperties}>
            <span aria-hidden="true">▲</span>
          </HoldButton>
        ))}
        <span className="ptz-centro" aria-hidden="true">PTZ</span>
      </div>

      {/* 2 · movement speed */}
      <div className="ptz-velocidade">
        <span className="ptz-rotulo">{t('live.ptz.speed')}</span>
        <input type="range" min={10} max={100} step={5} value={pct} aria-label={t('live.ptz.motion_speed')}
          onChange={(e) => ptz.applySpeed(Number(e.target.value) / 100)} />
        <span className="ptz-pct">{pct}%</span>
      </div>

      {/* 3 · zoom: the step is the same as the keyboard and the wheel; the panel speed does not apply to it */}
      <div className="ptz-zoom">
        <span className="ptz-rotulo">{t('live.ptz.zoom')}</span>
        <div className="ptz-zoom-par">
          {/* TODO(i18n): no `live.ptz.zoom_out`/`zoom_in` keys in en.ts yet (task 6.2). */}
          <HoldButton label="Zoom out" ptz={ptz} v={zoomVector(-1)}>−</HoldButton>
          <HoldButton label="Zoom in" ptz={ptz} v={zoomVector(1)}>+</HoldButton>
        </div>
      </div>

      {/* 4 · saved positions: search, header, single scrollable list and footer action, like the left sidebar */}
      <div className="ptz-presets">
        {/* Escape and the clear X come from the field itself (the local list needs no code at all).
            spec 2026-10-18: the field sits ABOVE the section header (operator request; probe in the spec). */}
        <SearchField value={filter} onChange={setFilter} label={t('live.ptz.filter')} />
        <div className="tree-secao">
          <span className="tree-nome">{t('live.ptz.saved_positions')}</span>
          <button type="button" className="cam-dots mini-cta" aria-label={saveLabel} title={saveLabel}
            aria-disabled={!ptz.canSave} onClick={save}>+</button>
        </div>
        <ul className="tree ptz-lista">
          {visible.length === 0 && <li className="muted">{t('live.ptz.no_positions')}</li>}
          {visible.map((p) => (
            <li key={p.id} className={`ptz-linha${ptz.runningPreset === p.id ? ' sel' : ''}`}
              onClick={() => void ptz.goTo(p.id)}
              onContextMenu={(e) => openMenu(e, p, false)}>
              <span className="tree-nome">{p.name}</span>
              <button type="button" className="cam-dots" aria-label={t('live.ptz.options', { name: p.name })}
                aria-haspopup="menu"
                title={t('live.ptz.options', { name: p.name })}
                onClick={(e) => openMenu(e, p, true)}>⋯</button>
            </li>
          ))}
        </ul>
        <button type="button" className="add-camera" aria-disabled={!ptz.canSave} onClick={save}>
          {reason || t('live.ptz.save_position_action')}
        </button>
      </div>

      {menu && <CameraMenu x={menu.x} y={menu.y} items={items} onPick={onPick} onClose={() => setMenu(null)} />}
      <PromptDialog request={dlg.request} onClosed={() => dlg.setRequest(null)} />
    </div>
  );
}
