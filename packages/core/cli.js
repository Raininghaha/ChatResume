import fs from 'node:fs';
import path from 'node:path';
import { EXIT, ResumeError } from './lib/errors.js';
import { check, exportPdf } from './lib/render.js';
import { browserStatus, closeBrowser } from './lib/browser.js';
import { ask, resetSession, sessionOf } from './lib/chat.js';
import {
  activeName,
  createResume,
  deleteResume,
  duplicateResume,
  listResumes,
  readResume,
  renameResume,
  resumePath,
  useResume,
  writeResume,
} from './lib/resumes.js';
import { listRunners } from './lib/runners/index.js';
import { ensureHome, homeDir, paths } from './lib/workspace.js';

const VERSION = JSON.parse(
  fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8')
).version;

const USAGE = `resume-chat —— 用对话改简历

用法：
  resume-chat <命令> [参数] [选项]

简历管理：
  list                        列出所有简历
  new <名字>                  新建（以模板为底）
  read <名字>                 把简历 HTML 打到标准输出
  write <名字> [文件]         从文件（或 stdin）覆盖写入
  duplicate [名字] [--as 新名] 复制，默认复制当前这份
  rename <原名> <新名>        重命名
  delete <名字>               删除
  use <名字>                  设为当前简历
  path [名字]                 打印简历文件的绝对路径
  home                        打印数据目录

对话：
  ask [名字] <要求…>          用自然语言改这份简历，文字流式打到标准输出
  reset [名字]                清空这份简历的对话记忆（简历内容不动）

渲染：
  check [名字]                量排了几页、有没有超出一页
  export [名字] [-o 文件]     导出 PDF（默认存到数据目录的 exports/）

其它：
  runners                     看当前可用的对话后端
  version / help

全局选项：
  --json                      以 JSON 输出（ask 下为 NDJSON 事件流）
  --home <目录>               覆盖数据目录（等价于 RESUME_HOME）
  --prompt-file <文件>        追加一段自己的编辑规范
  --runner <名字>             指定对话后端，默认 claude
  -q, --quiet                 抑制进度输出（ask 时只留正文）

退出码：
  0 成功    1 check 未通过    2 用法错误    3 环境不满足（缺 claude / 缺浏览器）`;

function parseArgs(argv) {
  const flags = { _: [] };
  const takesValue = new Set(['home', 'as', 'o', 'output', 'runner', 'prompt-file']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--') {
      flags._.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const key = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).toLowerCase();
      if (eq >= 0) {
        flags[key] = arg.slice(eq + 1);
      } else if (takesValue.has(key) && argv[i + 1] !== undefined) {
        flags[key] = argv[++i];
      } else {
        flags[key] = true;
      }
      continue;
    }
    if (arg.startsWith('-') && arg.length > 1) {
      const key = arg.slice(1).toLowerCase();
      if (takesValue.has(key) && argv[i + 1] !== undefined) flags[key] = argv[++i];
      else flags[key] = true;
      continue;
    }
    flags._.push(arg);
  }
  return flags;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function describeCheck(result) {
  if (!result.ok) return `未测量：${result.reason}`;
  const headline = result.fits
    ? `${result.name}：${result.pages} 页，正好装下`
    : `${result.name}：${result.pages} 页，超出 ${result.overflowPx}px`;
  const detail = result.perPage
    .map((p) => `  第 ${p.index} 页 内容 ${p.contentMm}mm / 297mm`)
    .join('\n');
  return `${headline}\n${detail}`;
}

/**
 * CLI 入口。ui 包通过 extraCommands 把 serve 挂进来，
 * 所以内核不需要知道「有个网页界面」这件事。
 */
