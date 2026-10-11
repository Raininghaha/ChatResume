import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export function findExecutable(command, candidates = []) {
  for (const c of [command, ...candidates].filter(Boolean)) {
    const locations = path.isAbsolute(c) || c.includes(path.sep) ? [c] :
      (process.env.PATH || '').split(path.delimiter).filter(Boolean).flatMap(d =>
        process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'].map(ext => path.join(d, c + ext)) : [path.join(d, c)]);
    for (const file of locations) {
      try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
    }
  }
  return null;
}

/** Launch without a shell. Prompts use stdin; stdout is either text or line events. */
export async function* runProcess({ bin, args = [], input, cwd, signal, parseLine,
  timeoutMs = 600000, label = 'Agent', requireCompletion = false }) {
  if (signal?.aborted) { yield { t: 'error', v: '对话已取消' }; yield { t: 'done' }; return; }
  const proc = spawn(bin, args, { cwd, env: process.env, stdio: ['pipe', 'pipe', 'pipe'] });
  const queue = [];
  let wake, settled = false, complete = false, failure = false, stderr = '', buffer = '', killTimer;
  const decoder = new StringDecoder('utf8');
  const push = ev => {
    if (ev.t === 'done') { complete = true; return; }
    if (ev.t === 'error') failure = true;
    queue.push(ev); wake?.(); wake = null;
  };
  const line = value => {
    try { for (const ev of parseLine(value) || []) push(ev); }
    catch { push({ t: 'error', v: `${label} 返回了无法解析的事件` }); }
  };
  const stop = () => {
    proc.kill('SIGTERM');
    killTimer = setTimeout(() => proc.kill('SIGKILL'), 2000); killTimer.unref();
  };
  const abort = () => { push({ t: 'error', v: '对话已取消' }); stop(); };
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { push({ t: 'error', v: `${label} 对话超时` }); stop(); }, timeoutMs);
  const finish = (code, sig) => {
    if (settled) return;
    const tail = decoder.end();
    if (parseLine) { buffer += tail; if (buffer.trim()) line(buffer); }
    else if (tail) push({ t: 'text', v: tail });
    if ((code !== 0 || sig) && !failure) push({ t: 'error', v: `${label} 退出失败：${stderr.trim().slice(-1000) || sig || code}` });
    if (requireCompletion && !complete && !failure) push({ t: 'error', v: `${label} 未返回完成事件` });
    settled = true; clearTimeout(timer); clearTimeout(killTimer);
    signal?.removeEventListener('abort', abort);
    queue.push({ t: 'done' }); wake?.(); wake = null;
  };
  proc.stdout.on('data', chunk => {
    const text = decoder.write(chunk);
    if (!parseLine) { push({ t: 'text', v: text }); return; }
    buffer += text;
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) { const value = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1); if (value) line(value); }
    if (buffer.length > 8 * 1024 * 1024) { push({ t: 'error', v: 'Agent 事件过大' }); stop(); }
  });
  proc.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
  proc.stdin.on('error', err => { if (err.code !== 'EPIPE') push({ t: 'error', v: err.message }); });
  proc.on('error', err => { push({ t: 'error', v: `无法启动 ${label}：${err.message}` }); finish(null); });
  proc.on('close', finish);
  proc.stdin.end(input);
  try {
    while (!settled || queue.length) {
      if (queue.length) yield queue.shift();
      else await new Promise(resolve => { wake = resolve; });
    }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort);
    if (!settled) stop();
  }
}
