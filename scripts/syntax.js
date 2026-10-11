#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 两个检查，都很便宜，所以合并成一个脚本：
 *   1. node --check —— 语法
 *   2. 控制字符扫描 —— 往正则字符组里写 \x00/\x1f 这类控制字符时，node --check
 *      不会报错，但匹配会静默失效（这个坑踩过）。所以单独扫一遍。
 */
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKIP = new Set(['node_modules', '.git', 'exports', 'workspace']);
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f]/;

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(entry.name) || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

const files = walk(ROOT).sort();
let failed = 0;

for (const file of files) {
  const rel = path.relative(ROOT, file);
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
  } catch (err) {
    failed++;
    process.stderr.write(`✗ 语法错误 ${rel}\n${err.stderr?.toString() || err.message}\n`);
    continue;
  }
  const hit = CONTROL.exec(fs.readFileSync(file, 'utf8'));
  if (hit) {
    failed++;
    const index = hit.index;
    process.stderr.write(
      `✗ 控制字符 ${rel} 偏移 ${index}: ${JSON.stringify(hit[0])} —— ` +
        `多半是想写正则里的 \\x 转义，实际被写成了真的控制字符\n`
    );
  }
}

if (failed) {
  process.stderr.write(`\n${failed} 个文件没通过\n`);
  process.exit(1);
}
process.stdout.write(`✓ ${files.length} 个文件语法与控制字符检查通过\n`);
