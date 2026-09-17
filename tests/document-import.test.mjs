import test from 'node:test';
import assert from 'node:assert/strict';
import { importTextDocument } from '../src/document-import.mjs';
import { createDocument, toMermaid } from '../src/core.mjs';

const read = (text, name = '文件名') => importTextDocument(text, '.md', name);
const children = (doc, node = doc.nodes[doc.rootId]) => node.children.map(id => doc.nodes[id]);
const texts = doc => Object.values(doc.nodes).map(node => node.text);

test('a leading heading becomes the root and headings, prose and nested lists retain hierarchy', () => {
  const doc = read('# 阅读笔记\n\n开篇说明。\n\n## 书目\n- **哲学**\n  - 古代\n  - 现代\n- 文学\n\n## 问题\n接下来读什么？');
  assert.equal(doc.title, '阅读笔记');
  assert.equal(doc.nodes[doc.rootId].text, '阅读笔记');
  const [intro, books, questions] = children(doc);
  assert.deepEqual([intro.text, books.text, questions.text], ['开篇说明。', '书目', '问题']);
  assert.deepEqual(children(doc, books).map(node => node.text), ['哲学', '文学']);
  assert.deepEqual(children(doc, children(doc, books)[0]).map(node => node.text), ['古代', '现代']);
  assert.equal(children(doc, questions)[0].text, '接下来读什么？');
});

test('multiple top-level headings keep the filename root and independent sibling sections', () => {
  const doc = read('# 一\n内容一\n# 二\n内容二');
  assert.equal(doc.nodes[doc.rootId].text, '文件名');
  assert.deepEqual(children(doc).map(node => node.text), ['一', '二']);
  assert.deepEqual(children(doc).map(node => children(doc, node)[0].text), ['内容一', '内容二']);
});

test('setext headings, numbered lists, tasks and loose-list paragraphs retain text', () => {
  const doc = read('计划\n====\n\n1. 阅读\n\n   继续阅读第二段。\n\n   - [x] 第一章\n   - [ ] 第二章\n2. 整理');
  const [reading, writing] = children(doc);
  assert.equal(reading.text, '阅读');
  assert.equal(writing.text, '整理');
  assert.deepEqual(children(doc, reading).map(node => node.text), ['继续阅读第二段。', '☑ 第一章', '☐ 第二章']);
});

test('inline text keeps entities, code literals, line breaks, links and image references as text', () => {
  const doc = read('# 字符\n\nA &amp; B  \n下一行 `&amp;` **加粗** [资料](https://example.com/a) ![配图](local.png)');
  assert.equal(children(doc)[0].text, 'A & B\n下一行 &amp; 加粗 资料 (https://example.com/a) 配图 (local.png)');
});

test('tables retain each cell and quoted prose remains text', () => {
  const doc = read('# 表\n\n| 名称 | 说明 |\n|---|---|\n| A | **内容** |\n| B | `代码` |\n\n> 引用文字');
  const [table, quote] = children(doc);
  assert.equal(table.text, '名称 | 说明');
  assert.deepEqual(children(doc, table).map(node => node.text), ['A | 内容', 'B | 代码']);
  assert.equal(quote.text, '引用文字');
});

test('inline breaks and automatic links keep their visible text without extra URLs', () => {
  const doc = read('# 笔记\n\n* 第一行<br>第二行<BR />第三行\n* www.example.com\n* a@example.com\n* https://example.com/path\n* &lt;br&gt;');
  assert.deepEqual(children(doc).map(node => node.text), ['第一行\n第二行\n第三行', 'www.example.com', 'a@example.com', 'https://example.com/path', '<br>']);
});

test('a heading inside a list labels that item without introducing an empty parent', () => {
  const doc = read('# 笔记\n\n* ## 章节\n  * 内容\n* 下一章');
  const [chapter, next] = children(doc);
  assert.equal(chapter.text, '章节');
  assert.equal(next.text, '下一章');
  assert.deepEqual(children(doc, chapter).map(node => node.text), ['内容']);
});

test('named HTML entities preserve exact visible characters and only decode once', () => {
  const doc = read('# Entities\n\n&Alpha; &alpha; &beta; &ndash; &hellip; &copy; &amp;alpha; `&alpha;`');
  assert.equal(children(doc)[0].text, 'Α α β – … © &alpha; &alpha;');
});

test('HTML and ordinary fenced code are stored as text, not interpreted as diagrams or markup', () => {
  const doc = read('# 原文\n\n<script>alert(1)</script>\n\n````text\n```mermaid\nA --> B\n```\n````');
  assert.ok(texts(doc).some(text => text.includes('<script>alert(1)</script>')));
  assert.ok(texts(doc).includes('```mermaid\nA --> B\n```'));
  assert.equal(Object.keys(doc.nodes).length, 3);
});

