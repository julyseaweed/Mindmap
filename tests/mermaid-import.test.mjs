import test from 'node:test';
import assert from 'node:assert/strict';
import { createDocument, toMermaid, validateDocument } from '../src/core.mjs';
import { parseMermaid } from '../src/mermaid-import.mjs';
import { decodeTextEntities } from '../src/text-entities.mjs';

const byText = (doc, text) => Object.values(doc.nodes).find(node => node.text === text);
const childTexts = (doc, text) => byText(doc, text).children.map(id => doc.nodes[id].text);
const relationships = doc => (doc.relationships ?? []).map(edge => [doc.nodes[edge.sourceId].text, doc.nodes[edge.targetId].text, edge.text]);

test('imports native Mermaid export with multiline Unicode, escaped punctuation, empty nodes and relationships', () => {
  const doc = createDocument('案例');
  doc.nodes.root.text = '中英 ABC & #34; " <b>literal</b> ` \\';
  doc.nodes.root.children = ['left', 'right'];
  doc.nodes.left = { id: 'left', text: '第一行\nsecond line', children: ['blank'], collapsed: true };
  doc.nodes.blank = { id: 'blank', text: '', children: [], collapsed: false };
  doc.nodes.right = { id: 'right', text: 'two | ; [x] (y) %%', children: [], collapsed: false };
  doc.relationships = [{ id: 'r1', sourceId: 'left', targetId: 'right', text: '有关 | "text"\n下一行 & #124;' }];
  const imported = parseMermaid(toMermaid(doc, false), '案例');
  assert.equal(imported.title, '案例');
  assert.deepEqual(childTexts(imported, doc.nodes.root.text), [doc.nodes.left.text, doc.nodes.right.text]);
  assert.deepEqual(childTexts(imported, doc.nodes.left.text), ['']);
  assert.deepEqual(relationships(imported), [[doc.nodes.left.text, doc.nodes.right.text, doc.relationships[0].text]]);
  assert.equal(Object.keys(imported.nodes).length, 4);
  assert.deepEqual(validateDocument(imported), imported);
});

for (const direction of ['LR', 'RL', 'TD', 'TB', 'BT']) {
  test(`imports graph ${direction} while preserving arrow direction as hierarchy`, () => {
    const doc = parseMermaid(`graph ${direction}; A[中心] --> B(分支); B --> C{细节}`);
    assert.deepEqual(childTexts(doc, '中心'), ['分支']);
    assert.deepEqual(childTexts(doc, '分支'), ['细节']);
    assert.equal(relationships(doc).length, 0);
  });
}

test('supports common shapes, grouped and chained edges, forward references, classes and comments', () => {
  const doc = parseMermaid(`flowchart LR
    %% ignore comments
    A --> B & C --> D
    A([Center]):::root
    B[[Child B]]
    C[(Child C)]
    D((Detail))
    E>Flag]
    A --> E
    classDef root fill:#fff,color:#000
    class B,C child
    style D stroke:#111
    linkStyle default stroke:#111`);
  assert.deepEqual(childTexts(doc, 'Center'), ['Child B', 'Child C', 'Flag']);
  assert.deepEqual(childTexts(doc, 'Child B'), ['Detail']);
  assert.deepEqual(relationships(doc), [['Child C', 'Detail', '']]);
});

test('supports alternative quadrilateral and double-circle shapes', () => {
  const doc = parseMermaid('flowchart LR\nA[/A/] --> B[\\B\\] --> C[/C\\] --> D[\\D/] --> E(((E))) --> F{{F}}');
  for (const [parent, child] of [['A', 'B'], ['B', 'C'], ['C', 'D'], ['D', 'E'], ['E', 'F']]) assert.deepEqual(childTexts(doc, parent), [child]);
});

test('last explicit node definition wins; references do not replace its label', () => {
  const doc = parseMermaid('flowchart LR\nA[first] --> B\nA[最后]\nA --> C\nA');
  assert.equal(doc.nodes[doc.rootId].text, '最后');
  assert.deepEqual(childTexts(doc, '最后'), ['B', 'C']);
});

