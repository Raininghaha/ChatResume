import * as claude from './claude.js';
import * as codex from './codex.js';
import { customRunners } from './custom.js';
import { ResumeError } from '../errors.js';
function registry() { return new Map([claude, codex, ...customRunners()].map(r => [r.name, r])); }
export function getRunner(name = process.env.RESUME_RUNNER || 'auto') {
  const runners = registry();
  if (name === 'auto') return [...runners.values()].find(r => r.available().ok) || claude;
  const runner = runners.get(name);
  if (!runner) throw new ResumeError(`没有名为「${name}」的 Agent，可选：${[...runners.keys()].join(', ')}`, 'NO_RUNNER', 400, 2);
  return runner;
}
export function listRunners() {
  return [...registry().values()].map(r => ({ name: r.name, description: r.description, available: r.available() }));
}
