import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { newAccessConfig } from '../packages/ui/auth.js';
import { createServer } from '../packages/ui/server.js';
import { activeName, readResume, closeBrowser } from '../packages/core/index.js';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'resume-remote-test-'));
process.env.RESUME_HOME = home;
const {password,config} = newAccessConfig();
config.publicUrl = 'https://resume.example.com';
fs.writeFileSync(path.join(home, 'remote-access.json'), JSON.stringify(config));
const {server} = createServer({log(){}});
server.listen(0, '127.0.0.1');
await once(server,'listening');
const base = `http://127.0.0.1:${server.address().port}`;
let cookie;
async function request(route, options = {}) {
  if (options.headers?.host) return new Promise((resolve,reject) => {
    const req = http.request(base+route,{method:options.method || 'GET',headers:{...(cookie ? {cookie} : {}),...options.headers}},res=>{
      const chunks=[];
      res.on('data',chunk=>chunks.push(chunk));
      res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });
    req.on('error',reject);
    req.end(options.body?.toString());
  });
  return fetch(base + route, {redirect:'manual', ...options, headers:{...(cookie ? {cookie} : {}), ...options.headers}});
}
let passed = 0;
function ok(label) { console.log(`✓ ${label}`); passed++; }
try {
  for (const route of ['/','/resume','/assets/photo.png','/app.js','/style.css']) {
    const r = await request(route); assert.equal(r.status,303); assert.equal(r.headers.get('location'),'/login');
  }
  for (const route of ['/api/resumes','/api/status','/api/events','/api/export']) assert.equal((await request(route)).status,401);
  ok('未登录不能访问简历、素材、接口、SSE 或下载');
  assert.equal((await request('/login')).status,200);
  assert.equal((await request('/login',{method:'POST',headers:{origin:'https://evil.example'},body:new URLSearchParams({password})})).status,403);
  ok('拒绝跨站登录');
  const wrong = await request('/login',{method:'POST',headers:{origin:base},body:new URLSearchParams({password:'wrong'})});
  assert.equal(wrong.status,401);
  const login = await request('/login',{method:'POST',headers:{origin:base},body:new URLSearchParams({password})});
  assert.equal(login.status,303);
  const setCookie = login.headers.get('set-cookie');
  assert.ok(setCookie.includes('HttpOnly') && setCookie.includes('SameSite=Strict'));
  cookie = setCookie.split(';')[0];
  assert.equal((await request('/')).status,200);
  ok('正确密码登录，使用 HttpOnly 会话 cookie');
  assert.equal((await request('/api/resumes',{headers:{cookie:cookie+'bad'}})).status,401);
  ok('篡改会话被拒绝');
  assert.equal((await request('/api/reset',{method:'POST',headers:{origin:'https://evil.example'},body:'{}'})).status,403);
  assert.equal((await request('/api/resumes',{headers:{host:'evil.example'}})).status,403);
  ok('拒绝跨站修改和未配置 Host');
  const remoteLogin = await request('/login',{method:'POST',headers:{host:'resume.example.com',origin:'https://resume.example.com'},body:new URLSearchParams({password})});
  assert.ok(remoteLogin.headers.get('set-cookie').includes('; Secure'));
  ok('远程 HTTPS 登录 cookie 带 Secure');
  const name = activeName();
  const original = readResume(name);
  const revision = createHash('sha256').update(original).digest('hex');
  const preview = await request('/resume');
  assert.ok(preview.headers.get('cache-control').includes('no-transform'));
  assert.ok(preview.headers.get('content-security-policy').includes("script-src 'none'"));
  const previewHtml = await preview.text();
  assert.ok(previewHtml.includes(`data-resume-revision="${revision}"`));
  assert.ok(previewHtml.includes('you@example.com'));
  assert.ok(!/data-cfemail|__cf_email__|\[email.?protected\]/i.test(previewHtml));
  ok('预览禁用简历脚本、禁止 Cloudflare 改写，并携带编辑基准版本');
  assert.equal((await request('/api/resume',{method:'PUT',headers:{origin:base,'if-match':'stale'},body:original})).status,409);
  assert.equal(readResume(name),original);
  const saved = await request(`/api/resume?name=${encodeURIComponent(name)}`,{method:'PUT',headers:{origin:base,'if-match':revision},body:original.replace('</body>','<p>版本更新</p></body>')});
  assert.equal(saved.status,200);
  assert.notEqual((await saved.json()).revision,revision);
  const beacon = await request(`/api/resume?name=${encodeURIComponent(name)}&revision=${revision}`,{method:'POST',headers:{origin:base},body:original});
  assert.equal(beacon.status,409);
  ok('手动保存和页面关闭保存均拒绝覆盖其他设备的新修改');
  if (process.argv.includes('--with-pdf')) {
    const pdf = await request(`/api/export?name=${encodeURIComponent(name)}`);
    assert.equal(pdf.status,200,await pdf.clone().text());
    assert.equal(pdf.headers.get('content-type'),'application/pdf');
    assert.ok(pdf.headers.get('cache-control').includes('no-transform'));
    assert.ok(pdf.headers.get('content-disposition').includes('attachment;'));
    assert.ok(pdf.headers.get('content-disposition').includes(encodeURIComponent(name)));
    const bytes = Buffer.from(await pdf.arrayBuffer());
    assert.equal(bytes.subarray(0,5).toString(),'%PDF-');
    const extracted = spawnSync('pdftotext',['-','-'],{input:bytes});
    if (!extracted.error) {
      assert.equal(extracted.status,0);
      assert.ok(extracted.stdout.toString().includes('you@example.com'));
      assert.ok(!/email.?protected/i.test(extracted.stdout.toString()));
    }
    assert.ok(!fs.readdirSync(path.join(home,'exports')).length);
    ok('认证后下载真实 PDF，中文文件名正确且无残留导出');
  }
  const logout = await request('/logout',{method:'POST',headers:{origin:base}});
  assert.equal(logout.status,303); assert.ok(logout.headers.get('set-cookie').includes('Max-Age=0'));
  cookie = null;
  assert.equal((await request('/api/export')).status,401);
  ok('退出后当前设备无法下载');
  for (let i=0;i<5;i++) await request('/login',{method:'POST',headers:{origin:base},body:new URLSearchParams({password:'wrong'})});
  assert.equal((await request('/login',{method:'POST',headers:{origin:base},body:new URLSearchParams({password})})).status,429);
  ok('密码尝试有频率限制');
  console.log(`${passed} 项远程访问检查通过`);
} finally {
  closeBrowser();
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));
  fs.rmSync(home,{recursive:true,force:true});
}
