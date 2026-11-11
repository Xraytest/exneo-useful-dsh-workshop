/**
 * Quill Delta → 可读文本的纯函数转换（独立导出便于测试）。
 * @module dsh-bilibili/lib/delta
 */

const MAX_IMAGE_URL_LEN = 1000;

/**
 * @param {string|{ops?: any[]}} content 专栏 content 字段（JSON 字符串或已解析对象）
 * @param {{ maxImages?: number }} options 图片收集上限（超出只计数不收集）
 * @returns {{ text: string, images: Array<{url: string, width?: number, height?: number}>, imagesTotal: number }}
 */
export function deltaToText(content, { maxImages = 50 } = {}) {
  let parsed = content;
  if (typeof content === 'string') {
    try { parsed = JSON.parse(content); } catch { return { text: stripBasic(content), images: [], imagesTotal: 0 }; }
  }
  if (!parsed || !Array.isArray(parsed.ops)) {
    return { text: '', images: [], imagesTotal: 0 };
  }
  const images = [];
  let imagesTotal = 0;
  const parts = [];
  for (const op of parsed.ops) {
    if (typeof op.insert === 'string') {
      parts.push(op.insert);
      continue;
    }
    if (op.insert && typeof op.insert === 'object') {
      const native = op.insert['native-image'];
      const url = native?.url ?? (typeof op.insert.image === 'string' ? op.insert.image : op.insert.image?.url);
      if (typeof url === 'string' && url !== '') {
        imagesTotal += 1;
        if (!/^https?:\/\//i.test(url) || url.length > MAX_IMAGE_URL_LEN) {
          // 外部数据不可信：非 http(s) 或超长的“图片链接”不进输出
          parts.push('\n[不合规图片链接已省略]\n');
        } else if (images.length < maxImages) {
          images.push({ url, width: native?.width, height: native?.height });
          parts.push(`\n[图片${imagesTotal}: ${url}]\n`);
        } else {
          parts.push(`\n[图片${imagesTotal}: 超出列出上限，链接省略]\n`);
        }
      } else if (op.insert['native-card'] || op.insert.card) {
        parts.push('\n[嵌入卡片]\n');
      } else {
        // 未识别的 embed 也留痕，正文不静默缺内容
        parts.push(`\n[嵌入内容: ${Object.keys(op.insert).slice(0, 3).join(',')}]\n`);
      }
    }
  }
  return { text: parts.join(''), images, imagesTotal };
}

function stripBasic(html) {
  return String(html ?? '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&#\d+;/g, '')
    .trim();
}
