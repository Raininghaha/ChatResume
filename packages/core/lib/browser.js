import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

/**
 * 找一个本机浏览器来干「量页面」和「导 PDF」。
 *
 * 不装 puppeteer 是刻意的：整个项目零依赖，为了两个动作拖进一个几百 MB 的
 * Chromium 不划算。找不到浏览器不是错误，只是这两个功能用不了，所以
 * available() 返回 { ok:false } 而不是抛异常，调用方降级成「未测量」。
 */
const CANDIDATES = {
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    '/Applications/Arc.app/Contents/MacOS/Arc',
  ],
  linux: [
    'google-chrome',
    'google-chrome-stable',
    'chromium',
    'chromium-browser',
    'microsoft-edge',
    'brave-browser',
  ],
  win32: [
    path.join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.PROGRAMFILES || '', 'Microsoft/Edge/Application/msedge.exe'),
  ],
};

let cachedPath;

export function findBrowser() {
  if (cachedPath !== undefined) return cachedPath;
  const env = process.env;
  const list = [env.RESUME_BROWSER, ...(CANDIDATES[process.platform] || [])].filter(Boolean);
  for (const c of list) {
    if (!c.includes(path.sep)) {
      // 裸命令名走 PATH
      const hit = (env.PATH || '')
        .split(path.delimiter)
        .filter(Boolean)
        .map((d) => path.join(d, c))
        .find((full) => {
          try {
            fs.accessSync(full, fs.constants.X_OK);
            return true;
          } catch {
            return false;
          }
        });
      if (hit) {
        cachedPath = hit;
        return cachedPath;
      }
      continue;
    }
    try {
      fs.accessSync(c, fs.constants.X_OK);
      cachedPath = c;
      return cachedPath;
    } catch {}
  }
  cachedPath = null;
  return cachedPath;
}

export function available() {
  const bin = findBrowser();
  if (!bin) {
    return {
      ok: false,
      reason:
        '没找到本机 Chrome/Edge/Chromium，页数测量与 PDF 导出不可用。可用 RESUME_BROWSER 指定浏览器路径。',
    };
  }
  // CDP 走的是 Node 内置 WebSocket（22+）。Node 18/20 上对话照常，只是这两个功能降级。
  if (typeof WebSocket === 'undefined') {
    return {
      ok: false,
      reason: '当前 Node 没有内置 WebSocket，升级到 Node 22+ 才能用页数测量与 PDF 导出。',
    };
  }
  return { ok: true, bin };
}

// ------------------------------------------------------------------ CDP 客户端

/** 极简 CDP 客户端：一条 WebSocket 打天下，用 flatten 模式带 sessionId 定向到页面。 */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessionListeners = new Map();
    this.closed = false;

    ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message || 'CDP error'));
        else resolve(msg.result);
        return;
      }
      if (msg.method) {
        const key = msg.sessionId || '';
        const listeners = this.sessionListeners.get(key);
        if (listeners) for (const fn of listeners) fn(msg.method, msg.params);
      }
    });

    ws.addEventListener('close', () => {
      this.closed = true;
      for (const { reject } of this.pending.values()) reject(new Error('浏览器连接已关闭'));
      this.pending.clear();
    });
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('浏览器连接已关闭'));
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.ws.send(JSON.stringify(payload));
      } catch (err) {
        this.pending.delete(id);
        reject(err);
      }
    });
  }

  once(sessionId, method, timeoutMs) {
    return new Promise((resolve, reject) => {
      const key = sessionId || '';
      const timer = setTimeout(() => {
        off();
        reject(new Error(`等待 ${method} 超时`));
      }, timeoutMs);
      const handler = (name, params) => {
        if (name !== method) return;
        clearTimeout(timer);
        off();
        resolve(params);
      };
      const off = () => {
        const set = this.sessionListeners.get(key);
        if (set) set.delete(handler);
      };
      if (!this.sessionListeners.has(key)) this.sessionListeners.set(key, new Set());
      this.sessionListeners.get(key).add(handler);
    });
  }
}

// ------------------------------------------------------------------- 生命周期

const LAUNCH_VARIANTS = [['--headless=new'], ['--headless']];
const IDLE_MS = 5 * 60 * 1000;

let browser = null; // { proc, cdp, dir, timer }
let launching = null; // 在途的启动 promise，见 ensureBrowser

function killBrowser() {
  if (!browser) return;
  clearTimeout(browser.timer);
  const { proc, dir } = browser;
  browser = null;
  try {
    proc.kill('SIGKILL');
  } catch {}
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}

function readDevtoolsUrl(proc, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('浏览器启动超时')), timeoutMs);
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const match = buf.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) {
        clearTimeout(timer);
        resolve(match[1]);
      }
    };
    proc.stderr.on('data', onData);
    proc.on('close', () => {
      clearTimeout(timer);
      reject(new Error('浏览器进程退出了'));
    });
  });
}

