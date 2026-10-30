import { useEffect, useState, type DragEvent, type MouseEvent } from 'react';
import { buildTree, filterCameras, flatten, range, type Device, type TreeNode } from '@/shared/domain/groups';
import EmptyState from '@/shared/components/EstadoVazio';
import CameraStatus, { type CameraState } from '@/shared/components/CameraStatus';
import type { DropPayload } from '@/shared/hooks/useCameras';
import { useT } from '@/shared/i18n';

const CAMERA_TYPE = 'application/x-ovms-camera';
const GROUP_TYPE = 'application/x-ovms-group';
// spec 2026-10-17 (1.3b): own payload for the DVR drag. The folder reads THIS one before the camera
// one — without the precedence, dropping a DVR on a folder would spread the channels instead of
// moving the recorder.
const DEVICE_TYPE = 'application/x-ovms-device';

// recording (spec 2026-10-16): feeds the FULL dot when recording is on
// ativa (spec 2026-10-27): OPTIONAL so old fixtures keep compiling; absent = active, only `ativa === false` is inactive.
// server_id (spec 2026-10-30): opcional — sem ele a árvore desenha o plano de sempre (Fase 2→4).
export type Camera = { id: string; name: string; state: string; group_id?: string | null; device_id?: string | null; recording?: boolean; ativa?: boolean; server_id?: string };
export type Group = { id: string; name: string; parent_id?: string | null; server_id?: string };
export type Kind = 'camera' | 'group' | 'device' | 'server';
// Linha do nó servidor (spec 5.3): rótulo + status do poll (o App mescla o ok, 5.5).
export type ServerNode = { id: string; label: string; online: boolean };
// What enters the MULTIPLE selection: the device is a container (amendment E10) and is not markable —
// only camera and folder enter the `Marked` array.
type Markable = 'camera' | 'group';
// The multiple selection is ONE array for both trees: LayoutTree adds 'layout' to it, so CameraTree
// accepts the whole selection (it only marks camera/group).
export type Marked = { kind: 'camera' | 'group' | 'layout'; id: string };

type TreeAction = { type: 'menu' | 'menu-toggle'; kind: Kind; id: string; x: number; y: number; name: string; camera?: Camera };
// O nó servidor NÃO vai ao palco: o Target exclui o kind novo.
type Target = { kind: Exclude<Kind, 'server'>; id: string };

type Props = {
  groups: Group[];
  cameras: Camera[];
  devices?: (Device & { server_id?: string })[];
  selected?: string | null;
  marked?: Marked[];
  onSelect: (id: string) => void;
  onMark?: (m: Marked[]) => void;
  onAction: (a: TreeAction) => void;
  onDrop: (d: DropPayload) => void;
  onOpen?: (n: Target) => void;
  // spec 2026-10-30: o "+" da seção CONECTA SERVIDOR (sem portão — D4); o antigo onAdd (wizard)
  // migrou para o menu de contexto do nó servidor (D6).
  onConnectServer?: () => void;
  // Nós raiz por servidor (spec 5.3). Sem o prop, a árvore desenha o plano de sempre — é o estado
  // de transição até o App passar a lista na Fase 4.
  servers?: ServerNode[];
  filter?: string;
  // spec 2026-10-18 (header filters). The folder signal is worth BOTH trees: the App increments `n`
  // on every click and `open` says the mode; each tree closes/opens its own folders in the effect.
  folderSignal?: { open: boolean; n: number };
  onToggleFolders?: () => void;
  recordingFilter?: 'with' | 'without' | null;
  onCycleRecording?: () => void;
};

// Status words for the spoken name of the badge (the visible dot never carries the state alone).
const STATUS_KEYS = {
  online: 'cameras.status.online',
  offline: 'cameras.status.offline',
  error: 'cameras.status.error',
  provisioning: 'cameras.status.provisioning',
} as const;

