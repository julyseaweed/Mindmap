import test from 'node:test';
import assert from 'node:assert/strict';
import { wrapText } from '../src/text-wrap.mjs';
import { relationshipGeometry } from '../src/relationships.mjs';

const segmenter = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const measure = text => [...segmenter.segment(text)].length;
const visible = lines => lines.map(line => line.trimEnd());

test('a word moves intact to the next line when only the remaining space is too small', () => {
  assert.deepEqual(visible(wrapText('one simple word', 8, measure)), ['one', 'simple', 'word']);
  assert.deepEqual(visible(wrapText("we don't split words", 10, measure)), ["we don't", 'split', 'words']);
  assert.deepEqual(visible(wrapText('we don’t split words', 10, measure)), ['we don’t', 'split', 'words']);
});

test('only overlong words need emergency breaks, with no visible overflow or lost characters', () => {
  const text = 'one extraordinary word';
  const lines = wrapText(text, 8, measure);
  assert.deepEqual(visible(lines), ['one', 'extraord', 'inary', 'word']);
  assert.equal(lines.join('').replace(/[\t ]/gu, ''), text.replace(/[\t ]/gu, ''));
  assert.ok(lines.every(line => measure(line.trimEnd()) <= 8));
});

test('CJK characters wrap naturally around whole Latin words', () => {
  const text = '中文English中文混合';
  assert.deepEqual(wrapText(text, 8, measure), ['中文', 'English中', '文混合']);
  assert.deepEqual(wrapText('中文按字换行', 3, measure), ['中文按', '字换行']);
  assert.deepEqual(wrapText('中文，testing', 8, measure), ['中文，', 'testing']);
  assert.deepEqual(wrapText('“中文”testing', 8, measure), ['“中文”', 'testing']);
  assert.deepEqual(wrapText('“中文”English（中文）English', 11, measure), ['“中文”English', '（中文）English']);
  assert.deepEqual(wrapText('中文 test 中文，testing 结束。', 8, measure), ['中文 test', '中文，', 'testing', '结束。']);
});

test('explicit line breaks and blank lines survive independently of soft wrapping', () => {
  assert.deepEqual(wrapText('alpha beta\n\nnext line\n', 8, measure), ['alpha', 'beta', '', 'next', 'line', '']);
  assert.deepEqual(wrapText('', 8, measure), ['']);
  assert.deepEqual(wrapText('\n\n', 8, measure), ['', '', '']);
});

test('only soft-wrap ASCII whitespace is omitted from centered visual lines', () => {
  assert.deepEqual(wrapText('first second \nend ', 8, measure), ['first', 'second ', 'end ']);
  assert.deepEqual(wrapText('first\tsecond', 8, measure), ['first', 'second']);
  assert.deepEqual(wrapText('some \nmore\t', 8, measure), ['some ', 'more\t']);
  assert.deepEqual(wrapText('one\u00a0two next', 8, measure), ['one\u00a0two', 'next']);
});

test('nonbreaking spaces stay inside a phrase if the complete phrase fits the line', () => {
  for (const space of ['\u00a0', '\u202f', '\u2007']) {
    const text = `a New${space}York next`;
    assert.deepEqual(visible(wrapText(text, 8, measure)), ['a', `New${space}York`, 'next']);
  }
});

test('emergency wrapping preserves combining sequences, emoji modifiers and joined emoji', () => {
  const text = 'e\u0301e\u0301e\u0301e\u0301';
  assert.deepEqual(wrapText(text, 2, measure), ['e\u0301e\u0301', 'e\u0301e\u0301']);
  const joined = '👩🏽‍💻👨‍👩‍👧‍👦🇨🇳';
  assert.deepEqual(wrapText(joined, 1, measure), ['👩🏽‍💻', '👨‍👩‍👧‍👦', '🇨🇳']);
});

test('common Chinese closing punctuation never starts a soft line and opening punctuation never ends one', () => {
  const text = '中文（说明）结束。测试“引号”，还有【方括号】、以及《书名》！';
  for (const width of [4, 5, 6, 8]) {
    const lines = wrapText(text, width, measure);
    assert.equal(lines.join(''), text);
    assert.ok(lines.every(line => measure(line) <= width));
    assert.ok(lines.every(line => !/^[）”】》，。、！]/u.test(line)), JSON.stringify(lines));
    assert.ok(lines.every(line => !/[（“【《]$/u.test(line)), JSON.stringify(lines));
  }
});

test('English quotes and closing punctuation stay attached to their text', () => {
  const text = 'a "quoted word", then (another word). End!';
  const lines = wrapText(text, 10, measure);
  assert.equal(lines.join('').replace(/[\t ]/gu, ''), text.replace(/[\t ]/gu, ''));
  assert.ok(lines.every(line => !/^[,.)!?]/u.test(line.trimStart())), JSON.stringify(lines));
  assert.ok(lines.every(line => !/[(]$/u.test(line.trimEnd())), JSON.stringify(lines));
  assert.ok(lines.some(line => line.includes('"quoted')));
  assert.ok(lines.some(line => line.includes('word",')));
});

test('relationship labels use the same word wrapping and keep the full available width', () => {
  const boxes = { a: { x: 0, y: 0, width: 100, height: 40 }, b: { x: 300, y: 0, width: 100, height: 40 } };
  const text = 'English relationship words stay together';
  const geometry = relationshipGeometry({ id: 'rel', sourceId: 'a', targetId: 'b', text,
    control1: { x: 0, y: -100 }, control2: { x: 0, y: -100 } }, boxes, value => measure(value) * 10);
  assert.equal(geometry.label.width, 280);
  assert.deepEqual(visible(geometry.label.lines), ['English relationship words', 'stay together']);
  assert.equal(geometry.label.height, 2 * 23 + 8);
});
