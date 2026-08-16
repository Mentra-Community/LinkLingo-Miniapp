export interface Language {
  code: string
  name: string
}

export const LANGUAGES: Language[] = [
  {code: "ar", name: "Arabic"},
  {code: "zh", name: "Chinese"},
  {code: "nl", name: "Dutch"},
  {code: "en", name: "English"},
  {code: "fr", name: "French"},
  {code: "de", name: "German"},
  {code: "it", name: "Italian"},
  {code: "ko", name: "Korean"},
  {code: "pt", name: "Portuguese"},
  {code: "ru", name: "Russian"},
  {code: "es", name: "Spanish"},
  {code: "tr", name: "Turkish"},
]

export function languageName(code: string): string {
  return LANGUAGES.find((l) => l.code === code)?.name ?? code
}
