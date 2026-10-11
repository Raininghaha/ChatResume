import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { paths } from '../packages/core/index.js';
import { serve } from '../packages/ui/server.js';

const home = paths().home;
const configFile = path.join(home, 'remote-access.json');
if (!fs.existsSync(configFile)) throw new Error('请先运行 node scripts/remote-setup.js init');
// 保留安装时实际使用的 CLI 环境；密钥不写入仓库或 launchd 参数。
const envFile = path.join(home, 'service-env.json');
if (fs.existsSync(envFile)) Object.assign(process.env, JSON.parse(fs.readFileSync(envFile, 'utf8')));
process.env.RESUME_ACCESS_CONFIG = configFile;
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));
await serve({port:8790,open:false,strictPort:true});
const tokenFile = path.join(home, 'cloudflare-token.txt');
const cloudflared = config.cloudflared || '/opt/homebrew/bin/cloudflared';
let child;
let stopping = false;
if (config.tunnelMode === 'quick' || (config.publicUrl && fs.existsSync(tokenFile))) {
  const originFile = path.join(home, 'remote-origin.json');
  const startTunnel = () => {
    if (stopping) return;
    const quick = config.tunnelMode === 'quick';
    if (quick) fs.writeFileSync(originFile, JSON.stringify({publicUrl:''}), {mode:0o600});
    const args = quick ? ['tunnel','--no-autoupdate','--protocol','http2','--url','http://127.0.0.1:8790'] : ['tunnel','--no-autoupdate','run','--token-file',tokenFile];
    child = spawn(cloudflared, args, {stdio:['ignore','pipe','pipe']});
    const log = chunk => {
      const output = chunk.toString();
      if (quick) {
        const url = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/)?.[0];
        if (url) {
          fs.writeFileSync(originFile, JSON.stringify({publicUrl:url}), {mode:0o600});
          console.log(`临时远程入口：${url}`);
        }
      }
      process.stderr.write(output);
    };
    child.stdout.on('data', log); child.stderr.on('data', log);
    child.on('error', () => console.error('隧道无法启动，请检查 cloudflared 路径'));
    child.on('close', () => { if (quick) fs.writeFileSync(originFile, JSON.stringify({publicUrl:''}), {mode:0o600}); if (!stopping) setTimeout(startTunnel, 10000); });
  };
  startTunnel();
  if (config.publicUrl) console.log(`远程入口：${config.publicUrl}`);
} else {
  console.log('本地后台服务已启动；固定远程入口等待配置域名和隧道 token。');
}
for (const sig of ['SIGINT','SIGTERM']) process.once(sig, () => { stopping = true; child?.kill('SIGTERM'); });
