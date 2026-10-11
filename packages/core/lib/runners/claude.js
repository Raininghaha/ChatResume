import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const name = 'claude';
export const description = '本机 claude CLI（复用你已登录的 Claude Code 订阅，不需要 API key）';

const TOOLS = {
  allowed: ['Read', 'Write', 'Edit', 'Glob', 'Grep'],
  // 会话类 Agent 最容易出事的就是让它自己出去跑命令；编辑简历用不到，直接关掉
  disallowed: ['Bash', 'WebFetch', 'WebSearch', 'Task', 'NotebookEdit'],
};

let cached = null;

/**
 * 找 claude 可执行文件。macOS 上 GUI 启动的进程 PATH 往往只有 /usr/bin:/bin，
 * 所以除了 PATH 还要探常见的装机位置，否则双击启动会找不到 CLI。
 */
export function resolveBin() {
  if (cached) return cached;
  const env = process.env;
  const candidates = [
    env.CLAUDE_BIN,
    ...(env.PATH || '')
      .split(path.delimiter)
      .filter(Boolean)
      .map((d) => path.join(d, 'claude')),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
    path.join(env.HOME || '', '.local/bin/claude'),
    path.join(env.HOME || '', '.claude/local/claude'),
  ].filter(Boolean);

  for (const c of candidates) {
    // 显式指定成裸命令名（如 CLAUDE_BIN=claude）时信任 PATH，不去 access 相对路径
    if (!c.includes(path.sep)) {
      cached = c;
      return cached;
    }
    try {
      fs.accessSync(c, fs.constants.X_OK);
      cached = c;
      return cached;
    } catch {}
  }
  return null;
}

export function available() {
  const bin = resolveBin();
  if (!bin) {
    return {
      ok: false,
      reason:
        '没有找到 claude CLI。装好 Claude Code 并确认它在 PATH 里，或用 CLAUDE_BIN 指定完整路径。',
    };
  }
  return { ok: true, bin };
}

function buildArgs({ systemPrompt, prompt, sessionId }) {
  const args = [
    '-p',
    prompt,
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--verbose',
    '--permission-mode',
    'acceptEdits',
    '--append-system-prompt',
    systemPrompt,
    '--allowedTools',
    TOOLS.allowed.join(' '),
    '--disallowedTools',
    TOOLS.disallowed.join(' '),
  ];
  if (sessionId) args.push('--resume', sessionId);
  return args;
}

/**
 * 跑一轮对话，产出统一的事件流：
 *   { t: 'status' | 'tool' | 'text' | 'session' | 'error' | 'done', v }
 *
 * 'session' 是给调用方存的会话号，界面层不显示。其余四种与浏览器端的
 * 事件词表完全一致，所以 UI 换 runner 不用改前端。
 */
export async function* run(options) {
  let invalidSession = false;
  for await (const ev of runAttempt(options)) {
    if (ev.t === 'invalid-session') invalidSession = true;
    else yield ev;
  }
  if (invalidSession && !options.signal?.aborted) {
    yield { t: 'session', v: null };
    yield { t: 'status', v: '旧会话已失效，正在建立新会话…' };
    yield* runAttempt({ ...options, sessionId: null });
  }
}

