import { createRoot } from 'react-dom/client';
import './styles.css';
import App from './App.jsx';
import { LanguageProvider } from './shared/i18n/index.jsx';

const root = document.getElementById('root');
if (!root) throw new Error('#root ausente no index.html');
createRoot(root).render(
  <LanguageProvider>
    <App />
  </LanguageProvider>,
);
