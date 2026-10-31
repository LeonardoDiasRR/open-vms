import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { en, type MessageKey } from './en';
import { ptBR } from './pt-BR';
import type { Language } from './format';

export type { Language } from './format';

const STORAGE_KEY = 'openvms.lang';

const DICTS: Record<Language, Record<MessageKey, string>> = { en, 'pt-BR': ptBR };

function readLang(): Language {
  const saved = localStorage.getItem(STORAGE_KEY);
  return saved === 'en' || saved === 'pt-BR' ? saved : 'pt-BR';
}

function interpolate(text: string, vars?: Record<string, string | number>): string {
  if (!vars) return text;
  return text.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}

type TContextValue = {
  t: (k: MessageKey, vars?: Record<string, string | number>) => string;
  tn: (k: string, n: number) => string;
  lang: Language;
  setLang: (l: Language) => void;
  locale: Language;
};

const TContext = createContext<TContextValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }): React.JSX.Element {
  const [lang, setLangState] = useState<Language>(readLang);

  // ponytail: one effect covers mount and change; setLang only touches state + storage.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const setLang = useCallback((next: Language) => {
    localStorage.setItem(STORAGE_KEY, next);
    setLangState(next);
  }, []);

  const value = useMemo<TContextValue>(() => {
    const t = (k: MessageKey, vars?: Record<string, string | number>) =>
      interpolate(DICTS[lang][k] ?? k, vars);
    const tn = (k: string, n: number) => {
      const shape = `${k}.${n === 1 ? 'one' : 'other'}`;
      return interpolate(DICTS[lang][shape as MessageKey] ?? shape, { n });
    };
    return { t, tn, lang, setLang, locale: lang };
  }, [lang, setLang]);

  return <TContext.Provider value={value}>{children}</TContext.Provider>;
}

export function useT(): TContextValue {
  const ctx = useContext(TContext);
  if (!ctx) throw new Error('useT must be used within LanguageProvider');
  return ctx;
}
