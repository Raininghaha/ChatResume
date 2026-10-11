import { randomUUID, randomBytes } from 'node:crypto';
import { ResumeError } from '../errors.js';
import { event } from './protocol.js';

// In-memory mailbox. The GUI server and its external runner share this process.
const jobs = new Map();
export const name = 'external';
export const description = '自己的 Agent（等待连接）';
let servers = 0;
export const available = () => servers > 0 ? { ok: true } : { ok: false, reason: '外部 Agent 连接需要启动 GUI 服务；CLI 请指定命令或 HTTP 连接' };
export function openMailbox() {
  servers++;
  return () => {
    servers--;
    if (!servers) for (const job of jobs.values()) {
      if (!job.finished) { job.push({ t: 'error', v: 'GUI 服务已关闭' }); job.push({ t: 'done' }); }
    }
  };
}
export function claimJob() {
  for (const job of jobs.values()) {
    if (job.claimed || job.finished) continue;
    job.claimed = true;
    job.token = randomBytes(32).toString('base64url');
    return { id: job.id, token: job.token, request: job.request, expiresAt: job.expiresAt };
  }
  return null;
}
export function submitEvents(id, token, values) {
  const job = jobs.get(id);
  if (!job || !job.claimed || job.token !== token)
    throw new ResumeError('任务已取消、过期或凭证无效', 'AGENT_JOB', 404, 1);
  if (job.finished) throw new ResumeError('任务已结束', 'AGENT_JOB', 409, 1);
  if (!Array.isArray(values) || !values.length || values.length > 100)
    throw new ResumeError('需要 1 至 100 个 events', 'AGENT_PROTOCOL', 400, 1);
  const events = values.map(event);
  const done = events.findIndex(e => e.t === 'done');
  if (done >= 0 && done !== events.length - 1)
    throw new ResumeError('done 必须是最后一个事件', 'AGENT_PROTOCOL', 400, 1);
  if (job.bytes + JSON.stringify(events).length > 9e6)
    throw new ResumeError('Agent 待处理事件过多，请减小批次', 'AGENT_PROTOCOL', 413, 1);
  for (const ev of events) job.push(ev);
}
export async function* run({ request, signal, timeoutMs = 600000 }) {
  if (signal?.aborted) return;
  const queue = [];
  let wake;
  const job = { id: randomUUID(), request, claimed: false, finished: false, bytes: 0,
    expiresAt: Date.now() + timeoutMs,
    push(ev) { job.bytes += JSON.stringify(ev).length; queue.push(ev); if (ev.t === 'done') job.finished = true; wake?.(); wake = null; } };
  jobs.set(job.id, job);
  const stop = message => {
    if (!job.finished) { job.push({ t: 'error', v: message }); job.push({ t: 'done' }); }
  };
  const abort = () => stop('对话已取消');
  signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => stop('Agent 未在十分钟内完成，请连接 Agent 后重试'), timeoutMs);
  try {
    yield { t: 'status', v: '等待你的 Agent 领取消息…' };
    while (!job.finished || queue.length) {
      if (queue.length) { const ev = queue.shift(); job.bytes -= JSON.stringify(ev).length; yield ev; }
      else await new Promise(resolve => { wake = resolve; });
    }
  } finally {
    clearTimeout(timer); signal?.removeEventListener('abort', abort); jobs.delete(job.id);
  }
}
