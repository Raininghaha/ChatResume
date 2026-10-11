import * as claude from './claude.js';
import { ResumeError } from '../errors.js';

/**
 * runner 适配层。
 *
 * 一个 runner 就是「把 prompt 变成事件流」的东西，接口只有三个成员：
 *
 *   name            名字（--runner 用它选）
 *   description     给 help 看的一句话
 *   available()     → { ok, bin?, reason? }，用来在动手前把环境问题说清楚
 *   run(opts)       → AsyncIterable<{ t, v }>
 *
 * 事件词表固定为 status / tool / text / session / error / done。
 * v1 只实现 claude，接口留着是为了换个后端（别的 CLI、别的模型）时
 * 不用动 chat.js、不用动前端。
 */
const registry = new Map([[claude.name, claude]]);

export function getRunner(name = 'claude') {
  const runner = registry.get(name);
  if (!runner) {
    throw new ResumeError(
      `没有名为「${name}」的 runner，可用的有：${[...registry.keys()].join(', ')}`,
      'NO_RUNNER',
      400,
      2
    );
  }
  return runner;
}

export function listRunners() {
  return [...registry.values()].map((r) => ({
    name: r.name,
    description: r.description,
    available: r.available(),
  }));
}
