const htmlEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };

// Keep one Markdown block per topic. Inline breaks also work in the root heading;
// literal HTML is escaped so importing it cannot turn topic text into markup.
function topicText(text) {
  // A standalone <br> starts an HTML block and can swallow nested list items.
  if (/^\n+$/.test(text)) return '&#10;'.repeat(text.length);
  return text.split('\n').map(line => line
    .replace(/[\\`*_\[\]#~@&<>]/g, char => htmlEscapes[char] ?? `\\${char}`)
    // GFM autolinks treat backslashes as URL characters instead of Markdown escapes.
    .replace(/\b(?:https?:\/\/|ftp:\/\/|www\.)/gi, prefix => prefix.replace(/[:.]/, '\\$&'))
    .replace(/^([+-])/, '\\$1')
    .replace(/^(\d{1,9})([.)])(?=\s|$)/, '$1\\$2')
    .replace(/[\t\r]/g, char => `&#${char.charCodeAt(0)};`)
    .replace(/^ +| +$/g, spaces => '&#32;'.repeat(spaces.length)))
    .join('<br>');
}

/** Export all topic text and hierarchy; images, relationships and layout stay in .mindmap. */
export function toMarkdown(doc) {
  const root = doc.nodes[doc.rootId];
  const rootText = topicText(root.text);
  const lines = [rootText ? `# ${rootText}` : '#', ''];
  const stack = root.children.toReversed().map(id => ({ id, depth: 0 }));
  while (stack.length) {
    const { id, depth } = stack.pop();
    const node = doc.nodes[id];
    const text = topicText(node.text);
    lines.push(`${'  '.repeat(depth)}*${text ? ` ${text}` : ''}`);
    for (const child of node.children.toReversed()) stack.push({ id: child, depth: depth + 1 });
  }
  return lines.join('\n').trimEnd() + '\n';
}
