export function saveTheme(theme: 'light' | 'dark'): void {
  window.localStorage.setItem('theme', theme)
}
