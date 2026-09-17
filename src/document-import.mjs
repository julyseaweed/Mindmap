import { Lexer } from 'marked';
import { createDocument, uid, validateDocument } from './core.mjs';
import { parseMermaid } from './mermaid-import.mjs';
import { decodeTextEntities } from './text-entities.mjs';

export const MAX_IMPORT_BYTES = 4 * 1024 * 1024;
const tooLarge = () => { throw new Error('文档内容过多，暂时无法转换为导图。请拆分后再打开。'); };
const inlineText = tokens => (tokens ?? []).map(token => {
  if (token.type === 'br') return '\n';
  if (token.type === 'codespan' || token.type === 'escape') return token.text;
  if (token.type === 'link' || token.type === 'image') {
    const label = inlineText(token.tokens) || token.text || '';
    return !token.href || label === token.href ? label : `${label}${label ? ' ' : ''}(${token.href})`;
  }
  if (token.tokens) return inlineText(token.tokens);
  return decodeTextEntities(token.text ?? token.raw ?? '');
}).join('');
const isMermaidBlock = token => token.type === 'code' && /^(mermaid|mmd)(?:\s|$)/i.test(token.lang ?? '');

function markdownDocument(source, filenameTitle) {
  // Front matter is document metadata, never instructions or executable YAML.
  let title = filenameTitle;
  const frontmatter = source.match(/^---[ \t]*\n([\s\S]*?)\n(?:---|\.\.\.)[ \t]*(?:\n|$)/);
  if (frontmatter) {
    const configuredTitle = frontmatter[1].match(/^title:\s*(.+?)\s*$/m)?.[1];
    if (configuredTitle) title = configuredTitle.replace(/^(["'])(.*)\1$/, '$2');
    source = source.slice(frontmatter[0].length);
  }
  // A raw Mermaid document is also useful when saved with an .md extension.
  const declaration = source.replace(/^\s*(?:(?:%%\{[\s\S]*?\}%%|%%[^\n]*(?:\n|$))\s*)*/, '');
  if (/^(?:(?:flowchart|graph)[ \t]+(?:LR|RL|TB|TD|BT)(?=[ \t]*(?:;|\n|$))|mindmap[ \t]*(?:\n|$))/i.test(declaration)) return parseMermaid(source, title);
  let tokens;
  try { tokens = Lexer.lex(source, { gfm: true }).filter(token => !['space', 'def'].includes(token.type)); }
  catch { throw new Error('无法解析这份 Markdown。请检查文档内容或拆分后再打开。'); }
  if (!tokens.length) throw new Error('文件里没有可以导入的文字或 Mermaid 图。');
  if (tokens.length === 1 && isMermaidBlock(tokens[0])) return parseMermaid(tokens[0].text, title);
  if (tokens.length === 2 && tokens[0].type === 'heading' && isMermaidBlock(tokens[1])) return parseMermaid(tokens[1].text, inlineText(tokens[0].tokens) || title);

  const doc = createDocument(title.trim().slice(0, 200) || '导入导图');
  doc.nodes.root.text = doc.title;
  let nodeCount = 1, relationshipCount = 0, contentCount = 0;
  const add = (parent, text) => {
    if (++nodeCount > 2000 || text.length > 8000) tooLarge();
    const id = uid();
    doc.nodes[id] = { id, text, children: [], collapsed: false };
    doc.nodes[parent].children.push(id);
    contentCount++;
    return id;
  };
  const attachDiagram = (parent, source) => {
    const graph = parseMermaid(source, doc.title);
    const ids = new Map();
    for (const node of Object.values(graph.nodes)) ids.set(node.id, add(parent, node.text));
    const attached = new Set(ids.values());
    doc.nodes[parent].children = doc.nodes[parent].children.filter(id => !attached.has(id));
    doc.nodes[parent].children.push(ids.get(graph.rootId));
    for (const node of Object.values(graph.nodes)) doc.nodes[ids.get(node.id)].children = node.children.map(id => ids.get(id));
    for (const relationship of graph.relationships ?? []) {
      if (++relationshipCount > 2000) tooLarge();
      (doc.relationships ??= []).push({ ...relationship, id: uid(), sourceId: ids.get(relationship.sourceId), targetId: ids.get(relationship.targetId) });
    }
  };
  const blocks = (items, parent, depth = 0) => {
    if (depth > 128) tooLarge();
    const headings = [{ level: 0, id: parent }];
    for (const token of items) {
      const current = () => headings.at(-1).id;
      if (token.type === 'heading') {
        while (headings.length > 1 && headings.at(-1).level >= token.depth) headings.pop();
        headings.push({ level: token.depth, id: add(current(), inlineText(token.tokens)) });
      } else if (token.type === 'list') {
        for (const item of token.items) {
          const children = item.tokens.filter(token => !['space', 'def'].includes(token.type));
          const first = children[0];
          const label = first && ['paragraph', 'text'].includes(first.type) ? inlineText(first.tokens) || first.text : '';
          const id = add(current(), `${item.task ? (item.checked ? '☑ ' : '☐ ') : ''}${label}`);
          blocks(label ? children.slice(1) : children, id, depth + 1);
        }
      } else if (token.type === 'blockquote') blocks(token.tokens, current(), depth + 1);
      else if (isMermaidBlock(token)) attachDiagram(current(), token.text);
      else if (token.type === 'table') {
        const header = add(current(), token.header.map(cell => inlineText(cell.tokens)).join(' | '));
        for (const row of token.rows) add(header, row.map(cell => inlineText(cell.tokens)).join(' | '));
      } else if (['paragraph', 'text', 'html', 'code'].includes(token.type)) {
        const text = token.tokens ? inlineText(token.tokens) : token.text;
        if (text?.trim()) add(current(), text);
      } else if (!['space', 'def', 'hr'].includes(token.type)) throw new Error('这份 Markdown 包含暂时无法转换的内容。');
    }
  };
  // Use a document's single leading heading as its actual root, without an extra wrapper.
  const first = tokens[0];
  if (first.type === 'heading' && tokens.slice(1).every(token => token.type !== 'heading' || token.depth > first.depth)) {
    doc.nodes.root.text = inlineText(first.tokens);
    doc.title = doc.nodes.root.text.trim().slice(0, 200) || doc.title;
    if (doc.nodes.root.text.length > 8000) tooLarge();
    contentCount++;
    tokens = tokens.slice(1);
  }
  blocks(tokens, doc.rootId);
  if (!contentCount) throw new Error('文件里没有可以导入的文字或 Mermaid 图。');
  return validateDocument(doc);
}

export function importTextDocument(source, extension, filenameTitle = '导入导图') {
  if (typeof source !== 'string' || source.includes('\0')) throw new Error('请选择有效的 UTF-8 文本文件。');
  source = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (!source.trim()) throw new Error('文件是空的，没有可以导入的内容。');
  if (Buffer.byteLength(source, 'utf8') > MAX_IMPORT_BYTES || source.split('\n').length > 20000) tooLarge();
  const title = filenameTitle.trim().slice(0, 200) || '导入导图';
  if (['.mmd', '.mermaid'].includes(extension.toLowerCase())) {
    if (/^\s*(?:`{3,}|~{3,})/.test(source)) {
      const tokens = Lexer.lex(source).filter(token => token.type !== 'space');
      if (tokens.length === 1 && tokens[0].type === 'code') return parseMermaid(tokens[0].text, title);
    }
    return parseMermaid(source, title);
  }
  if (['.md', '.markdown'].includes(extension.toLowerCase())) return markdownDocument(source, title);
  throw new Error('请选择 Markdown 或 Mermaid 文件。');
}