async function* runAttempt({
  systemPrompt,
  prompt,
  sessionId = null,
  cwd,
  signal,
  timeoutMs = 10 * 60 * 1000,
}) {
  const bin = resolveBin();
  if (!bin) {
    yield { t: 'error', v: available().reason };
    yield { t: 'done' };
    return;
  }

  const proc = spawn(bin, buildArgs({ systemPrompt, prompt, sessionId }), {
    cwd: cwd || process.cwd(),
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const queue = [];
  let wake = null;
  let settled = false;
  let session = '';
  let stderr = '';
  let stdoutBuf = '';
  let sawStreamEvent = false;
  let sawText = false;
  let resultEvent = null;
  let exitCode = null;
  const toolsSeen = new Set();

  const push = (ev) => {
    queue.push(ev);
    if (wake) {
      wake();
      wake = null;
    }
  };

  const onAbort = () => {
    try {
      proc.kill('SIGTERM');
    } catch {}
  };
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener('abort', onAbort, { once: true });
  }

  const timer = setTimeout(() => {
    push({ t: 'error', v: `生成超时（超过 ${Math.round(timeoutMs / 60000)} 分钟），已中止` });
    try {
      proc.kill('SIGKILL');
    } catch {}
  }, timeoutMs);

  const settle = () => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (signal) signal.removeEventListener?.('abort', onAbort);

    const detail = [
      resultEvent?.result,
      ...(Array.isArray(resultEvent?.errors) ? resultEvent.errors : []),
      stderr.trim(),
    ].filter(Boolean).join('\n');

    // 仅在确认旧会话不存在、且没有任何文字或工具执行时重试，避免重复修改。
    if (sessionId && !sawText && toolsSeen.size === 0 &&
        /No conversation found (?:with|for) session ID/i.test(detail)) {
      push({ t: 'invalid-session' });
      return;
    }

    if (session) push({ t: 'session', v: session });

    if (resultEvent) {
      if (resultEvent.is_error) {
        push({ t: 'error', v: (detail || `生成失败（${resultEvent.subtype || '未知错误'}）`).slice(0, 500) });
      } else if (!sawText && resultEvent.result) {
        push({ t: 'text', v: String(resultEvent.result) });
      }
    } else if (exitCode !== null && exitCode !== 0) {
      push({ t: 'error', v: `claude CLI 退出码 ${exitCode}${detail ? `\n${detail.slice(0, 500)}` : ''}` });
    } else if (!resultEvent && !signal?.aborted) {
      push({ t: 'error', v: 'claude CLI 未返回完成结果，请重试' });
    }

    push({ t: 'done' });
  };

  const handleLine = (line) => {
    if (!line) return;
    let evt;
    try {
      evt = JSON.parse(line);
    } catch {
      return;
    }

    if (evt.type === 'system' && evt.subtype === 'init') {
      session = evt.session_id || session;
      push({ t: 'status', v: '会话已就绪' });
      return;
    }

    if (evt.type === 'stream_event') {
      sawStreamEvent = true;
      const e = evt.event || {};
      if (e.type === 'content_block_start' && e.content_block?.type === 'tool_use') {
        const tool = e.content_block.name || 'Tool';
        if (!toolsSeen.has(tool)) {
          toolsSeen.add(tool);
          push({ t: 'tool', v: tool === 'Read' ? '正在阅读简历…' : '正在修改简历…' });
        }
      } else if (e.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
        sawText = true;
        push({ t: 'text', v: e.delta.text });
      }
      return;
    }

    if (evt.type === 'assistant' && !sawStreamEvent) {
      for (const block of evt.message?.content || []) {
        if (block.type === 'text' && block.text) {
          sawText = true;
          push({ t: 'text', v: block.text });
        } else if (block.type === 'tool_use' && block.name && !toolsSeen.has(block.name)) {
          toolsSeen.add(block.name);
          push({ t: 'tool', v: block.name === 'Read' ? '正在阅读简历…' : '正在修改简历…' });
        }
      }
      return;
    }

    if (evt.type === 'result') {
      resultEvent = evt;
      session = evt.session_id || session;
    }
  };

  proc.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    let idx;
    while ((idx = stdoutBuf.indexOf('\n')) >= 0) {
      const line = stdoutBuf.slice(0, idx).trim();
      stdoutBuf = stdoutBuf.slice(idx + 1);
      handleLine(line);
    }
  });

  proc.stderr.on('data', (chunk) => {
    stderr += chunk.toString('utf8');
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });

  proc.on('error', (err) => {
    push({ t: 'error', v: `无法启动 claude CLI：${err.message}` });
    settle();
  });

  proc.on('close', (code) => {
    if (stdoutBuf.trim()) handleLine(stdoutBuf.trim());
    exitCode = code;
    settle();
  });

  try {
    while (true) {
      if (queue.length) {
        yield queue.shift();
        continue;
      }
      if (settled) break;
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    // 消费方提前 break（比如浏览器断开）时也要把子进程收掉，不然会留个孤儿在跑
    clearTimeout(timer);
    if (!settled) {
      try {
        proc.kill('SIGTERM');
      } catch {}
    }
  }
}
