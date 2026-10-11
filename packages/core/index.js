/**
 * @resume-chat/core 的公开接口。
 *
 * 这一层的边界是刻意的：**对话在这里，界面不在这里**。
 * 「用对话驱动改简历」是这个产品的产品定义，不是某个前端的实现细节，
 * 所以编排对话、维护会话、约束模型行为的代码属于内核；HTTP、SSE、A4 预览
 * 属于 packages/ui。任何人（包括一个 agent）import 这个包，就拿到了完整的
 * 编辑简历能力，不需要起浏览器界面。
 */
export { ResumeError, EXIT } from './lib/errors.js';

export {
  DEFAULT_HOME,
  PACKAGE_ROOT,
  createLogger,
  ensureHome,
  homeDir,
  loadState,
  paths,
  readTemplate,
  saveState,
  watchWorkspace,
} from './lib/workspace.js';

export {
  activeName,
  applyAction,
  createResume,
  deleteResume,
  duplicateResume,
  listResumes,
  readResume,
  renameResume,
  resumePath,
  safeName,
  uniqueName,
  useResume,
  writeResume,
} from './lib/resumes.js';

export { buildSystemPrompt } from './lib/prompt.js';

export { ask, busyResumes, isBusy, preflight, resetSession, sessionOf } from './lib/chat.js';

export { check, exportPdf, renderStatus } from './lib/render.js';

export {
  available as browserAvailable,
  browserStatus,
  closeBrowser,
  findBrowser,
} from './lib/browser.js';

export { getRunner, listRunners } from './lib/runners/index.js';

export { runCli } from './cli.js';
