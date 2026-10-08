#!/usr/bin/env node
/**
 * ssh2proxy × PAC 备份数据 —— 端到端验证夹具
 *
 * 输入（只读）：`F:\笔记本数据备份\pac` 下的 4 份服务器配置 + 5 份 PAC 文件。
 * 目的：用**真实数据**验证 ssh2proxy 的 PAC 能力与配置兼容性，并静态/运行时校验 PAC 文件本身。
 *
 * 分区：
 *   A 环境与输入清点        B PAC 文件静态校验（语法 / 规则表完整性 / 未声明标识符）
 *   C 配置兼容性            D PacService 解析行为（含多 PAC 目录）
 *   E 端到端 HTTP + Worker  F Worker 线程 ⇄ 主线程同源（含 >256KiB 尺寸边界）
 *   G SSH 端点 TCP 可达性（仅 INFO/WARN，不做认证）
 *
 * 用法：
 *   node verify/pac-backup-verify.mjs [--dir <pac目录>] [--json <报告路径>] [--skip-net]
 * 退出码：断言（PASS/FAIL）无 FAIL → 0；否则 1。数据缺陷（DEFECT）不改变退出码，但会在结论中点名。
 */
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import http from 'http';
import net from 'net';
import { spawnSync } from 'child_process';
import { fileURLToPath } from 'url';

import defaultConfig from '../src/config/default.config.mjs';
import { mergeConfig, validateConfig } from '../src/utils/helpers.mjs';
import PacService from '../src/core/pac-service.mjs';
import WorkerManager from '../src/core/worker-manager.mjs';
import ProxyServer from '../src/app.mjs';

const DEFAULT_PAC_DIR = 'F:\\笔记本数据备份\\pac';
const PAC_FILES = ['proxy.pac.js', 'me.pac', 'proxy1.pac.js', 'proxy2.pac.js', 'proxy.pac-vm.js'];
const CONFIG_FILES = ['config.json', 'config-us.json', 'config-hk-2.json', 'config-hk-bn.json'];
/** R-B 审查门实测过的尺寸边界（>256KiB），用于证明「尺寸不改变语义」 */
const PARITY_LARGE_BYTES = 307265;

// ───────────────────────── 参数 ─────────────────────────
function parseArgs(argv) {
  const out = { dir: DEFAULT_PAC_DIR, json: path.join(process.cwd(), 'verify', 'pac-backup-report.json'), net: true };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--dir') out.dir = argv[++i];
    else if (a === '--json') out.json = argv[++i];
    else if (a === '--skip-net') out.net = false;
  }
  return out;
}
const ARGS = parseArgs(process.argv.slice(2));
const PAC_DIR = path.resolve(ARGS.dir);

// ───────────────────────── 报告 ─────────────────────────
const results = [];
const counts = { PASS: 0, FAIL: 0, WARN: 0, INFO: 0, DEFECT: 0 };
const MARK = { PASS: 'PASS', FAIL: 'FAIL', WARN: 'WARN', INFO: 'INFO', DEFECT: 'DEFECT' };

