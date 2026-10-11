const $ = (id) => document.getElementById(id);

const messagesEl = $('messages');
const emptyEl = $('empty');
const inputEl = $('input');
const sendBtn = $('sendBtn');
const canvasEl = $('canvas');
const stageEl = $('stage');
const frameEl = $('frame');
const statusEl = $('status');
const statusTextEl = $('statusText');
const pageCountEl = $('pageCount');
const zoomValEl = $('zoomVal');
const turnHintEl = $('turnHint');
const chatHintEl = $('chatHint');
const editBtn = $('editBtn');
const editHintEl = $('editHint');
const savedTagEl = $('savedTag');
const switcherBtn = $('switcherBtn');
const switcherMenu = $('switcherMenu');
const menuListEl = $('menuList');
const activeNameEl = $('activeName');

const EDITOR_STYLE_ID = '__resume_editor_style';
const EDITOR_CSS = `
  .page[contenteditable="true"] { cursor: text; outline: none; }
  .page[contenteditable="true"]:focus { outline: 3px solid rgba(47,92,255,.45); outline-offset: -3px; }
`;

let resumes = [];
let activeResume = null;
let clientPages = 0;
let lastCheck = null;
let busy = false;
let editMode = false;
let dirty = false;
let editSaveTimer = null;
let suppressReloadUntil = 0;
let reloadTimer = null;
let elapsedTimer = null;
let turn = 0;
let zoomMode = 'fit';
let docWidth = 793.7;
let docHeight = 1122.5;

// ------------------------------------------------------------------- iframe

function frameDoc() {
  try {
    return frameEl.contentDocument || null;
  } catch {
    return null;
  }
}

function measureFrame() {
  try {
    const doc = frameDoc();
    if (!doc || !doc.body) return;
    frameEl.style.height = '0px';
    docHeight = Math.max(doc.documentElement.scrollHeight, doc.body.scrollHeight);
    docWidth = frameEl.offsetWidth || docWidth;
    frameEl.style.height = `${docHeight}px`;
    clientPages = doc.querySelectorAll('.page').length;
    renderPageInfo();
    applyZoom();
  } catch (err) {
    console.warn('measure failed', err);
  }
}

/**
 * 页数优先显示服务端量出来的结果。
 *
 * 客户端这里数的是 .page 元素个数，数不出「内容悄悄溢出一页」——那要在无头
 * 浏览器里把 min-height 清掉量真实内容高。所以服务端量到了就用它的结论，
 * 量不到（没装浏览器）就退回元素个数，并把原因挂在 title 上。
 */
function renderPageInfo() {
  if (lastCheck?.ok) {
    if (lastCheck.fits) {
      pageCountEl.textContent = `${lastCheck.pages} 页`;
      pageCountEl.title = '内容正好装下';
      pageCountEl.classList.remove('warn');
    } else {
      pageCountEl.textContent = `${lastCheck.pages} 页 · 超 ${Math.round(lastCheck.overflowPx)}px`;
      pageCountEl.title = '内容超出了一页，导出的 PDF 会断到下一页';
      pageCountEl.classList.add('warn');
    }
    return;
  }
  pageCountEl.classList.remove('warn');
  if (lastCheck && !lastCheck.ok) {
    pageCountEl.textContent = clientPages ? `${clientPages} 页（未测量）` : '未测量';
    pageCountEl.title = lastCheck.reason || '';
    return;
  }
  pageCountEl.textContent = clientPages ? `${clientPages} 页` : '—';
  pageCountEl.title = '';
}

function refreshCheck() {
  fetch(`/api/check?name=${encodeURIComponent(activeResume || '')}`)
    .then((r) => r.json())
    .then((data) => {
      lastCheck = data;
      renderPageInfo();
    })
    .catch(() => {});
}

