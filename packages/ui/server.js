import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { accessGate } from './auth.js';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  ResumeError,
  claimJob,
  openMailbox,
  submitEvents,
  activeName,
  applyAction,
  ask,
  browserStatus,
  check,
  closeBrowser,
  createLogger,
  ensureHome,
  exportPdf,
  isBusy,
  listRunners,
  listResumes,
  preflight,
  renderStatus,
  resetSession,
  resumePath,
  readResume,
  watchWorkspace,
  writeResume,
  paths,
} from '@resume-chat/core';

const PKG_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(PKG_ROOT, 'public');
const DEFAULT_PORT = 8790;
const revision = html => createHash('sha256').update(html).digest('hex');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.gif': 'image/gif',
  '.pdf': 'application/pdf',
  '.woff2': 'font/woff2',
};

const EMPTY_DOC = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>还没有简历</title>
<style>@page{size:A4;margin:0}body{margin:0;background:#b9b9b9;font-family:"PingFang SC",-apple-system,sans-serif}
.page{width:210mm;min-height:297mm;background:#fff;display:grid;place-items:center;color:#b0b0b0;font-size:14px}
</style></head><body><div class="page">还没有简历 —— 点右上角「+ 新建」建一份</div></body></html>`;

// ------------------------------------------------------------------- helpers

function readBody(req, limit = 1e6) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > limit) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

function readJson(req, limit) {
  return readBody(req, limit).then((raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  });
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'content-type': MIME['.json'], 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

/** 把内核的 ResumeError 直接映射成状态码，别的错误一律 500。 */
function sendError(res, err) {
  const status = err instanceof ResumeError ? err.status : 500;
  sendJson(res, status, {
    error: err?.message || '服务器内部错误',
    code: err instanceof ResumeError ? err.code : 'INTERNAL',
  });
}

function safeJoin(base, rel) {
  const full = path.resolve(base, '.' + path.posix.normalize('/' + rel));
  return full.startsWith(base + path.sep) || full === base ? full : null;
}

function serveFile(res, file, { noStore = true } = {}) {
  fs.readFile(file, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
      'cache-control': noStore ? 'private, no-store, no-transform' : 'public, max-age=60, no-transform',
    });
    res.end(buf);
  });
}

export function openUrl(url) {
  const cmd =
    process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  try {
    spawn(cmd, args, { stdio: 'ignore', detached: true }).unref();
  } catch {}
}

// --------------------------------------------------------------------- 启动

export function createServer({ log = createLogger() } = {}) {
  ensureHome();
  const home = paths().home;
  const gate = accessGate(process.env.RESUME_ACCESS_CONFIG || path.join(home, 'remote-access.json'));
  let exporting = false;
  const stopMailbox = openMailbox();

  // ------------------------------------------------------------- SSE 广播
  const clients = new Set();

  function broadcast(obj) {
    const payload = `data: ${JSON.stringify(obj)}\n\n`;
    for (const c of clients) {
      try {
        c.write(payload);
      } catch {}
    }
  }

  const stopWatch = watchWorkspace(() => broadcast({ type: 'resume-changed' }));

  /**
   * 每轮对话之后自动量一次页。
   *
   * 简历最常见的暗病是「内容多两行悄悄溢到第二页」，预览里不一定看得出来。
   * 量不出来（没装浏览器）就广播一个带 reason 的结果，界面显示「未测量」，
   * 而不是弹个错误——这是能力缺失，不是故障。
   */
  async function broadcastCheck() {
    const name = activeName();
    if (!name) return;
    try {
      const result = await check(name);
      broadcast({ type: 'check', check: result });
    } catch (err) {
      log(`check ▸ 失败 ${err.message}`);
    }
  }

  // ---------------------------------------------------------------- 对话
  function handleChat(req, res) {
    readJson(req).then(async (body) => {
      const message = String(body?.message || '').trim();
      const name = body?.name ? String(body.name) : undefined;

      // 必须在写响应头之前校验：一开流就没法改状态码了
      try {
        preflight({ name, message, runner: body?.runner });
      } catch (err) {
        sendError(res, err);
        return;
      }

      const target = name || activeName();
      res.writeHead(200, {
        'content-type': 'application/x-ndjson; charset=utf-8',
        'cache-control': 'no-store',
        'x-accel-buffering': 'no',
      });

      const emit = (obj) => {
        if (res.writableEnded) return;
        try {
          res.write(JSON.stringify(obj) + '\n');
        } catch {}
      };
      // 空行保持代理连接活跃，客户端 NDJSON 解析器会忽略。
      const heartbeat = setInterval(() => { if (!res.writableEnded) res.write('\n'); }, 15000);
      res.once('close', () => clearInterval(heartbeat));

      const controller = new AbortController();
      let clientGone = false;
      const t0 = Date.now();

      res.on('close', () => {
        if (!res.writableEnded) {
          clientGone = true;
          log(`chat ▸ 客户端断开 简历=${target} 用时=${Date.now() - t0}ms`);
          controller.abort();
        }
      });

      log(`chat ▸ 开始 简历=${target} 用户: ${message.slice(0, 120).replace(/\n/g, ' ')}`);

      // runner 结束时已经发过 done；这里只在它没发的情况下补一个，
      // 否则客户端会收到两个 done（前端忽略得掉，但 --json 的消费者会看到重复项）
      let sawDone = false;

      try {
        for await (const ev of ask({
          name: target,
          runner: body?.runner,
          message,
          signal: controller.signal,
          promptFile: body?.promptFile,
        })) {
          if (ev.t === 'done') sawDone = true;
          if (ev.t === 'error') log(`chat ▸ 错误 简历=${target} ${String(ev.v).slice(0, 500)}`);
          emit(ev);
        }
        log(`chat ▸ 结束 简历=${target} 用时=${Date.now() - t0}ms`);
      } catch (err) {
        emit({ t: 'error', v: err?.message || String(err) });
      } finally {
        if (!sawDone) emit({ t: 'done' });
        if (!res.writableEnded) res.end();
        broadcast({ type: 'resume-changed' });
        if (!clientGone) broadcastCheck();
      }
    });
  }

  // ------------------------------------------------------------ 简历管理
  function handleResumeAction(req, res) {
    readJson(req).then((body) => {
      try {
        const result = applyAction(body);
        broadcast({ type: 'resume-changed' });
        sendJson(res, 200, { ok: true, items: listResumes(), ...result });
      } catch (err) {
        sendError(res, err);
      }
    });
  }

  function handleResumeSave(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const name = url.searchParams.get('name') || activeName();
    if (!name) {
      sendJson(res, 400, { error: '还没有简历' });
      return;
    }
    readBody(req, 8e6).then((html) => {
      try {
        if (isBusy(name)) throw new ResumeError('这份简历正在由 AI 修改，请稍后保存', 'BUSY', 409, 1);
        const expected = req.headers['if-match'] || url.searchParams.get('revision');
        if (!expected || expected !== revision(readResume(name))) throw new ResumeError('简历已在其他设备更新，未覆盖新内容。请复制当前修改后刷新重试。', 'CONFLICT', 409, 1);
        writeResume(name, html);
        sendJson(res, 200, { ok: true, active: name, revision:revision(readResume(name)) });
      } catch (err) {
        sendError(res, err);
      }
    });
  }

  // --------------------------------------------------------------- 路由
  const server = http.createServer(async (req, res) => {
    try {
    const url = new URL(req.url, `http://localhost:${DEFAULT_PORT}`);
    const p = url.pathname;
    if (!await gate(req, res, url)) return;
    // Same access gate as the GUI: remote workers must authenticate first.
    if (req.method === 'GET' && p === '/api/agent/protocol') {
      sendJson(res, 200, { protocol: 'chatresume/1', transports: ['command', 'http', 'external'],
        events: ['status', 'tool', 'text', 'resume', 'session', 'error', 'done'] });
      return;
    }
    if (req.method === 'POST' && p === '/api/agent/next') {
      sendJson(res, 200, { job: claimJob() });
      return;
    }
    if (req.method === 'POST' && p === '/api/agent/events') {
      const body = await readJson(req, 9e6);
      submitEvents(body?.id, body?.token, body?.events);
      sendJson(res, 200, { ok: true });
      return;
    }
    if (req.method === 'GET' && p === '/api/access') {
      const configFile = process.env.RESUME_ACCESS_CONFIG || path.join(home, 'remote-access.json');
      const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile,'utf8')) : null;
      sendJson(res, 200, {enabled:!!config,notifications:config?.tunnelMode === 'quick' ? 'poll' : 'sse'});
      return;
    }
    if (req.method === 'GET' && p === '/api/revision') {
      const name = url.searchParams.get('name') || activeName();
      sendJson(res,200,{revision:name ? revision(readResume(name)) : null});
      return;
    }

    if (req.method === 'GET' && p === '/api/export') {
      const name = url.searchParams.get('name') || activeName();
      if (!name) { sendJson(res, 400, {error:'还没有简历'}); return; }
      if (exporting || isBusy(name)) { sendJson(res, 409, {error:'简历正在处理，请稍后下载'}); return; }
      exporting = true;
      let temp;
      try {
        temp = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-download-'));
        const result = await exportPdf(name, path.join(temp, 'resume.pdf'));
        const buffer = fs.readFileSync(result.file);
        res.writeHead(200, {
          'content-type':'application/pdf', 'content-length':buffer.length,
          'content-disposition':`attachment; filename="resume.pdf"; filename*=UTF-8''${encodeURIComponent(`${result.name}.pdf`)}`,
          'cache-control':'private, no-store, no-transform',
        });
        res.end(buffer);
      } catch (err) { sendError(res, err); }
      finally { exporting = false; if (temp) fs.rmSync(temp, {recursive:true,force:true}); }
      return;
    }

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
      return;
    }
    if (req.method === 'GET' && p === '/resume') {
      const name = url.searchParams.get('name') || activeName();
      const file = name && resumePath(name);
      if (!file || !fs.existsSync(file)) {
        res.writeHead(200, { 'content-type': MIME['.html'], 'cache-control': 'private, no-store, no-transform' });
        res.end(EMPTY_DOC);
        return;
      }
      const html = readResume(name);
      const rendered = html.replace(/<html(?=[\s>])/i, `<html data-resume-revision="${revision(html)}" data-resume-name="${encodeURIComponent(name)}"`);
      // Cloudflare 邮箱混淆依赖解码脚本，与简历的 script-src 'none' 冲突。
      // no-transform 禁止边缘改写，保留真实邮箱而不放开预览脚本。
      res.writeHead(200, {'content-type':MIME['.html'],'cache-control':'private, no-store, no-transform'});
      res.end(rendered);
      return;
    }
    if (req.method === 'GET' && p.startsWith('/assets/')) {
      const file = safeJoin(paths().assets, p.slice('/assets/'.length));
      if (!file) {
        res.writeHead(403).end();
        return;
      }
      serveFile(res, file);
      return;
    }
    if (req.method === 'GET' && (p === '/app.js' || p === '/style.css')) {
      serveFile(res, path.join(PUBLIC_DIR, p.slice(1)));
      return;
    }

    if (req.method === 'GET' && p === '/api/resumes') {
      sendJson(res, 200, { items: listResumes(), active: activeName() });
      return;
    }
    if (req.method === 'POST' && p === '/api/resumes') {
      handleResumeAction(req, res);
      return;
    }
    // PUT 用于正常保存；POST 用于页面关闭前的 sendBeacon 兜底
    if ((req.method === 'PUT' || req.method === 'POST') && p === '/api/resume') {
      handleResumeSave(req, res);
      return;
    }

    if (req.method === 'GET' && p === '/api/check') {
      const name = url.searchParams.get('name') || activeName();
      if (!name) {
        sendJson(res, 200, { ok: false, reason: '还没有简历' });
        return;
      }
      check(name)
        .then((result) => sendJson(res, 200, result))
        .catch((err) => sendJson(res, 500, { ok: false, reason: err.message }));
      return;
    }

    if (req.method === 'GET' && p === '/api/status') {
      sendJson(res, 200, {
        home,
        active: activeName(),
        items: listResumes(),
        browser: browserStatus(),
        render: renderStatus(),
        runners: listRunners(),
        defaultRunner: process.env.RESUME_RUNNER || 'external',
      });
      return;
    }

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write(': connected\n\n');
      clients.add(res);
      const ping = setInterval(() => {
        try {
          res.write(': ping\n\n');
        } catch {}
      }, 20000);
      req.on('close', () => {
        clearInterval(ping);
        clients.delete(res);
      });
      return;
    }

    if (req.method === 'POST' && p === '/api/chat') {
      handleChat(req, res);
      return;
    }
    if (req.method === 'POST' && p === '/api/reset') {
      readJson(req)
        .then((body) => {
          resetSession(body?.name, body?.runner);
          sendJson(res, 200, { ok: true });
        })
        .catch((err) => sendError(res, err));
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
    } catch (err) {
      if (!res.headersSent) sendError(res, err);
      else res.end();
    }
  });
  server.on('close', () => { stopWatch(); stopMailbox(); });

  // 长连接的生成超时由 Agent runner 管理；HTTP 层允许持续传输事件。
  server.requestTimeout = 0;
  server.headersTimeout = 65000;
  server.keepAliveTimeout = 65000;

  return { server, broadcast, log };
}

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      server.removeListener('listening', onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve(server.address().port);
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * 起服务。端口被占就往后挪，而不是直接报错——用户双击启动时最不想要的
 * 就是一个「端口已被占用」然后窗口关掉。
 */
export async function serve({ port = DEFAULT_PORT, open = true, host = '127.0.0.1', strictPort = false } = {}) {
  const { server, log } = createServer();

  let actual = port;
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      actual = await listen(server, port + attempt, host);
      break;
    } catch (err) {
      if (strictPort || err.code !== 'EADDRINUSE' || attempt === 19) throw err;
    }
  }

  const url = `http://localhost:${actual}`;
  const active = activeName();
  const names = listResumes();
  const browser = browserStatus();

  log(
    `启动 ▸ 端口=${actual} 简历=${active || '(无)'} 共${names.length}份 pid=${process.pid}`,
    `浏览器=${browser.ok ? 'ok' : '不可用'}`
  );
  console.log(`\n  resume-chat 已启动`);
  console.log(`  → ${url}\n`);
  console.log(`  数据目录: ${paths().home}`);
  console.log(`  当前简历: ${active ? `${active}.html` : '（暂无，请新建）'}`);
  console.log(`  共 ${names.length} 份`);
  console.log(`  页数测量: ${browser.ok ? '可用' : `不可用（${browser.reason}）`}`);
  console.log(`  运行日志: ${paths().log}\n`);
  console.log(`  按 Ctrl+C 退出\n`);

  // 优雅退出：不注册的话 Node 会因为 SIGINT 直接终止，常驻的无头 Chrome
  // 就成了孤儿进程（'exit' 回调在信号终止时不会执行）。once 是故意的 ——
  // 再按一次 Ctrl+C 就恢复默认的立即退出，不会卡住。
  const shutdown = () => {
    closeBrowser();
    server.close(() => process.exit(0));
    // 有 SSE 长连接挂着时 close 不会立刻回调，兜个底
    setTimeout(() => process.exit(0), 300).unref();
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, shutdown);

  if (open) openUrl(url);
  return { server, url, port: actual, shutdown };
}

/** 直接 `node server.js` 时的行为。 */
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const portFlag = process.argv.indexOf('--port');
  const port = portFlag > -1 ? Number(process.argv[portFlag + 1]) : Number(process.env.PORT) || DEFAULT_PORT;
  serve({ port, open: !process.argv.includes('--no-open') });
}

export { DEFAULT_PORT };