function record(area, name, status, detail = '') {
  counts[status] += 1;
  results.push({ area, name, status, detail });
  console.log(`  [${MARK[status]}] ${name}${detail ? ` — ${detail}` : ''}`);
}
const pass = (a, n, d) => record(a, n, 'PASS', d);
const fail = (a, n, d) => record(a, n, 'FAIL', d);
const warn = (a, n, d) => record(a, n, 'WARN', d);
const info = (a, n, d) => record(a, n, 'INFO', d);
const defect = (a, n, d) => record(a, n, 'DEFECT', d);
function check(area, name, cond, detail = '') {
  if (cond) pass(area, name, detail);
  else fail(area, name, detail);
  return Boolean(cond);
}
function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 60 - title.length))}`);
}

// ───────────────────────── 工具 ─────────────────────────
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const short = (h) => h.slice(0, 12);
const byteLen = (s) => Buffer.byteLength(s, 'utf8');

/** 标准 PAC 辅助函数桩：确定性、无副作用 */
const PAC_HELPERS = {
  isPlainHostName: (host) => !String(host).includes('.'),
  dnsDomainIs: (host, domain) => String(host).endsWith(String(domain)),
  localHostOrDomainIs: (host, hostdom) => host === hostdom || String(hostdom).startsWith(`${host}.`),
  isResolvable: () => true,
  isInNet: (ip, pattern, mask) => {
    const toInt = (s) => {
      const m = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(String(s));
      if (!m) return null;
      const parts = m.slice(1).map(Number);
      if (parts.some((p) => p > 255)) return null;
      return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
    };
    const a = toInt(ip); const b = toInt(pattern); const c = toInt(mask);
    if (a === null || b === null || c === null) return false;
    return (a & c) === (b & c);
  },
  dnsResolve: (host) => String(host),
  myIpAddress: () => '127.0.0.1',
  dnsDomainLevels: (host) => String(host).split('.').length - 1,
  shExpMatch: (str, pattern) =>
    new RegExp(`^${String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`).test(String(str)),
  weekdayRange: () => false,
  dateRange: () => false,
  timeRange: () => false,
  alert: () => {},
};

/** 编译 PAC 文本并取出 FindProxyForURL（主 realm，sloppy 模式，与浏览器脚本语义接近） */
function compilePac(content) {
  const names = Object.keys(PAC_HELPERS);
  const values = names.map((n) => PAC_HELPERS[n]);
  // eslint-disable-next-line no-new-func
  const factory = new Function(...names, `${content}\n;return typeof FindProxyForURL === "function" ? FindProxyForURL : null;`);
  return factory(...values);
}

/**
 * 取 `var <name> = [ ... ]` 的字符串条目。
 * 用括号配对扫描（跳过注释与字符串），因为部分 PAC 的数组结尾没有 `];`（只有 `]`），
 * 也避免把注释掉的域名计入条目。
 */
function extractRuleEntries(content, name) {
  const start = content.indexOf(`var ${name} = [`);
  if (start === -1) return null;
  const open = content.indexOf('[', start);
  const entries = [];
  let depth = 0;
  let inLine = false;
  let inBlock = false;
  let str = null;
  let cur = '';
  for (let i = open; i < content.length; i += 1) {
    const ch = content[i];
    const next = content[i + 1];
    if (inLine) {
      if (ch === '\n') inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === '*' && next === '/') { inBlock = false; i += 1; }
      continue;
    }
    if (str) {
      if (ch === '\\') { cur += next ?? ''; i += 1; continue; }
      if (ch === str) { str = null; entries.push(cur); cur = ''; continue; }
      cur += ch;
      continue;
    }
    if (ch === '/' && next === '/') { inLine = true; i += 1; continue; }
    if (ch === '/' && next === '*') { inBlock = true; i += 1; continue; }
    if (ch === '"' || ch === "'") { str = ch; cur = ''; continue; }
    if (ch === '[') depth += 1;
    else if (ch === ']') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return entries;
}

/** 静态收集已声明标识符 */
function collectDeclared(content) {
  const names = new Set(['undefined', 'null', 'true', 'false', 'NaN', 'Infinity']);
  for (const re of [/\bvar\s+([A-Za-z_$][\w$]*)/g, /\bfunction\s+([A-Za-z_$][\w$]*)/g, /\blet\s+([A-Za-z_$][\w$]*)/g, /\bconst\s+([A-Za-z_$][\w$]*)/g]) {
    let m;
    while ((m = re.exec(content)) !== null) names.add(m[1]);
  }
  const fpn = /function FindProxyForURL\s*\(([^)]*)\)/.exec(content);
  if (fpn) fpn[1].split(',').map((s) => s.trim()).filter(Boolean).forEach((p) => names.add(p));
  return names;
}

/**
 * `return <identifier>;` 中出现但未声明的标识符（vpnProxyl 类缺陷的通用检测）
 * implicitGlobal=true 表示该名在别处被赋值（sloppy 模式下隐式全局，严格模式抛错）——
 * 归为告警；否则运行时必然 ReferenceError，归为确定缺陷。
 */
function findUndeclaredReturns(content) {
  const declared = collectDeclared(content);
  const bad = [];
  const re = /return\s+([A-Za-z_$][\w$]*)\s*;/g;
  let m;
  while ((m = re.exec(content)) !== null) {
    const id = m[1];
    if (declared.has(id)) continue;
    const assigned = new RegExp(`(^|[^.\\w$])${id}\\s*=(?!=)`, 'm').test(content);
    bad.push({ identifier: id, index: m.index, implicitGlobal: assigned });
  }
  return bad;
}

function lineOf(content, index) {
  return content.slice(0, index).split('\n').length;
}

/**
 * PAC 返回串校验。规范（Netscape/MDN）：多条指令以 `;` 分隔，每条为 `DIRECT`
 * 或 `PROTO host:port`。空格式（如 `DIRECT SOCKS5 1.2.3.4:80`）把两条指令用空格连在一起，
 * 不属于合法条目 —— 记为非标准（多数客户端会整条丢弃）。
 */
function validatePacResult(value) {
  if (typeof value !== 'string' || value.trim() === '') return { ok: false, reason: `非字符串或空: ${JSON.stringify(value)}` };
  const tokens = value.split(';').map((s) => s.trim()).filter(Boolean);
  if (tokens.length === 0) return { ok: false, reason: '空代理串' };
  const malformed = [];
  for (const token of tokens) {
    if (token === 'DIRECT') continue;
    if (/^(PROXY|SOCKS|SOCKS4|SOCKS5|HTTP|HTTPS)\s+[^\s:]+:\d{1,5}$/.test(token)) continue;
    malformed.push(token);
  }
  if (malformed.length > 0) {
    return { ok: false, reason: `非标准条目（规范要求以 ; 分隔多条指令）: ${JSON.stringify(malformed.join(' || '))}`, tokens };
  }
  return { ok: true, tokens };
}

/** 从 PAC 文本抽取代理指令（PROXY/SOCKS5 host:port） */
function extractProxyDirectives(content) {
  const found = new Set();
  const re = /(PROXY|SOCKS5|SOCKS4|SOCKS|HTTPS|HTTP)\s+([A-Za-z0-9._\-[\]:]+:\d{1,5})/g;
  let m;
  while ((m = re.exec(content)) !== null) found.add(`${m[1]} ${m[2]}`);
  return [...found];
}

function httpGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET' }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(15000, () => req.destroy(new Error('HTTP timeout')));
    req.on('error', reject);
    req.end();
  });
}

function tcpProbe(host, port, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host, port });
    const done = (ok, error) => {
      socket.destroy();
      resolve({ ok, error, ms: Date.now() - started });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false, `TCP 连接超时(${timeoutMs}ms)`));
    socket.once('error', (err) => done(false, err.code || err.message));
  });
}

/** 本机能否绑定该端口（与 ssh2proxy 的 listen(port) 同形：不指定 host） */
function bindProbe(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', (err) => resolve({ ok: false, code: err.code || err.message }));
    server.listen(port, () => {
      server.close(() => resolve({ ok: true }));
    });
  });
}

/** 原始 TCP 请求：返回 {note, data}；note ∈ connect 结果（data/end/timeout/error:CODE） */
function rawTcpRequest(host, port, payload, timeoutMs = 2500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let data = '';
    let settled = false;
    const done = (note) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch (err) { /* ignore */ }
      resolve({ note, data: data.slice(0, 200) });
    };
    socket.setTimeout(timeoutMs);
    socket.on('connect', () => socket.write(payload));
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
      if (data.length > 200) done('data');
    });
    socket.on('end', () => done('end'));
    socket.on('timeout', () => done('timeout'));
    socket.on('error', (err) => done(`error:${err.code}`));
  });
}

/** HTTP 代理探测请求（testingMode 下 ssh2proxy 会以 502 Proxy Error 应答，足以判断「谁在服务该端口」） */
const HTTP_PROBE_PAYLOAD = 'GET http://example.com/ HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n';


/** 构造恰好 targetBytes 字节的合法 PAC 文本（用注释填充） */
function buildPaddedPac(targetBytes) {
  const base = 'function FindProxyForURL(url, host) {\n  return "DIRECT";\n}\n';
  const head = '// parity-boundary-padding ';
  const padLen = targetBytes - byteLen(base) - byteLen(head) - 1;
  const content = `${head}${'p'.repeat(padLen)}\n${base}`;
  return content;
}

// ───────────────────────── A 环境与输入 ─────────────────────────
async function sectionA() {
  section('A. 环境与输入清点');
  info('环境', 'Node 版本', `${process.version} (${process.platform})`);
  info('环境', 'PAC 目录', PAC_DIR);
  info('环境', '工作目录', process.cwd());

  const dirOk = fs.existsSync(PAC_DIR) && fs.statSync(PAC_DIR).isDirectory();
  check('输入', 'PAC 目录存在且为目录', dirOk, PAC_DIR);
  if (!dirOk) return null;

  const entries = await fsp.readdir(PAC_DIR, { withFileTypes: true });
  const fileNames = entries.filter((e) => e.isFile()).map((e) => e.name).sort();
  info('输入', '目录内容', fileNames.join(', '));

  const inventory = { files: {}, configs: {} };
  for (const name of PAC_FILES) {
    const full = path.join(PAC_DIR, name);
    if (!fs.existsSync(full)) {
      fail('输入', `PAC 文件存在: ${name}`, '缺失');
      continue;
    }
    const buf = await fsp.readFile(full);
    inventory.files[name] = { path: full, bytes: buf.length, sha256: sha256(buf), content: buf.toString('utf8') };
    pass('输入', `PAC 文件存在: ${name}`, `${buf.length} 字节 sha256=${short(inventory.files[name].sha256)}`);
  }
  for (const name of CONFIG_FILES) {
    const full = path.join(PAC_DIR, name);
    if (!fs.existsSync(full)) {
      fail('输入', `配置文件存在: ${name}`, '缺失');
      continue;
    }
    const buf = await fsp.readFile(full);
    let parsed = null;
    try {
      parsed = JSON.parse(buf.toString('utf8'));
    } catch (err) {
      fail('输入', `配置文件 JSON 合法: ${name}`, err.message);
      continue;
    }
    inventory.configs[name] = { path: full, json: parsed, bytes: buf.length };
    pass('输入', `配置文件 JSON 合法: ${name}`, `${buf.length} 字节`);
  }
  return inventory;
}

// ───────────────────────── B PAC 文件静态校验 ─────────────────────────
function sectionB(inventory) {
  section('B. PAC 文件静态 / 运行时校验');
  const probeHostsOf = (entries) => (entries && entries.length ? entries[0] : null);

  for (const name of PAC_FILES) {
    const item = inventory.files[name];
    if (!item) continue;
    const content = item.content;

    info('PAC 文件', `${name} 基线`, `${item.bytes} 字节 sha256=${short(item.sha256)}`);

    // UTF-8 完整性
    const replacement = (content.match(/\uFFFD/g) || []).length;
    check('PAC 文件', `${name} UTF-8 解码无替换字符`, replacement === 0, `U+FFFD×${replacement}`);

    // 语法编译
    let fn = null;
    let compileError = null;
    try {
      fn = compilePac(content);
    } catch (err) {
      compileError = err;
    }
    const compiled = check('PAC 文件', `${name} 语法编译通过`, !compileError && typeof fn === 'function', compileError ? compileError.message : 'FindProxyForURL 已导出');
    if (!compiled) continue;

    // 规则表完整性
    const arrays = ['publicRules', 'userDomains', 'grabBagRules', 'vpnRules', 'rules'];
    const stats = [];
    for (const arr of arrays) {
      const entries = extractRuleEntries(content, arr);
      if (!entries) continue;
      const empties = entries.filter((e) => e.trim() === '').length;
      const dupes = entries.length - new Set(entries).size;
      const untidy = entries.filter((e) => e !== e.trim() || e.startsWith('.') || /[A-Z]/.test(e)).length;
      stats.push(`${arr}=${entries.length}${empties ? ` 空${empties}` : ''}${dupes ? ` 重复${dupes}` : ''}${untidy ? ` 不规范${untidy}` : ''}`);
      if (empties) warn('PAC 文件', `${name} ${arr} 含空条目`, String(empties));
      if (dupes) warn('PAC 文件', `${name} ${arr} 含重复条目`, String(dupes));
    }
    info('PAC 文件', `${name} 规则表`, stats.join(' | ') || '(未找到已知规则表)');

    // 未声明标识符的 return（通用缺陷检测）
    const undeclared = findUndeclaredReturns(content);
    const hard = undeclared.filter((u) => !u.implicitGlobal);
    const soft = undeclared.filter((u) => u.implicitGlobal);
    if (hard.length > 0) {
      const desc = hard.map((u) => `第${lineOf(content, u.index)}行 return ${u.identifier}`).join('; ');
      defect('PAC 文件', `${name} 存在未声明标识符的 return（必然 ReferenceError）`, desc);
    }
    if (soft.length > 0) {
      const desc = soft.map((u) => `第${lineOf(content, u.index)}行 return ${u.identifier}`).join('; ');
      warn('PAC 文件', `${name} 存在隐式全局变量的 return（严格模式会抛错）`, desc);
    }
    if (hard.length === 0 && soft.length === 0) {
      pass('PAC 文件', `${name} 无未声明的 return 标识符`, '');
    }

    // 运行时探针
    const allRules = [];
    for (const arr of ['publicRules', 'userDomains', 'grabBagRules', 'vpnRules']) {
      const entries = extractRuleEntries(content, arr);
      if (entries && entries.length) allRules.push({ arr, host: entries[0] });
    }
    const probes = [
      { host: 'localhost', why: 'isPlainHostName 直连分支' },
      { host: 'example.com', why: '未命中规则' },
      { host: 'www.google.com', why: '典型被墙域名' },
      { host: 'www.baidu.com', why: '典型国内域名' },
      ...allRules.map((r) => ({ host: r.host, why: `命中 ${r.arr}[0]` })),
    ];
    const seen = new Set();
    const probeResults = [];
    const reportedBadValues = new Set();
    for (const p of probes) {
      if (seen.has(p.host)) continue;
      seen.add(p.host);
      try {
        const value = fn(`http://${p.host}/`, p.host);
        const v = validatePacResult(value);
        probeResults.push(`${p.host}→${value}${v.ok ? '' : ' [非标准]'}`);
        if (!v.ok && !reportedBadValues.has(value)) {
          reportedBadValues.add(value);
          defect('PAC 文件', `${name} 返回串非标准`, `值=${JSON.stringify(value)} — ${v.reason}`);
        }
      } catch (err) {
        probeResults.push(`${p.host}→抛错`);
        defect('PAC 文件', `${name} FindProxyForURL 抛错 (${p.host})`, `${err.name}: ${err.message} | ${p.why}`);
      }
    }
    pass('PAC 文件', `${name} 探针执行完成`, `${seen.size} 个主机`);
    info('PAC 文件', `${name} 探针结果`, probeResults.join(' ; '));

    // 代理指令
    const directives = extractProxyDirectives(content);
    info('PAC 文件', `${name} 代理指令`, directives.join(' | ') || '(无)');
  }
}

