export interface Language {
  code: string
  name: string
  native: string
}

export const LANGUAGES: Language[] = [
  {code: "zh", name: "Chinese", native: "中文"},
  {code: "en", name: "English", native: "English"},
  {code: "ar", name: "Arabic", native: "العربية"},
  {code: "nl", name: "Dutch", native: "Nederlands"},
  {code: "fr", name: "French", native: "Français"},
  {code: "de", name: "German", native: "Deutsch"},
  {code: "it", name: "Italian", native: "Italiano"},
  {code: "ko", name: "Korean", native: "한국어"},
  {code: "pt", name: "Portuguese", native: "Português"},
  {code: "ru", name: "Russian", native: "Русский"},
  {code: "es", name: "Spanish", native: "Español"},
  {code: "tr", name: "Turkish", native: "Türkçe"},
]

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.native ?? languageEnglishName(code)
}

export function languageEnglishName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code
}

export function languageOptionLabel(code: string): string {
  const language = LANGUAGES.find((l) => l.code === code)
  if (!language) return code
  if (language.native === language.name) return language.name
  return `${language.native} · ${language.name}`
}
