import fs from 'node:fs';
import { ResumeError } from './errors.js';
import { buildSystemPrompt } from './prompt.js';
import { getRunner } from './runners/index.js';
import { activeName, readResume } from './resumes.js';
import { ensureHome, loadState, paths, saveState } from './workspace.js';

/**
 * 同时在跑的对话，按简历名分开锁。
 *
 * 原来是全局一把锁，两个标签页改两份不同的简历会互相挡。锁的粒度应该是
 * 「同一份简历不能并发改」，而不是「整个服务同时只能有一条对话」。
 */
const running = new Map();

export function isBusy(name) {
  return running.has(name);
}

export function busyResumes() {
  return [...running.keys()];
}

function readPromptExtra(file) {
  const target = file || process.env.RESUME_PROMPT_FILE;
  if (!target) return '';
  try {
    return fs.readFileSync(target, 'utf8');
  } catch {
    return '';
  }
}

/**
 * 起一轮对话之前该做的检查，全部集中在这里。
 *
 * 单独拆出来是因为 HTTP 层必须在写响应头之前就知道「这一轮能不能跑」——
 * 一旦开始流式输出就没法再改状态码了。让 UI 和 ask 共用同一份校验，
 * 两边不会各写一套然后慢慢漂移。
 */
export function preflight({ name, message, runner: runnerName } = {}) {
  ensureHome();
  const text = String(message || '').trim();
  if (!text) throw new ResumeError('消息不能为空', 'EMPTY_MESSAGE', 400, 2);

  const target = name || activeName();
  if (!target) throw new ResumeError('还没有简历，请先新建一份', 'NO_RESUME', 400, 1);

  // 读一下确认存在，顺便让「找不到简历」在起子进程之前就报出来
  readResume(target);

  if (running.has(target)) {
    throw new ResumeError('这条简历上一条消息还在处理中，请稍候', 'BUSY', 409, 1);
  }

  const runner = getRunner(runnerName);
  const availability = runner.available();
  if (!availability.ok) {
    throw new ResumeError(availability.reason, 'NO_RUNNER', 503, 3);
  }

  return { target, message: text, runner };
}

/**
 * 对话一轮。产出 runner 的同款事件流（并顺手吞掉 'session' 的实现细节）。
 *
 * 落在磁盘上的只有简历文件本身：session 号是过程状态，存在 state.json 里，
 * 让下一轮能接着聊。
 */
export async function* ask({
  name,
  message,
  runner: runnerName,
  cwd,
  signal,
  promptFile,
  promptExtra,
} = {}) {
  const { target, message: text, runner } = preflight({ name, message, runner: runnerName });

  const controller = new AbortController();
  const forwardAbort = () => controller.abort();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', forwardAbort, { once: true });
  }
  running.set(target, controller);

  const state = loadState();
  const sessionId = runner.name === 'claude' ? state.sessions?.[target] || null : state.runnerSessions?.[target]?.[runner.name] || null;
  let nextSession;

  try {
    const stream = runner.run({
      systemPrompt: buildSystemPrompt({
        active: target,
        extra: readPromptExtra(promptFile) || promptExtra || '',
      }),
      prompt: text,
      sessionId,
      cwd: cwd || paths().home,
      signal: controller.signal,
    });

    for await (const ev of stream) {
      if (ev.t === 'session') {
        nextSession = ev.v;
        continue;
      }
      yield ev;
    }
  } finally {
    if (running.get(target) === controller) running.delete(target);
    if (signal) signal.removeEventListener?.('abort', forwardAbort);
    if (nextSession !== undefined && !controller.signal.aborted) {
      const s = loadState();
      s.sessions = { ...(s.sessions || {}) };
      if (runner.name === 'claude') {
        if (nextSession) s.sessions[target] = nextSession;
        else delete s.sessions[target];
      } else {
        s.runnerSessions ||= {};
        s.runnerSessions[target] ||= {};
        if (nextSession) s.runnerSessions[target][runner.name] = nextSession;
        else delete s.runnerSessions[target][runner.name];
      }
      saveState(s);
    }
  }
}

/** 中止正在跑的对话，并丢掉这份简历的会话记忆（简历内容不动）。 */
export function resetSession(name, runnerName) {
  if (runnerName === 'auto') runnerName = getRunner('auto').name;
  const target = name || activeName();
  const controller = target && running.get(target);
  if (controller) {
    controller.abort();
  }
  const state = loadState();
  if (target) {
    if (!runnerName || runnerName === 'claude') delete state.sessions[target];
    if (!runnerName) delete state.runnerSessions?.[target];
    else if (state.runnerSessions?.[target]) delete state.runnerSessions[target][runnerName];
    saveState(state);
  }
  return { reset: target, aborted: Boolean(controller) };
}

export function sessionOf(name, runnerName) {
  const target = name || activeName();
  const runner = getRunner(runnerName);
  const state = loadState();
  return runner.name === 'claude' ? state.sessions?.[target] || null : state.runnerSessions?.[target]?.[runner.name] || null;
}
