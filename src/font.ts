import { NODE_STYLE } from './core.mjs';
import './font.css';

export type AppFont = 'serif' | 'nevermind';

const preferenceKey = 'mindmap.font';

async function loadFont(font: AppFont): Promise<void> {
  const size = NODE_STYLE.fontSize;
  if (font === 'nevermind') {
    const faces = await Promise.all([
      document.fonts.load(`${size}px "NeverMind"`, 'English'),
      document.fonts.load(`700 ${size}px "NeverMind"`, 'English'),
      document.fonts.load(`${size}px "Microsoft YaHei"`, '中文'),
    ]);
    if (!faces[0].length || !faces[1].length) throw new Error('字体加载失败，请重试。');
  } else {
    await Promise.all([
      document.fonts.load(`${size}px "URW Classico"`, 'English'),
      document.fonts.load(`700 ${size}px "URW Classico"`, 'English'),
      document.fonts.load(`italic ${size}px "URW Classico"`, 'English'),
      // Missing system fonts use the existing CSS serif fallback.
      document.fonts.load(`${size}px "PMingLiU"`, '中文').catch(() => []),
    ]);
  }
}

export async function applyFont(font: AppFont): Promise<void> {
  await loadFont(font);
  document.documentElement.dataset.font = font;
  try { localStorage.setItem(preferenceKey, font); } catch { /* The current window can still use the font when storage is unavailable. */ }
}

export async function initializeFont(): Promise<void> {
  let font: AppFont = 'serif';
  try { if (localStorage.getItem(preferenceKey) === 'nevermind') font = 'nevermind'; } catch { /* Keep the original font when storage is unavailable. */ }
  try { await applyFont(font); }
  catch {
    document.documentElement.dataset.font = 'serif';
    await loadFont('serif').catch(() => undefined);
  }
}
