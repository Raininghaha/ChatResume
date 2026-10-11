import fs from 'node:fs';
import path from 'node:path';
import { homeDir } from '../workspace.js';
import { ResumeError } from '../errors.js';
import { httpRunner } from './http.js';
import { event } from './protocol.js';
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
  const names = new Set(['claude', 'codex', 'auto', 'external']);
  return configs.map(config => {
    if (!/^[a-z][a-z0-9-]*$/.test(config.name || '') || names.has(config.name))
      throw new ResumeError('自定义 Agent 名称无效或重复', 'RUNNER_CONFIG', 400, 2);
    names.add(config.name);
    if (config.transport === 'http') {
      let url;
      try { url = new URL(config.url); } catch {}
      if (!url || !['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
          (config.headers && (typeof config.headers !== 'object' || Array.isArray(config.headers) ||
            !Object.values(config.headers).every(v => typeof v === 'string'))))
        throw new ResumeError('HTTP Agent 配置无效', 'RUNNER_CONFIG', 400, 2);
      return httpRunner(config);
    }
    if ((config.transport && config.transport !== 'command') || typeof config.command !== 'string' || !config.command ||
        !Array.isArray(config.args || []) || !(config.args || []).every(a => typeof a === 'string') ||
        !['text', 'ndjson'].includes(config.protocol || 'text'))
      throw new ResumeError('自定义 Agent 命令、参数或协议无效', 'RUNNER_CONFIG', 400, 2);
    const protocol = config.protocol || 'text';
    return {
      name: config.name, description: config.description || `自定义 Agent：${config.name}`,
      available() { const bin = findExecutable(config.command); return bin ? { ok: true, bin } : { ok: false, reason: `找不到 ${config.command}` }; },
      async *run({ systemPrompt, prompt, sessionId, cwd, signal, timeoutMs, request }) {
        const bin = findExecutable(config.command);
        if (!bin) { yield { t: 'error', v: `找不到 ${config.command}` }; yield { t: 'done' }; return; }
        const input = protocol === 'ndjson' ? JSON.stringify(request) + '\n' : `${systemPrompt}\n\n用户要求：\n${prompt}\n`;
        const parseLine = protocol === 'ndjson' ? value => [event(JSON.parse(value))] : undefined;
        yield* runProcess({ bin, args: config.args || [], input, cwd, signal, timeoutMs, parseLine,
          requireCompletion: protocol === 'ndjson', label: config.name });
      },
    };
  });
}
