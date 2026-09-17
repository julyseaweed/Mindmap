import { createDocument, validateDocument } from './core.mjs';
import { decodeTextEntities } from './text-entities.mjs';

const MAX_SOURCE = 2 * 1024 * 1024;
const MAX_NODES = 2000;
const MAX_EDGES = 6000;
const shapes = [
  ['(((', ')))'], ['([', '])'], ['[[', ']]'], ['[(', ')]'], ['((', '))'],
  ['{{', '}}'], ['[/', '/]'], ['[\\', '\\]'], ['[/', '\\]'], ['[\\', '/]'],
  ['[', ']'], ['(', ')'], ['{', '}'], ['>', ']'], ['))', '(('], [')', '('],
];
const invalid = detail => new Error(`无法导入 Mermaid：${detail}`);

function labelText(raw) {
  let text = raw.trim();
  if (text.startsWith('"') && text.endsWith('"')) text = text.slice(1, -1);
  if (text.startsWith('`') && text.endsWith('`')) text = text.slice(1, -1);
  // Only format text. Never interpret HTML, evaluate directives, or load resources.
  text = text.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/?(?:b|strong|i|em|u|s|del|span)(?:\s[^<>]*)?>/gi, '');
  if (/<\/?[a-z][^>]*>/i.test(text)) throw invalid('节点中含有暂不支持的 HTML 或图片标签。');
  text = decodeTextEntities(text, { mermaid: true });
  if (text.length > 8000) throw invalid('单个节点或联系的文字超过了 8000 字符。');
  return text.trim() ? text : '';
}

function stripPrelude(source) {
  let text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (text.startsWith('---\n')) {
    const end = text.indexOf('\n---', 4);
    if (end < 0 || !/^\n---(?:\n|$)/.test(text.slice(end))) throw invalid('文件开头的配置区没有正确结束。');
    text = text.slice(end + 4).trimStart();
  }
  while (text.startsWith('%%')) {
    const directive = text.startsWith('%%{');
    const end = directive ? text.indexOf('}%%', 3) : text.indexOf('\n');
    if (end < 0) {
      if (directive) throw invalid('Mermaid 配置区没有正确结束。');
      return '';
    }
    text = text.slice(end + (directive ? 3 : 1)).trimStart();
  }
  return text;
}