// ───────────────────────── C 配置兼容性 ─────────────────────────
function sectionC(inventory) {
  section('C. 配置兼容性（4 份服务器配置）');
  const defaultTopKeys = Object.keys(defaultConfig);
  const merged = {};

  for (const name of CONFIG_FILES) {
    const item = inventory.configs[name];
    if (!item) continue;
    const userCfg = JSON.parse(JSON.stringify(item.json));
    const cfg = mergeConfig(structuredClone(defaultConfig), userCfg);
    merged[name] = cfg;

    const errors = validateConfig(cfg);
    const fatal = errors.filter((m) => /port/i.test(m));
    check('配置', `${name} 端口校验无致命错误`, fatal.length === 0, fatal.join('; ') || '无');
    if (errors.length > 0) {
      info('配置', `${name} 非致命告警`, errors.join('; '));
    } else {
      pass('配置', `${name} 校验无告警`, '');
    }

    const unknownTop = Object.keys(userCfg).filter((k) => !defaultTopKeys.includes(k));
    if (unknownTop.length) warn('配置', `${name} 存在未知顶层键`, unknownTop.join(', '));
    else pass('配置', `${name} 顶层键均在默认配置模式内`, Object.keys(userCfg).join(', '));

    // 关键键落位
    const checks = [
      ['pac.enabled', cfg.pac.enabled === true],
      ['pac.filePath 存在', typeof cfg.pac.filePath === 'string' && cfg.pac.filePath.length > 0],
      ['pac.directory 未配置（多 PAC 关闭）', cfg.pac.directory === ''],
      ['proxy.pacPort=8013', cfg.proxy.pacPort === 8013],
      ['proxy.socksPort=11080', cfg.proxy.socksPort === 11080],
      ['proxy.httpPort=8080', cfg.proxy.httpPort === 8080],
      ['testingMode=false（生产口径）', cfg.testingMode === false],
      ['tunnel.type 默认 ssh', cfg.tunnel.type === 'ssh'],
    ];
    for (const [label, ok] of checks) check('配置', `${name} ${label}`, ok, ok ? '' : '不符');

    // pac.filePath 指向的文件确实存在，且内容与目录内 PAC 文件一致
    if (cfg.pac.filePath) {
      const target = path.resolve(cfg.pac.filePath);
      const exists = fs.existsSync(target);
      check('配置', `${name} pac.filePath 指向的文件存在`, exists, target);
      if (exists) {
        const buf = fs.readFileSync(target);
        const base = path.basename(target);
        if (inventory.files[base]) {
          check('配置', `${name} pac.filePath 内容与目录内同名文件一致`, sha256(buf) === inventory.files[base].sha256, `sha256=${short(sha256(buf))}`);
        }
        // 回环端口一致性：PAC 中 127.0.0.1 的端口是否落在配置端口集内
        const directives = extractProxyDirectives(buf.toString('utf8'));
        const localPorts = directives
          .filter((d) => d.includes('127.0.0.1'))
          .map((d) => Number(d.split(':').pop()));
        const known = new Set([cfg.proxy.socksPort, cfg.proxy.httpPort, cfg.proxy.httpsPort].filter(Boolean));
        const unknownPorts = [...new Set(localPorts)].filter((p) => !known.has(p));
        if (unknownPorts.length === 0) {
          pass('配置', `${name} PAC 回环端口与配置端口一致`, `127.0.0.1 端口 ∈ {${[...known].join(', ')}}`);
        } else {
          warn('配置', `${name} PAC 引用了配置未监听的回环端口`, unknownPorts.join(', '));
        }
      }
    }

    // SSH 凭据完备性（只告警，不致命）
    const hasPassword = typeof cfg.ssh.password === 'string' && cfg.ssh.password.length > 0;
    const hasKey = typeof cfg.ssh.privateKey === 'string' && cfg.ssh.privateKey.length > 0;
    if (!hasPassword && !hasKey) {
      warn('配置', `${name} 未内置 SSH 凭据`, `host=${cfg.ssh.host} user=${cfg.ssh.username}；仅凭此文件无法建立隧道（需 --ssh-private-key-path 或密码）`);
    } else {
      pass('配置', `${name} SSH 凭据已内置`, '');
    }
  }
  return merged;
}

