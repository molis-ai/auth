// Explicit presentation preferences only. Passwords and session credentials never enter browser storage.
const emailKey = 'molis.auth.remembered-email';
const languageKey = 'molis.auth.locale';
export function rememberedEmail(): string {
  try { return localStorage.getItem(emailKey) ?? ''; } catch { return ''; }
}
export function rememberEmail(value: string): void {
  try { if (value) localStorage.setItem(emailKey, value); else localStorage.removeItem(emailKey); } catch { /* Optional convenience. */ }
}
export function entryLanguage(): 'zh-CN' | 'en' {
  try { const saved = localStorage.getItem(languageKey); if (saved === 'en' || saved === 'zh-CN') return saved; } catch { /* Use the browser preference. */ }
  return navigator.language.startsWith('zh') ? 'zh-CN' : 'en';
}
export function saveEntryLanguage(value: 'zh-CN' | 'en'): void {
  document.documentElement.lang = value;
  try { localStorage.setItem(languageKey, value); } catch { /* Optional preference. */ }
}
