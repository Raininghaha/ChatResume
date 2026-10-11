import fs from 'node:fs';
import path from 'node:path';
import { ResumeError } from './errors.js';
import { ensureHome, loadState, paths, readTemplate, saveState } from './workspace.js';

/** 去掉路径分隔符等不安全字符。中文名保留，只滤掉真正非法的部分。 */
export function safeName(name) {
  const n = String(name || '')
    .trim()
    .replace(/[/\\:*?"<>|]/g, '')
    .replace(/^\.+/, '')
    .replace(/\s+/g, ' ')
    .slice(0, 60)
    .trim();
  return n || null;
}

export function resumePath(name) {
  const safe = safeName(name);
  if (!safe) return null;
  const dir = paths().resumes;
  const full = path.join(dir, `${safe}.html`);
  // safeName 已经滤过分隔符，这里再确认一次没跑出目录
  return full.startsWith(dir + path.sep) ? full : null;
}

export function listResumes() {
  const dir = paths().resumes;
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.toLowerCase().endsWith('.html') && !f.startsWith('.'))
      .map((f) => f.slice(0, -'.html'.length))
      .sort((a, b) => a.localeCompare(b, 'zh'));
  } catch {
    return [];
  }
}

export function activeName() {
  const names = listResumes();
  if (!names.length) return null;
  const state = loadState();
  return names.includes(state.activeResume) ? state.activeResume : names[0];
}

export function readResume(name) {
  const file = resumePath(name);
  if (!file || !fs.existsSync(file)) {
    throw new ResumeError(`找不到简历「${name}」`, 'NOT_FOUND', 404, 1);
  }
  return fs.readFileSync(file, 'utf8');
}

const HTML_DOC = /<html[\s>]/i;

export function writeResume(name, html) {
  const file = resumePath(name);
  if (!file) throw new ResumeError('简历名不合法', 'BAD_NAME', 400, 2);
  const text = String(html || '').trim();
  if (!text) throw new ResumeError('内容为空', 'EMPTY', 400, 2);
  if (!HTML_DOC.test(text) || !/<\/html>\s*$/i.test(text)) {
    throw new ResumeError('内容不是完整的 HTML 文档，已拒绝保存', 'MALFORMED', 400, 2);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text.endsWith('\n') ? text : `${text}\n`, 'utf8');
  return file;
}

export function uniqueName(base) {
  const names = listResumes();
  if (!names.includes(base)) return base;
  for (let i = 2; i < 200; i++) {
    const candidate = `${base} ${i}`;
    if (!names.includes(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}

function setActive(name) {
  const state = loadState();
  state.activeResume = name;
  saveState(state);
}

export function useResume(name) {
  const names = listResumes();
  if (!names.includes(name)) {
    throw new ResumeError(`找不到简历「${name}」`, 'NOT_FOUND', 404, 1);
  }
  setActive(name);
  return name;
}

export function createResume(name) {
  ensureHome();
  const finalName = safeName(name) || uniqueName('新简历');
  if (listResumes().includes(finalName)) {
    throw new ResumeError(`已存在名为「${finalName}」的简历`, 'EXISTS', 409, 1);
  }
  writeResume(finalName, readTemplate(finalName));
  setActive(finalName);
  return finalName;
}

export function duplicateResume(from, asName) {
  const source = from || activeName();
  if (!source) throw new ResumeError('没有可复制的简历', 'NO_RESUME', 400, 1);
  const file = resumePath(source);
  if (!file || !fs.existsSync(file)) {
    throw new ResumeError(`找不到简历「${source}」`, 'NOT_FOUND', 404, 1);
  }
  const target = uniqueName(safeName(asName) || `${source} - 副本`);
  fs.copyFileSync(file, resumePath(target));
  setActive(target);
  return target;
}

export function renameResume(from, to) {
  const names = listResumes();
  if (!names.includes(from)) {
    throw new ResumeError(`找不到简历「${from}」`, 'NOT_FOUND', 404, 1);
  }
  const safe = safeName(to);
  if (!safe) throw new ResumeError('新名字不能为空', 'BAD_NAME', 400, 2);
  if (safe !== from && names.includes(safe)) {
    throw new ResumeError(`已存在名为「${safe}」的简历`, 'EXISTS', 409, 1);
  }
  fs.renameSync(resumePath(from), resumePath(safe));

  // 对话 session 跟着简历一起改名，否则改完名上下文就断了
  const state = loadState();
  if (state.sessions?.[from]) {
    state.sessions[safe] = state.sessions[from];
    delete state.sessions[from];
  }
  state.activeResume = safe;
  saveState(state);
  return safe;
}

export function deleteResume(name) {
  const names = listResumes();
  if (!names.includes(name)) {
    throw new ResumeError(`找不到简历「${name}」`, 'NOT_FOUND', 404, 1);
  }
  if (names.length <= 1) {
    throw new ResumeError('至少要保留一份简历', 'LAST_ONE', 400, 1);
  }
  fs.unlinkSync(resumePath(name));

  const state = loadState();
  if (state.sessions?.[name]) delete state.sessions[name];
  const remaining = names.filter((n) => n !== name);
  const next = state.activeResume === name ? remaining[0] : activeName() || remaining[0];
  state.activeResume = next;
  saveState(state);
  return { deleted: name, active: next };
}

/** UI 的 /api/resumes 用的动作分发。名字沿用前端已有的 action 串。 */
export function applyAction(body) {
  const action = body?.action;
  switch (action) {
    case 'select':
      return { active: useResume(body.name) };
    case 'create':
      return { active: createResume(body.name) };
    case 'duplicate':
      return { active: duplicateResume(body.name, body.as) };
    case 'rename':
      return { active: renameResume(body.name, body.to) };
    case 'delete':
      return deleteResume(body.name);
    default:
      throw new ResumeError('未知操作', 'UNKNOWN_ACTION', 400, 2);
  }
}
