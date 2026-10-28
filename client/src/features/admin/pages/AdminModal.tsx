import { useRef, useState } from 'react';
import { useEsc } from '@/shared/hooks/useEsc';
import { useModalFocus } from '@/shared/hooks/useFocoModal';
import type { ApiClient } from '@/shared/utils/api';
import type { PromptHandle } from '@/shared/components/PromptDialog';
import type { Notify } from '@/shared/components/Toast';
import { useT } from '@/shared/i18n';
import UsersTable from '../components/TabelaUsuarios';
import ProfilesTable from '../components/TabelaPerfis';
import RecordingsTab from './AbaGravacoes';

// spec §12-F4 + 2026-10-18 (4.7): the administration screens in a modal with tabs. The 1000 px width
// comes from the modifier class `.nx-dialog-largo` (styles.css); `.nx-dialog` stays in the class list
// because the AdminModal.test.tsx guard pins the selector. The toast comes from the App: without it
// (the old calls) the default is to notify nothing.
type Api = Pick<ApiClient, 'users' | 'accessProfiles' | 'accessProfileGrants' | 'cameras' | 'createUser'
  | 'patchUser' | 'renameUser' | 'deleteUser' | 'resetPassword' | 'createAccessProfile'
  | 'patchAccessProfile' | 'deleteAccessProfile' | 'settings' | 'settingsPatch'>;
type TabId = 'users' | 'profiles' | 'recordings';
const noNotify: Notify = () => {};

// phase 4 contract (consumed in 4.5): the three tabs answer to capability PROPS. Default true keeps
// every existing caller (and test) working until the App passes the real can() results.
export default function AdminModal({ api, dlg, onClose, notify = noNotify,
  canUsers = true, canProfiles = true, canRetention = true }:
{ api: Api; dlg: PromptHandle; onClose: () => void; notify?: Notify;
  canUsers?: boolean; canProfiles?: boolean; canRetention?: boolean }) {
  const t = useT().t;
  const allTabs: { id: TabId; label: string }[] = [
    { id: 'users', label: t('admin.tab.users') },
    { id: 'profiles', label: t('admin.tab.profiles') },
    { id: 'recordings', label: t('admin.tab.recordings') },
  ];
  // phase 4: a tab is only listed when its capability prop allows it (the default tab follows suit)
  const tabs = allTabs.filter((a) => (a.id === 'users' ? canUsers : a.id === 'profiles' ? canProfiles : canRetention));
  const [tab, setTab] = useState<TabId>(canUsers ? 'users' : canProfiles ? 'profiles' : 'recordings');
  const ref = useRef<HTMLDivElement>(null);
  useModalFocus(ref);
  useEsc(onClose);
  return (
    <div className="nx-backdrop">
      <div className="nx-dialog nx-dialog-largo" role="dialog" aria-modal="true" aria-labelledby="adm-titulo" ref={ref}>
        <div className="nx-titlebar">
          <span className="nx-title" id="adm-titulo">{t('admin.title')}</span>
          <button className="nx-close" onClick={onClose} title={t('shared.close')}>✕</button>
        </div>
        <div className="nx-tabs">
          {tabs.map((a) => (
            <button key={a.id} className={`nx-tab${a.id === tab ? ' active' : ''}`} onClick={() => setTab(a.id)}>{a.label}</button>
          ))}
        </div>
        <div className="nx-body">
          {tab === 'users'
            ? <UsersTable api={api} dlg={dlg} notify={notify} />
            : tab === 'profiles'
              ? <ProfilesTable api={api} dlg={dlg} notify={notify} />
              : <RecordingsTab api={api} />}
        </div>
      </div>
    </div>
  );
}
