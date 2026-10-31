export type Language = 'en' | 'pt-BR';

export function formatters(lang: Language) {
  return {
    date: (v: number | string | Date) =>
      new Intl.DateTimeFormat(lang, { dateStyle: 'short', timeStyle: 'short' }).format(new Date(v)),
    compare: (a: string, b: string) => a.localeCompare(b, lang, { numeric: true }),
  };
}