test('preserves pipe and inline labels, dashed links and text linebreaks', () => {
  const doc = parseMermaid(`flowchart LR
    A --> B
    A --> C
    B -.->|"a | b; c<br/>第二行"| C
    A -- because --> D
    C -. depends .-> D
    D == then ==> E`);
  assert.deepEqual(relationships(doc), [
    ['B', 'C', 'a | b; c\n第二行'], ['A', 'D', 'because'], ['C', 'D', 'depends'], ['D', 'E', 'then'],
  ]);
  assert.deepEqual(childTexts(doc, 'A'), ['B', 'C', 'D']);
});

test('inline quoted relationship labels may contain arrow characters literally', () => {
  const doc = parseMermaid('flowchart LR\nA -- "literal --> arrow" --> B');
  assert.deepEqual(relationships(doc), [['A', 'B', 'literal --> arrow']]);
});

test('label quoting and entities are decoded once; tags are never interpreted as HTML', () => {
  const doc = parseMermaid('flowchart LR\nA["<b>bold</b><br>line &amp; #35;38; &#x1F331;"] --> B["`**raw markdown**`"]');
  assert.equal(doc.nodes[doc.rootId].text, 'bold\nline & #38; 🌱');
  assert.ok(byText(doc, '**raw markdown**'));
});

test('full named entities preserve case, Greek letters and multi-codepoint values', () => {
  const doc = parseMermaid('flowchart LR\nA["&alpha; &Alpha; &beta; #9829; &NotEqualTilde; #alpha;"]');
  assert.equal(doc.nodes[doc.rootId].text, 'α Α β ♥ ≂̸ α');
  assert.equal(decodeTextEntities('&ndash;&hellip;&copy; &CounterClockwiseContourIntegral;'), '–…© ∳');
  assert.equal(decodeTextEntities('&ALPHA; &madeup;'), '&ALPHA; &madeup;');
});

test('entity decoding is exactly once and Mermaid numeric syntax is opt-in', () => {
  assert.equal(decodeTextEntities('&amp;alpha; #35;9829;', { mermaid: true }), '&alpha; #9829;');
  assert.equal(decodeTextEntities('&amp;alpha; #35;9829;'), '&alpha; #35;9829;');
  assert.equal(parseMermaid('flowchart LR\nA["&amp;alpha; #35;9829;"]').nodes.n0.text, '&alpha; #9829;');
  assert.equal(decodeTextEntities('&#0; &#xD800; &#1114112; &nbsp;&#160;&NonBreakingSpace;'), '� � �    ');
});

test('declarations keep punctuation, semicolons and comments inside quoted text', () => {
  const doc = parseMermaid('flowchart LR; A["a; %% nope\nend"] --> B["b | "] %% real comment\nB --> C');
  assert.ok(byText(doc, 'a; %% nope\nend'));
  assert.ok(byText(doc, 'b | '));
  assert.deepEqual(childTexts(doc, 'b | '), ['C']);
});

test('disconnected and dashed-only nodes all survive below a synthetic root', () => {
  const doc = parseMermaid('flowchart LR\nA --> B\nC -.->|related| D\nZ', '组合');
  assert.deepEqual(childTexts(doc, '组合'), ['A', 'C', 'D', 'Z']);
  assert.deepEqual(childTexts(doc, 'A'), ['B']);
  assert.deepEqual(relationships(doc), [['C', 'D', 'related']]);
  assert.equal(Object.keys(doc.nodes).length, 6);
});

test('cycles and multiple parents become editable relationships, preserving every node and edge', () => {
  const doc = parseMermaid('flowchart LR\nA --> B --> C --> A\nA --> C');
  assert.deepEqual(childTexts(doc, 'A'), ['B', 'C']);
  assert.deepEqual(relationships(doc), [['B', 'C', ''], ['C', 'A', '']]);
  assert.equal(Object.keys(doc.nodes).length, 3);
});

test('bidirectional and reverse arrows preserve both directed connections', () => {
  const doc = parseMermaid('flowchart LR\nA <--> B\nC <-- B');
  assert.deepEqual(childTexts(doc, 'A'), ['B']);
  assert.deepEqual(childTexts(doc, 'B'), ['C']);
  assert.deepEqual(relationships(doc), [['B', 'A', '']]);
});

