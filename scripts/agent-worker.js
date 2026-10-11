#!/usr/bin/env node
// Run a user-owned command adapter against the GUI mailbox.
// node scripts/agent-worker.js http://localhost:8790 /path/to/adapter [args...]
import { runProcess } from '../packages/core/lib/runners/process.js';
import { event } from '../packages/core/lib/runners/protocol.js';
const [origin, command, ...args] = process.argv.slice(2);
if (!origin || !command || !/^https?:\/\//.test(origin)) {
  console.error('用法：node scripts/agent-worker.js <GUI网址> <NDJSON适配命令> [参数...]');
  process.exit(2);
}
const controller = new AbortController();
for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => controller.abort());
async function post(route, body) {
  const response = await fetch(new URL(route, origin), { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json', ...(process.env.RESUME_AGENT_COOKIE ?
      { cookie: process.env.RESUME_AGENT_COOKIE } : {}) },
    body: JSON.stringify(body), signal: controller.signal });
  if (!response.ok) throw new Error(`GUI HTTP ${response.status}: ${await response.text()}`);
  return response.json();
}
console.log('等待 GUI 消息；按 Ctrl+C 停止。');
try {
  while (!controller.signal.aborted) {
    const { job } = await post('/api/agent/next', {});
    if (!job) {
      await new Promise(resolve => {
        const done = () => { clearTimeout(timer); controller.signal.removeEventListener('abort', done); resolve(); };
        const timer = setTimeout(done, 1000);
        controller.signal.addEventListener('abort', done, { once: true });
      });
      continue;
    }
    // No shell. The adapter consumes one request and returns line events.
    for await (const ev of runProcess({ bin: command, args,
      input: JSON.stringify(job.request) + '\n', cwd: process.cwd(), signal: controller.signal,
      parseLine: line => [event(JSON.parse(line))], requireCompletion: true })) {
      await post('/api/agent/events', { id: job.id, token: job.token, events: [ev] });
    }
  }
} catch (err) {
  if (!controller.signal.aborted) { console.error(err.message); process.exitCode = 1; }
}
