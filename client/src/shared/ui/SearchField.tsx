import { Search, X } from 'lucide-react';
import { useT } from '@/shared/i18n';

type Props = { value: string; onChange: (v: string) => void; label?: string };

// Sidebar search, in the style of NX's SearchField.qml: magnifier on the left, placeholder,
// X button on the right that only shows with text and clears the field.
// ponytail: `type="text"` on purpose — `type="search"` adds the browser's NATIVE X and there
// would be two clear buttons. The visual lives in the .busca* classes of styles.css, like the
// rest of the sidebar (the component carries no styles).
// spec 2026-10-17: the PTZ panel filters saved positions — the fixed search text talks about
// cameras and layouts, which is a lie in there. Callers that pass nothing keep the left bar text.
export default function SearchField({ value, onChange, label }: Props) {
  const { t } = useT();
  const placeholder = t('shared.search_placeholder');
  return (
    <div className="busca">
      <Search className="busca-icone" size={14} aria-hidden="true" />
      <input
        className="busca-campo"
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onChange(''); }}
        placeholder={placeholder}
        aria-label={label ?? placeholder}
      />
      {value !== '' && (
        <button type="button" className="busca-limpar" aria-label={t('shared.clear_search')} title={t('shared.clear_search')} onClick={() => onChange('')}>
          <X size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