function reloadPreview(keepScroll = true) {
  let ratio = 0;
  if (keepScroll && canvasEl.scrollHeight > canvasEl.clientHeight) {
    ratio = canvasEl.scrollTop / (canvasEl.scrollHeight - canvasEl.clientHeight);
  }
  frameEl.src = `/resume?name=${encodeURIComponent(activeResume || '')}`;
  frameEl.addEventListener(
    'load',
    () => {
      measureFrame();
      if (editMode) applyEditableDecor();
      if (keepScroll && ratio > 0) {
        canvasEl.scrollTop = ratio * (canvasEl.scrollHeight - canvasEl.clientHeight);
      }
    },
    { once: true }
  );
}

function currentScale() {
  if (zoomMode !== 'fit') return zoomMode;
  const avail = canvasEl.clientWidth - 56;
  return Math.min(1, Math.max(0.25, avail / docWidth));
}

function applyZoom() {
  const scale = currentScale();
  stageEl.style.transform = `scale(${scale})`;
  stageEl.style.width = `${docWidth * scale}px`;
  stageEl.style.height = `${docHeight * scale}px`;
  zoomValEl.textContent = `${Math.round(scale * 100)}%`;
}

frameEl.addEventListener('load', () => {
  measureFrame();
  if (editMode) applyEditableDecor();
});

// ---------------------------------------------------------------- 简历切换

async function loadResumes() {
  try {
    const r = await fetch('/api/resumes');
    const data = await r.json();
    resumes = data.items || [];
    activeResume = data.active;
    activeNameEl.textContent = activeResume || '（暂无简历）';
    renderMenu();
  } catch (err) {
    activeNameEl.textContent = '加载失败';
  }
}

function renderMenu() {
  menuListEl.innerHTML = '';
  if (!resumes.length) {
    const d = document.createElement('div');
    d.className = 'menu-empty';
    d.textContent = '还没有简历，点下面新建一份';
    menuListEl.appendChild(d);
  }
  resumes.forEach((name) => {
    const b = document.createElement('button');
    b.className = `menu-item${name === activeResume ? ' active' : ''}`;
    b.dataset.name = name;
    const nm = document.createElement('span');
    nm.className = 'mi-name';
    nm.textContent = name;
    const ck = document.createElement('span');
    ck.className = 'mi-check';
    ck.textContent = name === activeResume ? '✓' : '';
    b.append(nm, ck);
    menuListEl.appendChild(b);
  });
}

function openMenu(open) {
  switcherMenu.hidden = !open;
  switcherBtn.setAttribute('aria-expanded', String(open));
}

async function resumeAction(payload) {
  const r = await fetch('/api/resumes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await r.json();
  if (!r.ok) {
    toast(data.error || '操作失败');
    return null;
  }
  resumes = data.items || [];
  activeResume = data.active;
  activeNameEl.textContent = activeResume || '（暂无简历）';
  renderMenu();
  return data;
}

async function switchResume(name) {
  if (name === activeResume) return;
  await flushSave();
  const ok = await resumeAction({ action: 'select', name });
  if (ok) {
    turn = 0;
    turnHintEl.textContent = '';
    reloadPreview(false);
    canvasEl.scrollTop = 0;
    toast(`已切到「${name}」`);
  }
}

switcherBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  openMenu(switcherMenu.hidden);
});

document.addEventListener('click', (e) => {
  if (!switcherMenu.hidden && !switcherMenu.contains(e.target)) openMenu(false);
});

menuListEl.addEventListener('click', (e) => {
  const item = e.target.closest('.menu-item');
  if (!item) return;
  openMenu(false);
  switchResume(item.dataset.name);
});

