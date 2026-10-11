import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { newAccessConfig } from '../packages/ui/auth.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const home = path.resolve(process.env.RESUME_HOME || path.join(os.homedir(), '.resume-chat'));
const configFile = path.join(home, 'remote-access.json');
const label = 'com.resume-chat.personal';
const plist = path.join(os.homedir(), 'Library', 'LaunchAgents', `${label}.plist`);
const service = `gui/${process.getuid()}/${label}`;
function write(file, content) {
  fs.mkdirSync(path.dirname(file), {recursive:true});
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, content, {mode:0o600});
  fs.chmodSync(temp, 0o600);
  fs.renameSync(temp, file);
}
function xml(text) { return String(text).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[c])); }
function launch(args) { return execFileSync('/bin/launchctl', args, {encoding:'utf8',stdio:['ignore','pipe','pipe']}); }
const command = process.argv[2];
if (command === 'init' || command === 'rotate-password') {
  if (command === 'init' && fs.existsSync(configFile)) {
    console.log('访问配置已存在，保留当前密码。');
  } else {
    const {password, config} = newAccessConfig();
    const existing = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};
    write(configFile, JSON.stringify({...existing,...config,publicUrl:existing.publicUrl || ''}, null, 2));
    write(path.join(home, '访问密码.txt'), `${password}\n`);
    console.log(`访问密码已保存到 ${path.join(home, '访问密码.txt')}（仅当前用户可读）。`);
    if (command === 'rotate-password') console.log('请重启服务，新密码生效后所有旧登录失效。');
  }
} else if (command === 'configure') {
  const url = new URL(process.argv[3] || '');
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || url.port) throw new Error('请输入固定 HTTPS 域名，例如 https://resume.example.com');
  const tokenSource = process.argv[4];
  if (!tokenSource) throw new Error('请指定本地 token 文件路径，不要把 token 放进命令参数或聊天');
  const token = fs.readFileSync(tokenSource, 'utf8').trim();
  if (!/^[\w+/=-]{40,}$/.test(token)) throw new Error('隧道 token 格式不正确');
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  write(path.join(home, 'cloudflare-token.txt'), `${token}\n`);
  write(configFile, JSON.stringify({...config,publicUrl:url.origin,tunnelMode:'named'}, null, 2));
  console.log(`已配置 ${url.origin}。Cloudflare 的 origin 必须指向 http://127.0.0.1:8790，且保留访问域名的 Host。`);
  console.log('运行 node scripts/remote-setup.js restart 使配置生效。');
} else if (command === 'temporary') {
  const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
  write(configFile, JSON.stringify({...config,publicUrl:'',tunnelMode:'quick'}, null, 2));
  console.log('已启用临时隧道。重启后获得试用网址，隧道重新连接时网址可能变化。');
} else if (command === 'install') {
  if (process.platform !== 'darwin') throw new Error('自动启动安装仅支持 macOS');
  if (!fs.existsSync(configFile)) throw new Error('请先执行 init');
  const env = {};
  for (const [key,value] of Object.entries(process.env)) {
    if (/^(ANTHROPIC_|CLAUDE_|RESUME_BROWSER$)/.test(key)) env[key] = value;
  }
  write(path.join(home, 'service-env.json'), JSON.stringify(env, null, 2));
  const args = [process.execPath,path.join(root,'scripts','remote-run.js')].map(v=>`<string>${xml(v)}</string>`).join('');
  const envs = {HOME:os.homedir(),RESUME_HOME:home,PATH:`/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${path.dirname(process.execPath)}`};
  const envXml = Object.entries(envs).map(([key,value])=>`<key>${xml(key)}</key><string>${xml(value)}</string>`).join('');
  write(plist, `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${args}</array><key>WorkingDirectory</key><string>${xml(root)}</string><key>EnvironmentVariables</key><dict>${envXml}</dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer><key>StandardOutPath</key><string>${xml(path.join(home,'service.log'))}</string><key>StandardErrorPath</key><string>${xml(path.join(home,'service-error.log'))}</string></dict></plist>`);
  execFileSync('/usr/bin/plutil', ['-lint',plist], {stdio:'pipe'});
  try { launch(['bootout',service]); } catch {}
  launch(['bootstrap',`gui/${process.getuid()}`,plist]);
  console.log('已安装用户登录后自动启动与异常恢复。服务仍需要 Mac 开机、联网且未休眠。');
} else if (command === 'restart') {
  launch(['kickstart','-k',service]);
  console.log('后台服务已重新启动。');
} else if (command === 'uninstall') {
  try { launch(['bootout',service]); } catch {}
  if (fs.existsSync(plist)) fs.unlinkSync(plist);
  console.log('已移除自动启动；简历、密码和配置仍保留。');
} else if (command === 'status') {
  const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile,'utf8')) : null;
  let temporaryUrl;
  try { temporaryUrl = JSON.parse(fs.readFileSync(path.join(home,'remote-origin.json'),'utf8')).publicUrl; } catch {}
  console.log(`登录保护：${config ? '已配置' : '未配置'}\n远程入口：${config?.tunnelMode === 'quick' ? temporaryUrl || '连接中' : config?.publicUrl || '待配置'}\n隧道模式：${config?.tunnelMode || '待配置'}\n启动项：${fs.existsSync(plist) ? '已安装' : '未安装'}`);
  try { const state = launch(['print',service]); console.log(state.split('\n').filter(line=>/state =|pid =|last exit code =/.test(line)).join('\n')); } catch { console.log('后台任务未加载'); }
} else {
  console.log('用法：node scripts/remote-setup.js init | temporary | install | status | restart | rotate-password | uninstall\n配置固定网址：node scripts/remote-setup.js configure https://resume.example.com /本地/token文件');
}
