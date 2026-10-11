import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'chatresume-agents-'));
process.env.RESUME_HOME = home;
const fake = path.join(home, 'agent.cjs');
fs.writeFileSync(fake, `const fs=require('fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{
const args=process.argv.slice(2);fs.appendFileSync('calls.jsonl',JSON.stringify({args,input})+'\\n');
if(args.includes('exec')) {const emit=v=>console.log(JSON.stringify(v));emit({type:'thread.started',thread_id:'codex-session'});emit({type:'item.started',item:{type:'file_change'}});emit({type:'item.completed',item:{type:'agent_message',text:'你好'}});emit({type:'turn.completed'});}
else if(args.includes('text')) process.stdout.write('通用 Agent 回复');
else if(args.includes('fail')) {process.stderr.write('失败');process.exitCode=2;}
else {const q=JSON.parse(input);console.log(JSON.stringify({t:'session',v:'custom-session'}));console.log(JSON.stringify({t:'text',v:q.sessionId||'fresh'}));process.stdout.write(JSON.stringify({t:'done'}));}
});`);
const codex = path.join(home, 'codex');
fs.writeFileSync(codex, `#!/bin/sh\nexec '${process.execPath}' '${fake}' "$@"\n`, {mode:0o755});
process.env.CODEX_BIN = codex;
fs.writeFileSync(path.join(home,'runners.json'),JSON.stringify({runners:[
 {name:'example',command:process.execPath,args:[fake],protocol:'ndjson'},
 {name:'plain',command:process.execPath,args:[fake,'text'],protocol:'text'},
 {name:'failing',command:process.execPath,args:[fake,'fail'],protocol:'text'},
]}));
const core = await import('../packages/core/index.js');
core.ensureHome();const name=core.activeName();
core.saveState({activeResume:name,sessions:{[name]:'legacy-claude'}});
const collect = async runner => {const events=[];for await(const e of core.ask({name,message:'test',runner}))events.push(e);return events;};
try {
 for(const runner of ['codex','example','plain']) {
  const events=await collect(runner);assert.equal(events.filter(e=>e.t==='done').length,1);assert.ok(events.some(e=>e.t==='text'));assert.ok(!events.some(e=>e.t==='error'));
 }
 assert.equal(core.loadState().sessions[name],'legacy-claude');
 assert.equal(core.sessionOf(name,'codex'),'codex-session');
 assert.equal(core.sessionOf(name,'example'),'custom-session');
 await collect('codex');const e=await collect('example');assert.ok(e.some(e=>e.v==='custom-session'));
 const calls=fs.readFileSync(path.join(home,'calls.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 const resumes=calls.filter(c=>c.args.includes('resume'));assert.equal(resumes.length,1);assert.ok(resumes[0].args.includes('codex-session'));
 assert.ok(resumes[0].args.includes('sandbox_mode="workspace-write"'));assert.ok(!resumes[0].args.includes('--dangerously-bypass-approvals-and-sandbox'));
 core.resetSession(name,'codex');assert.equal(core.sessionOf(name,'codex'),null);assert.equal(core.sessionOf(name,'example'),'custom-session');
 const result=spawnSync(process.execPath,['packages/ui/bin/resume-chat.js','ask','--runner','failing','--json','test'],{env:process.env,encoding:'utf8'});assert.equal(result.status,1);assert.ok(result.stdout.includes('error'));
 const abort=new AbortController();abort.abort();const events=[];for await(const e of core.ask({name,message:'test',runner:'plain',signal:abort.signal}))events.push(e);assert.ok(events.some(e=>e.t==='error'));
 // Exercise the HTTP/UI-selected runner path without a real model or browser.
 globalThis.WebSocket = undefined;
 const { createServer } = await import('../packages/ui/server.js');
 const { once } = await import('node:events');
 const { server } = createServer({log(){}});
 server.listen(0,'127.0.0.1'); await once(server,'listening');
 const base = `http://127.0.0.1:${server.address().port}`;
 try {
  const meta = await (await fetch(base+'/api/status')).json(); assert.ok(meta.runners.some(r=>r.name==='codex'));
  const res = await fetch(base+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,message:'test',runner:'codex'})});
  assert.equal(res.status,200); const httpEvents=(await res.text()).trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(httpEvents.filter(e=>e.t==='done').length,1); assert.ok(httpEvents.some(e=>e.t==='text'&&e.v==='你好'));
  const bad = await fetch(base+'/api/chat',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name,message:'test',runner:'unknown-agent'})});assert.equal(bad.status,400);
 } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
 console.log('✓ 网页/HTTP 可选 Codex，未知 Agent 在开流前拒绝');
 console.log('✓ Codex 事件转换、续接、Agent 会话隔离、通用文本/NDJSON、失败退出码与取消通过');
} finally {fs.rmSync(home,{recursive:true,force:true});}
