import type { NodeImage } from './types';

export async function readClipboardImage(file: File, availableWidth: number): Promise<NodeImage> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) throw new Error('请粘贴 PNG、JPEG 或 WebP 图片。');
  if (file.size > 9 * 1024 * 1024) throw new Error('这张图片过大，请缩小图片后再粘贴。');
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('无法读取图片，请重新复制后粘贴。'));
    reader.readAsDataURL(file);
  });
  if (dataUrl.length > 12 * 1024 * 1024) throw new Error('这张图片过大，请缩小图片后再粘贴。');
  const decoded = new Image();
  decoded.src = dataUrl;
  try { await decoded.decode(); } catch { throw new Error('无法读取图片，请重新复制后粘贴。'); }
  const naturalWidth = decoded.naturalWidth, naturalHeight = decoded.naturalHeight;
  if (!naturalWidth || !naturalHeight || naturalWidth > 16384 || naturalHeight > 16384 || naturalWidth * naturalHeight > 48_000_000) throw new Error('图片尺寸过大，请缩小图片后再粘贴。');
  const width = Math.min(naturalWidth, Math.max(32, availableWidth), 240, 12000 * naturalWidth / naturalHeight);
  return { id: 'i' + crypto.randomUUID().replaceAll('-', ''), dataUrl, width, height: width * naturalHeight / naturalWidth, naturalWidth, naturalHeight };
}
