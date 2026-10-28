import { createContext, useContext, useState, useCallback, useMemo, ReactNode } from 'react'
import en from './en.json'
import ar from './ar.json'
import fr from './fr.json'

export type Lang = 'en' | 'ar' | 'fr'

const resources: Record<Lang, Record<string, unknown>> = { en, ar, fr }

type Dict = Record<string, unknown>

function lookup(dict: Dict, key: string): string {
  const parts = key.split('.')
  let cur: unknown = dict
  for (const p of parts) {
    if (cur && typeof cur === 'object' && p in (cur as Dict)) cur = (cur as Dict)[p]
    else return key
  }
  return typeof cur === 'string' ? cur : key
}

export function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template
  return template.replace(/\{(\w+)\}/g, (_, k) => (k in vars ? String(vars[k]) : `{${k}}`))
}

interface I18nContextValue {
  lang: Lang
  setLang: (l: Lang) => void
  t: (key: string, vars?: Record<string, string | number>) => string
}

const I18nContext = createContext<I18nContextValue>({
  lang: 'en',
  setLang: () => undefined,
  t: (k) => k
})

export function I18nProvider({ lang, children }: { lang: Lang; children: ReactNode }): JSX.Element {
  const [current, setCurrent] = useState<Lang>(lang)
  const setLang = useCallback((l: Lang) => setCurrent(l), [])
  const t = useCallback(
    (key: string, vars?: Record<string, string | number>) => {
      const dict = resources[current] ?? en
      const fallback = resources.en ?? {}
      return interpolate(lookup(dict, key) !== key ? lookup(dict, key) : lookup(fallback, key), vars)
    },
    [current]
  )
  const value = useMemo(() => ({ lang: current, setLang, t }), [current, setLang, t])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useI18n(): I18nContextValue {
  return useContext(I18nContext)
}
