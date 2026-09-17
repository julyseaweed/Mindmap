const graphemes = new Intl.Segmenter('zh-CN', { granularity: 'grapheme' });
const eastAsian = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const emoji = /[\p{Extended_Pictographic}\p{Regional_Indicator}]/u;
const opening = /[\p{Ps}\p{Pi}]/u;
const closing = /[\p{Pe}\p{Pf},.;:!?%‰‱°…、。，．：；！？‼⁇⁈⁉％]/u;
const breakAfter = /[\p{Pe}\p{Pf}、。，．：；！？％]/u;
const breakBefore = /[（［｛〈《「『【〔〖〘〚]/u;
const smallKana = /^[ぁぃぅぇぉっゃゅょゎゕゖァィゥェォッャュョヮヵヶー々ゝゞヽヾ]/u;
const space = /^[\t \u1680\u2000-\u2006\u2008-\u200a\u205f\u3000]+$/u;
const noBreak = /[\u00a0\u2007\u202f\u2060\ufeff]/u;
const letter = /[\p{L}\p{N}\p{M}]/u;

function quoteRole(parts, index) {
  const char = parts[index];
  if (char !== '"' && char !== "'" && char !== '’') return null;
  const before = parts[index - 1], after = parts[index + 1];
  if (char !== '"' && before && after && letter.test(before) && letter.test(after)
    && !eastAsian.test(before) && !eastAsian.test(after)) return 'inside';
  if (char === '’') return 'close';
  return !before || space.test(before) || opening.test(before) ? 'open' : 'close';
}

function punctuationAllows(parts, index) {
  const before = parts[index - 1], after = parts[index];
  return !opening.test(before) && quoteRole(parts, index - 1) !== 'open'
    && !closing.test(after) && !smallKana.test(after) && quoteRole(parts, index) !== 'close';
}

function mayBreak(parts, index) {
  const before = parts[index - 1], after = parts[index];
  if (noBreak.test(before) || noBreak.test(after) || space.test(after)) return false;
  if (!punctuationAllows(parts, index)) return false;
  if (space.test(before) || before === '\u200b') return true;
  if (breakBefore.test(after)) return true;
  if ((breakAfter.test(before) && quoteRole(parts, index - 1) !== 'inside') || quoteRole(parts, index - 1) === 'close') return true;
  if (before === '-' || before === '‐' || before === '/' || before === '–') return true;
  return eastAsian.test(before) || eastAsian.test(after) || emoji.test(before) || emoji.test(after)
    || before === '—' || after === '—';
}

/** Shared screen/PDF wrapping: keep words intact, then fall back at grapheme boundaries. */
export function wrapText(text, contentWidth, measure) {
  const lines = [];
  const width = Math.max(0, contentWidth);
  for (const paragraph of text.split('\n')) {
    const parts = Array.from(graphemes.segment(paragraph), item => item.segment);
    if (!parts.length) { lines.push(''); continue; }
    const breaks = parts.map((_, index) => index > 0 && mayBreak(parts, index));
    let start = 0;
    while (start < parts.length) {
      let end = start, current = '', lastBreak = start;
      while (end < parts.length) {
        const next = current + parts[end];
        // As with pre-wrap, spaces at a soft line ending can hang outside its measure.
        if (end > start && measure(next.replace(/[\t ]+$/u, '')) > width) break;
        current = next;
        end++;
        if (breaks[end]) lastBreak = end;
      }
      if (end === parts.length) { lines.push(current); break; }
      if (lastBreak > start) end = lastBreak;
      else {
        // Break an overlong token without splitting a combining sequence or emoji.
        // Prefer a nearby safe boundary so closing marks do not land on the next line.
        let safe = end;
        while (safe > start && !punctuationAllows(parts, safe)) safe--;
        if (safe > start) end = safe;
      }
      // Soft-wrap spaces hang in the editor and must not shift centered display text.
      // Only visual lines are trimmed; explicit paragraph endings and stored text stay intact.
      lines.push(parts.slice(start, end).join('').replace(/[\t ]+$/u, ''));
      start = end;
    }
  }
  return lines;
}
