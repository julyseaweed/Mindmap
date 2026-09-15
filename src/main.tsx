import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initializeTheme } from './theme';
import { initializeFont } from './font';
import { NODE_STYLE } from './core.mjs';
import './styles.css';

for (const [name, value] of Object.entries({
  'padding-x': NODE_STYLE.paddingX, 'padding-y': NODE_STYLE.paddingY, 'border-width': NODE_STYLE.borderWidth,
  'font-size': NODE_STYLE.fontSize, 'line-height': NODE_STYLE.lineHeight, 'content-gap': NODE_STYLE.contentGap,
})) document.documentElement.style.setProperty(`--node-${name}`, `${value}px`);

// Finish appearance and font loading before measuring any diagram nodes.
void Promise.allSettled([
  initializeTheme(),
  initializeFont(),
]).then(() => {
  createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
});