// ───────────────────────── D PacService 解析 ─────────────────────────
async function sectionD(inventory, merged) {
  section('D. PacService 解析行为（含多 PAC 目录）');
  const primary = merged[CONFIG_FILES[0]];
  const expected = inventory.files['proxy.pac.js'];

  const svc = new PacService(primary);
  const content = await svc.generatePacContent(null);
  check('PacService', '默认面 /proxy.pac 返回 pac.filePath 正文', content !== null && sha256(Buffer.from(content, 'utf8')) === expected.sha256, `${byteLen(content || '')} 字节`);

  const resolvedByBase = await svc.resolvePacFile(path.basename(primary.pac.filePath));
  check('PacService', '按 basename 命中单文件（/pac/proxy.pac.js）', resolvedByBase === path.resolve(primary.pac.filePath), String(resolvedByBase));

  const missSingle = await svc.resolvePacFile('me.pac');
  check('PacService', 'filePath 为文件时其他名字未命中（→404）', missSingle === null, '返回 null');

  const renderDefault = await svc.resolvePacRender(null);
  check('PacService', 'resolvePacRender(默认面) 为 content 且尺寸一致', renderDefault && renderDefault.kind === 'content' && byteLen(renderDefault.content) === expected.bytes, `${renderDefault ? renderDefault.kind : 'null'}`);

  // 多 PAC：pac.directory 指向备份目录
  const dirCfg = mergeConfig(structuredClone(defaultConfig), {
    testingMode: true,
    pac: { enabled: true, directory: PAC_DIR, filePath: '', content: '' },
  });
  const dirSvc = new PacService(dirCfg);
  for (const name of PAC_FILES) {
    const resolved = await dirSvc.resolvePacFile(name);
    const fileContent = await dirSvc.generatePacContent(name);
    const ok = resolved !== null && fileContent !== null && sha256(Buffer.from(fileContent, 'utf8')) === inventory.files[name].sha256;
    check('PacService 多PAC', `按名装载 ${name}`, ok, ok ? `${inventory.files[name].bytes} 字节` : '未命中或内容不一致');
  }
  const misses = ['nope.pac', '..\\config.json', '../config.json', 'a/b.pac', ''];
  for (const bad of misses) {
    const r = await dirSvc.resolvePacFile(bad);
    check('PacService 多PAC', `拒绝未命中/穿越名 ${JSON.stringify(bad)}`, r === null, String(r));
  }

  // pac.files 显式映射优先于目录
  const filesCfg = mergeConfig(structuredClone(defaultConfig), {
    testingMode: true,
    pac: { enabled: true, directory: PAC_DIR, files: { 'me-by-map.pac': path.join(PAC_DIR, 'me.pac') } },
  });
  const filesSvc = new PacService(filesCfg);
  const mapped = await filesSvc.generatePacContent('me-by-map.pac');
  check('PacService 多PAC', 'pac.files 显式映射生效', mapped !== null && sha256(Buffer.from(mapped, 'utf8')) === inventory.files['me.pac'].sha256, 'me.pac 通过显式映射返回');

  // 默认模板端口归一化：模板写 1080，真实 socksPort=11080 → 必须归一化为 11080
  const tplCfg = mergeConfig(structuredClone(defaultConfig), {
    testingMode: true,
    proxy: { socksPort: 11080, httpPort: 8080 },
    pac: { enabled: true, filePath: '', content: '', defaultProxy: 'SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT' },
  });
  const tplSvc = new PacService(tplCfg);
  const proxied = tplSvc.generateDefaultProxyString();
  check('PacService', '默认模板端口按 proxy.socksPort 归一化', proxied === 'SOCKS5 127.0.0.1:11080; SOCKS 127.0.0.1:11080; DIRECT', proxied);
  const tplRender = await tplSvc.resolvePacRender(null);
  check('PacService', '无文件时默认面返回 template 形态', tplRender && tplRender.kind === 'template' && tplRender.proxy === proxied, tplRender ? tplRender.kind : 'null');
}

