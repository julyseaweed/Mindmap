import type { Theme } from './types';

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme === 'dark' ? '#191919' : '#ffffff');
}

export async function initializeTheme() {
  const initial = window.inkmap?.initialTheme ?? 'light';
  applyTheme(initial);
  if (window.inkmap) {
    // A renderer reload reads the current choice as well as the launch-time value.
    applyTheme(await window.inkmap.getTheme().catch(() => initial));
  }
}