async function connect(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('连接浏览器调试端口超时')), 10000);
    ws.addEventListener('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('无法连接浏览器调试端口'));
    });
  });
  return new Cdp(ws);
}

async function launch(variant) {
  const bin = findBrowser();
  if (!bin) throw new Error(available().reason);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-chat-chrome-'));
  const proc = spawn(
    bin,
    [
      ...variant,
      '--remote-debugging-port=0',
      `--user-data-dir=${dir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions',
      '--disable-background-networking',
      '--disable-sync',
      '--hide-scrollbars',
      '--allow-file-access-from-files',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] }
  );

  try {
    const wsUrl = await readDevtoolsUrl(proc, 15000);
    const cdp = await connect(wsUrl);
    browser = { proc, cdp, dir, timer: null };
    proc.on('close', () => {
      if (browser?.proc === proc) {
        clearTimeout(browser.timer);
        browser = null;
      }
    });
    return browser;
  } catch (err) {
    try {
      proc.kill('SIGKILL');
    } catch {}
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
    throw err;
  }
}

/**
 * 常驻复用：每轮对话都要量一次页，每次重新起 Chrome 要一秒多，太亏。
 *
 * 启动必须是单飞（single-flight）的：两个并发的 check 同时看到 browser 为空，
 * 各自起一个 Chrome，后起来的那个会覆盖模块变量，先起来的就再也没人能 kill 了 ——
 * 表现是每次并发就漏一组孤儿 Chrome 进程。所以共享同一个在途 promise。
 */
async function ensureBrowser() {
  if (browser && !browser.cdp.closed) return browser;
  if (!launching) {
    launching = (async () => {
      try {
        let lastError = null;
        for (const variant of LAUNCH_VARIANTS) {
          try {
            return await launch(variant);
          } catch (err) {
            lastError = err;
          }
        }
        throw lastError || new Error('浏览器启动失败');
      } finally {
        launching = null;
      }
    })();
  }
  return launching;
}

function touchIdle() {
  if (!browser) return;
  clearTimeout(browser.timer);
  browser.timer = setTimeout(killBrowser, IDLE_MS);
  // 别让这个计时器把 Node 进程吊着不退出
  browser.timer.unref?.();
}

/**
 * 借一个页面用一用，用完就关。
 * fn 收到 { evaluate, printToPDF, navigate, session }。
 */
export async function withPage(fn, { timeoutMs = 20000 } = {}) {
  const b = await ensureBrowser();
  const { targetId } = await b.cdp.send('Target.createTarget', { url: 'about:blank' });
  let sessionId;
  try {
    ({ sessionId } = await b.cdp.send('Target.attachToTarget', { targetId, flatten: true }));
    await b.cdp.send('Page.enable', {}, sessionId);
    await b.cdp.send('Runtime.enable', {}, sessionId);

    const page = {
      session: sessionId,
      /** 接受 http(s)/file 的完整 URL，也接受本地文件路径。 */
      async navigate(target) {
        // 只有不是带协议头的 URL 时才当成本地路径。反过来判断（只认 file:）会把
        // http:// 也拼成 file 路径，导航到一个不存在的文件，页面变成错误页。
        const url = /^[a-z][a-z0-9+.-]*:/i.test(target) ? target : pathToFileURL(target).href;
        // 监听必须在 navigate 之前挂上，且只在真正导航时才创建：提前创建又没等到
        // load 的 promise 会在超时后 reject，而没人 catch，变成 unhandledRejection。
        const loaded = b.cdp.once(sessionId, 'Page.loadEventFired', timeoutMs);
        await b.cdp.send('Page.navigate', { url }, sessionId);
        await loaded;
        return url;
      },
      async evaluate(expression) {
        const res = await b.cdp.send(
          'Runtime.evaluate',
          { expression, returnByValue: true, awaitPromise: true },
          sessionId
        );
        if (res.exceptionDetails) {
          throw new Error(res.exceptionDetails.text || '页面内脚本执行失败');
        }
        return res.result?.value;
      },
      async printToPDF(params = {}) {
        const { data } = await b.cdp.send(
          'Page.printToPDF',
          { printBackground: true, preferCSSPageSize: true, ...params },
          sessionId
        );
        return Buffer.from(data, 'base64');
      },
    };

    const result = await fn(page);
    return result;
  } finally {
    touchIdle();
    try {
      await b.cdp.send('Target.closeTarget', { targetId });
    } catch {}
  }
}

export function browserStatus() {
  const av = available();
  return {
    ...av,
    warm: Boolean(browser && !browser.cdp.closed),
  };
}

/**
 * 收掉常驻浏览器。调用方（CLI 的收尾、UI 的 SIGINT 处理）负责在退出前叫一次。
 *
 * 这里刻意不注册 SIGINT/SIGTERM：一旦注册了，Node 就不再按默认行为退出，
 * 任何 import 了这个模块的脚本按 Ctrl+C 都会挂住。只在 exit 上兜一次底。
 */
export function closeBrowser() {
  killBrowser();
}

process.once('exit', killBrowser);
