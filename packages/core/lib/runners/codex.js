import os from 'node:os';
import path from 'node:path';
import { findExecutable, runProcess } from './process.js';
export const name = 'codex';
export const description = '本机 Codex CLI（复用本机登录和模型配置）';
export function resolveBin() {
  return findExecutable(process.env.CODEX_BIN || 'codex', [
    '/opt/homebrew/bin/codex', '/usr/local/bin/codex', path.join(os.homedir(), '.local/bin/codex'),
    '/Applications/Codex.app/Contents/Resources/codex',
    '/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex',
  ]);
}
export function available() {
  const bin = resolveBin();
  return bin ? { ok: true, bin } : { ok: false, reason: '没有找到 Codex CLI，请安装并登录，或设置 CODEX_BIN。' };
}
export function buildArgs(sessionId) {
  const args = ['exec', '-c', 'approval_policy="never"', '-c', 'sandbox_mode="workspace-write"'];
  if (sessionId) args.push('resume', sessionId);
  args.push('--json', '--skip-git-repo-check', '-');
  return args;
}
export function parseEvent(line) {
  const ev = JSON.parse(line);
  if (ev.type === 'thread.started') return [{ t: 'session', v: ev.thread_id }, { t: 'status', v: 'Codex 会话已就绪' }];
  if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') return [{ t: 'text', v: ev.item.text }];
  if (ev.type === 'item.started' && ['command_execution', 'file_change', 'mcp_tool_call'].includes(ev.item?.type))
    return [{ t: 'tool', v: ev.item.type === 'file_change' ? '正在修改简历…' : 'Codex 正在处理简历…' }];
  if (ev.type === 'error' && /^Reconnecting/i.test(ev.message || '')) return [{ t: 'status', v: ev.message }];
  if (ev.type === 'turn.failed' || ev.type === 'error') return [{ t: 'error', v: ev.error?.message || ev.message || 'Codex 生成失败' }];
  if (ev.type === 'turn.completed') return [{ t: 'done' }];
  return [];
}
export async function* run({ systemPrompt, prompt, sessionId, cwd, signal, timeoutMs }) {
  const bin = resolveBin();
  if (!bin) { yield { t: 'error', v: available().reason }; yield { t: 'done' }; return; }
  yield* runProcess({ bin, args: buildArgs(sessionId), input: `${systemPrompt}\n\n用户要求：\n${prompt}\n`,
    cwd, signal, timeoutMs, parseLine: parseEvent, requireCompletion: true, label: 'Codex' });
}