// Statement separators inside node/edge labels are literal text, including entity semicolons.
function statements(text) {
  const result = [];
  let start = 0, quote = false, pipe = false, stack = [];
  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    if (char === '"') { quote = !quote; continue; }
    if (quote) continue;
    if (!stack.length && !pipe && text.startsWith('%%', i)) {
      if (text.slice(start, i).trim()) result.push(text.slice(start, i).trim());
      const directive = text.startsWith('%%{', i);
      const end = directive ? text.indexOf('}%%', i + 3) : text.indexOf('\n', i + 2);
      if (directive && end < 0) throw invalid('Mermaid 配置区没有正确结束。');
      i = end < 0 ? text.length : end + (directive ? 2 : 0);
      start = i + 1;
      continue;
    }
    if (!stack.length && char === '|') { pipe = !pipe; continue; }
    if (pipe) continue;
    if ('[({'.includes(char)) stack.push(char);
    else if (char === '>' && !stack.length && !/[-=.<]/.test(text[i - 1] ?? '')) stack.push('[');
    else if ('])}'.includes(char)) {
      if (!stack.length) throw invalid('节点括号没有正确配对。');
      const open = stack.pop();
      if ('[({'.indexOf(open) !== '])}'.indexOf(char)) throw invalid('节点括号没有正确配对。');
    }
    if (!stack.length && (char === ';' || char === '\n')) {
      if (text.slice(start, i).trim()) result.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  if (quote || pipe || stack.length) throw invalid('文字引号、节点括号或联系标签没有正确结束。');
  if (text.slice(start).trim()) result.push(text.slice(start).trim());
  return result;
}

class FlowReader {
  constructor(text, graph) { this.text = text; this.at = 0; this.graph = graph; }
  skip() { while (/\s/.test(this.text[this.at] ?? '') && this.at < this.text.length) this.at++; }
  rest() { return this.text.slice(this.at); }
  node() {
    this.skip();
    const start = this.at;
    while (this.at < this.text.length) {
      const rest = this.rest(), char = rest[0];
      if (/\s/.test(char) || /[\[\](){}<>|&;:@"`]/.test(char) || /^(?:--|==|-\.)/.test(rest)) break;
      this.at++;
    }
    const key = this.text.slice(start, this.at);
    if (!key || !/^[\p{L}\p{N}_.-]+$/u.test(key)) throw invalid('包含无法识别的节点或连线写法。');
    if (['end', 'subgraph'].includes(key)) throw invalid('暂不支持 subgraph 分组，请先展开为普通节点。');
    this.skip();
    let text;
    if (/^[\[({>]/.test(this.rest())) text = this.shape();
    this.skip();
    if (this.rest().startsWith('@')) throw invalid('暂不支持 @{…} 节点属性、图片或图标节点。');
    if (this.rest().startsWith(':::')) {
      const match = /^:::[\p{L}\p{N}_,-]+/u.exec(this.rest());
      if (!match) throw invalid('节点样式名称无效。');
      this.at += match[0].length;
    }
    this.graph.node(key, text);
    return key;
  }
  shape() {
    const options = shapes.filter(([open]) => this.rest().startsWith(open));
    // The slash shapes have two possible closing forms; locate the actual ending.
    for (const [open, close] of options) {
      let quote = false;
      for (let i = this.at + open.length; i < this.text.length; i++) {
        if (this.text[i] === '"') { quote = !quote; continue; }
        if (!quote && this.text.startsWith(close, i)) {
          const raw = this.text.slice(this.at + open.length, i);
          if (!raw.startsWith('"') && /[\[\](){}]/.test(raw)) continue;
          this.at = i + close.length;
          return labelText(raw);
        }
      }
    }
    throw invalid('节点文字或括号格式无效。');
  }
  group() {
    const keys = [this.node()];
    this.skip();
    while (this.text[this.at] === '&') { this.at++; keys.push(this.node()); this.skip(); }
    return keys;
  }
  edge() {
    this.skip();
    let token = /^(?:<)?(?:-{2,}>|-{3,}|-\.{1,}->?|-\.{1,}-|={2,}>|={3,})|^<-{2,}/.exec(this.rest())?.[0];
    let text = '';
    if (token) {
      this.at += token.length;
      if (!token.endsWith('>') && /^[ox]/.test(this.rest())) throw invalid('暂不支持带圆圈或叉号端点的连线。');
    }
    else {
      // Mermaid also allows A -- words --> B / A -. words .-> B.
      const prefix = /^(--|-\.|==)\s+/.exec(this.rest());
      if (!prefix) throw invalid('暂不支持这种连线写法。');
      this.at += prefix[0].length;
      const ending = prefix[1] === '-.' ? '.->' : prefix[1] === '==' ? '==>' : '-->';
      let end = this.at, quote = false;
      while (end < this.text.length) {
        if (this.text[end] === '"') quote = !quote;
        if (!quote && this.text.startsWith(ending, end)) break;
        end++;
      }
      if (end === this.text.length) throw invalid('联系文字后的箭头不完整。');
      text = labelText(this.text.slice(this.at, end));
      this.at = end + ending.length;
      token = prefix[1] === '-.' ? '-.->' : prefix[1] === '==' ? '==>' : '-->';
    }
    this.skip();
    if (this.text[this.at] === '|') {
      if (text) throw invalid('同一条联系包含了两种文字标签写法。');
      const start = ++this.at;
      let quote = false;
      while (this.at < this.text.length) {
        if (this.text[this.at] === '"') quote = !quote;
        if (!quote && this.text[this.at] === '|') break;
        this.at++;
      }
      if (this.at === this.text.length) throw invalid('联系标签没有正确结束。');
      text = labelText(this.text.slice(start, this.at++));
    }
    return { dashed: token.includes('.'), reverse: token.startsWith('<'), forward: !token.startsWith('<') || token.endsWith('>'), text };
  }
  parse() {
    let sources = this.group();
    this.skip();
    while (this.at < this.text.length) {
      const edge = this.edge();
      const targets = this.group();
      for (const source of sources) for (const target of targets) {
        if (edge.forward) this.graph.edge(source, target, edge);
        if (edge.reverse) this.graph.edge(target, source, { ...edge, dashed: edge.forward || edge.dashed });
      }
      sources = targets;
      this.skip();
    }
  }
}

function graphModel() {
  const nodes = new Map(), edges = [], edgeKeys = new Set();
  return {
    nodes, edges,
    node(key, text) {
      if ((text ?? key).length > 8000) throw invalid('单个节点的文字超过了 8000 字符。');
      if (!nodes.has(key)) {
        if (nodes.size >= MAX_NODES) throw invalid('节点超过了 2000 个。');
        nodes.set(key, { id: `n${nodes.size}`, text: text ?? key, children: [], collapsed: false });
      } else if (text !== undefined) nodes.get(key).text = text;
    },
    edge(source, target, edge) {
      if (source === target) throw invalid('暂不支持节点指向自身的连线。');
      const key = JSON.stringify([source, target, !!edge.dashed, edge.text ?? '']);
      if (edgeKeys.has(key)) return;
      if (edges.length >= MAX_EDGES) throw invalid('连线数量过多。');
      edgeKeys.add(key);
      edges.push({ source, target, dashed: !!edge.dashed, text: edge.text ?? '' });
    },
  };
}

function documentFromGraph(graph, title) {
  const { nodes, edges } = graph;
  if (!nodes.size) throw invalid('文件中没有节点。');
  const adjacency = new Map([...nodes.keys()].map(key => [key, []]));
  const incoming = new Set();
  edges.forEach((edge, index) => {
    if (!edge.dashed) { adjacency.get(edge.source).push({ edge, index }); incoming.add(edge.target); }
  });
  const roots = [], visited = new Set(), treeEdges = new Set();
  const candidates = [...nodes.keys()].filter(key => !incoming.has(key));
  candidates.push(...nodes.keys());
  for (const candidate of candidates) {
    if (visited.has(candidate)) continue;
    roots.push(candidate);
    visited.add(candidate);
    const queue = [candidate];
    for (let i = 0; i < queue.length; i++) {
      const parent = queue[i];
      for (const { edge, index } of adjacency.get(parent)) {
        if (visited.has(edge.target)) continue;
        visited.add(edge.target); treeEdges.add(index); queue.push(edge.target);
        nodes.get(parent).children.push(nodes.get(edge.target).id);
      }
    }
  }
  const doc = createDocument(title.trim().slice(0, 200) || '导入导图');
  doc.nodes = Object.fromEntries([...nodes.values()].map(node => [node.id, node]));
  if (roots.length === 1) doc.rootId = nodes.get(roots[0]).id;
  else {
    if (nodes.size >= MAX_NODES) throw invalid('多个独立主题需要增加中心节点，导入后会超过 2000 个节点。');
    doc.rootId = 'root';
    doc.nodes.root = { id: 'root', text: doc.title, children: roots.map(key => nodes.get(key).id), collapsed: false };
  }
  const pairs = new Map();
  edges.forEach((edge, index) => {
    if (treeEdges.has(index) && !edge.text) return;
    const sourceId = nodes.get(edge.source).id, targetId = nodes.get(edge.target).id;
    const pair = `${sourceId}:${targetId}`;
    if (pairs.has(pair)) {
      if (pairs.get(pair).text !== edge.text) throw invalid('同一对节点之间有多条不同文字的联系，暂时无法完整保留。');
      return;
    }
    pairs.set(pair, { id: `r${pairs.size}`, sourceId, targetId, text: edge.text });
  });
  if (pairs.size > 2000) throw invalid('联系超过了 2000 条。');
  if (pairs.size) doc.relationships = [...pairs.values()];
  try { return validateDocument(doc); }
  catch { throw invalid('导入后的层级超过 128 层，或内容超过了导图容量。'); }
}

function parseFlowchart(text, title) {
  const lines = statements(text);
  if (!/^(?:flowchart|graph)\s+(?:LR|RL|TD|TB|BT)$/.test(lines.shift() ?? '')) throw invalid('flowchart / graph 后需要 LR、RL、TD、TB 或 BT 方向。');
  const graph = graphModel();
  for (const line of lines) {
    // Appearance is supplied by Mindmap. Interactivity and extra diagram semantics are not imported.
    if (/^(?:classDef|class|style|linkStyle)\s+/.test(line)) continue;
    if (/^(?:subgraph\b|end$)/.test(line)) throw invalid('暂不支持 subgraph 分组，请先展开为普通节点。');
    if (/^click\s+/.test(line)) throw invalid('文件包含节点点击动作或链接，暂时无法完整导入。');
    if (/^(?:direction\s+|accTitle\s*:|accDescr\s*:)/.test(line)) continue;
    new FlowReader(line, graph).parse();
  }
  return documentFromGraph(graph, title);
}

function parseMindmap(text, title) {
  const lines = text.split('\n');
  if (lines.shift().trim() !== 'mindmap') throw invalid('mindmap 声明格式无效。');
  const graph = graphModel(), stack = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('%%')) continue;
    if (/^(?:::icon\([\w: -]+\)|:::[\w -]+)$/.test(trimmed)) continue;
    const indent = line.match(/^\s*/)[0].replaceAll('\t', '    ').length;
    let label = trimmed;
    const shaped = /^(?:[\p{L}\p{N}_.-]+)?(?=[\[(){}>])/u.exec(label);
    if (shaped) {
      const reader = new FlowReader(label.slice(shaped[0].length), graph);
      label = reader.shape();
      reader.skip();
      if (reader.at !== reader.text.length) throw invalid('mindmap 节点形状后含有无法识别的内容。');
    } else label = labelText(label);
    while (stack.length && stack.at(-1).indent >= indent) stack.pop();
    const key = `m${graph.nodes.size}`;
    graph.node(key, label);
    if (stack.length) graph.edge(stack.at(-1).key, key, {});
    stack.push({ key, indent });
  }
  return documentFromGraph(graph, title);
}

/** Parse data only: supported diagrams become editable native nodes, never rendered source HTML. */
export function parseMermaid(source, title = '导入导图') {
  if (typeof source !== 'string' || source.length > MAX_SOURCE) throw invalid('文件为空或超过 2 MB。');
  if (typeof title !== 'string') throw invalid('导图名称无效。');
  const text = stripPrelude(source);
  if (/^(?:flowchart|graph)\b/.test(text)) return parseFlowchart(text, title);
  if (/^mindmap\b/.test(text)) return parseMindmap(text, title);
  throw invalid('目前支持 flowchart、graph 和 mindmap；不支持时序图等其他 Mermaid 图表。');
}
