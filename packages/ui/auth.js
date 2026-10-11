import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, scryptSync, timingSafeEqual, createHmac } from 'node:crypto';

export function passwordHash(password, salt) {
  return scryptSync(password, salt, 64).toString('hex');
}

export function newAccessConfig() {
  const password = randomBytes(18).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  return { password, config: { salt, passwordHash: passwordHash(password, salt), sessionKey: randomBytes(32).toString('hex'), publicUrl: '' } };
}

const LOGIN = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>登录 · 简历助手</title>
<style>body{margin:0;min-height:100dvh;display:grid;place-items:center;background:#eceae6;font:16px -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#17181c}main{box-sizing:border-box;width:min(400px,calc(100% - 32px));padding:32px;background:white;border:1px solid #e7e4de;border-radius:16px}h1{font-size:24px;margin:0 0 12px}p{line-height:1.6;color:#666}label{display:block;font-size:14px;margin-top:24px}input,button{box-sizing:border-box;width:100%;font:inherit;padding:12px;margin-top:10px;border-radius:8px;border:1px solid #ddd}button{background:#2f5cff;color:white;border:0;cursor:pointer}.error{color:#b3261e;font-size:14px}</style>
<main><h1>简历助手</h1><p>输入访问密码，继续编辑你的简历。</p>__ERROR__<form method="post" action="/login"><label for="password">访问密码</label><input id="password" name="password" type="password" required maxlength="256" autocomplete="current-password"><button type="submit">登录</button></form></main></html>`;

function equal(a, b) {
  const left = Buffer.from(a || '');
  const right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function accessGate(configFile) {
  const config = configFile && fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : null;
  if (config && (!/^[a-f0-9]{128}$/.test(config.passwordHash || '') || !/^[a-f0-9]{64}$/.test(config.sessionKey || '') || !config.salt)) throw new Error('远程访问配置不完整，拒绝启动');
  if (config?.publicUrl && !config.publicUrl.startsWith('https://')) throw new Error('远程网址必须使用 HTTPS');
  const attempts = new Map();
  const sessionAge = 7 * 24 * 3600;
  function sign(value) { return createHmac('sha256', config.sessionKey).update(value).digest('base64url'); }
  function valid(req) {
    const cookie = (req.headers.cookie || '').split(';').map(s => s.trim()).find(s => s.startsWith('resume_session='));
    const token = cookie?.slice('resume_session='.length) || '';
    const [expiry, nonce, signature] = token.split('.');
    return /^\d+$/.test(expiry || '') && /^[\w-]+$/.test(nonce || '') && Number(expiry) > Date.now() && Number(expiry) <= Date.now() + sessionAge * 1000 && equal(signature, sign(`${expiry}.${nonce}`));
  }
  function login(res, error = '', code = 200) {
    res.writeHead(code, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
    res.end(LOGIN.replace('__ERROR__', error ? `<p class="error">${error}</p>` : ''));
  }
  return async function gate(req, res, url) {
    let publicUrl = config?.publicUrl;
    if (config?.tunnelMode === 'quick') {
      try { publicUrl = JSON.parse(fs.readFileSync(path.join(path.dirname(configFile), 'remote-origin.json'), 'utf8')).publicUrl; } catch { publicUrl = ''; }
      if (publicUrl && !/^https:\/\/[a-z0-9-]+\.trycloudflare\.com$/.test(publicUrl)) publicUrl = '';
    }
    const publicOrigin = publicUrl ? new URL(publicUrl).origin : null;
    const host = req.headers.host || '';
    const local = /^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host);
    const remote = publicOrigin && host === new URL(publicOrigin).host;
    if (!local && !remote) { res.writeHead(403); res.end('未配置的访问地址'); return false; }
    const origin = local ? `http://${host}` : publicOrigin;
    const unsafe = !['GET','HEAD','OPTIONS'].includes(req.method);
    if ((req.headers['sec-fetch-site'] === 'cross-site' && (unsafe || url.pathname.startsWith('/api/'))) ||
        (req.headers.origin && req.headers.origin !== origin)) {
      res.writeHead(403); res.end('不允许跨站请求'); return false;
    }
    if (!config) return true;
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'self'");
    // 防止 HTML 简历中的脚本访问已登录接口，同时保留预览和文本编辑能力。
    if (url.pathname === '/resume' || url.pathname.startsWith('/assets/')) res.setHeader('Content-Security-Policy', "script-src 'none'; object-src 'none'; base-uri 'none'; connect-src 'none'; frame-src 'none'; form-action 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:");
    if (url.pathname === '/login' && req.method === 'GET') { login(res); return false; }
    if (url.pathname === '/login' && req.method === 'POST') {
      if (req.headers.origin !== origin) { res.writeHead(403); res.end('登录请求来源无效'); return false; }
      const now = Date.now();
      for (const [key, item] of attempts) if (item.until <= now) attempts.delete(key);
      const ip = String(req.headers['cf-connecting-ip'] || req.socket.remoteAddress);
      const item = attempts.get(ip) || {count:0, until:now + 60000};
      const global = attempts.get('*') || {count:0, until:now + 60000};
      if (item.count >= 5 || global.count >= 30) { login(res, '尝试次数过多，请一分钟后重试。', 429); return false; }
      item.count++; global.count++; attempts.set(ip, item); attempts.set('*', global);
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 4096) break; }
      const password = new URLSearchParams(body).get('password') || '';
      if (body.length > 4096 || password.length > 256 || !equal(passwordHash(password, config.salt), config.passwordHash)) { login(res, '访问密码不正确。', 401); return false; }
      attempts.delete(ip);
      const value = `${Date.now() + sessionAge * 1000}.${randomBytes(16).toString('base64url')}`;
      res.setHeader('Set-Cookie', `resume_session=${value}.${sign(value)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessionAge}${remote ? '; Secure' : ''}`);
      res.writeHead(303, {location:'/','cache-control':'no-store'}); res.end(); return false;
    }
    if (!valid(req)) {
      if (url.pathname.startsWith('/api/')) { res.writeHead(401, {'content-type':'application/json','cache-control':'no-store'}); res.end(JSON.stringify({error:'登录已过期，请重新登录'})); }
      else { res.writeHead(303, {location:'/login','cache-control':'no-store'}); res.end(); }
      return false;
    }
    if (url.pathname === '/logout' && req.method === 'POST') {
      res.writeHead(303, {'Set-Cookie':`resume_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${remote ? '; Secure' : ''}`,location:'/login'}); res.end(); return false;
    }
    return true;
  };
}
