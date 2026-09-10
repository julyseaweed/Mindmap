import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initializeTheme } from './theme';
import { NODE_STYLE } from './core.mjs';
import './styles.css';

for (const [name, value] of Object.entries({
  'padding-x': NODE_STYLE.paddingX, 'padding-y': NODE_STYLE.paddingY, 'border-width': NODE_STYLE.borderWidth,
  'font-size': NODE_STYLE.fontSize, 'line-height': NODE_STYLE.lineHeight, 'content-gap': NODE_STYLE.contentGap,
})) document.documentElement.style.setProperty(`--node-${name}`, `${value}px`);

// Load both scripts before measuring and positioning any diagram nodes.
void Promise.all([
  initializeTheme(),
  document.fonts.load(`${NODE_STYLE.fontSize}px "PMingLiU"`, '中文'),
  document.fonts.load(`${NODE_STYLE.fontSize}px "URW Classico"`, 'English'),
  document.fonts.load(`700 ${NODE_STYLE.fontSize}px "URW Classico"`, 'English'),
  document.fonts.load(`italic ${NODE_STYLE.fontSize}px "URW Classico"`, 'English'),
]).finally(() => {
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
});
