import {pinyin} from "pinyin-pro"

export function isChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
}

export function toPinyin(text: string): string {
  if (!isChinese(text)) return text
  return pinyin(text, {toneType: "symbol", type: "array"}).join(" ")
}

export function annotateChinese(text: string, preferPinyin: boolean): string {
  if (!isChinese(text)) return text
  if (preferPinyin) return toPinyin(text)
  return `${text} (${toPinyin(text)})`
}

export function languageWantsPinyin(language: string): boolean {
  return /pinyin/i.test(language)
}

export function languageIsChinese(language: string): boolean {
  const lower = language.toLowerCase()
  return lower.includes("zh") || lower.includes("chinese")
}