test('front matter is inert metadata, with a title fallback when no leading heading exists', () => {
  const doc = read('---\ntitle: "我的笔记"\naction: delete_everything\n---\n- 第一项\n- 第二项');
  assert.equal(doc.title, '我的笔记');
  assert.deepEqual(children(doc).map(node => node.text), ['第一项', '第二项']);
});

test('single Mermaid code fences import the graph without extra wrappers', () => {
  for (const fence of ['```', '~~~']) {
    const doc = read(`${fence}mermaid\nflowchart LR\nA[主题] --> B[内容]\n${fence}`);
    assert.equal(doc.nodes[doc.rootId].text, '主题');
    assert.deepEqual(children(doc).map(node => node.text), ['内容']);
    assert.equal(Object.keys(doc.nodes).length, 2);
  }
});

test('an optional Markdown heading and exported Mermaid preserve the complete supported graph', () => {
  const original = createDocument('本地标题');
  original.nodes.root.text = '中心 & <标签>\n第二行';
  original.nodes.a = { id: 'a', text: '分支 A', children: [], collapsed: false };
  original.nodes.b = { id: 'b', text: '分支 B', children: [], collapsed: true };
  original.nodes.root.children = ['a', 'b'];
  original.relationships = [{ id: 'r', sourceId: 'a', targetId: 'b', text: '相互 | 联系' }];
  const imported = read('# 导出的文件\n\n' + toMermaid(original, true));
  assert.deepEqual(texts(imported).sort(), texts(original).sort());
  assert.equal(imported.relationships.length, 1);
  assert.equal(imported.relationships[0].text, '相互 | 联系');
  assert.equal(imported.nodes[imported.relationships[0].sourceId].text, '分支 A');
  assert.equal(imported.nodes[imported.relationships[0].targetId].text, '分支 B');
});

test('multiple embedded graphs preserve their sections, all nodes and remapped relationships', () => {
  const doc = read('# 文档\n\n说明\n\n## 第一张\n```mermaid\nflowchart LR\nA[甲] --> B[乙]\nA -.->|关系一| B\n```\n\n## 第二张\n```mermaid\nflowchart LR\nA[丙] --> B[丁]\nA -.->|关系二| B\n```\n\n结束。');
  assert.deepEqual(children(doc).map(node => node.text), ['说明', '第一张', '第二张']);
  assert.equal(doc.relationships.length, 2);
  assert.deepEqual(doc.relationships.map(link => [doc.nodes[link.sourceId].text, doc.nodes[link.targetId].text, link.text]), [['甲', '乙', '关系一'], ['丙', '丁', '关系二']]);
  assert.ok(texts(doc).includes('结束。'));
  assert.equal(new Set(doc.relationships.map(link => link.id)).size, 2);
});

test('raw Mermaid saved as Markdown, uppercase extensions, BOM and CRLF are accepted', () => {
  const doc = importTextDocument('\uFEFFflowchart LR\r\nA[左] --> B[右]', '.MD', '文件');
  assert.equal(doc.nodes[doc.rootId].text, '左');
  assert.equal(children(doc)[0].text, '右');
});

test('unsupported embedded diagrams fail the whole import instead of dropping a block', () => {
  assert.throws(() => read('# 有正文\n\n保留我\n\n```mermaid\nsequenceDiagram\nA->>B: hello\n```'), /暂不支持|暂时不支持|不支持/);
});

test('ordinary prose beginning with a diagram keyword is still ordinary Markdown', () => {
  for (const text of ['graph theory\n\n- Nodes\n- Edges', 'mindmap notes\n\nA useful topic.', 'flowchart overview']) {
    const doc = read(text);
    assert.ok(texts(doc).includes(text.split('\n')[0]));
  }
});

test('raw Mermaid in Markdown accepts inert multiline configuration and comments', () => {
  const doc = read('%%{\n init: {"theme":"dark"}\n}%%\n%% a comment\nflowchart LR\nA[甲] --> B[乙]');
  assert.equal(doc.nodes[doc.rootId].text, '甲');
  assert.equal(children(doc)[0].text, '乙');
});

test('Mermaid files may retain the code fence copied with their graph', () => {
  const doc = importTextDocument('```mermaid\nflowchart LR\nA[甲] --> B[乙]\n```', '.mermaid', '图');
  assert.deepEqual(texts(doc), ['甲', '乙']);
});

test('empty metadata, binary strings and oversized node text fail with usable messages', () => {
  for (const source of ['', '  \n', '---\ntitle: Nothing\n---\n', '\n---\n']) assert.throws(() => read(source), /空|没有/);
  assert.throws(() => read('Hello\0World'), /文本|UTF-8/);
  assert.throws(() => read('# 大段\n\n' + '字'.repeat(8001)), /内容过多|拆分/);
  assert.throws(() => importTextDocument('正文', '.txt', '文件'), /Markdown|Mermaid/);
});
