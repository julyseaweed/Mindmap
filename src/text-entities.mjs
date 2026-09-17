import htmlEntities from './html-entities.json' with { type: 'json' };

// Lookup generated from Python 3.11 html.entities.html5, including case-sensitive and
// multi-codepoint values: https://docs.python.org/3/library/html.entities.html#html.entities.html5
// Decode one layer only. This is text conversion, never HTML parsing or execution.
export function decodeTextEntities(text, { mermaid = false } = {}) {
  const pattern = mermaid
    ? /&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);|#(?:[xX][\da-fA-F]+|\d+|[A-Za-z][A-Za-z0-9]*);/g
    : /&(?:#[xX][\da-fA-F]+|#\d+|[A-Za-z][A-Za-z0-9]*);/g;
  return text.replace(pattern, raw => {
    const body = raw.slice(1, -1);
    const numeric = raw[0] === '#' ? body : body.startsWith('#') ? body.slice(1) : null;
    let decoded;
    if (numeric !== null && /^(?:[xX][\da-fA-F]+|\d+)$/.test(numeric)) {
      const code = /^[xX]/.test(numeric) ? parseInt(numeric.slice(1), 16) : Number(numeric);
      decoded = code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '\ufffd';
    } else decoded = htmlEntities[body + ';'] ?? raw;
    return decoded.replaceAll('\u00a0', ' ');
  });
}
