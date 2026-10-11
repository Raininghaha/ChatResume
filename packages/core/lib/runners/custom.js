import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../workspace.js';
import { ResumeError } from '../errors.js';
import { findExecutable, runProcess } from './process.js';

/** Local configuration only: never supplied by an HTTP request. */
export function customRunners() {
  const file = process.env.RESUME_RUNNERS_FILE || path.join(homeDir(), 'runners.json');
  if (!fs.existsSync(file)) return [];
  let configs;
  try { configs = JSON.parse(fs.readFileSync(file, 'utf8')).runners; } catch {
    throw new ResumeError('无法读取 runners.json', 'RUNNER_CONFIG', 400, 2);
  }
  if (!Array.isArray(configs)) throw new ResumeError('runners.json 需要 runners 数组', 'RUNNER_CONFIG', 400, 2);
  const names = new Set(['claude', 'codex', 'auto']);
  return configs.map(config => {
    if (!/^[a-z][a-z0-9-]*$/.test(config.name || '') || names.has(config.name) ||
      typeof config.command !== 'string' || !config.command ||
      !Array.isArray(config.args || []) || !(config.args || []).every(a => typeof a === 'string') ||
      !['text', 'ndjson'].includes(config.protocol || 'text'))
      throw new ResumeError('自定义 Agent 的名称、命令、参数或协议无效', 'RUNNER_CONFIG', 400, 2);
    names.add(config.name);
    const protocol = config.protocol || 'text';
    return {
      name: config.name, description: config.description || `自定义 Agent：${config.name}`,
      available() { const bin = findExecutable(config.command); return bin ? { ok: true, bin } : { ok: false, reason: `找不到 ${config.command}` }; },
      async *run({ systemPrompt, prompt, sessionId, cwd, signal, timeoutMs }) {
        const bin = findExecutable(config.command);
        if (!bin) { yield { t: 'error', v: `找不到 ${config.command}` }; yield { t: 'done' }; return; }
        const input = protocol === 'ndjson' ? JSON.stringify({ systemPrompt, prompt, sessionId, cwd }) + '\n' : `${systemPrompt}\n\n用户要求：\n${prompt}\n`;
        const parseLine = protocol === 'ndjson' ? value => {
          const ev = JSON.parse(value);
          if (!['status', 'tool', 'text', 'session', 'error', 'done'].includes(ev.t) ||
              (ev.t !== 'done' && ev.t !== 'session' && typeof ev.v !== 'string') ||
              (ev.t === 'session' && ev.v !== null && typeof ev.v !== 'string')) throw new Error('invalid event');
          return [ev];
        } : undefined;
        yield* runProcess({ bin, args: config.args || [], input, cwd, signal, timeoutMs, parseLine,
          requireCompletion: protocol === 'ndjson', label: config.name });
      },
    };
  });
}
