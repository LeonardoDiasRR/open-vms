import { createRoot } from 'react-dom/client';
import '@/styles.css';
import { LanguageProvider } from '@/shared/i18n';
import { ApiClient, type Camera } from '@/shared/utils/api';
import ArchiveView from '../pages/ArchiveView';

const seed: { token: string; cameras: Camera[] } = await (await fetch('/__playback_fixture')).json();
const api = new ApiClient(location.origin); api.token = seed.token;
createRoot(document.getElementById('root')!).render(
  <LanguageProvider><div style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
    <ArchiveView api={api} cameras={seed.cameras} groups={[]} openRequest={{ cameras: seed.cameras.map(c => c.id) }} />
  </div></LanguageProvider>,
);