export async function runCli(argv = process.argv.slice(2), { extraCommands = {} } = {}) {
  const flags = parseArgs(argv);
  const [commandRaw, ...rest] = flags._;
  const json = Boolean(flags.json);

  if (flags.home) process.env.RESUME_HOME = path.resolve(String(flags.home));

  const out = (text) => process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
  // human 允许传函数：像 list 这种要等数据拿到才好拼接输出的，直接用回调更顺手
  const emit = (obj, human = '') =>
    json ? out(JSON.stringify(obj)) : out(typeof human === 'function' ? human() : human);

  const commands = {
    help: () => {
      out(USAGE);
      return EXIT.OK;
    },
    version: () => {
      out(VERSION);
      return EXIT.OK;
    },
    home: () => {
      ensureHome();
      emit({ home: homeDir() }, homeDir());
      return EXIT.OK;
    },
    list: () => {
      ensureHome();
      const active = activeName();
      const items = listResumes().map((name) => {
        const file = resumePath(name);
        let bytes = 0;
        try {
          bytes = fs.statSync(file).size;
        } catch {}
        return { name, active: name === active, file, bytes };
      });
      emit({ home: homeDir(), active, items }, () => {
        if (!items.length) return '（还没有简历，用 resume-chat new 建一份）';
        return items
          .map((it) => `${it.active ? '*' : ' '} ${it.name}  ${humanBytes(it.bytes)}`)
          .join('\n');
      });
      return EXIT.OK;
    },
    new: () => {
      const name = rest.join(' ').trim();
      if (!name) throw new ResumeError('用法：resume-chat new <名字>', 'USAGE', 400, EXIT.USAGE);
      ensureHome();
      const created = createResume(name);
      emit({ created, active: created, file: resumePath(created) }, `已新建「${created}」`);
      return EXIT.OK;
    },
    read: () => {
      ensureHome();
      const name = rest.join(' ').trim() || activeName();
      const html = readResume(name);
      if (json) emit({ name, file: resumePath(name), html }, '');
      else process.stdout.write(html);
      return EXIT.OK;
    },
    write: () => {
      ensureHome();
      const name = rest[0];
      if (!name) throw new ResumeError('用法：resume-chat write <名字> [文件]', 'USAGE', 400, EXIT.USAGE);
      const source = rest[1];
      const html = source
        ? fs.readFileSync(path.resolve(source), 'utf8')
        : fs.readFileSync(0, 'utf8');
      const file = writeResume(name, html);
      emit({ ok: true, name, file }, `已写入「${name}」`);
      return EXIT.OK;
    },
    duplicate: () => {
      ensureHome();
      const from = rest[0] || activeName();
      const created = duplicateResume(from, flags.as === true ? undefined : flags.as);
      emit({ created, from, active: created }, `已复制为「${created}」`);
      return EXIT.OK;
    },
    rename: () => {
      const [from, ...toParts] = rest;
      const to = toParts.join(' ').trim();
      if (!from || !to) {
        throw new ResumeError('用法：resume-chat rename <原名> <新名>', 'USAGE', 400, EXIT.USAGE);
      }
      ensureHome();
      const renamed = renameResume(from, to);
      emit({ renamed, from, to: renamed }, `已重命名为「${renamed}」`);
      return EXIT.OK;
    },
    delete: () => {
      const name = rest.join(' ').trim();
      if (!name) throw new ResumeError('用法：resume-chat delete <名字>', 'USAGE', 400, EXIT.USAGE);
      ensureHome();
      const result = deleteResume(name);
      emit({ ...result }, `已删除「${result.deleted}」，当前是「${result.active}」`);
      return EXIT.OK;
    },
    use: () => {
      const name = rest.join(' ').trim();
      if (!name) throw new ResumeError('用法：resume-chat use <名字>', 'USAGE', 400, EXIT.USAGE);
      ensureHome();
      const active = useResume(name);
      emit({ active }, `当前简历：${active}`);
      return EXIT.OK;
    },
    path: () => {
      ensureHome();
      const name = rest.join(' ').trim() || activeName();
      const file = resumePath(name);
      if (!file || !fs.existsSync(file)) {
        throw new ResumeError(`找不到简历「${name}」`, 'NOT_FOUND', 404, EXIT.USAGE);
      }
      emit({ name, file }, file);
      return EXIT.OK;
    },
    runners: () => {
      const items = listRunners();
      emit({ items }, () =>
        items
          .map((r) => `${r.available.ok ? '✓' : '✗'} ${r.name}（${r.description}）`)
          .join('\n')
      );
      return EXIT.OK;
    },
    check: async () => {
      ensureHome();
      const name = rest.join(' ').trim() || activeName();
      const result = await check(name);
      emit(result, describeCheck(result));
      if (!result.ok) return EXIT.ENVIRONMENT;
      return result.fits ? EXIT.OK : EXIT.CHECK_FAILED;
    },
    export: async () => {
      ensureHome();
      const name = rest.join(' ').trim() || activeName();
      const dest = flags.o === true ? undefined : flags.o || flags.output;
      const result = await exportPdf(name, dest);
      emit(result, `已导出 ${result.file}（${humanBytes(result.bytes)}）`);
      return EXIT.OK;
    },
    reset: () => {
      ensureHome();
      const name = rest.join(' ').trim() || activeName();
      resetSession(name);
      emit({ reset: name }, `已清空「${name}」的对话记忆`);
      return EXIT.OK;
    },
    ask: async () => {
      ensureHome();
      const explicit = rest.length > 1 ? rest[0] : null;
      const name = explicit || activeName();
      const message = (explicit ? rest.slice(1) : rest).join(' ').trim();
      if (!message) {
        throw new ResumeError(
          '用法：resume-chat ask [名字] <要求…>',
          'USAGE',
          400,
          EXIT.USAGE
        );
      }

      const events = ask({
        name,
        message,
        runner: flags.runner === true ? undefined : flags.runner,
        promptFile: flags['prompt-file'] === true ? undefined : flags['prompt-file'],
      });

      try {
        for await (const ev of events) {
          if (json) {
            process.stdout.write(JSON.stringify({ ...ev, name }) + '\n');
            continue;
          }
          if (ev.t === 'text') {
            process.stdout.write(ev.v);
          } else if (ev.t === 'tool' && !flags.quiet && !flags.q) {
            process.stderr.write(`· ${ev.v}\n`);
          } else if (ev.t === 'error') {
            process.stderr.write(`! ${ev.v}\n`);
          } else if (ev.t === 'status' && !flags.quiet && !flags.q) {
            process.stderr.write(`· ${ev.v}\n`);
          }
        }
        if (!json) process.stdout.write('\n');
      } finally {
        closeBrowser();
      }
      return EXIT.OK;
    },
    session: () => {
      ensureHome();
      const name = rest.join(' ').trim() || activeName();
      const id = sessionOf(name);
      emit({ name, sessionId: id }, id || '（这份简历还没有对话记录）');
      return EXIT.OK;
    },
    status: () => {
      ensureHome();
      const b = browserStatus();
      const runners = listRunners();
      const payload = { home: homeDir(), browser: b, runners, resumes: listResumes() };
      emit(payload, () =>
        [
          `数据目录  ${payload.home}`,
          `简历      ${payload.resumes.length} 份`,
          `浏览器    ${b.ok ? b.bin : `不可用（${b.reason}）`}`,
          ...runners.map((r) => `后端      ${r.available.ok ? '✓' : '✗'} ${r.name}`),
        ].join('\n')
      );
      return EXIT.OK;
    },
    ...extraCommands,
  };

  const command = commands[commandRaw] || (commandRaw ? null : commands.help);

  if (commandRaw && !commands[commandRaw]) {
    process.stderr.write(`未知命令：${commandRaw}\n\n${USAGE}\n`);
    return EXIT.USAGE;
  }

  try {
    // 括号是必须的：`await command.run ? A : B` 会被解析成 `(await command.run) ? A : B`,
    // 于是命令根本不会被 await —— check/export 会在导出完成前就「成功返回」，
    // finally 里的 closeBrowser 也跑在浏览器起来之前，最后留一个孤儿 Chrome。
    const result = command.run ? await command.run({ flags, rest, argv }) : await command();
    return typeof result === 'number' ? result : EXIT.OK;
  } catch (err) {
    if (err instanceof ResumeError) {
      process.stderr.write(`${err.message}\n`);
      return err.exitCode;
    }
    process.stderr.write(`${err?.stack || err}\n`);
    return EXIT.CHECK_FAILED;
  } finally {
    closeBrowser();
  }
}

export { VERSION, USAGE };
