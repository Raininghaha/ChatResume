import { ResumeError } from '../errors.js';
export const PROTOCOL = 'chatresume/1';
export function event(value) {
  if (!value || !['status', 'tool', 'text', 'session', 'resume', 'error', 'done'].includes(value.t))
    throw new ResumeError('未知 Agent 事件', 'AGENT_PROTOCOL', 400, 1);
  if (value.t === 'resume') {
    if (typeof value.html !== 'string' || typeof value.revision !== 'string' || value.html.length > 8e6)
      throw new ResumeError('resume 事件需要 html 和 revision', 'AGENT_PROTOCOL', 400, 1);
    return { t: 'resume', html: value.html, revision: value.revision };
  }
  if (value.t === 'done') return { t: 'done' };
  if (value.t === 'session' && value.v === null) return { t: 'session', v: null };
  if (typeof value.v !== 'string' || value.v.length > 8e6)
    throw new ResumeError('Agent 事件内容无效', 'AGENT_PROTOCOL', 400, 1);
  return { t: value.t, v: value.v };
}
