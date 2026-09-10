import './pdf-export.css';

interface PdfExportSize { width: number; height: number }
interface PreparedPdfExport extends PdfExportSize { dispose(): void }

const margin = 36;
const minimumPage = 96;
const maximumPage = 17280;
let exportSequence = 0;

export function preparePdfExport(world: HTMLElement, size: PdfExportSize, title: string): PreparedPdfExport {
  if (!world.isConnected || !Number.isFinite(size.width) || !Number.isFinite(size.height) || size.width <= 0 || size.height <= 0) {
    throw new Error('导图尺寸无效，暂时无法导出 PDF。');
  }
  const document = world.ownerDocument;
  if (document.getElementById('pdf-export')) throw new Error('已有导图正在导出，请稍候再试。');
  const scale = Math.min(1, (maximumPage - margin * 2) / Math.max(size.width, size.height));
  const width = Math.max(minimumPage, Math.min(maximumPage, Math.ceil(size.width * scale + margin * 2)));
  const height = Math.max(minimumPage, Math.min(maximumPage, Math.ceil(size.height * scale + margin * 2)));
  const host = document.createElement('div');
  const pageStyle = document.createElement('style');
  const dispose = () => { host.remove(); pageStyle.remove(); };

  try {
    host.id = 'pdf-export';
    host.setAttribute('role', 'img');
    host.setAttribute('aria-label', title);
    host.style.width = `${width}px`;
    host.style.height = `${height}px`;
    const sourceNode = world.querySelector<HTMLElement>('.mind-node') ?? world;
    const font = document.defaultView?.getComputedStyle(sourceNode).fontFamily;
    if (font) host.style.setProperty('--pdf-node-font', font);

    const clone = world.cloneNode(true) as HTMLElement;
    clone.classList.add('pdf-world');
    clone.style.setProperty('left', `${margin}px`, 'important');
    clone.style.setProperty('top', `${margin}px`, 'important');
    clone.style.setProperty('width', `${size.width}px`, 'important');
    clone.style.setProperty('height', `${size.height}px`, 'important');
    clone.style.setProperty('transform', `scale(${scale})`, 'important');
    clone.querySelectorAll('button').forEach(button => button.remove());
    clone.querySelectorAll('.node-resize-handle, .node-image-resizer').forEach(handle => handle.remove());
    clone.querySelectorAll('.node-image').forEach(image => { image.classList.remove('is-selected'); image.removeAttribute('tabindex'); });
    const inputValues = Array.from(world.querySelectorAll('textarea'), input => input.value);
    clone.querySelectorAll('textarea').forEach((input, index) => {
      const text = document.createElement('span');
      text.className = 'node-text pdf-textarea-fallback';
      text.textContent = inputValues[index] ?? input.value;
      input.replaceWith(text);
    });
    clone.querySelectorAll<HTMLElement>('.mind-node').forEach(node => {
      node.classList.remove('selected', 'editing', 'drag-source', 'drop-inside', 'drop-before', 'drop-after');
      node.removeAttribute('aria-selected');
      node.removeAttribute('tabindex');
    });

    // Each snapshot has private SVG marker ids, independent of the on-screen graph.
    const prefix = `pdf-${++exportSequence}-`;
    const ids = new Map<string, string>();
    const elements = [clone, ...Array.from(clone.querySelectorAll('*'))];
    for (const element of elements) {
      const id = element.getAttribute('id');
      if (id) { const next = prefix + id; ids.set(id, next); element.setAttribute('id', next); }
    }
    for (const element of elements) {
      for (const attribute of Array.from(element.attributes)) {
        let value = attribute.value.replace(/url\(\s*(['"]?)#([^\s)'"]+)\1\s*\)/g, (reference, _quote: string, id: string) => ids.has(id) ? `url(#${ids.get(id)})` : reference);
        if ((attribute.name === 'href' || attribute.name === 'xlink:href') && value.startsWith('#') && ids.has(value.slice(1))) value = '#' + ids.get(value.slice(1));
        if (value !== attribute.value) element.setAttribute(attribute.name, value);
      }
    }

    host.append(clone);
    pageStyle.textContent = `@page { size: ${width}px ${height}px; margin: 0; }`;
    document.head.append(pageStyle);
    document.body.append(host);
    return { width, height, dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
