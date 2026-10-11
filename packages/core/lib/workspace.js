import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** packages/core —— 内置模板所在位置，与用户数据无关。 */
export const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 用户数据默认落在这里，与代码仓库完全分离。 */
export const DEFAULT_HOME = path.join(os.homedir(), '.resume-chat');

/**
 * 所有目录都从 RESUME_HOME 现算，不在模块加载时缓存：
 * CLI 允许调用方在 import 之后再设环境变量（测试就靠这个把数据关进临时目录）。
 */
export function homeDir() {
  return path.resolve(process.env.RESUME_HOME || DEFAULT_HOME);
}

export function paths() {
  const home = homeDir();
  return {
    home,
    resumes: path.join(home, 'resumes'),
    assets: path.join(home, 'assets'),
    templates: path.join(home, 'templates'),
    exports: path.join(home, 'exports'),
    state: path.join(home, 'state.json'),
    log: path.join(home, 'resume-chat.log'),
    builtinTemplate: path.join(PACKAGE_ROOT, 'templates', 'blank.html'),
  };
}

/** 首次运行落地一份空简历，让 `npx resume-chat` 打开就有东西可改。 */
const SEED_RESUME = '我的简历';

export function ensureHome() {
  const p = paths();
  for (const dir of [p.home, p.resumes, p.assets, p.templates, p.exports]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // 模板复制一份到用户目录，用户可以自己改；内置那份始终作为兜底
  const userTemplate = path.join(p.templates, 'blank.html');
  if (!fs.existsSync(userTemplate)) {
    try {
      fs.copyFileSync(p.builtinTemplate, userTemplate);
    } catch {}
  }

  if (!fs.existsSync(p.resumes)) fs.mkdirSync(p.resumes, { recursive: true });
  const hasAny = fs
    .readdirSync(p.resumes)
    .some((f) => f.toLowerCase().endsWith('.html') && !f.startsWith('.'));
  if (!hasAny) {
    const seed = path.join(p.resumes, `${SEED_RESUME}.html`);
    try {
      fs.writeFileSync(seed, readTemplate(SEED_RESUME), 'utf8');
      const state = loadState();
      if (!state.activeResume) saveState({ ...state, activeResume: SEED_RESUME });
    } catch {}
  }

  return p;
}

export function readTemplate(name = '新简历') {
  const candidates = [path.join(paths().templates, 'blank.html'), paths().builtinTemplate];
  for (const file of candidates) {
    try {
      return fs
        .readFileSync(file, 'utf8')
        .replace(/<title>[\s\S]*?<\/title>/, `<title>${name}</title>`);
    } catch {}
  }
  return `<!doctype html>\n<html lang="zh-CN"><head><meta charset="utf-8"><title>${name}</title></head><body></body></html>`;
}

/**
 * 状态文件只存「当前看的是哪份」和「每份简历各自的对话 session」。
 *
 * session 按简历分开存是刻意的：全局只存一个 sessionId 时，切换简历会继续用
 * 上一份的对话上下文，模型会把另一份简历当成当前目标，得靠 system prompt 里
 * 一句「忽略历史里出现过的其他文件名」硬掰回来。数据结构修对了，那句补丁就不需要了。
 */
export function loadState() {
  let raw = {};
  try {
    raw = JSON.parse(fs.readFileSync(paths().state, 'utf8'));
  } catch {}
  const state = {
    activeResume: raw.activeResume || null,
    sessions: { ...(raw.sessions || {}) },
  };
  // 旧版本把 sessionId 放在顶层（全局一份），迁移到按简历分开的 sessions
  if (raw.sessionId && state.activeResume && !state.sessions[state.activeResume]) {
    state.sessions[state.activeResume] = raw.sessionId;
  }
  return state;
}

export function saveState(state) {
  const p = paths();
  try {
    fs.mkdirSync(p.home, { recursive: true });
    const tmp = `${p.state}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, p.state);
  } catch {}
}

/**
 * 简历或素材一变就通知调用方。刻意只盯 resumes/ 和 assets/，不盯整个 home：
 * 日志和 state.json 每次对话都在写，盯了就会把「AI 改了简历」和「我记了个日志」
 * 混成同一种事件，前端会莫名其妙地反复刷新。
 */
export function watchWorkspace(onChange, { debounce = 180 } = {}) {
  const p = paths();
  let timer = null;
  const watchers = [];
  const trigger = () => {
    clearTimeout(timer);
    timer = setTimeout(onChange, debounce);
  };
  for (const dir of [p.resumes, p.assets]) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      watchers.push(fs.watch(dir, { recursive: true }, trigger));
    } catch {}
  }
  return () => {
    clearTimeout(timer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {}
    }
  };
}

/** 逐行落盘的运行日志。断连类问题最难查的就是没有现场。 */
export function createLogger(file = paths().log) {
  return function log(...parts) {
    const line = `[${new Date().toISOString()}] ${parts.join(' ')}`;
    console.log(line);
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, line + '\n');
    } catch {}
  };
}