// ───────────────────────── E 端到端 HTTP（真实监听 + 真实 Worker 线程） ─────────────────────────
async function sectionE(inventory, merged) {
  section('E. 端到端 HTTP + Worker 线程（testingMode 仅用于隔离 SSH）');
  const base = JSON.parse(JSON.stringify(merged[CONFIG_FILES[0]]));
  const e2ePorts = { httpPort: 18080, socksPort: 21080, pacPort: 28013, httpsPort: 0 };
  const e2eConfig = mergeConfig(structuredClone(defaultConfig), {
    ...base,
    testingMode: true, // 隔离 SSH 连接池，只验证 PAC/HTTP 面
    proxy: { ...base.proxy, ...e2ePorts },
    pac: { ...base.pac, enabled: true, directory: PAC_DIR, filePath: path.join(PAC_DIR, 'proxy.pac.js') },
  });
  const server = new ProxyServer(e2eConfig);
  let started = false;
  try {
    await server.start();
    started = true;
    pass('端到端', 'ProxyServer.start() 成功', `HTTP ${e2ePorts.httpPort} / SOCKS5 ${e2ePorts.socksPort} / PAC ${e2ePorts.pacPort}, httpsPort=0`);

    // 真实 Worker 线程池（testingMode 不自动启动，这里手工启动以命中 Worker 热路径）
    const poolInfo = await server.workerManager.start();
    check('端到端', 'Worker 池启动（真实线程）', poolInfo && poolInfo.size > 0 && poolInfo.threadIds.length === poolInfo.size, JSON.stringify(poolInfo));

    const fileHashes = {
      '/proxy.pac': inventory.files['proxy.pac.js'],
      '/pac/proxy.pac.js': inventory.files['proxy.pac.js'],
      '/pac/me.pac': inventory.files['me.pac'],
      '/pac/proxy1.pac.js': inventory.files['proxy1.pac.js'],
      '/pac/proxy2.pac.js': inventory.files['proxy2.pac.js'],
      '/pac/proxy.pac-vm.js': inventory.files['proxy.pac-vm.js'],
    };

    for (const [urlPath, expectedFile] of Object.entries(fileHashes)) {
      const res = await httpGet(e2ePorts.pacPort, urlPath);
      const gotHash = sha256(res.body);
      check('端到端', `GET ${urlPath} → 200`, res.status === 200, `status=${res.status}`);
      check('端到端', `GET ${urlPath} Content-Type`, res.headers['content-type'] === 'application/x-ns-proxy-autoconfig', String(res.headers['content-type']));
      check('端到端', `GET ${urlPath} Content-Length`, Number(res.headers['content-length']) === expectedFile.bytes, `${res.headers['content-length']} vs ${expectedFile.bytes}`);
      check('端到端', `GET ${urlPath} 字节级一致`, gotHash === expectedFile.sha256, `${res.body.length} 字节 sha256=${short(gotHash)} vs ${short(expectedFile.sha256)}`);
    }

    const missing = await httpGet(e2ePorts.pacPort, '/pac/does-not-exist.pac');
    check('端到端', 'GET /pac/does-not-exist.pac → 404', missing.status === 404, `status=${missing.status}`);

    const traversal = await httpGet(e2ePorts.pacPort, '/pac/..%2Fconfig.json');
    check('端到端', 'GET /pac/..%2Fconfig.json → 非 200（穿越防护）', traversal.status !== 200, `status=${traversal.status}`);

    const stats = server.workerManager.getStats();
    check('端到端', 'PAC 热路径确实在 Worker 线程执行', stats.totalTasks >= 6 && stats.mainThreadTasks === 0, `totalTasks=${stats.totalTasks} mainThreadTasks=${stats.mainThreadTasks}`);
    info('端到端', 'Worker 池统计', JSON.stringify(stats.workers));

    // 请求统计
    const rateLimited = await httpGet(e2ePorts.pacPort, '/proxy.pac');
    check('端到端', '限流未误伤 PAC 探测（连续请求仍 200）', rateLimited.status === 200, `status=${rateLimited.status}`);

    // 强制 Worker 返回脏值 → 触发 PacService 主线程回落：同一 URL 必须仍是同一份字节
    const originalAssign = server.workerManager.assignTask;
    server.workerManager.assignTask = async () => 'dirty-not-a-pac';
    let fallbackName = null;
    let fallbackDefault = null;
    try {
      fallbackName = await httpGet(e2ePorts.pacPort, '/pac/me.pac');
      fallbackDefault = await httpGet(e2ePorts.pacPort, '/proxy.pac');
    } finally {
      server.workerManager.assignTask = originalAssign;
    }
    check('端到端', 'Worker 降级后 /pac/me.pac 仍返回同一份文件',
      fallbackName && fallbackName.status === 200 && sha256(fallbackName.body) === inventory.files['me.pac'].sha256,
      fallbackName ? `${fallbackName.body.length} 字节 status=${fallbackName.status}` : '无响应');
    check('端到端', 'Worker 降级后 /proxy.pac 仍返回同一份文件',
      fallbackDefault && fallbackDefault.status === 200 && sha256(fallbackDefault.body) === inventory.files['proxy.pac.js'].sha256,
      fallbackDefault ? `${fallbackDefault.body.length} 字节 status=${fallbackDefault.status}` : '无响应');
  } finally {
    try {
      await server.stop();
      pass('端到端', 'ProxyServer.stop() 干净退出', '');
    } catch (err) {
      fail('端到端', 'ProxyServer.stop() 干净退出', err.message);
    }
    if (!started) {
      fail('端到端', 'ProxyServer.start() 成功', '未启动，后续检查已跳过');
    }
  }
}

