import { event } from './protocol.js';

export function httpRunner(config) {
  return {
    name: config.name, description: config.description || `HTTP Agent：${config.name}`,
    available: () => ({ ok: true }),
    async *run({ request, signal, timeoutMs = 600000 }) {
      const controller = new AbortController();
      const abort = () => controller.abort();
      if (signal?.aborted) controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      const timer = setTimeout(abort, timeoutMs);
      let reader;
      try {
        const response = await fetch(config.url, { method: 'POST', redirect: 'error',
          headers: { ...config.headers, 'content-type': 'application/json' },
          body: JSON.stringify(request), signal: controller.signal });
        if (!response.ok) throw new Error(`Agent HTTP ${response.status}`);
        reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '', done = false;
        while (!done) {
          const chunk = await reader.read();
          buffer += decoder.decode(chunk.value, { stream: !chunk.done });
          if (buffer.length > 8e6) throw new Error('Agent 事件过大');
          const lines = buffer.split('\n'); buffer = lines.pop();
          if (chunk.done && buffer.trim()) { lines.push(buffer); buffer = ''; }
          for (const line of lines) {
            if (!line.trim()) continue;
            const ev = event(JSON.parse(line));
            if (ev.t === 'done') { done = true; break; }
            yield ev;
          }
          if (chunk.done && !done) throw new Error('Agent 未返回 done 事件');
        }
      } catch (err) {
        yield { t: 'error', v: controller.signal.aborted ? 'Agent 请求已取消或超时' : err.message };
      } finally {
        await reader?.cancel().catch(() => {});
        clearTimeout(timer); signal?.removeEventListener('abort', abort);
      }
      yield { t: 'done' };
    },
  };
}
