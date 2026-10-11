import fs from 'node:fs';
import path from 'node:path';
import { ResumeError } from './errors.js';
import { available, withPage } from './browser.js';
import { activeName, resumePath } from './resumes.js';
import { paths } from './workspace.js';

/**
 * 量页面用的脚本，在浏览器里跑。
 *
 * 关键一步是把 .page 的 min-height 临时清掉：简历模板的 .page 是
 * `min-height: 297mm`，不清掉的话 scrollHeight 永远被夹在恰好一页上，
 * 「内容超了没有」这个问题会永远回答「刚好合适」。
 */
const MEASURE = `(() => {
  const PX_PER_MM = 96 / 25.4;
  const pageBoxPx = 297 * PX_PER_MM;
  const nodes = [...document.querySelectorAll('.page')];

  const measureOne = (el) => {
    const prev = el.style.minHeight;
    el.style.minHeight = '0px';
    const contentPx = el.scrollHeight;
    el.style.minHeight = prev;
    return contentPx;
  };

  if (!nodes.length) {
    // 没用 .page 的模版：只能按整篇算一页
    const contentPx = document.documentElement.scrollHeight;
    return { pageBoxPx, custom: true, perPage: [{ index: 1, contentPx, overflowPx: contentPx - pageBoxPx }] };
  }

  const perPage = nodes.map((el, i) => {
    const contentPx = measureOne(el);
    return { index: i + 1, contentPx, overflowPx: contentPx - pageBoxPx };
  });
  return { pageBoxPx, custom: false, perPage };
})()`;

function resource(name) {
  if (!available().ok) return { ok: false, reason: available().reason };
  const target = name || activeName();
  if (!target) return { ok: false, reason: '还没有简历' };
  const file = resumePath(target);
  if (!file || !fs.existsSync(file)) return { ok: false, reason: `找不到简历「${target}」` };
  return { ok: true, name: target, file };
}

/**
 * 量当前这份简历排几页、有没有超出一页。
 *
 * 「超版」是简历最常见的暗病：内容多两行就悄悄溢到第二页，肉眼在预览里
 * 不一定看得出来。所以每轮对话之后都自动量一次，量不了就报「未测」。
 */
export async function check(name, { timeoutMs } = {}) {
  const target = resource(name);
  if (!target.ok) return { ok: false, reason: target.reason };

  const { file, name: resolved } = target;
  try {
    const result = await withPage(async (page) => {
      await page.navigate(file);
      return page.evaluate(MEASURE);
    }, timeoutMs ? { timeoutMs } : undefined);

    const perPage = result.perPage.map((p) => ({
      index: p.index,
      contentPx: p.contentPx,
      contentMm: Math.round((p.contentPx / (96 / 25.4)) * 10) / 10,
      overflowPx: Math.max(0, Math.round(p.overflowPx * 100) / 100),
      // 一个 .page 装不下时，打印会把它断到下一页，所以页数要按内容量算
      printedPages: Math.max(1, Math.ceil((p.contentPx - 1) / result.pageBoxPx)),
    }));

    const overflowPx = perPage.reduce((max, p) => Math.max(max, p.overflowPx), 0);
    const pages = perPage.reduce((sum, p) => sum + p.printedPages, 0);
    return {
      ok: true,
      name: resolved,
      file,
      custom: result.custom,
      pages,
      fits: overflowPx <= 0,
      overflowPx: Math.round(overflowPx * 100) / 100,
      perPage,
    };
  } catch (err) {
    return { ok: false, reason: `测量失败：${err.message}` };
  }
}

/** 用 CSS 里的 @page 尺寸导出，和浏览器「打印 → 存储为 PDF」出来的结果一致。 */
export async function exportPdf(name, outFile, { timeoutMs } = {}) {
  const target = resource(name);
  if (!target.ok) {
    throw new ResumeError(target.reason, 'EXPORT_UNAVAILABLE', 503, 3);
  }

  const dest = outFile
    ? path.resolve(outFile)
    : path.join(paths().exports, `${target.name}.pdf`);

  const buffer = await withPage(async (page) => {
    await page.navigate(target.file);
    // preferCSSPageSize 让 @page{size:A4;margin:0} 说了算；四个 margin 再显式给 0，
    // 兜住 prefersCSSPageSize 没生效时 Chrome 默认的 1cm 边距
    return page.printToPDF({
      preferCSSPageSize: true,
      marginTop: 0,
      marginBottom: 0,
      marginLeft: 0,
      marginRight: 0,
    });
  }, timeoutMs ? { timeoutMs } : undefined);

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.writeFileSync(dest, buffer);
  return { ok: true, name: target.name, file: dest, bytes: buffer.length };
}

export function renderStatus() {
  return available();
}