// ───────────────────────── F Worker ⇄ 主线程同源 ─────────────────────────
async function sectionF(inventory) {
  section('F. Worker 线程 ⇄ 主线程同源（含 307265B 尺寸边界）');
  const pool = new WorkerManager({ size: 2 });
  const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ssh2proxy-parity-'));
  try {
    const poolInfo = await pool.start();
    check('同源', 'WorkerManager.start()', poolInfo.size === 2 && poolInfo.threadIds.length === 2, JSON.stringify(poolInfo));

    // 1) 真实文件：worker 路径 vs 主线程路径
    for (const name of PAC_FILES) {
      const item = inventory.files[name];
      if (!item) continue;
      const cfg = mergeConfig(structuredClone(defaultConfig), {
        testingMode: true,
        proxy: { socksPort: 11080 },
        pac: { enabled: true, filePath: item.path },
      });
      const svc = new PacService(cfg);
      const mainThread = await svc.generatePacContent(null);
      const resolved = await svc.resolvePacRender(null);
      const workerOut = await pool.assignTask({ type: 'renderPac', payload: { name: null, content: resolved.content } });
      check('同源', `${name} worker 输出 === 主线程输出`, sha256(Buffer.from(workerOut, 'utf8')) === sha256(Buffer.from(mainThread, 'utf8')), `${byteLen(mainThread)} 字节`);
      check('同源', `${name} worker 输出含 FindProxyForURL`, typeof workerOut === 'string' && workerOut.includes('FindProxyForURL'), '');
    }

    // 2) 超 256KiB 边界：尺寸不得改变语义
    const largePath = path.join(tmpDir, 'large-307265.pac');
    const largeContent = buildPaddedPac(PARITY_LARGE_BYTES);
    await fsp.writeFile(largePath, largeContent, 'utf8');
    check('同源', `构造 ${PARITY_LARGE_BYTES}B PAC 文件`, fs.statSync(largePath).size === PARITY_LARGE_BYTES, `${fs.statSync(largePath).size} 字节`);

    const largeCfg = mergeConfig(structuredClone(defaultConfig), {
      testingMode: true,
      proxy: { socksPort: 11080 },
      pac: { enabled: true, filePath: largePath },
    });
    const largeSvc = new PacService(largeCfg);
    const largeMain = await largeSvc.generatePacContent(null);
    const largeResolved = await largeSvc.resolvePacRender(null);
    const largeWorker = await pool.assignTask({ type: 'renderPac', payload: { name: null, content: largeResolved.content } });
    check('同源', `>256KiB worker 输出 === 主线程输出（不做尺寸裁剪）`, sha256(Buffer.from(largeWorker, 'utf8')) === sha256(Buffer.from(largeMain, 'utf8')), `${byteLen(largeMain)} 字节`);
    check('同源', `>256KiB 输出长度未被裁剪为默认模板`, byteLen(largeWorker) === PARITY_LARGE_BYTES, `worker=${byteLen(largeWorker)} main=${byteLen(largeMain)}`);

    // 3) 默认模板形态同源
    const tplCfg = mergeConfig(structuredClone(defaultConfig), {
      testingMode: true,
      proxy: { socksPort: 11080, httpPort: 8080 },
      pac: { enabled: true, filePath: '', content: '', defaultProxy: 'SOCKS5 127.0.0.1:1080; SOCKS 127.0.0.1:1080; DIRECT' },
    });
    const tplSvc = new PacService(tplCfg);
    const tplMain = await tplSvc.generatePacContent(null);
    const tplResolved = await tplSvc.resolvePacRender(null);
    const tplWorker = await pool.assignTask({ type: 'renderPac', payload: { name: null, renderProxy: tplResolved.proxy } });
    // 注意：默认面（未配置 pac.filePath/content）两路**本就不同文本** —— Worker 侧是「本地/内网直连 + 代理」富模板
    // （src/core/worker-manager.mjs 的 renderPac handler），PacService 侧是紧凑模板（buildDefaultPacContent()）；
    // 该分工被仓库自带用例 src/tests/d3-regressions.test.mjs「resolvePacRender：默认面返回归一化模板」钉住。
    // 故此处只断言「都携带归一化端口」，文本差异按 WARN 记录，不作为失败。
    check('同源', '默认模板两路均携带归一化端口（无 1080 回落）',
      tplWorker.includes('127.0.0.1:11080') && tplMain.includes('127.0.0.1:11080')
      && !tplWorker.includes('127.0.0.1:1080;') && !tplMain.includes('127.0.0.1:1080;'),
      `worker=${byteLen(tplWorker)}B main=${byteLen(tplMain)}B`);
    if (tplWorker === tplMain) {
      pass('同源', '默认模板两路文本字节一致', `${byteLen(tplMain)} 字节`);
    } else {
      warn('同源', '默认模板两路文本不同（设计如此：Worker 富模板 vs PacService 紧凑回落）',
        `worker=${byteLen(tplWorker)}B / main=${byteLen(tplMain)}B；Worker 不可用时降级文本会缺少「本地/内网直连」分支`);
    }

    const stats = pool.getStats();
    check('同源', '同源检查全部经 Worker 线程执行', stats.mainThreadTasks === 0, `mainThreadTasks=${stats.mainThreadTasks} totalTasks=${stats.totalTasks}`);
  } finally {
    await pool.close();
    await fsp.rm(tmpDir, { recursive: true, force: true });
  }
}

