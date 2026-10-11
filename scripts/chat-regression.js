import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';

// 使用模拟 CLI 和临时数据验证恢复行为，不调用模型、不碰真实简历。
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-chat-regression-'));
const bin = path.join(home, 'claude');
fs.writeFileSync(bin, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const home = process.env.RESUME_HOME;
fs.appendFileSync(path.join(home, 'calls'), JSON.stringify(args) + '\\n');
const mode = fs.readFileSync(path.join(home, 'mode'), 'utf8');
function send(ev) { process.stdout.write(JSON.stringify(ev) + '\\n'); }
if (args.includes('--resume') && mode.startsWith('stale')) {
  if (mode === 'stale-stderr') process.stderr.write('No conversation found with session ID: old');
  else send({type:'result', is_error:true, errors:['No conversation found with session ID: old']});
  process.exitCode = 1;
} else if (mode === 'api-error') {
  send({type:'result', is_error:true, subtype:'error_during_execution', errors:['API Error: 401 Unauthorized']});
  process.exitCode = 1;
} else if (mode === 'empty') {
  process.exitCode = 0;
} else if (mode === 'stale-fresh-fails') {
  send({type:'result', is_error:true, errors:['API Error: 503 Unavailable']});
  process.exitCode = 1;
} else if (mode === 'tool-error') {
  send({type:'assistant', message:{content:[{type:'tool_use',name:'Edit'}]}});
  send({type:'result', is_error:true, errors:['No conversation found with session ID: old']});
  process.exitCode = 1;
} else {
  process.stdout.write(JSON.stringify({type:'result',is_error:false,result:'OK',session_id:'new'}));
}
`, { mode: 0o755 });
process.env.CLAUDE_BIN = bin;
process.env.RESUME_HOME = home;
const { ask, ensureHome, loadState, saveState, activeName, readResume } = await import('../packages/core/index.js');
ensureHome();
const name = activeName();
const original = readResume(name);

async function scenario(mode) {
  fs.writeFileSync(path.join(home, 'mode'), mode);
  fs.writeFileSync(path.join(home, 'calls'), '');
  saveState({ activeResume:name, sessions:{[name]:'old',other:'keep'} });
  const events = [];
  for await (const ev of ask({ name, message:'测试' })) events.push(ev);
  const calls = fs.readFileSync(path.join(home, 'calls'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(ev => ev.t === 'done').length, 1);
  assert.equal(loadState().sessions.other, 'keep');
  assert.equal(readResume(name), original);
  return {events,calls};
}

try {
  for (const mode of ['stale-json','stale-stderr']) {
    const {events,calls} = await scenario(mode);
    assert.equal(calls.length, 2);
    assert.ok(calls[0].includes('--resume'));
    assert.ok(!calls[1].includes('--resume'));
    assert.ok(events.some(ev => ev.t === 'text' && ev.v === 'OK'));
    assert.ok(!events.some(ev => ev.t === 'error'));
    assert.equal(loadState().sessions[name], 'new');
    console.log(`✓ ${mode}: 自动恢复且只重试一次`);
  }
  const failedRetry = await scenario('stale-fresh-fails');
  assert.equal(failedRetry.calls.length, 2);
  assert.ok(failedRetry.events.some(ev => ev.t === 'error' && ev.v.includes('503')));
  assert.equal(loadState().sessions[name], undefined);
  console.log('✓ 新会话失败时清除旧记录并保留真实错误');
  for (const mode of ['api-error','empty','tool-error']) {
    const {events,calls} = await scenario(mode);
    assert.equal(calls.length, 1);
    assert.ok(events.some(ev => ev.t === 'error'));
    if (mode === 'api-error') assert.ok(events.some(ev => ev.v?.includes?.('401 Unauthorized')));
    console.log(`✓ ${mode}: 报错且不盲目重试`);
  }
  const appSource = fs.readFileSync(new URL('../packages/ui/public/app.js', import.meta.url), 'utf8');
  const sendSource = appSource.slice(appSource.indexOf('async function send()'), appSource.indexOf('// ------------------------------------------------------------------- events'));
  for (const [label, events, fails] of [
    ['生成错误', [{t:'error',v:'API 401'},{t:'done'}], true],
    ['中途断流', [], true],
    ['正常完成', [{t:'done'}], false],
  ]) {
    const messages = [];
    const errors = [];
    const context = vm.createContext({
      inputEl:{value:'测试'},busy:false,editMode:false,activeResume:name,runnerSelect:{value:'claude'},
      autoGrow(){},addUserMessage(){},setBusy(){},setStatus(){},reloadPreview(){},
      addErrorMessage(value){errors.push(value);},
      addAssistantMessage(){return {setCaret(){},doneTools(){},append(value){messages.push(value);}};},
      statusEl:{classList:{contains(){return false;}}},
      TextDecoder,
      fetch:async () => ({ok:true,body:{getReader(){
        let sent = false;
        return {async read(){if(sent)return {done:true};sent=true;return {done:false,value:Buffer.from(events.map(ev=>JSON.stringify(ev)+'\n').join(''))};}};
      }}}),
    });
    await vm.runInContext(`${sendSource}\nsend()`, context);
    assert.equal(errors.length > 0, fails);
    assert.equal(messages.some(text => text.includes('已处理完成')), !fails);
    console.log(`✓ 界面${label}: 完成提示与错误状态一致`);
  }
} finally {
  fs.rmSync(home, {recursive:true,force:true});
}