switcherMenu.addEventListener('click', async (e) => {
  const item = e.target.closest('.menu-item[data-act]');
  if (!item) return;
  const act = item.dataset.act;
  openMenu(false);

  if (act === 'create') {
    const name = prompt('新简历的名字：', '新简历');
    if (!name) return;
    await flushSave();
    const ok = await resumeAction({ action: 'create', name });
    if (ok) {
      reloadPreview(false);
      canvasEl.scrollTop = 0;
      toast(`已新建「${ok.active}」`);
    }
    return;
  }

  if (act === 'duplicate') {
    await flushSave();
    const ok = await resumeAction({ action: 'duplicate' });
    if (ok) {
      reloadPreview(false);
      canvasEl.scrollTop = 0;
      toast(`已复制为「${ok.active}」`);
    }
    return;
  }

  if (act === 'rename') {
    const to = prompt('新的名字：', activeResume || '');
    if (!to || to === activeResume) return;
    await flushSave();
    const ok = await resumeAction({ action: 'rename', name: activeResume, to });
    if (ok) toast(`已重命名为「${ok.active}」`);
    return;
  }

  if (act === 'delete') {
    if (!confirm(`删除「${activeResume}」？文件会从硬盘上删掉，不可恢复。`)) return;
    const ok = await resumeAction({ action: 'delete', name: activeResume });
    if (ok) {
      reloadPreview(false);
      toast(`已删除，现在看的是「${ok.active}」`);
    }
  }
});

// -------------------------------------------------------------- 就地编辑

function applyEditableDecor() {
  const doc = frameDoc();
  if (!doc || !doc.body || !editMode) return;

  if (!doc.getElementById(EDITOR_STYLE_ID)) {
    const style = doc.createElement('style');
    style.id = EDITOR_STYLE_ID;
    style.textContent = EDITOR_CSS;
    doc.head.appendChild(style);
  }

  doc.querySelectorAll('.page').forEach((page) => {
    page.setAttribute('contenteditable', 'true');
    page.setAttribute('spellcheck', 'false');
  });

  if (!doc.__editorBound) {
    doc.__editorBound = true;
    doc.addEventListener('input', onEditInput);
    doc.addEventListener('paste', onEditPaste);
  }
}

function onEditInput() {
  if (!dirty) {
    dirty = true;
    savedTagEl.textContent = '未保存';
  }
  clearTimeout(editSaveTimer);
  // 静默存：工具条上的胶囊已经显示「已保存」了，再弹 toast 会盖在正在写的字上
  editSaveTimer = setTimeout(() => saveResume({ silent: true }), 1200);
}

function onEditPaste(e) {
  e.preventDefault();
  const text = (e.clipboardData || window.clipboardData).getData('text/plain');
  const doc = frameDoc();
  if (text && doc) doc.execCommand('insertText', false, text);
}

function serializeResume() {
  const doc = frameDoc();
  if (!doc) return null;
  // 在原文档的副本上清理，绝不碰正在编辑的那份：给焦点所在元素摘掉 contenteditable
  // 会让它失去编辑宿主身份，光标和输入法候选一起丢掉，自动保存时就表现为「打字被打断」
  const clone = doc.documentElement.cloneNode(true);
  clone.removeAttribute('data-resume-revision');
  clone.removeAttribute('data-resume-name');
  clone.querySelector(`#${EDITOR_STYLE_ID}`)?.remove();
  clone.querySelectorAll('[contenteditable]').forEach((el) => {
    el.removeAttribute('contenteditable');
    el.removeAttribute('spellcheck');
  });
  return `<!DOCTYPE html>\n${clone.outerHTML}`;
}

