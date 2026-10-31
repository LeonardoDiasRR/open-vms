import { useState, type ReactNode } from 'react';
import { Badge } from '@/shared/ui/badge';
import { Button } from '@/shared/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/shared/ui/dialog';
import { Input } from '@/shared/ui/input';
import { Switch } from '@/shared/ui/switch';
import CameraStatus from '@/shared/components/CameraStatus';
import EmptyState from '@/shared/components/EstadoVazio';
import { PromptDialog, type PromptRequest } from '@/shared/components/PromptDialog';
import { Toasts, type Notice } from '@/shared/components/Toast';
import { useT } from '@/shared/i18n';

// Live catalog of the design system (spec 2026-10-17, M4). Internal /design route, no navigation menu:
// it is a REFERENCE screen, not an operation one. Each section shows the SAME component the operation
// uses — if one of them changes shape, the section changes with it, which is why the catalog does not
// age like a markdown file. Each section is asserted by `design.test.tsx`.
//
// No CSS of its own, on purpose: the layout uses this wave's SCALE tokens (--space-*, --radius-*) inline,
// the pattern App.tsx already uses. A new class would mean touching styles.css — another task's file.
//
// The PTZ here is STATIC: the real .ptz-* classes with fixed markup. No `usePtz` — the operation panel
// arms a camera and talks to the API, and the catalog does neither.

// The 4 disk directions, with the same `rotation` as the real panel (the arrow turns with the button).
const DIRECTIONS = [
  { name: 'up', rotation: 0 }, { name: 'right', rotation: 90 }, { name: 'down', rotation: 180 },
  { name: 'left', rotation: 270 },
];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section data-secao style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-md)', padding: 'var(--space-lg)' }}>
      <h2>{title}</h2>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 'var(--space-md)' }}>{children}</div>
    </section>
  );
}

// The Radix dialog opens by button: open from the first render it LOCKS the scroll of the catalog page
// itself (modal behavior) and tints everything with the overlay.
function DialogSection() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('design.open_dialog')}</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Design system dialog</DialogTitle>
            <DialogDescription>shadcn surface: title, description, X button and bg-background fill.</DialogDescription>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    </>
  );
}

// The PromptDialog also opens by button: `.nx-backdrop` is `position: fixed; inset: 0` with a scrim, and
// static it would cover the whole catalog.
function PromptSection() {
  const { t } = useT();
  const [open, setOpen] = useState(false);
  const request: PromptRequest = {
    id: 0, type: 'ask', title: t('design.rename_camera'), label: t('design.name'), initial: 'Gate 1',
    resolve: () => {},   // ponytail: static catalog; no real request is resolved or closed
  };
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t('design.open_prompt')}</Button>
      {open && <PromptDialog request={request} onClosed={() => setOpen(false)} />}
    </>
  );
}