test('identical duplicate edges are accepted and parallel labels fail explicitly', () => {
  const doc = parseMermaid('flowchart LR\nA --> B\nA -.->|same| B\nA -.->|same| B');
  assert.deepEqual(relationships(doc), [['A', 'B', 'same']]);
  assert.throws(() => parseMermaid('flowchart LR\nA -->|one| B\nA -->|two| B'), /多条不同文字/);
  assert.deepEqual(relationships(parseMermaid('flowchart LR\nA --> B\nA --> B')), []);
});

test('mindmap imports indentation, Chinese/English plain text, shapes and appearance directives', () => {
  const doc = parseMermaid(`mindmap
    root((中心主题))
      Origins 起源
        Long history
        ::icon(fa fa-book)
      id[第二分支]
        "多行<br/>内容"
        :::large bold
      Other topic`);
  assert.equal(doc.nodes[doc.rootId].text, '中心主题');
  assert.deepEqual(childTexts(doc, '中心主题'), ['Origins 起源', '第二分支', 'Other topic']);
  assert.deepEqual(childTexts(doc, 'Origins 起源'), ['Long history']);
  assert.deepEqual(childTexts(doc, '第二分支'), ['多行\n内容']);
});

test('mindmap root may have no id and tab indentation is supported', () => {
  const doc = parseMermaid('mindmap\n((根))\n\tA\n\t\tB\n\tC');
  assert.deepEqual(childTexts(doc, '根'), ['A', 'C']);
  assert.deepEqual(childTexts(doc, 'A'), ['B']);
});

test('mindmap cloud and bang shapes preserve labels instead of punctuation', () => {
  const doc = parseMermaid('mindmap\nroot)Cloud(\n  child))Bang((');
  assert.deepEqual(childTexts(doc, 'Cloud'), ['Bang']);
});

test('untrusted frontmatter and init directives are skipped as inert metadata', () => {
  const doc = parseMermaid('\uFEFF---\nconfig:\n  securityLevel: loose\n---\n%%{init: {"securityLevel":"loose"}}%%\n%% note\nflowchart LR\nA --> B');
  assert.deepEqual(childTexts(doc, 'A'), ['B']);
});

for (const [input, error] of [
  ['sequenceDiagram\nA->>B: hello', /目前支持/],
  ['flowchart LR\nsubgraph Group\nA --> B\nend', /subgraph/],
  ['flowchart LR\nA@{ img: "https:\/\/example.com\/image.png" }', /节点属性/],
  ['flowchart LR\nA["<img src=x onerror=alert(1)>"]', /HTML 或图片/],
  ['flowchart LR\nA --> A', /自身/],
  ['flowchart LR\nA --> B\nclick A call run()', /点击动作/],
  ['flowchart LR\nA[broken', /正确结束/],
  ['flowchart LR\nA -->|broken B', /正确结束/],
  ['flowchart LR\nA --o B', /连线写法/],
  ['flowchart LR\nA ---oB', /圆圈或叉号/],
  ['flowchart LR\nA ---xB', /圆圈或叉号/],
  ['flowchart LR\nA ??? B', /连线写法/],
  ['flowchart LR', /没有节点/],
  ['flowchart DIAGONAL\nA --> B', /需要/],
]) test(`rejects unsupported or malformed input without a partial document: ${input.slice(0, 55)}`, () => {
  assert.throws(() => parseMermaid(input), error);
});

test('enforces input, node, label and depth capacity bounds', () => {
  assert.throws(() => parseMermaid('x'.repeat(2 * 1024 * 1024 + 1)), /2 MB/);
  assert.throws(() => parseMermaid(`flowchart LR\nA["${'x'.repeat(8001)}"]`), /8000/);
  assert.throws(() => parseMermaid('flowchart LR\n' + Array.from({ length: 2001 }, (_, i) => `A${i}`).join('\n')), /2000/);
  assert.throws(() => parseMermaid('flowchart LR\n' + Array.from({ length: 130 }, (_, i) => `A${i}`).join(' --> ')), /128/);
});

test('untrusted identifiers are remapped instead of becoming object properties', () => {
  const doc = parseMermaid('flowchart LR\nconstructor --> prototype --> __proto__ --> 中文');
  assert.equal(Object.keys(doc.nodes).length, 4);
  assert.deepEqual(childTexts(doc, '__proto__'), ['中文']);
  assert.equal({}.polluted, undefined);
});
