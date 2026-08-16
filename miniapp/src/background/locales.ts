const LOCALES: Record<string, string> = {
  ar: "ar-SA",
  de: "de-DE",
  en: "en-US",
  es: "es-ES",
  fr: "fr-FR",
  it: "it-IT",
  ko: "ko-KR",
  nl: "nl-NL",
  pt: "pt-BR",
  ru: "ru-RU",
  tr: "tr-TR",
  zh: "zh-CN",
}

export function toLocale(code: string): string {
  if (code.includes("-")) return code
  return LOCALES[code] ?? code
}
