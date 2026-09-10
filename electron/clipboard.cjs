const { createHash, randomUUID } = require('node:crypto');

const MAX_DATA_URL = 12 * 1024 * 1024;
const MAX_CLIPBOARD_BYTES = 48 * 1024 * 1024;
const MAX_BRANCH_BYTES = 128 * 1024 * 1024;
const BRANCH_TYPE = 'electron application/osclipboard;format="Mindmap.Nodes"';
const PNG_PREFIX = 'data:image/png;base64,';
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'];

function createImageClipboard({ clipboard, ClipboardItem, nativeImage, validateDocument }) {
  let retained = null;
  let queue = Promise.resolve();
  const enqueue = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  const validate = image => validateDocument({
    format: 'inkmap', version: 1, id: 'clipboard', title: '图片', rootId: 'root',
    nodes: { root: { id: 'root', text: '', children: [], collapsed: false, images: [image] } },
  }).nodes.root.images[0];
  const normalize = bytes => {
    if (!bytes.length || bytes.length > MAX_CLIPBOARD_BYTES) throw new Error('剪贴板图片过大，无法读取。');
    const bitmap = nativeImage.createFromBuffer(bytes);
    if (bitmap.isEmpty()) throw new Error('无法读取这张图片。');
    const { width, height } = bitmap.getSize(1);
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > 48_000_000) throw new Error('图片尺寸过大，请缩小图片后再粘贴。');
    const png = bitmap.toPNG({ scaleFactor: 1 });
    if (!png.length || png.length > MAX_CLIPBOARD_BYTES) throw new Error('剪贴板图片过大，无法读取。');
    return { png, width, height, hash: createHash('sha256').update(png).digest('hex') };
  };
  const plainBranch = branch => {
    const lines = [];
    let bytes = 0;
    const visit = (id, depth) => {
      const node = branch.nodes[id];
      const indentation = '\t'.repeat(depth);
      for (const line of node.text.split(/\r\n?|\n/)) {
        bytes += indentation.length + Buffer.byteLength(line, 'utf8') + (lines.length ? 1 : 0);
        if (bytes > MAX_BRANCH_BYTES) throw new Error('复制内容过大。');
        lines.push(indentation + line);
      }
      node.children.forEach(child => visit(child, depth + 1));
    };
    visit(branch.rootId, 0);
    return lines.join('\n');
  };
  const readPayload = async type => {
    for (const item of await clipboard.read()) {
      if (!item.types.includes(type)) continue;
      const blob = await item.getType(type);
      if (!Number.isFinite(blob.size) || blob.size < 0 || blob.size > MAX_BRANCH_BYTES) throw new Error('剪贴板内容过大，无法粘贴。');
      return blob;
    }
    return null;
  };

  return {
    copyBranch: branch => enqueue(async () => {
      const validated = validateDocument(branch);
      const serialized = JSON.stringify(validated);
      if (Buffer.byteLength(serialized, 'utf8') > MAX_BRANCH_BYTES) throw new Error('复制内容过大。');
      const text = plainBranch(validated);
      const item = new ClipboardItem({
        'text/plain': text,
        [BRANCH_TYPE]: new Blob([serialized], { type: 'application/json' }),
      });
      // The fixed raw OS format persists beyond this process, independently of plain-text fallback.
      await clipboard.write([item]);
      retained = null;
    }),

    pasteBranch: () => enqueue(async () => {
      const blob = await readPayload(BRANCH_TYPE);
      if (!blob) return null;
      const text = await blob.text();
      try { return validateDocument(JSON.parse(text.replace(/\0+$/, ''))); }
      catch { throw new Error('剪贴板中的节点内容无效，请重新复制。'); }
    }),

    pasteText: () => enqueue(async () => {
      const blob = await readPayload('text/plain');
      return blob ? blob.text() : '';
    }),

    copyImage: image => enqueue(async () => {
      const original = validate(image);
      const bytes = Buffer.from(original.dataUrl.slice(original.dataUrl.indexOf(',') + 1), 'base64');
      const { png, hash } = normalize(bytes);
      // Electron commits every representation atomically; validation and encoding happen first.
      await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
      retained = { image: original, hash };
    }),

    pasteImage: availableWidth => enqueue(async () => {
      if (availableWidth !== undefined && (!Number.isFinite(availableWidth) || availableWidth <= 0)) throw new Error('粘贴位置的尺寸无效。');
      const items = await clipboard.read();
      let blob;
      for (const item of items) {
        const type = IMAGE_TYPES.find(candidate => item.types.includes(candidate));
        if (type) { blob = await item.getType(type); break; }
      }
      if (!blob) { retained = null; return null; }
      if (!Number.isFinite(blob.size) || blob.size < 1 || blob.size > MAX_CLIPBOARD_BYTES) throw new Error('剪贴板图片过大，无法读取。');
      const bitmap = normalize(Buffer.from(await blob.arrayBuffer()));
      // Preserve display size and the original encoding only while the real clipboard image still matches.
      if (retained?.hash === bitmap.hash) return { ...retained.image };
      retained = null;
      if (PNG_PREFIX.length + Math.ceil(bitmap.png.length / 3) * 4 > MAX_DATA_URL) throw new Error('图片太大，请压缩后再粘贴。');
      const ratio = bitmap.width / bitmap.height;
      const width = Math.min(bitmap.width, Math.max(32, availableWidth ?? 240), 240, 12000 * ratio);
      return validate({
        id: 'n' + randomUUID().replaceAll('-', ''),
        dataUrl: PNG_PREFIX + bitmap.png.toString('base64'),
        width, height: Math.min(12000, width / ratio),
        naturalWidth: bitmap.width, naturalHeight: bitmap.height,
      });
    }),
  };
}

module.exports = { createImageClipboard };
