#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 在临时目录里跑一遍完整流程。刻意不碰 ~/.resume-chat —— 冒烟测试不该拿
 * 真实简历做实验，否则「测一下」就等于「改一遍」。
 *
 *   node scripts/smoke.js            # 不跑对话（CI 里没有 claude）
 *   node scripts/smoke.js --with-ask # 额外真跑一轮对话（会消耗 token）
 */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CLI = path.join(ROOT, 'packages', 'ui', 'bin', 'resume-chat.js');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-chat-smoke-'));
const withAsk = process.argv.includes('--with-ask');

let passed = 0;
const failures = [];

function cli(args, { input } = {}) {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    env: { ...process.env, RESUME_HOME: home },
    encoding: 'utf8',
    input,
  });
  return { code: result.status, stdout: result.stdout || '', stderr: result.stderr || '' };
}

function jsonOf(args, opts) {
  const r = cli([...args, '--json'], opts);
  let parsed = null;
  try {
    parsed = JSON.parse(r.stdout.trim().split('\n').pop());
  } catch {}
  return { ...r, data: parsed };
}

function ok(label, condition, detail = '') {
  if (condition) {
    passed++;
    process.stdout.write(`  ✓ ${label}\n`);
  } else {
    failures.push(`${label}${detail ? ` —— ${detail}` : ''}`);
    process.stdout.write(`  ✗ ${label}${detail ? ` —— ${detail}` : ''}\n`);
  }
}

process.stdout.write(`\n冒烟测试（数据目录 ${home}）\n\n`);

// 1. 首次运行应当自己把目录和一份空简历铺好
const status = jsonOf(['status']);
ok('status 正常返回', status.code === 0 && status.data?.home === home, status.stderr.trim());
ok('首次运行自动生成一份空简历', status.data?.resumes?.length === 1, `实际 ${status.data?.resumes?.length}`);
ok('数据目录已建立', fs.existsSync(path.join(home, 'resumes')));

// 2. 新建
const created = jsonOf(['new', '冒烟测试']);
ok('new 建出简历', created.code === 0 && created.data?.created === '冒烟测试', created.stderr.trim());
ok('新建后成为当前简历', jsonOf(['list']).data?.active === '冒烟测试');
ok('模板 title 被替换成简历名', fs.readFileSync(created.data.file, 'utf8').includes('<title>冒烟测试</title>'));

// 3. 读
const read = cli(['read', '冒烟测试']);
ok('read 输出完整 HTML', read.stdout.includes('<html') && read.stdout.includes('</html>'));

// 4. 写（同时校验「不是完整 HTML 就拒绝保存」这条防线）
const written = cli(['write', '冒烟测试'], { input: '<!doctype html><html><body>MARKER</body></html>' });
ok('write 从 stdin 写入成功', written.code === 0, written.stderr.trim());
ok('写进去的内容读得回来', cli(['read', '冒烟测试']).stdout.includes('MARKER'));
const rejected = cli(['write', '冒烟测试'], { input: '这不是 HTML' });
ok('残缺 HTML 被拒绝', rejected.code === 2, `退出码 ${rejected.code}`);
ok('被拒绝后原内容没被破坏', cli(['read', '冒烟测试']).stdout.includes('MARKER'));

// 5. 改名会让对话 session 跟着走
const renamed = jsonOf(['rename', '冒烟测试', '冒烟改名']);
ok('rename 成功', renamed.code === 0 && renamed.data?.renamed === '冒烟改名', renamed.stderr.trim());

// 6. 复制 / 切换 / 删除
const dup = jsonOf(['duplicate']);
ok('duplicate 生成副本', dup.code === 0 && String(dup.data?.created).includes('副本'), dup.stderr.trim());
ok('use 切换当前简历', jsonOf(['use', '冒烟改名']).data?.active === '冒烟改名');
const del = jsonOf(['delete', String(dup.data?.created)]);
ok('delete 成功并给出接替者', del.code === 0 && del.data?.active === '冒烟改名', del.stderr.trim());

// 7. 最后一份不能删
const names = jsonOf(['list']).data.items.map((i) => i.name);
let lastOneGuard = false;
for (const name of names.slice(0, -1)) cli(['delete', name]);
lastOneGuard = cli(['delete', names[names.length - 1]]).code !== 0;
ok('拒绝删掉最后一份简历', lastOneGuard);

// 8. state.json 的结构：session 按简历分开存
const state = JSON.parse(fs.readFileSync(path.join(home, 'state.json'), 'utf8'));
ok('state.json 是 sessions 映射而非全局单个 sessionId', state.sessions && typeof state.sessions === 'object');

// 9. path
const p = jsonOf(['path']);
ok('path 指向真实文件', p.code === 0 && fs.existsSync(p.data.file));

// 10. 环境缺失时要优雅报错，而不是抛栈
const runnerCheck = jsonOf(['runners']);
ok('runners 能报告可用性', runnerCheck.code === 0 && runnerCheck.data.items.length >= 1);

// 11. 量页（没装浏览器时允许降级成「未测量」，退出码 3）
const check = jsonOf(['check']);
if (check.data?.ok) {
  ok('check 量出页数', typeof check.data.pages === 'number' && check.data.pages >= 1);
  ok('check 给出溢出量', typeof check.data.overflowPx === 'number');
  ok('check 通过时退出码 0', check.code === 0, `退出码 ${check.code}`);
} else {
  ok('没浏览器时 check 降级而不是崩', check.code === 3, `退出码 ${check.code}，${check.stderr.trim()}`);
}

// 12. 导出（同样允许降级）
const out = path.join(home, 'exports', 'smoke.pdf');
const exp = cli(['export', '-o', out]);
if (exp.code === 0) {
  const buf = fs.readFileSync(out);
  ok('导出的文件是 PDF', buf.subarray(0, 5).toString() === '%PDF-');
  const info = spawnSync('pdfinfo', [out], { encoding: 'utf8' });
  if (info.status === 0) {
    const pages = info.stdout.match(/^Pages:\s+(\d+)/m)?.[1];
    const size = info.stdout.match(/^Page size:\s+([\d.]+)\s+x\s+([\d.]+)/m);
    ok('PDF 页数 >= 1', Number(pages) >= 1, `实际 ${pages}`);
    // A4 = 595.28 x 841.89 pt。Chrome 报 594.96 x 841.92（mm→pt 的取整差异），
    // 所以按容差判，别去匹配字面值
    const [w, h] = size ? [Number(size[1]), Number(size[2])] : [0, 0];
    const isA4 = Math.abs(w - 595.28) < 3 && Math.abs(h - 841.89) < 3;
    ok('PDF 是 A4', isA4, `实测 ${w} x ${h} pt`);
  }
} else {
  ok('没浏览器时 export 以环境错误退出', exp.code === 3, `退出码 ${exp.code}`);
}

// 13. 对话（默认不跑）
if (withAsk) {
  const ask = cli(['ask', '把正文里的 MARKER 改成 ASKED']);
  if (ask.code === 3) {
    ok('没有 claude 时 ask 以环境错误退出', true);
  } else {
    ok('ask 退出码 0', ask.code === 0, ask.stderr.trim());
    ok('ask 真的改了文件', cli(['read']).stdout.includes('ASKED'));
  }
}

process.stdout.write('\n');
if (failures.length) {
  process.stdout.write(`${failures.length} 项失败：\n${failures.map((f) => `  - ${f}`).join('\n')}\n\n`);
  process.exit(1);
}
process.stdout.write(`${passed} 项全部通过\n\n`);
process.exit(0);