async function saveResume({ silent = false, force = false } = {}) {
  if ((!editMode && !force) || !dirty) return true;
  clearTimeout(editSaveTimer);
  const html = serializeResume();
  if (!html) return false;

  suppressReloadUntil = Date.now() + 1500;
  dirty = false;
  savedTagEl.textContent = '保存中…';

  try {
    const doc = frameDoc();
    const name = decodeURIComponent(doc.documentElement.dataset.resumeName || '');
    const r = await fetch(`/api/resume?name=${encodeURIComponent(name)}`, {
      method: 'PUT',
      headers: { 'content-type': 'text/html; charset=utf-8', 'if-match':doc.documentElement.dataset.resumeRevision || '' },
      body: html,
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      savedTagEl.textContent = '保存失败';
      dirty = true;
      toast(err.error || '保存失败');
      return false;
    }
    const result = await r.json();
    doc.documentElement.dataset.resumeRevision = result.revision;
    savedTagEl.textContent = '已保存';
    if (!silent) toast('已保存');
    return true;
  } catch (err) {
    savedTagEl.textContent = '保存失败';
    dirty = true;
    toast(`保存失败：${err.message}`);
    return false;
  }
}

function flushSave() {
  return dirty ? saveResume({ silent: true }) : Promise.resolve(true);
}

function setEditMode(on) {
  if (on && busy) {
    toast('等这条消息处理完再手动编辑');
    return;
  }
  editMode = on;
  stageEl.classList.toggle('editing', on);
  editBtn.classList.toggle('active', on);
  editBtn.textContent = on ? '完成' : '编辑';
  editHintEl.hidden = !on;
  inputEl.disabled = on || busy;
  sendBtn.disabled = on || busy;
  switcherBtn.disabled = on;
  chatHintEl.textContent = on ? '手动编辑中，先点「完成」再对话' : 'Enter 发送 · Shift+Enter 换行';

  if (on) {
    applyEditableDecor();
    savedTagEl.textContent = '';
  } else {
    // editMode 上面已经翻成 false 了，得 force 才能把最后这段改动落盘（否则手快的人
    // 打完字 1.2 秒内点「完成」，这段就丢了）
    saveResume({ silent: true, force: true }).then((ok) => {
      if (!ok) {
        setEditMode(true); // 没存下去就别退出编辑态，不然一刷新改动就没了
        return;
      }
      reloadPreview();
      toast('已保存');
    });
  }
}

editBtn.addEventListener('click', () => setEditMode(!editMode));

window.addEventListener('beforeunload', (e) => {
  if (!dirty) return;
  const html = serializeResume();
  if (html) {
    try {
      const data = frameDoc().documentElement.dataset;
      navigator.sendBeacon(`/api/resume?name=${data.resumeName || ''}&revision=${data.resumeRevision || ''}`, new Blob([html], { type: 'text/html; charset=utf-8' }));
    } catch {}
  }
  e.preventDefault();
  e.returnValue = '';
});

// -------------------------------------------------------------------- status

function setStatus(kind, text) {
  statusEl.className = `status${kind ? ` ${kind}` : ''}`;
  statusTextEl.textContent = text;
}

function toast(msg) {
  const el = $('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2200);
}

// ------------------------------------------------------------------ messages

function hideEmpty() {
  if (emptyEl?.parentElement) emptyEl.remove();
}

function addUserMessage(text) {
  hideEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg user';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollMessages();
}

function addAssistantMessage() {
  hideEmpty();
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';

  const tools = document.createElement('div');
  tools.style.display = 'flex';
  tools.style.flexDirection = 'column';
  tools.style.gap = '6px';

  const bubble = document.createElement('div');
  bubble.className = 'bubble';

  wrap.append(tools, bubble);
  messagesEl.appendChild(wrap);
  scrollMessages();

  return {
    addTool(label) {
      const chip = document.createElement('div');
      chip.className = 'tool-chip';
      chip.innerHTML = '<i class="spin"></i><span></span>';
      chip.querySelector('span').textContent = label;
      tools.appendChild(chip);
      scrollMessages();
    },
    doneTools() {
      tools.querySelectorAll('.tool-chip').forEach((c) => c.classList.add('done'));
    },
    append(text) {
      bubble.textContent += text;
      scrollMessages();
    },
    setCaret(on) {
      const existing = bubble.querySelector('.caret');
      if (on && !existing) {
        const c = document.createElement('span');
        c.className = 'caret';
        bubble.appendChild(c);
      } else if (!on) {
        existing?.remove();
      }
    },
  };
}

function addErrorMessage(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg error';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollMessages();
}

function scrollMessages() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// ----------------------------------------------------------------- composer

function autoGrow() {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 160)}px`;
}

function setBusy(value) {
  busy = value;
  sendBtn.disabled = value || editMode;
  inputEl.disabled = value || editMode;
  editBtn.disabled = value;
  switcherBtn.disabled = value || editMode;

  if (value) {
    const start = Date.now();
    turn += 1;
    setStatus('busy', '思考中');
    clearInterval(elapsedTimer);
    elapsedTimer = setInterval(() => {
      const s = Math.round((Date.now() - start) / 1000);
      setStatus('busy', s < 1 ? '思考中' : `处理中 ${s}s`);
    }, 500);
  } else {
    clearInterval(elapsedTimer);
    elapsedTimer = null;
    setStatus('', '就绪');
    turnHintEl.textContent = turn > 0 ? `第 ${turn} 轮` : '';
    inputEl.focus();
  }
}

async function send() {
  const message = inputEl.value.trim();
  if (!message || busy) return;
  if (editMode) {
    toast('先点「完成」结束手动编辑，再发消息');
    return;
  }
  if (!activeResume) {
    toast('还没有简历，先在左上角新建一份');
    return;
  }

  inputEl.value = '';
  autoGrow();
  addUserMessage(message);
  const msg = addAssistantMessage();
  msg.setCaret(true);
  setBusy(true);

  let sawText = false;
  let sawError = false;
  let sawDone = false;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, name:activeResume }),
    });

    if (!res.ok || !res.body) {
      let detail = `请求失败（${res.status}）`;
      try {
        detail = (await res.json()).error || detail;
      } catch {}
      msg.setCaret(false);
      msg.doneTools();
      addErrorMessage(detail);
      setStatus('error', '出错');
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        let evt;
        try {
          evt = JSON.parse(line);
        } catch {
          continue;
        }
        if (evt.t === 'status') {
          setStatus('busy', evt.v);
        } else if (evt.t === 'tool') {
          msg.setCaret(false);
          msg.addTool(evt.v);
        } else if (evt.t === 'text') {
          if (!sawText) {
            sawText = true;
            msg.doneTools();
          }
          msg.append(evt.v);
        } else if (evt.t === 'error') {
          sawError = true;
          msg.setCaret(false);
          msg.doneTools();
          addErrorMessage(evt.v);
          setStatus('error', '出错');
        } else if (evt.t === 'done') {
          sawDone = true;
        }
      }
    }

    msg.setCaret(false);
    msg.doneTools();
    if (!sawDone && !sawError) {
      sawError = true;
      addErrorMessage('连接提前结束，未收到处理完成结果，请重试');
      setStatus('error', '出错');
    }
    if (!sawText) msg.append(sawError ? '本次处理失败，请查看下方错误详情。' : '（已处理完成，但没有返回文字说明）');
    reloadPreview();
  } catch (err) {
    msg.setCaret(false);
    msg.doneTools();
    addErrorMessage(`连接中断：${err.name}: ${err.message}`);
    setStatus('error', '断开');
  } finally {
    if (statusEl.classList.contains('error')) {
      setTimeout(() => setStatus('', '就绪'), 2600);
    }
    setBusy(false);
  }
}

// ------------------------------------------------------------------- events

sendBtn.addEventListener('click', send);
inputEl.addEventListener('input', autoGrow);

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    send();
  }
});

document.addEventListener('click', (e) => {
  const chip = e.target.closest('.chip');
  if (chip) {
    inputEl.value = chip.dataset.prompt || chip.textContent;
    autoGrow();
    inputEl.focus();
  }
});

$('reloadBtn').addEventListener('click', async () => {
  await flushSave();
  reloadPreview();
});

async function exportPdf() {
  if (busy) { toast('请等待当前修改完成后下载'); return; }
  if (editMode && !await saveResume({ silent: true })) return;
  const name = activeResume;
  const button = $('exportBtn');
  button.disabled = true;
  button.textContent = '生成中…';
  try {
    const response = await fetch(`/api/export?name=${encodeURIComponent(name)}`);
    if (response.status === 401) { location.href = '/login'; return; }
    if (!response.ok) throw new Error((await response.json()).error || 'PDF 生成失败');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${name}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast('PDF 已生成，请在当前设备的下载或文件中查看');
  } catch (err) { toast(err.message); }
  finally { button.disabled = false; button.textContent = '下载 PDF'; }
}

$('exportBtn').addEventListener('click', exportPdf);

for (const [id, view] of [['showChat', 'chat'], ['showPreview', 'preview']]) {
  $(id).addEventListener('click', async () => {
    if (view === 'chat' && editMode) {
      if (!await saveResume({ silent: true })) return;
      setEditMode(false);
    }
    document.querySelector('.layout').dataset.view = view;
    for (const tabId of ['showChat', 'showPreview']) {
      $(tabId).classList.toggle('active', tabId === id);
      $(tabId).setAttribute('aria-pressed', String(tabId === id));
    }
    requestAnimationFrame(measureFrame);
  });
}
let observedRevision;
function startPolling() {
  setInterval(async () => {
    if (document.hidden || editMode || busy) return;
    try {
      const response = await fetch(`/api/revision?name=${encodeURIComponent(activeResume || '')}`);
      if (response.status === 401) { location.href = '/login'; return; }
      if (!response.ok) return;
      const data = await response.json();
      if (observedRevision && observedRevision !== data.revision && Date.now() >= suppressReloadUntil) { reloadPreview(); refreshCheck(); }
      observedRevision = data.revision;
    } catch {}
  }, 5000);
}

$('resetBtn').addEventListener('click', async () => {
  if (!confirm('清空当前对话记录，重新开始？（简历内容不受影响）')) return;
  await fetch('/api/reset', { method: 'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:activeResume}) });
  messagesEl.innerHTML = '';
  messagesEl.appendChild(emptyEl);
  turn = 0;
  turnHintEl.textContent = '';
  toast('对话已重置');
});

$('zoomIn').addEventListener('click', () => {
  zoomMode = Math.min(1.6, Math.round((currentScale() + 0.1) * 10) / 10);
  applyZoom();
});

$('zoomOut').addEventListener('click', () => {
  zoomMode = Math.max(0.3, Math.round((currentScale() - 0.1) * 10) / 10);
  applyZoom();
});

$('zoomFit').addEventListener('click', () => {
  zoomMode = 'fit';
  applyZoom();
  canvasEl.scrollTop = 0;
});

zoomValEl.addEventListener('dblclick', () => {
  zoomMode = 1;
  applyZoom();
});

window.addEventListener('resize', applyZoom);

document.addEventListener('keydown', (e) => {
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'p') {
    e.preventDefault();
    $('exportBtn').click();
  }
  if (mod && e.key.toLowerCase() === 's' && editMode) {
    e.preventDefault();
    dirty = true;
    saveResume();
  }
  if (e.key === 'Escape' && editMode) setEditMode(false);
});

// AI 改了磁盘上的简历就自动刷新（手动编辑期间一律不打扰）
function handleWorkspaceEvent(e) {
  let data;
  try {
    data = JSON.parse(e.data);
  } catch {
    return;
  }
  if (data.type === 'check') {
    lastCheck = data.check || null;
    renderPageInfo();
    return;
  }
  if (data.type !== 'resume-changed') return;
  if (editMode) return;
  if (Date.now() < suppressReloadUntil) return;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    reloadPreview();
    refreshCheck();
  }, 320);
}
fetch('/api/access').then(r => r.json()).then(data => {
  $('logoutForm').hidden = !data.enabled;
  if (data.notifications === 'poll') startPolling();
  else { const es = new EventSource('/api/events'); es.onmessage = handleWorkspaceEvent; }
}).catch(startPolling);

loadResumes().then(() => {
  measureFrame();
  refreshCheck();
});
autoGrow();
inputEl.focus();