// ───────────────────────── G SSH 端点可达性 ─────────────────────────
async function sectionG(inventory) {
  section('G. 配置中的 SSH 端点 TCP 可达性（只做 TCP 连接，不认证）');
  if (!ARGS.net) {
    info('网络', '已通过 --skip-net 跳过', '');
    return;
  }
  const targets = new Map();
  for (const name of CONFIG_FILES) {
    const cfg = inventory.configs[name];
    if (!cfg) continue;
    const key = `${cfg.json.ssh.host}:${cfg.json.ssh.port || 22}`;
    if (!targets.has(key)) targets.set(key, []);
    targets.get(key).push(`${name}(${cfg.json.ssh.username})`);
  }
  for (const key of targets.keys()) {
    const [host, portStr] = key.split(':');
    const probe = await tcpProbe(host, Number(portStr));
    if (probe.ok) {
      info('网络', `SSH 端点可达 ${key}`, `${probe.ms}ms —— 由 ${targets.get(key).join(', ')} 使用（未做认证，配置内无凭据）`);
    } else {
      warn('网络', `SSH 端点不可达 ${key}`, `${probe.error} —— 由 ${targets.get(key).join(', ')} 使用`);
    }
  }
}

// ───────────────────────── H 配置端口占用与冲突行为 ─────────────────────────
async function sectionH(inventory) {
  section('H. 配置端口在本机的占用情况与冲突行为');

  // H1：把 4 份配置声明的端口去重后逐个试绑定
  const portUsers = new Map();
  for (const name of CONFIG_FILES) {
    const cfg = inventory.configs[name];
    if (!cfg) continue;
    const p = cfg.json.proxy || {};
    for (const [label, port] of [['httpPort', p.httpPort], ['httpsPort', p.httpsPort], ['socksPort', p.socksPort], ['pacPort', p.pacPort]]) {
      if (!port) continue;
      if (!portUsers.has(port)) portUsers.set(port, []);
      portUsers.get(port).push(`${name}.${label}`);
    }
  }
  for (const port of [...portUsers.keys()].sort((a, b) => a - b)) {
    const users = portUsers.get(port).join(', ');
    const probe = await bindProbe(port);
    if (probe.ok) {
      info('端口', `本机可绑定 ${port}`, users);
    } else {
      warn('端口', `本机已占用 ${port}（${probe.code}）`, `${users} —— 用这些配置直接启动会在该端口失败`);
    }
  }

  // H2：端口被占用时的进程行为（子进程隔离：可能触发未捕获异常）
  const scenarioPortKey = { http: 'httpPort', https: 'httpsPort', socks: 'socksPort', pac: 'pacPort' };
  for (const scenario of Object.keys(scenarioPortKey)) {
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--conflict-child', scenario], {
      encoding: 'utf8',
      timeout: 20000,
    });
    const output = `${res.stdout || ''}${res.stderr || ''}`;
    const startThrew = output.includes('CHILD_START_THREW');
    const startReturned = output.includes('CHILD_START_RETURNED');
    const survived = res.status === 0 && output.includes('CHILD_SURVIVED');
    const code = /EADDRINUSE/.test(output) ? 'EADDRINUSE' : (/EACCES/.test(output) ? 'EACCES' : '');
    const key = scenarioPortKey[scenario];
    if (survived) {
      pass('端口冲突', `${key} 被占用时进程存活`, 'start() 返回后未崩溃（监听错误被记录/处理）');
    } else if (startThrew) {
      pass('端口冲突', `${key} 被占用时 fail-fast（构造/启动期抛错）`, (output.match(/CHILD_START_THREW[^\n]*/) || [''])[0]);
    } else if (startReturned) {
      warn('端口冲突', `${key} 被占用时 start() 已返回但进程随后崩溃`, `退出码=${res.status}${code ? `，${code} 未捕获` : ''}`);
      info('端口冲突', `${key} 崩溃尾部输出`, output.trim().split('\n').slice(-2).join(' | ') || '(无输出)');
    } else {
      warn('端口冲突', `${key} 被占用时子进程未按预期退出`, `退出码=${res.status} signal=${res.signal} 末行=${output.trim().split('\n').slice(-1)[0] || '(无输出)'}`);
    }
  }

  // H3：配置的 httpPort 在 127.0.0.1 上是否真的由 ssh2proxy 服务
  // （Windows 上 WSL 端口转发（wslrelay）可能只占 127.0.0.1，而 ssh2proxy 绑定的是 ::，
  //   于是「启动日志说 listening」但 127.0.0.1 的流量仍进不到 ssh2proxy）
  const httpPorts = [...new Set(CONFIG_FILES
    .map((name) => inventory.configs[name])
    .filter(Boolean)
    .map((cfg) => cfg.json.proxy && cfg.json.proxy.httpPort)
    .filter(Boolean))];
  for (const port of httpPorts) {
    const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--http-shadow-child', String(port)], {
      encoding: 'utf8',
      timeout: 30000,
    });
    const line = `${res.stdout || ''}`.split('\n').find((l) => l.startsWith('SHADOW_RESULT '));
    if (!line) {
      warn('端口', `httpPort ${port} 遮蔽探测未返回结果`, `${res.stderr || ''}`.trim().split('\n').slice(-1)[0] || '(无输出)');
      continue;
    }
    const r = JSON.parse(line.slice('SHADOW_RESULT '.length));
    const servedV4 = /HTTP\/1\.1/.test(r.v4.data);
    const servedV6 = /HTTP\/1\.1/.test(r.v6.data);
    const busyBefore = ['data', 'end', 'timeout'].includes(r.before.note);
    if (servedV4 && servedV6) {
      pass('端口', `httpPort ${port} 在 127.0.0.1 与 ::1 上均由 ssh2proxy 服务`, `监听地址=${r.family}`);
    } else if (!servedV4 && busyBefore) {
      warn('端口', `httpPort ${port} 在 127.0.0.1 上被其他进程遮蔽`,
        `启动前 127.0.0.1:${port} 已有占用响应(${r.before.note})；启动后 127.0.0.1 仍不达 ssh2proxy，::1 ${servedV6 ? '可达' : '不可达'}；ssh2proxy 监听=${r.family}`);
    } else {
      warn('端口', `httpPort ${port} 可达性异常`, JSON.stringify(r).slice(0, 240));
    }
  }
}