export default function DesignCatalog() {
  const { t } = useT();

  const notices: Notice[] = [
    { id: 1, text: t('design.created_toast'), kind: 'ok' },
    { id: 2, text: t('design.password_error'), kind: 'error' },
  ];

  // The asynchronous states the M2 spec asked to name in the catalog: each one with the component that
  // represents it today in the operation. None is a new component — the catalog points at what exists.
  const states: { name: string; sample: ReactNode }[] = [
    { name: 'idle', sample: <Badge variant="secondary">no activity</Badge> },
    { name: 'connecting', sample: <span className="cell-spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> },
    { name: 'loading', sample: <span className="cell-spinner" style={{ width: 14, height: 14 }} aria-hidden="true" /> },
    { name: 'success', sample: <Badge>ok</Badge> },
    { name: 'empty', sample: <EmptyState message="nothing here" /> },
    { name: 'offline', sample: <CameraStatus state="offline" /> },
    { name: 'unavailable', sample: <Badge variant="destructive">unavailable</Badge> },
    { name: 'retry', sample: <Button size="xs" variant="outline">{t('design.retry')}</Button> },
  ];

  return (
    <div data-design style={{ padding: 'var(--space-lg)', display: 'flex', flexDirection: 'column', gap: 'var(--space-lg)' }}>
      <h1 style={{ fontSize: 16, margin: 0 }}>Design system catalog</h1>

      <Section title="Button">
        {(['default', 'destructive', 'outline', 'secondary', 'ghost', 'link'] as const).map((v) => (
          <Button key={v} variant={v}>{v}</Button>
        ))}
        <Button disabled>disabled</Button>
        <Button disabled aria-busy="true">
          <span className="cell-spinner" style={{ width: 14, height: 14 }} aria-hidden="true" />{t('design.loading')}
        </Button>
        <p className="muted" style={{ margin: 0, fontSize: 11 }}>
          the focus ring (`:focus-visible`) shows up with Tab — the shell rule applies in here too
        </p>
      </Section>

      <Section title="Input">
        <Input placeholder={t('design.camera_name_placeholder')} aria-label={t('design.field_example')} />
        <Input disabled placeholder="disabled" aria-label="Disabled example field" />
      </Section>

      <Section title="Selects">
        <select className="nx-input" aria-label={t('design.example_profile')}>
          {['admin', 'operator', 'viewer'].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
        <select className="nx-input nx-largura-auto" aria-label={t('design.example_small_profile')}>
          {['admin', 'operator', 'viewer'].map((v) => <option key={v} value={v}>{v}</option>)}
        </select>
      </Section>

      <Section title="Badge">
        {(['default', 'secondary', 'destructive', 'outline', 'ghost', 'link'] as const).map((v) => (
          <Badge key={v} variant={v}>{v}</Badge>
        ))}
      </Section>

      <Section title="Switch">
        <Switch defaultChecked aria-label="Checked example" />
        <Switch aria-label="Unchecked example" />
      </Section>

      <Section title="Dialog"><DialogSection /></Section>
      <Section title="PromptDialog"><PromptSection /></Section>

      <Section title="CameraStatus">
        <CameraStatus state="online" />
        <CameraStatus state="offline" />
        <CameraStatus state="error" />
        <CameraStatus state="provisioning" />
        <CameraStatus state="online" recording />
      </Section>

      <Section title="Spinner">
        <span className="cell-spinner" aria-hidden="true" />
        {/* "stopped": the same component with the animation off — what the operator sees with
            `prefers-reduced-motion`, without changing the spinner drawing */}
        <span className="cell-spinner" style={{ animation: 'none' }} aria-hidden="true" />
      </Section>

      <Section title="Empty state">
        <EmptyState message={t('design.no_cameras')} />
        <EmptyState message={t('design.no_recordings')} action={<Button size="xs">{t('design.retry')}</Button>} />
      </Section>

      <Section title="PTZ">
        <div className="painel-ptz">
          <div className="ptz-joystick">
            {DIRECTIONS.map((d) => (
              <button key={d.name} type="button" className="ptz-seta" aria-label={d.name} title={d.name}
                style={{ '--giro': `${d.rotation}deg` } as React.CSSProperties}>
                <span aria-hidden="true">▲</span>
              </button>
            ))}
            <span className="ptz-centro" aria-hidden="true">PTZ</span>
          </div>
          <div className="ptz-velocidade">
            <span className="ptz-rotulo">{t('design.speed')}</span>
            <input type="range" min={10} max={100} step={5} defaultValue={50} aria-label={t('design.example_speed')} />
            <span className="ptz-pct">50%</span>
          </div>
          <div className="ptz-zoom">
            <span className="ptz-rotulo">Zoom</span>
            <div className="ptz-zoom-par">
              <button type="button" aria-label="zoom out" title="zoom out">−</button>
              <button type="button" aria-label="zoom in" title="zoom in">+</button>
            </div>
          </div>
          <div className="ptz-presets">
            <div className="tree-secao">
              <span className="tree-nome">{t('design.saved_positions')}</span>
              <button type="button" className="cam-dots mini-cta" aria-label={t('design.save_position')} title={t('design.save_position')} aria-disabled="false">+</button>
            </div>
            <ul className="tree ptz-lista">
              <li className="ptz-linha">
                <span className="tree-nome">Entrance</span>
                <button type="button" className="cam-dots" aria-label={t('design.input_options')} title={t('design.input_options')} aria-haspopup="menu">⋯</button>
              </li>
            </ul>
            <button type="button" className="add-camera">{t('design.save_position_action')}</button>
          </div>
        </div>
      </Section>

      <Section title="Toast">
        {/* Static, like the PTZ here: the operation toast is mounted by the App and lives in the
            `useToasts` state. These two notices show the success and the error format. */}
        <Toasts notices={notices} />
      </Section>

      <Section title="Async states">
        {states.map(({ name, sample }) => (
          <span key={name} style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-sm)' }}>
            <span className="muted" style={{ fontSize: 11, minWidth: 78 }}>{name}</span>
            {sample}
          </span>
        ))}
      </Section>
    </div>
  );
}
