import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument } from '../src/core.mjs';
import { importTextDocument } from '../src/document-import.mjs';
import { toMarkdown } from '../src/markdown-export.mjs';

const outline = (text, ...children) => ({ text, children });
function document(tree) {
  const doc = createDocument('文件名');
  let next = 0;
  const add = (entry, id) => {
    const children = entry.children.map(() => `n${++next}`);
    doc.nodes[id] = { id, text: entry.text, children, collapsed: false };
    entry.children.forEach((child, index) => add(child, children[index]));
  };
  add(tree, doc.rootId);
  return doc;
}
const treeOf = (doc, id = doc.rootId) => outline(doc.nodes[id].text, ...doc.nodes[id].children.map(child => treeOf(doc, child)));
const roundtrip = doc => assert.deepEqual(treeOf(importTextDocument(toMarkdown(doc), '.md', doc.title)), treeOf(doc));

test('Markdown export is a readable heading and nested list, including collapsed descendants in order', () => {
  const doc = document(outline('阅读笔记', outline('哲学', outline('古代'), outline('现代', outline('新问题'))), outline('文学')));
  doc.nodes.n1.collapsed = true;
  assert.equal(toMarkdown(doc), '# 阅读笔记\n\n* 哲学\n  * 古代\n  * 现代\n    * 新问题\n* 文学\n');
  roundtrip(doc);
});

test('multiline topics preserve line breaks at the root and every depth without creating extra nodes', () => {
  const doc = document(outline('第一行\nSecond line', outline('中英 mixed\n\n空行之后\n', outline('\n先换行')), outline('普通文本')));
  assert.match(toMarkdown(doc), /^# 第一行<br>Second line/);
  roundtrip(doc);
});

test('newline-only roots and parents preserve children and siblings as an outline', () => {
  for (const text of ['\n', '\n\n']) {
    roundtrip(document(outline(text, outline('Child'), outline('Sibling'))));
    roundtrip(document(outline('Root', outline(text, outline('Child')), outline('Sibling'))));
  }
});

test('Markdown punctuation, literal code, HTML and entity-like text remain literal topic text', () => {
  const doc = document(outline('# Heading *stars* & <root>',
    outline('**粗体原文** _underscore_ ~~strike~~ `code` \\path\\file'),
    outline('[label](https://example.com/a) ![image](a.png) [x] task'),
    outline('<br> <script>test</script> &amp; &#10; &nbsp;'),
    outline('1. 编号', outline('- 列表', outline('+ 子项', outline('> quote')))),
    outline('---'), outline('### Heading ###'), outline('2) second'), outline('| a | b |')));
  roundtrip(doc);
});

test('URLs and emails keep their original text instead of adding an inferred address', () => {
  roundtrip(document(outline('Links', outline('https://example.com/a?x=1&y=2'), outline('www.example.com'), outline('hello@example.com'), outline('http://example.com/a_(b)#section'))));
});

test('empty roots, siblings and parents keep their positions without invented labels', () => {
  for (const tree of [outline(''), outline('', outline('')), outline('主题', outline('', outline('', outline('内容'))), outline(''), outline('最后'), outline('')), outline('主题', outline('有文字的父节点', outline(''), outline('后一个子节点')))]) {
    const doc = document(tree);
    assert.doesNotMatch(toMarkdown(doc), /新主题|中心主题|未命名|<!/);
    roundtrip(doc);
  }
});

test('significant edge spaces and tabs survive an outline roundtrip', () => {
  roundtrip(document(outline('  root  ', outline('  indent  '), outline('\tTab\ttext\t'), outline(' '), outline(' a \n b '))));
});

test('text-only export omits pictures and cross-links without adding misleading hierarchy or mutating the document', () => {
  const doc = document(outline('主题', outline('甲'), outline('乙')));
  doc.nodes.n1.images = [{ id: 'image1', dataUrl: 'data:image/png;base64,example', width: 120, height: 100 }];
  doc.relationships = [{ id: 'r1', sourceId: 'n1', targetId: 'n2', text: '非层级联系' }];
  doc.columnWidths = { 1: 300 };
  const before = structuredClone(doc);
  assert.equal(toMarkdown(doc), '# 主题\n\n* 甲\n* 乙\n');
  assert.deepEqual(doc, before);
  const imported = importTextDocument(toMarkdown(doc), '.md');
  assert.deepEqual(treeOf(imported), treeOf(doc));
  assert.equal(imported.relationships, undefined);
  assert.ok(Object.values(imported.nodes).every(node => !node.images));
});