/** 子进程：在指定 httpPort 上启动 ProxyServer，判断 127.0.0.1 与 ::1 各自落到谁 */
async function httpShadowChild(port) {
  const before = await rawTcpRequest('127.0.0.1', port, HTTP_PROBE_PAYLOAD);
  const cfg = mergeConfig(structuredClone(defaultConfig), {
    testingMode: true,
    proxy: {
      httpPort: port,
      socksPort: await freePort(),
      pacPort: await freePort(),
      httpsPort: 0,
      adminPort: await freePort(),
      workerPoolSize: 2,
    },
    pac: { enabled: false },
    admin: { enabled: false },
  });
  const server = new ProxyServer(cfg);
  try {
    await server.start();
    const family = JSON.stringify(server.httpServer.address());
    const v4 = await rawTcpRequest('127.0.0.1', port, HTTP_PROBE_PAYLOAD);
    const v6 = await rawTcpRequest('::1', port, HTTP_PROBE_PAYLOAD);
    console.log(`SHADOW_RESULT ${JSON.stringify({ before, family, v4, v6 })}`);
  } finally {
    await server.stop().catch(() => {});
  }
  process.exit(0);
}

/** 取一个当前空闲的端口（先绑定 0 再释放） */
async function freePort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/**
 * 子进程：先占住端口，再以该端口启动 ProxyServer，观察进程是否存活。
 * 注意 validateConfig 只接受 socksPort/httpPort > 0，故其余监听端口取真实空闲端口而非 0。
 */
async function conflictChild(scenario) {
  const portKey = { http: 'httpPort', https: 'httpsPort', socks: 'socksPort', pac: 'pacPort' }[scenario];
  const blocker = net.createServer();
  // 占位时**不指定 host**，与 ssh2proxy 的 listen(port) 同形（绑定 ::）；
  // 若只绑 127.0.0.1，:: 绑定在 Windows 上仍会成功，构造不出真实冲突。
  await new Promise((resolve) => blocker.listen(0, resolve));
  const port = blocker.address().port;

  try {
    const cfg = mergeConfig(structuredClone(defaultConfig), {
      testingMode: true,
      proxy: {
        httpPort: await freePort(),
        httpsPort: 0, // 0 = 不监听（且 validateConfig 不校验该键）
        socksPort: await freePort(),
        pacPort: await freePort(),
        adminPort: await freePort(),
        workerPoolSize: 2,
      },
      pac: { enabled: scenario === 'pac', content: 'function FindProxyForURL(url, host) { return "DIRECT"; }' },
      admin: { enabled: false },
    });
    cfg.proxy[portKey] = port;

    const server = new ProxyServer(cfg);
    await server.start();
    console.log(`CHILD_START_RETURNED scenario=${scenario} port=${port}`);
    await new Promise((resolve) => setTimeout(resolve, 700));
    console.log(`CHILD_SURVIVED scenario=${scenario}`);
    await server.stop().catch(() => {});
  } catch (err) {
    console.log(`CHILD_START_THREW scenario=${scenario} error=${err && err.message}`);
  } finally {
    blocker.close();
  }
  process.exit(0);
}

// ───────────────────────── 主流程 ─────────────────────────
async function main() {
  const childFlag = process.argv.indexOf('--conflict-child');
  if (childFlag !== -1) {
    await conflictChild(process.argv[childFlag + 1]);
    return;
  }
  const shadowFlag = process.argv.indexOf('--http-shadow-child');
  if (shadowFlag !== -1) {
    await httpShadowChild(Number(process.argv[shadowFlag + 1]));
    return;
  }

  console.log('ssh2proxy × PAC 备份数据验证');
  console.log(`PAC 目录: ${PAC_DIR}`);
  console.log(`报告输出: ${ARGS.json}`);

  const inventory = await sectionA();
  if (!inventory) {
    console.log('\n输入目录不可用，终止。');
    process.exitCode = 1;
    return;
  }
  sectionB(inventory);
  const merged = sectionC(inventory);
  await sectionD(inventory, merged);
  await sectionE(inventory, merged);
  await sectionF(inventory);
  await sectionG(inventory);
  await sectionH(inventory);

  const assertions = counts.PASS + counts.FAIL;
  const verdict = counts.FAIL === 0 ? 'PASS' : 'FAIL';
  console.log(`\n════════════════════════════════════════════════════════`);
  console.log(`断言: ${assertions}（PASS ${counts.PASS} / FAIL ${counts.FAIL}）  非断言: WARN ${counts.WARN} / INFO ${counts.INFO}`);
  console.log(`输入数据缺陷: ${counts.DEFECT}`);
  console.log(`总体判定: ${verdict}`);
  if (counts.DEFECT > 0) {
    console.log('\n数据缺陷清单:');
    for (const r of results.filter((x) => x.status === 'DEFECT')) {
      console.log(`  · [${r.area}] ${r.name} — ${r.detail}`);
    }
  }
  console.log('════════════════════════════════════════════════════════');

  const report = {
    generatedAt: new Date().toISOString(),
    node: process.version,
    pacDir: PAC_DIR,
    verdict,
    counts,
    assertions,
    results,
  };
  await fsp.mkdir(path.dirname(ARGS.json), { recursive: true });
  await fsp.writeFile(ARGS.json, JSON.stringify(report, null, 2), 'utf8');
  console.log(`报告已写入: ${ARGS.json}`);

  process.exitCode = counts.FAIL === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error('验证夹具异常终止:', err);
  process.exitCode = 1;
});
