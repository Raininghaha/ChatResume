import { runCli } from '@resume-chat/core';
import { serve } from './server.js';

/**
 * serve 这个子命令由 UI 包挂进内核的 CLI，而不是内核自己实现。
 *
 * 内核不认识「网页界面」这件事：它只知道简历和对话。多出来这一个命令，
 * 让 `npx resume-chat` 这种最自然的用法成立，同时内核仍然可以单独用。
 */
export const serveCommand = {
  run: ({ flags }) =>
    serve({
      port: flags.port ? Number(flags.port) : undefined,
      open: !flags['no-open'],
    }).then(() => new Promise(() => {})), // 服务一直跑，直到收到信号
};

/** 完整的 resume-chat 入口：内核命令 + serve。 */
export function run(argv) {
  return runCli(argv, { extraCommands: { serve: serveCommand } });
}
