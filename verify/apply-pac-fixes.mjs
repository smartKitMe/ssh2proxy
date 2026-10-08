#!/usr/bin/env node
/**
 * PAC 备份文件修复脚本（**默认 dry-run**，必须显式 `--write` 才落盘）
 *
 * 只做**精确字符串替换**，并校验期望出现次数；次数不符即整体中止（不做部分写入）。
 * 修复项来自 `verify/pac-backup-verify.mjs` 的验证结论，逐条对应报告中 D1/D2/D3。
 *
 * 用法：
 *   node verify/apply-pac-fixes.mjs                 # 只打印将要做的修改
 *   node verify/apply-pac-fixes.mjs --write         # 实际写入（会先备份为 <file>.bak-<时间戳>）
 *   node verify/apply-pac-fixes.mjs --dir <目录> --write
 */
import fs from 'fs';
import path from 'path';

const DEFAULT_DIR = 'F:\\笔记本数据备份\\pac';
const argv = process.argv.slice(2);
const write = argv.includes('--write');
const dirArgIndex = argv.indexOf('--dir');
const PAC_DIR = path.resolve(dirArgIndex >= 0 ? argv[dirArgIndex + 1] : DEFAULT_DIR);

/**
 * find/replace 均为字面量。
 * 说明（D2）：`return 'DIRECT ' + proxy;` 用空格连接了 DIRECT 与 SOCKS5 两条指令，
 * 规范要求以 `;` 分隔（MDN: "building blocks, separated by a semicolon"）。
 * 这里改成 `'DIRECT; ' + proxy`，保持原作者「先直连、失败再用代理」的顺序意图，
 * 只把非法的空格分隔修正为分号分隔。
 */
const FIXES = [
  {
    id: 'D1',
    file: 'proxy.pac.js',
    find: 'return vpnProxyl;',
    replace: 'return vpnProxy;',
    expect: 1,
    why: 'vpnProxyl 未声明 → 命中 vpnRules(rbidom.cn) 时 ReferenceError',
  },
  {
    id: 'D1',
    file: 'proxy.pac-vm.js',
    find: 'return vpnProxyl;',
    replace: 'return vpnProxy;',
    expect: 1,
    why: '同上（proxy.pac-vm.js 5936 行）',
  },
  {
    id: 'D2',
    file: 'proxy.pac.js',
    find: "return 'DIRECT ' + proxy;",
    replace: "return 'DIRECT; ' + proxy;",
    expect: 1,
    why: '两条 PAC 指令被空格连接，规范要求分号分隔',
  },
  {
    id: 'D2',
    file: 'proxy1.pac.js',
    find: "return 'DIRECT ' + proxy;",
    replace: "return 'DIRECT; ' + proxy;",
    expect: 1,
    why: '同上',
  },
  {
    id: 'D2',
    file: 'proxy2.pac.js',
    find: "return 'DIRECT ' + proxy;",
    replace: "return 'DIRECT; ' + proxy;",
    expect: 1,
    why: '同上',
  },
  {
    id: 'D2',
    file: 'proxy.pac-vm.js',
    find: "return 'DIRECT ' + proxy;",
    replace: "return 'DIRECT; ' + proxy;",
    expect: 1,
    why: '同上',
  },
  {
    id: 'D3',
    file: 'me.pac',
    find: '        ret = testHost(host, i);',
    replace: '        var ret = testHost(host, i);',
    expect: 1,
    why: 'ret 为隐式全局（严格模式/模块化加载会抛 ReferenceError）',
  },
];

function main() {
  console.log(`PAC 目录: ${PAC_DIR}`);
  console.log(`模式: ${write ? 'WRITE（将落盘）' : 'DRY-RUN（不改文件）'}`);

  const plan = [];
  for (const fix of FIXES) {
    const full = path.join(PAC_DIR, fix.file);
    if (!fs.existsSync(full)) {
      console.error(`[中止] 文件不存在: ${full}`);
      process.exitCode = 1;
      return;
    }
    const text = fs.readFileSync(full, 'utf8');
    const occurrences = text.split(fix.find).length - 1;
    if (occurrences !== fix.expect) {
      console.error(`[中止] ${fix.file}: 期望 ${fix.expect} 处 "${fix.find}"，实际 ${occurrences} 处（可能已修复或文件已变更）`);
      process.exitCode = 1;
      return;
    }
    const after = text.split(fix.find).join(fix.replace);
    plan.push({ ...fix, full, after, before: text });
  }

  for (const item of plan) {
    console.log(`  [${item.id}] ${item.file}: "${item.find}" → "${item.replace}"（${item.why}）`);
  }

  if (!write) {
    console.log(`\nDRY-RUN 结束：共 ${plan.length} 处待修改。确认后加 --write 落盘。`);
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const written = new Map();
  for (const item of plan) {
    if (!written.has(item.full)) {
      const backup = `${item.full}.bak-${stamp}`;
      fs.copyFileSync(item.full, backup);
      console.log(`  备份: ${backup}`);
      written.set(item.full, fs.readFileSync(item.full, 'utf8'));
    }
    const current = written.get(item.full);
    const updated = current.split(item.find).join(item.replace);
    written.set(item.full, updated);
  }
  for (const [full, content] of written) {
    fs.writeFileSync(full, content, 'utf8');
    console.log(`  已写入: ${full}`);
  }
  console.log(`\n完成：${plan.length} 处修改，原文件已备份。建议随后重跑 node verify/pac-backup-verify.mjs 复核。`);
}

main();