// Sidebar as a tree (NX pattern): folders with disclosure and the cameras inside.
// The selection keeps PAIRS {kind, id}: camera AND folder are selectable (Ctrl toggles, Shift takes
// the visible range). The drag carries a CSV of ids per format in the dataTransfer.
// The component only renders: whoever decides the actions talks to the server via onAction/onDrop.
// Double click goes up through onOpen (the App takes the camera/folder to the wall).
export default function CameraTree({ groups, cameras, devices = [], selected, marked = [], onSelect, onMark = () => {}, onAction, onDrop, onOpen = () => {}, onConnectServer, servers = [], filter = '', folderSignal, onToggleFolders, recordingFilter = null, onCycleRecording }: Props) {
  const { t } = useT();
  // ponytail: open by default — a new folder with the camera inside already shows open, with no
  // second click to find out where the camera went
  const [closed, setClosed] = useState<string[]>([]);
  const [hovered, setHovered] = useState<string | null>(null); // folder under the drag (highlight)

  const toggle = (id: string) => setClosed((f) => (f.includes(id) ? f.filter((x) => x !== id) : [...f, id]));

  // spec 2026-10-18: the header folder click sends a signal (n grows). n=0 is the initial state:
  // the effect only reacts to a real click. Closes folder AND device (the DVR is a folder too).
  const signalN = folderSignal?.n ?? 0;
  useEffect(() => {
    if (!signalN) return;
    setClosed(folderSignal?.open ? [] : [...groups.map((g) => g.id), ...devices.map((d) => d.id)]);
    // eslint-disable-line react-hooks/exhaustive-deps -- only the new signal may touch this
  }, [signalN]);

  const isMarked = (kind: Markable, id: string) => marked.some((m) => m.kind === kind && m.id === id);

  const isFiltering = filter.trim() !== '' || recordingFilter !== null;   // empty or blank filter = today's behavior (spec 4.2)

  // The VISIBLE view of one slice — the flat list of always, or the slice of a server (spec 5.3):
  // recording filter BEFORE the text one (folders without a match vanish while filtering,
  // spec 2026-10-18), then the recording keepers, then the devices without a visible child.
  // The filter is derived from the data in memory: no debounce, no server call (spec 3.4).
  function viewFor(g0: Group[], c0: Camera[], d0: (Device & { server_id?: string })[]) {
    const recordingMatch = recordingFilter ? c0.filter((c) => !!c.recording === (recordingFilter === 'with')) : c0;
    const { groups: filteredGroups, cameras: visibleCameras } = filterCameras(g0, recordingMatch, filter);
    let visibleGroups = filteredGroups;
    if (recordingFilter) {
      const byId = new Map(g0.map((g) => [g.id, g]));
      const keepers = new Set<string>();
      for (const c of visibleCameras) {
        let current: string | null | undefined = c.group_id;
        while (current && !keepers.has(current)) { keepers.add(current); current = byId.get(current)?.parent_id; }  // walks up to the ancestors; a cycle does not hang
      }
      visibleGroups = filteredGroups.filter((g) => keepers.has(g.id));
    }
    // With a filter active a device with no visible child does not appear; without a filter it stays:
    // a device with no children is a real state and must remain reachable.
    const visibleDevices = isFiltering ? d0.filter((d) => visibleCameras.some((c) => c.device_id === d.id)) : d0;
    return { groups: visibleGroups, cameras: visibleCameras, devices: visibleDevices };
  }

  const flat = viewFor(groups, cameras, devices);

  // plain click = just the item (camera opens the right panel); Ctrl = toggles (without touching the
  // panel); Shift = visible range from the anchor (the first marked one) up to it.
  function handleClick(e: MouseEvent, kind: Markable, id: string) {
    if (e.shiftKey) {
      const rows = flatten(buildTree(flat.groups, flat.cameras, flat.devices), closed);
      onMark(range(rows, marked[0]?.id ?? id, id));
      if (kind === 'camera') onSelect(id);
      return;
    }
    if (e.ctrlKey || e.metaKey) {
      onMark(isMarked(kind, id) ? marked.filter((m) => !(m.kind === kind && m.id === id)) : [...marked, { kind, id }]);
      return;
    }
    onMark([{ kind, id }]);
    if (kind === 'camera') onSelect(id);
  }

  // row payload: the whole selection when the row is marked, otherwise just itself.
  // The dragged row opens the CSV of its own format — it is the one the tree moves.
  function loadDragPayload(e: DragEvent, kind: Markable, id: string) {
    const sel = isMarked(kind, id) ? marked : [{ kind, id }];
    const camIds = sel.filter((m) => m.kind === 'camera').map((m) => m.id);
    if (camIds.length) e.dataTransfer.setData(CAMERA_TYPE, camIds.join(','));
    let groupIds = sel.filter((m) => m.kind === 'group').map((m) => m.id);
    if (kind === 'group') groupIds = [id, ...groupIds.filter((g) => g !== id)];
    if (groupIds.length) e.dataTransfer.setData(GROUP_TYPE, groupIds.join(','));
    e.dataTransfer.effectAllowed = 'move';
  }

  const acceptDrag = (e: DragEvent) => { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; };

  function handleDrop(e: DragEvent, targetId: string | null) {
    e.preventDefault();
    e.stopPropagation(); // without this the container treats the same drop as "to the root"
    setHovered(null);
    const csv = (type: string) => (e.dataTransfer.getData(type) || '').split(',').filter(Boolean);
    const cameraIds = csv(CAMERA_TYPE);
    const groupIds = csv(GROUP_TYPE);
    // PRECEDENCE (spec 1.3b/d): the DVR drag sends BOTH payloads. When the device one arrived, the
    // drop is over the RECORDER — the children that came in the camera payload are ignored here.
    const deviceId = e.dataTransfer.getData(DEVICE_TYPE) || '';
    if (!deviceId && !cameraIds.length && !groupIds.length) return;
    onDrop({ cameraIds, groupIds, target: targetId, ...(deviceId ? { device_id: deviceId } : {}) });
  }

  function renderNode(n: TreeNode<Camera>) {
    if (n.kind === 'camera') {
      const statusKey = STATUS_KEYS[n.camera.state as CameraState];
      return (
        <li
          key={n.id}
          className={`tree-row tree-camera${isMarked('camera', n.id) ? ' sel' : ''}`}
          onClick={(e) => handleClick(e, 'camera', n.id)}
          // ponytail: stopPropagation on both: the camera li lives INSIDE the folder li, so without
          // this the menu/double click of the FOLDER overwrites the camera one (item 1.7)
          onDoubleClick={(e) => { e.stopPropagation(); onOpen({ kind: 'camera', id: n.id }); }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // ponytail: the .cam-dots button always exists on this row; the ! only tells TS that
            const r = e.currentTarget.querySelector('.cam-dots')!.getBoundingClientRect();
            onAction({ type: 'menu', kind: 'camera', id: n.id, x: r.right, y: r.bottom, name: n.name, camera: n.camera });
          }}
          draggable
          onDragStart={(e) => { e.stopPropagation(); loadDragPayload(e, 'camera', n.id); }}
        >
          <span className="tree-alca" aria-hidden="true" />
          <CameraStatus state={n.camera.state as CameraState} recording={n.camera.recording} title={n.name}
            inactive={n.camera.ativa === false}
            ariaLabel={statusKey ? `${t(statusKey)}${n.camera.recording ? `, ${t('cameras.status.recording')}` : ''}` : undefined} />
          {/* the name truncates by the column width: the title gives the whole name back on hover */}
          <span className={`tree-nome${n.camera.ativa === false ? ' inativa' : ''}`} title={n.name}>{n.name}</span>
          <button
            type="button"
            className="cam-dots"
            aria-label={t('cameras.options', { name: n.name })}
            title={t('cameras.options', { name: n.name })}
            aria-haspopup="menu"
            // two quick clicks on the "..." cannot become a double click of the row
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              onAction({ type: 'menu-toggle', kind: 'camera', id: n.id, x: r.right, y: r.bottom, name: n.name, camera: n.camera });
            }}
          >
            ⋯
          </button>
        </li>
      );
    }
    if (n.kind === 'device') {
      const deviceOpen = isFiltering || !closed.includes(n.id);
      // spec 2026-10-17 (1.3a-c): the DVR behaves like a folder — opens on the stage by double click,
      // drags publishing the CHILDREN (the stage already reads this type and the video wall does not
      // change) PLUS its own id (the folder reads this one before the camera one), and has the same
      // menu on "..." and on the right button.
      // It stays without selection and without being a drop target: the children link is `device_id`
      // (amendment E10).
      const childChannels = n.children.filter((c) => c.kind === 'camera').map((c) => c.id);
      return (
        <li
          key={n.id}
          className="tree-row tree-device"
          draggable
          // ponytail: the innermost row is the one that drags; without stopPropagation the dragstart
          // goes up
          onDragStart={(e) => {
            e.stopPropagation();
            if (childChannels.length) e.dataTransfer.setData(CAMERA_TYPE, childChannels.join(','));
            e.dataTransfer.setData(DEVICE_TYPE, n.id);
            e.dataTransfer.effectAllowed = 'move';
          }}
          onDoubleClick={(e) => { e.stopPropagation(); onOpen({ kind: 'device', id: n.id }); }}
          onContextMenu={(e) => {
            e.preventDefault();
            e.stopPropagation();
            // ponytail: the .cam-dots button always exists on this row; the ! only tells TS that
            const r = e.currentTarget.querySelector('.cam-dots')!.getBoundingClientRect();
            onAction({ type: 'menu', kind: 'device', id: n.id, x: r.right, y: r.bottom, name: n.name });
          }}
        >
          <span className="tree-cabeca">
            <span
              className={`tree-alca${isFiltering ? ' inativa' : ''}`} role="button" tabIndex={isFiltering ? -1 : 0}
              aria-label={deviceOpen ? t('cameras.collapse', { name: n.name }) : t('cameras.expand', { name: n.name })}
              aria-expanded={deviceOpen}
              aria-disabled={isFiltering || undefined}
              onClick={(e) => { e.stopPropagation(); if (!isFiltering) toggle(n.id); }}   // spec alca-inativa 3.2
              // ponytail: the double click on the arrow also needs stopPropagation — without it, it
              // goes up to the li onDoubleClick and throws the whole DVR on the stage
              onDoubleClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => { if (!isFiltering && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(n.id); } }}
            >
              {deviceOpen ? '▾' : '▸'}
            </span>
            <span className="tree-icone nx-device" aria-hidden="true">📹</span>
            <span className="tree-nome">{n.name}</span>
            <button
              type="button"
              className="cam-dots"
              aria-label={t('cameras.options', { name: n.name })}
              title={t('cameras.options', { name: n.name })}
              aria-haspopup="menu"
              onDoubleClick={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                const r = e.currentTarget.getBoundingClientRect();
                onAction({ type: 'menu-toggle', kind: 'device', id: n.id, x: r.right, y: r.bottom, name: n.name });
              }}
            >
              ⋯
            </button>
          </span>
          {deviceOpen && n.children.length > 0 && (
            <ul className="tree-filhos">{n.children.map(renderNode)}</ul>
          )}
        </li>
      );
    }
    // With a filter active the ancestor folder opens FORCED — otherwise the match would stay hidden
    // inside it. `closed` is not erased: it applies again when the filter clears (spec 4.3.4).
    const open = isFiltering || !closed.includes(n.id);
    return (
      <li
        key={n.id}
        className="tree-row tree-grupo"
        draggable
        // ponytail: the innermost row is the one that drags; without stopPropagation the dragstart
        // goes up and the outer folder overwrites the payload — dragging "Alfa 1" dragged "Alfa"
        onDragStart={(e) => { e.stopPropagation(); loadDragPayload(e, 'group', n.id); }}
        // ponytail: without stopPropagation the dragover goes up and the outer folder becomes the
        // highlight target
        onDragOver={(e) => { e.stopPropagation(); acceptDrag(e); setHovered(n.id); }}
        onDrop={(e) => handleDrop(e, n.id)}
        // ponytail: folder nested in folder — without stopPropagation the dblclick bubbles to the
        // ancestor <li> and the ancestor opens its own cameras too (spec 2026-10-27, 144 cells)
        onDoubleClick={(e) => { e.stopPropagation(); onOpen({ kind: 'group', id: n.id }); }}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation(); // folder nested in folder: the outer one cannot overwrite
          // ponytail: the .cam-dots button always exists on this row; the ! only tells TS that
          const r = e.currentTarget.querySelector('.cam-dots')!.getBoundingClientRect();
          onAction({ type: 'menu', kind: 'group', id: n.id, x: r.right, y: r.bottom, name: n.name });
        }}
      >
        {/* the selection click lives on the ROW (.tree-cabeca), not on the li: the children are
           siblings of the row wrapper, so a camera clicked inside the folder does not bubble here */}
        <span
          className={`tree-cabeca${hovered === n.id ? ' drop-alvo' : ''}${isMarked('group', n.id) ? ' sel' : ''}`}
          onClick={(e) => handleClick(e, 'group', n.id)}
        >
          <span
            className={`tree-alca${isFiltering ? ' inativa' : ''}`}
            role="button"
            tabIndex={isFiltering ? -1 : 0}
            aria-label={open ? t('cameras.collapse', { name: n.name }) : t('cameras.expand', { name: n.name })}
            aria-expanded={open}
            aria-disabled={isFiltering || undefined}
            onClick={(e) => { e.stopPropagation(); if (!isFiltering) toggle(n.id); }}   // spec alca-inativa 3.2
            // ponytail: the double click on the arrow also needs stopPropagation — without it, it
            // goes up to the folder li onDoubleClick, toggles twice (zero effect) and throws the WHOLE
            // folder on the wall (measured: Pacaraima sent 8 cameras, 2026-10-15)
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (!isFiltering && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); toggle(n.id); } }}
          >
            {open ? '▾' : '▸'}
          </span>
          <span className="tree-icone" aria-hidden="true">📁</span>
          <span className="tree-nome">{n.name}</span>
          <button
            type="button"
            className="cam-dots"
            aria-label={t('cameras.options', { name: n.name })}
            title={t('cameras.options', { name: n.name })}
            aria-haspopup="menu"
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              onAction({ type: 'menu-toggle', kind: 'group', id: n.id, x: r.right, y: r.bottom, name: n.name });
            }}
          >
            ⋯
          </button>
        </span>
        {open && n.children.length > 0 && (
          <ul className="tree-filhos">
            {n.children.map(renderNode)}
          </ul>
        )}
      </li>
    );
  }

  // Linha do nó servidor (spec 5.3): ícone 🖥, rótulo, ⋯. O ponto de status online/offline foi
  // removido a pedido (2026-10-30); o campo `online` segue no ServerNode (menu/poll).
  // Sem drag do nó, sem drop no nó, sem palco: duplo-clique só expandre/recolhe.
  function renderServer(s: ServerNode, childNodes: TreeNode<Camera>[]) {
    const open = !closed.includes(s.id);
    return (
      <li
        key={s.id}
        className="tree-row tree-servidor"
        onDoubleClick={() => toggle(s.id)}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          // ponytail: the .cam-dots button always exists on this row; the ! only tells TS that
          const r = e.currentTarget.querySelector('.cam-dots')!.getBoundingClientRect();
          onAction({ type: 'menu', kind: 'server', id: s.id, x: r.right, y: r.bottom, name: s.label });
        }}
      >
        <span className="tree-cabeca">
          <span
            className="tree-alca" role="button" tabIndex={0}
            aria-label={open ? t('cameras.collapse', { name: s.label }) : t('cameras.expand', { name: s.label })}
            aria-expanded={open}
            onClick={(e) => { e.stopPropagation(); toggle(s.id); }}
            onDoubleClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(s.id); } }}
          >
            {open ? '▾' : '▸'}
          </span>
          <span className="tree-icone" aria-hidden="true">🖥</span>
          <span className="tree-nome">{s.label}</span>
          <button
            type="button"
            className="cam-dots"
            aria-label={t('cameras.options', { name: s.label })}
            title={t('cameras.options', { name: s.label })}
            aria-haspopup="menu"
            onDoubleClick={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              const r = e.currentTarget.getBoundingClientRect();
              onAction({ type: 'menu-toggle', kind: 'server', id: s.id, x: r.right, y: r.bottom, name: s.label });
            }}
          >
            ⋯
          </button>
        </span>
        {open && childNodes.length > 0 && <ul className="tree-filhos">{childNodes.map(renderNode)}</ul>}
      </li>
    );
  }

  const nodes = buildTree(flat.groups, flat.cameras, flat.devices);
  // Uma sub-árvore por servidor com os dados daquele server_id (spec 5.3): buildTree/filterCameras
  // chamados por servidor, nunca sobre a lista mescla.
  const serverViews = servers.map((s) => ({
    server: s,
    view: viewFor(groups.filter((g) => g.server_id === s.id), cameras.filter((c) => c.server_id === s.id), devices.filter((d) => d.server_id === s.id)),
  }));
  return (
    <>
      {/* "Cameras" section: the tree existed with no header at all (the Layouts one has its own).
         Without the .tree-cabeca class on purpose: it carries flex-basis:100%, which in the sidebar
         column becomes 100% of the HEIGHT and swallows the screen (defect fixed on 2026-10-15) */}
      <div className="tree-secao">
        {/* plan 2026-10-30: a seção de câmeras passou a ser a de SERVIDORES (requisito 4) */}
        <span className="tree-nome">{t('servers.title')}</span>
        {/* spec 2026-10-18 (filters): the 📁 opens/closes the folders of BOTH sections; the dot cycles
            recording (all -> with -> without). The state lives in the App — here the component only
            renders. */}
        {onToggleFolders && (
          <button
            type="button"
            className="cam-dots ativo"
            title={t('cameras.expand_all')}
            aria-label={t('cameras.expand_all')}
            disabled={isFiltering}   // spec alca-inativa 3.1-3.2: no visible effect under a filter
            // spec 2026-10-18 (1.1) + fix 2026-10-19: the active look is FIXED and the click toggles
            // open/close, so the button is an action, not a switch. `aria-pressed` announced a state
            // the drawing never represented (and diverged on the 2nd click).
            onClick={onToggleFolders}
          >
            📁
          </button>
        )}
        {onCycleRecording && (
          <button
            type="button"
            className={`cam-dots filtro-gravacao${recordingFilter ? ' ativo' : ''}`}
            title={t('cameras.filter_by_recording')}
            aria-label={t('cameras.filter_by_recording')}
            aria-pressed={!!recordingFilter}
            onClick={onCycleRecording}
          >
            {/* SAME dot as the camera row (CameraStatus): empty = no filter, green outline = "without
                recording", full = "with recording" (design system: outline=empty, filled=recording) */}
            <span className={`badge${recordingFilter ? ' online' : ''}${recordingFilter === 'with' ? ' cheia' : ''}`} aria-hidden="true" />
          </button>
        )}
        {/* spec 5.3/D4: o + conecta servidor e NÃO tem portão de capacidade — sempre visível */}
        <button type="button" className="cam-dots mini-cta" title={t('servers.add')} aria-label={t('servers.add')} onClick={onConnectServer}>+</button>
      </div>
      {/* ponytail: the container is the drop area of the ROOT — the child drop stops propagation, so
          dropping inside a folder does not become "drop on the root" */}
      <ul className="tree" onDragEnd={() => setHovered(null)} onDragOver={acceptDrag} onDrop={(e) => handleDrop(e, null)}>
        {servers.length === 0 && nodes.length === 0 && <EmptyState as="li" className="muted" message={t('cameras.empty')} />}
        {servers.length === 0 && nodes.map(renderNode)}
        {serverViews.map(({ server, view }) => {
          // filtro ativo: servidor sem NENHUM match some (regra da pasta); sem filtro, servidor
          // vazio aparece — é estado real (spec 5.3)
          if (isFiltering && view.cameras.length === 0 && view.groups.length === 0) return null;
          return renderServer(server, buildTree(view.groups, view.cameras, view.devices));
        })}
      </ul>
      {/* empty strip: dropping here raises camera(s) or folder to the root (target null) */}
      <div className="tree-raiz" onDragOver={acceptDrag} onDrop={(e) => handleDrop(e, null)} />
    </>
  );
}
