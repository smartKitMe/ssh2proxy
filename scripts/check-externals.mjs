// scripts/check-externals.mjs —— external 契约的**单一真源** + **双向机械校验器**
//
// 注意：本文件 MUST NOT 带 shebang。它被 vite.config.js import，而 Vite 用自己的 esbuild
// 打包配置文件——shebang 若出现在打包后的中间位置会直接导致 `Syntax error "!"`（已实测）。
// 调用方式一律为 `node scripts/check-externals.mjs`（见 package.json 的 check-externals 脚本）。
//
// 背景（Round 02 坐实，本文件即修复该失效判据）：
//   C1 曾把 external 判据写进两份重复列表（vite.config.js / scripts/build-cli.mjs），
//   并把「校验工具」放在运行根（artifacts/check-externals.mjs）而非仓库内，导致：
//     ① 遗漏（H2-S501）：C4 后来在 src/cli/cli.mjs 加了 `import { pathToFileURL } from 'url'`，
//        而列表认为 url 是「幽灵项」被删 ⇒ CLI 构建把 url 当 node 内置垫片化 ⇒
//        `npm run build` exit=1（"pathToFileURL" is not exported by "__vite-browser-external"）。
//     ② 遗漏（H5-S503）：列表只写 'net'，而 src/utils/helpers.mjs 用的是 `node:net` ⇒
//        未命中 external ⇒ 产物内联 `const Z = {}`，SOCKS5 IPv4 CONNECT 运行时报
//        `Z.isIPv4 is not a function`（发布形态主路径 100% 不可用）。
//     ③ 幽灵（H5-S503 附）：列表含 'https'，但 src 非测试代码零 import（C5 删除 http-proxy.mjs 后）——
//        「无幽灵」方向当时并未真正执行过。
//     ④ 无单一真源：两份列表逐字重复 15 项，任意一处漂移都会静默失效。
//
// 本文件因此承担两件事：
//   A. 导出 `EXTERNAL_MODULES` / `isExternalSpecifier()` —— **唯一真源**，
//      vite.config.js 与 scripts/build-cli.mjs 都从这里引用，不再各写一份。
//   B. 作为可复跑校验器（`npm run check-externals` / `node scripts/check-externals.mjs`），
//      做**双向**断言 + **判据自检**（自检不是可选项：判据抓不出已知两类错即 FAIL）。
//
// 用法：
//   node scripts/check-externals.mjs            # 校验（需已存在 dist；无 dist 则跳过产物段并提示）
//   node scripts/check-externals.mjs --strict   # 无 dist 视为 FAIL（接入 build 时使用）
import { readdirSync, readFileSync, statSync, existsSync } from 'fs';
import { join, resolve, dirname, extname } from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
// A. 单一真源
// ---------------------------------------------------------------------------

/**
 * 需要外部化（不打包进 bundle）的说明符。
 * 判据（由本文件的校验逻辑强制）：每一项 MUST 在 `src/**`（排除 src/tests/**）中
 * 存在真实 import 引用点，否则即为「幽灵项」（如曾经的 'https'）。
 * 反向：`src/**` 非测试代码出现的每个裸说明符 MUST 被本列表覆盖，否则即为「遗漏项」
 * （如曾经的 'url' 与 'node:net'）。
 */
export const EXTERNAL_MODULES = Object.freeze([
  // 第三方运行时依赖
  'ssh2',
  'socks',
  'express',
  'commander',
  'cors',
  'helmet',
  'winston',
  // Node 内置（按去 `node:` 前缀后的名字登记；两种写法都由 isExternalSpecifier 覆盖）
  'worker_threads',
  'http',
  'net',
  'fs',
  'fs/promises',
  'events',
  'crypto',
  'path',
  'url'
]);

/** 去掉 `node:` 前缀，得到用于匹配的裸说明符。 */
export function normalizeSpecifier(id) {
  return String(id).replace(/^node:/, '');
}

/**
 * external 匹配（供 rollup `external` 选项直接使用）。
 * 覆盖三种易漏情形：
 *   1) `node:` 前缀写法（`node:net` ↔ `net`）；
 *   2) 子路径导入（`pkg/sub` 由 `pkg` 覆盖）；
 *   3) 相对/绝对路径一律不算 external（属源码内部模块）。
 */
export function isExternalSpecifier(id) {
  if (typeof id !== 'string' || id.length === 0) return false;
  if (id.startsWith('.') || id.startsWith('/') || /^[A-Za-z]:[\\/]/.test(id)) return false;
  const bare = normalizeSpecifier(id);
  return EXTERNAL_MODULES.some((m) => bare === m || bare.startsWith(m + '/'));
}

// ---------------------------------------------------------------------------
// B. 校验逻辑（纯函数，便于自检复用）
// ---------------------------------------------------------------------------

/** 粗略剥离注释，避免把注释里的引号字符串当成 import 说明符。 */
export function stripComments(code) {
  let out = '';
  let i = 0;
  let inLine = false;
  let inBlock = false;
  let quote = null;
  while (i < code.length) {
    const c = code[i];
    const n = code[i + 1];
    if (inLine) {
      if (c === '\n') { inLine = false; out += c; }
      i++;
      continue;
    }
    if (inBlock) {
      if (c === '*' && n === '/') { inBlock = false; i += 2; continue; }
      if (c === '\n') out += c;
      i++;
      continue;
    }
    if (quote) {
      out += c;
      if (c === '\\') { out += n ?? ''; i += 2; continue; }
      if (c === quote) quote = null;
      i++;
      continue;
    }
    if (c === '/' && n === '/') { inLine = true; i += 2; continue; }
    if (c === '/' && n === '*') { inBlock = true; i += 2; continue; }
    if (c === '"' || c === '\'' || c === '`') { quote = c; out += c; i++; continue; }
    out += c;
    i++;
  }
  return out;
}

// 三类导入形态分别匹配（单一正则无法同时覆盖 `import x from 'y'` 与 `import 'y'`）：
//   ① `import ... from '<spec>'` / `export ... from '<spec>'`
//   ② `import '<spec>'`（裸导入）
//   ③ `import('<spec>')` / `require('<spec>')`
const FROM_RE = /(?:^|[^\w$.])(?:import|export)\b[^'"()\n]{0,300}?\bfrom\s*['"]([^'"]+)['"]/g;
const BARE_IMPORT_RE = /(?:^|[^\w$.])import\s*['"]([^'"]+)['"]/g;
const DYNAMIC_RE = /(?:^|[^\w$.])(?:import|require)\s*\(\s*['"]([^'"]+)['"]/g;

/** 抽取一段代码里的所有模块说明符。 */
export function extractSpecifiers(code) {
  const clean = stripComments(code);
  const found = new Set();
  for (const re of [FROM_RE, BARE_IMPORT_RE, DYNAMIC_RE]) {
    for (const m of clean.matchAll(re)) found.add(m[1]);
  }
  return [...found];
}

/**
 * 被扫描的源码扩展名（R2 修复）：原先只收 `.mjs`，`src/**` 下的 `.js`/`.cjs` 会**静默漏检**
 * —— 实测在 `src/utils/probe.js` 里 `import semver from 'semver'` 时，校验器与构建双双 PASS
 * （依赖被静默打包进产物）。仓库内本就存在 `.js` 文件（`example.js`/`proxy.pac.js`/`test-socks5-pool.js`）。
 */
export const SRC_EXTENSIONS = Object.freeze(['.mjs', '.js', '.cjs']);

function walkFiles(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (name !== 'node_modules' && name !== '.git') walkFiles(p, out);
    } else if (SRC_EXTENSIONS.includes(extname(p))) {
      out.push(p);
    }
  }
  return out;
}

/** 解析相对导入（支持省略扩展名与目录 index，R2 配套：`.js` 常写成无扩展名）。 */
export function resolveRelativeImport(fromFile, spec) {
  const base = resolve(dirname(fromFile), spec);
  if (existsSync(base) && statSync(base).isFile()) return base;
  for (const ext of SRC_EXTENSIONS) {
    if (existsSync(base + ext)) return base + ext;
  }
  for (const ext of SRC_EXTENSIONS) {
    const idx = join(base, `index${ext}`);
    if (existsSync(idx)) return idx;
  }
  return base;
}

/**
 * 双向分析（纯函数）。
 * @param {{files: Array<{path: string, code: string}>, externalModules: readonly string[]}} input
 * @returns {{bare: string[], missing: string[], ghosts: string[], references: Record<string,string[]>}}
 */
export function analyzeSpecifiers({ files, externalModules }) {
  const bare = new Set();
  const references = {};
  for (const f of files) {
    for (const spec of extractSpecifiers(f.code)) {
      if (spec.startsWith('.') || spec.startsWith('/') || /^[A-Za-z]:[\\/]/.test(spec)) continue;
      const norm = normalizeSpecifier(spec);
      bare.add(norm);
      (references[norm] ||= []).push(f.path);
    }
  }
  // ① 无遗漏：每个裸说明符都被 external 覆盖
  const missing = [...bare].filter((b) => !externalModules.some((m) => b === m || b.startsWith(m + '/'))).sort();
  // ② 无幽灵：每个 external 项都有引用点
  const ghosts = externalModules.filter((m) => ![...bare].some((b) => b === m || b.startsWith(m + '/'))).sort();
  return { bare: [...bare].sort(), missing, ghosts, references };
}

/** 收集 src 非测试代码（排除 src/tests/**）。 */
export function collectSrcFiles(srcDir) {
  const testsPrefix = join(srcDir, 'tests');
  return walkFiles(srcDir)
    .filter((p) => !p.startsWith(testsPrefix))
    .map((p) => ({ path: p.replace(/\\/g, '/'), code: readFileSync(p, 'utf8') }));
}

/**
 * R3（判据盲区，最严重）：**字符串检测已废弃、不再作为判据**。
 * 原实现扫产物里是否出现 `__vite-browser-external`。sdet 实测：真实坏产物中该字面量出现 **0 次** ——
 * vite 在 build 期把未 external 的 node 内置**内联成空对象**（`const Z = {}`），不留标记字符串。
 * 因此该守卫**恒不触发、检测力为 0**（"守卫存在但等于没有"比缺守卫更危险：给出虚假安全感）。
 * 取而代之的**功能性判据**是 `analyzeProductSignatures`：图内说明符 MUST 以**原始形态**保留在产物中。
 * 实测：前态坏产物 → FAIL（`lib 产物缺失图内说明符：node:net`）；后态 → PASS。
 * 本函数仅保留"检测力取证"用途（打印命中数供前后对照）。
 */
export function legacyShimStringScan(distDir) {
  const hits = [];
  if (!existsSync(distDir)) return hits;
  for (const name of readdirSync(distDir)) {
    if (!['.js', '.mjs', '.cjs'].includes(extname(name))) continue;
    const code = readFileSync(join(distDir, name), 'utf8');
    if (code.includes('__vite-browser-external')) hits.push(name);
  }
  return hits;
}

// --- 产物级判据（抓 H5-S503：说明符**原始形态**未被 external ⇒ 被 vite 垫片化） -------------
//
// 关键：比对 MUST 使用说明符的**原始形态**（保留 `node:` 前缀）。历史教训是——
// external 列表只写 'net' 时，`import net from 'node:net'` 未命中；若按去前缀后比对，
// 产物里残留的另一处 `from "net"` 会让判据误判为「已覆盖」，正是原判据两头失准的原因之一。
// 实测坏产物 `dist/index.mjs`：归一化后 13/13 齐全，但缺 `node:net`，对应 `const Z = {}` 垫片。

/** 从入口出发做相对导入 BFS，返回可达文件与其中出现的**原始**裸说明符。 */
export function graphSpecifiers(entryFile) {
  const seen = new Set();
  const bare = new Set();
  const queue = [resolve(entryFile)];
  while (queue.length > 0) {
    const f = resolve(queue.pop());
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    for (const spec of extractSpecifiers(readFileSync(f, 'utf8'))) {
      if (spec.startsWith('.')) queue.push(resolveRelativeImport(f, spec));
      else if (!spec.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(spec)) bare.add(spec);
    }
  }
  return { files: [...seen].sort(), bare: [...bare].sort() };
}

/** 读一组产物文件，收集其中的裸说明符（原始形态）与它们跟随的相对引用文件。 */
export function bundleSpecifiers(files) {
  const seen = new Set();
  const bare = new Set();
  const queue = [...files].map((f) => resolve(f));
  while (queue.length > 0) {
    const f = resolve(queue.pop());
    if (seen.has(f) || !existsSync(f)) continue;
    seen.add(f);
    const code = readFileSync(f, 'utf8');
    for (const spec of extractSpecifiers(code)) {
      if (spec.startsWith('.')) queue.push(resolveRelativeImport(f, spec));
      else bare.add(spec);
    }
  }
  return { files: [...seen].sort(), bare: [...bare].sort() };
}

/**
 * 纯函数：图内说明符是否都在产物中以**原始形态**保留。
 * 严格比对（不做 `node:` 归一化宽容）——历史判据正是在此处过宽而漏掉 `node:net`。
 * @returns {{missing: string[], graphBare: string[], bundleBare: string[]}}
 */
export function analyzeProductSignatures({ graphBare, bundleBare }) {
  const missing = graphBare.filter((s) => !bundleBare.includes(s));
  return { missing: missing.sort(), graphBare: [...graphBare].sort(), bundleBare: [...bundleBare].sort() };
}

// ---------------------------------------------------------------------------
// C. 判据自检（MUST 通过；判据抓不出已知两类错即视为判据失效）
// ---------------------------------------------------------------------------

export function selfTest() {
  const cases = [];
  const run = (files, externalModules) => analyzeSpecifiers({ files, externalModules });

  // 反例 1（幽灵）：external 里有 src 从不引用的项 → MUST 被抓出
  {
    const r = run([{ path: 'a.mjs', code: 'import x from \'real-pkg\';' }], ['real-pkg', 'bogus-pkg']);
    cases.push({ name: '抓出幽灵项 bogus-pkg', ok: r.ghosts.length === 1 && r.ghosts[0] === 'bogus-pkg', got: JSON.stringify(r.ghosts) });
  }
  // 反例 2（遗漏）：src 用 node: 前缀而列表只写裸名 → MUST 被认定覆盖（H5-S503 的正解）
  {
    const r = run([{ path: 'a.mjs', code: 'import net from \'node:net\';' }], ['net']);
    cases.push({ name: 'node:net 被 net 覆盖（无遗漏、无幽灵）', ok: r.missing.length === 0 && r.ghosts.length === 0, got: `missing=${JSON.stringify(r.missing)} ghosts=${JSON.stringify(r.ghosts)}` });
  }
  // 反例 3（遗漏）：src 引用未列入的裸说明符 → MUST 被抓出（H2-S501 的正解）
  {
    const r = run([{ path: 'a.mjs', code: 'import { pathToFileURL } from \'url\';' }], ['path']);
    cases.push({ name: '抓出遗漏项 url', ok: r.missing.length === 1 && r.missing[0] === 'url', got: JSON.stringify(r.missing) });
  }
  // 反例 4（噪音）：相对路径与注释里的假说明符 MUST 不参与判定
  {
    const code = 'import \'./local.mjs\';\n// import \'fake-from-comment\';\n/* import \'also-fake\'; */\nimport real from \'real-pkg\';';
    const r = run([{ path: 'a.mjs', code }], ['real-pkg']);
    cases.push({ name: '相对路径/注释不参与判定', ok: r.missing.length === 0 && r.ghosts.length === 0 && r.bare.length === 1, got: `bare=${JSON.stringify(r.bare)} missing=${JSON.stringify(r.missing)} ghosts=${JSON.stringify(r.ghosts)}` });
  }
  // 反例 5（子路径）：pkg/sub 由 pkg 覆盖
  {
    const r = run([{ path: 'a.mjs', code: 'import x from \'pkg/sub\';' }], ['pkg']);
    cases.push({ name: '子路径 pkg/sub 由 pkg 覆盖', ok: r.missing.length === 0 && r.ghosts.length === 0, got: `missing=${JSON.stringify(r.missing)} ghosts=${JSON.stringify(r.ghosts)}` });
  }
  // 反例 6（匹配函数）：node: 前缀、相对路径、子路径的 external 判定
  {
    const ok = isExternalSpecifier('node:net') && isExternalSpecifier('net') && isExternalSpecifier('fs/promises')
      && isExternalSpecifier('node:fs/promises') && !isExternalSpecifier('./x.mjs') && !isExternalSpecifier('not-listed');
    cases.push({ name: 'isExternalSpecifier 覆盖 node:/子路径/相对路径', ok, got: String(ok) });
  }
  // 反例 7（产物垫片，H5-S503 的真实形态）：图内是 node:net，产物被垫片后另一处 net 仍在 ⇒ MUST 判缺失
  {
    const r = analyzeProductSignatures({ graphBare: ['node:net', 'http'], bundleBare: ['net', 'http'] });
    cases.push({ name: '产物判据抓出 node:net 未 external（被垫片化）', ok: r.missing.length === 1 && r.missing[0] === 'node:net', got: JSON.stringify(r.missing) });
  }
  // 反例 8（正例）：产物保留原始形态 ⇒ 判通过
  {
    const r = analyzeProductSignatures({ graphBare: ['node:net', 'http'], bundleBare: ['node:net', 'http'] });
    cases.push({ name: '产物判据对保留 node: 前缀的产物判通过', ok: r.missing.length === 0, got: JSON.stringify(r.missing) });
  }
  // 反例 9（R2 扫描面）：`.js`/`.cjs` MUST 在扫描扩展名内（原先只收 .mjs ⇒ .js 静默漏检）
  {
    const ok = SRC_EXTENSIONS.includes('.mjs') && SRC_EXTENSIONS.includes('.js') && SRC_EXTENSIONS.includes('.cjs');
    cases.push({ name: '扫描面覆盖 .mjs/.js/.cjs（R2）', ok, got: JSON.stringify(SRC_EXTENSIONS) });
  }
  // 反例 10（R3 检测力）：真实坏产物是内联空对象形态，**不含** `__vite-browser-external` 字面量
  // ⇒ 证明"扫字符串"式守卫对该形态恒不触发（检测力 0），必须用功能性判据
  {
    const realBadBundleSample = 'const Z = {};\nfunction isIPv4(h){ return Z.isIPv4(h); }\nexport const x = 1;';
    const stringJudgeWouldFire = realBadBundleSample.includes('__vite-browser-external');
    const functionalJudgeFires = analyzeProductSignatures({ graphBare: ['node:net'], bundleBare: ['net'] }).missing.length === 1;
    cases.push({
      name: '字符串守卫对真实坏产物不触发、功能判据触发（R3）',
      ok: stringJudgeWouldFire === false && functionalJudgeFires === true,
      got: `stringJudgeWouldFire=${stringJudgeWouldFire} functionalJudgeFires=${functionalJudgeFires}`
    });
  }
  return cases;
}

// ---------------------------------------------------------------------------
// D. CLI 入口
// ---------------------------------------------------------------------------

function main() {
  const strict = process.argv.includes('--strict');
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const srcDir = join(root, 'src');
  const distDir = join(root, 'dist');
  const problems = [];

  // 自检计数 MUST 动态统计（R-cr-1 教训：曾把条数写死且与实际用例数不符 ⇒ 虚假声称，
  // 且该不实数字扩散到 evidence 与多份文档。此处改为从 selfCases 计算，永不再漂移）。
  const selfCases = selfTest();
  const selfPassed = selfCases.filter((c) => c.ok).length;
  console.log(`=== 判据自检（self-test，共 ${selfCases.length} 条）===`);
  for (const c of selfCases) {
    console.log(`  ${c.ok ? 'OK  ' : 'FAIL'} ${c.name}${c.ok ? '' : ' -> ' + c.got}`);
    if (!c.ok) problems.push(`self-test 失败：${c.name}（${c.got}）`);
  }
  if (selfPassed !== selfCases.length) {
    console.log('SELF_TEST_FAILED：判据本身不可信，后续结论一律无效');
    console.log('verdict=FAIL');
    process.exit(1);
  }

  console.log('=== 双向校验（src 非测试代码 ↔ EXTERNAL_MODULES）===');
  const files = collectSrcFiles(srcDir);
  const { bare, missing, ghosts, references } = analyzeSpecifiers({ files, externalModules: EXTERNAL_MODULES });
  console.log(`  扫描 src 非测试文件 ${files.length} 个；裸说明符 ${bare.length} 个：${bare.join(', ')}`);
  for (const m of EXTERNAL_MODULES) {
    const refs = references[m] || [];
    const subRefs = Object.entries(references).filter(([k]) => k.startsWith(m + '/')).flatMap(([, v]) => v);
    const all = [...new Set([...refs, ...subRefs])].map((p) => p.replace(root.replace(/\\/g, '/') + '/', ''));
    console.log(`  [external] ${m} <- 引用点 ${all.length} 处${all.length ? '：' + all.join('、') : '（无！）'}`);
  }
  if (missing.length > 0) problems.push(`遗漏项（src 引用但未 external，会触发 vite browser 垫片或打包）：${missing.join(', ')}`);
  if (ghosts.length > 0) problems.push(`幽灵项（列入 external 但 src 非测试代码零引用）：${ghosts.join(', ')}`);

  console.log('=== 产物校验（dist）===');
  if (!existsSync(distDir)) {
    const msg = 'dist 不存在，产物段未执行（请先 npm run build）';
    if (strict) problems.push(msg); else console.log('  SKIP ' + msg);
  } else {
    // (0) dist 卫生（R-cr-4）：发布前 dist 只应含预期产物。
    //     背景：package.json 的 files:["dist/"] 会把 dist 下**任何**文件打进 tarball，而
    //     `prepublishOnly` 只在 `npm publish` 触发（`npm pack` 不触发），故残留文件可静默入包
    //     （蓝队曾指出 dist/RESTORED-BY-R02-S5.txt 会被打包）。此断言即该风险的机械防线。
    const EXPECTED_DIST_FILES = ['index.mjs', 'index.cjs', 'cli.js'];
    const unexpected = readdirSync(distDir).filter((n) => !EXPECTED_DIST_FILES.includes(n));
    if (unexpected.length > 0) {
      problems.push(`dist 含预期外文件（会被 files:["dist/"] 打进 npm 包）：${unexpected.join(', ')}`);
    } else {
      console.log(`  dist 卫生：仅含预期产物 ${EXPECTED_DIST_FILES.join(', ')}`);
    }

    // 说明（R3）：旧字符串检测检测力为 0 —— 仅作前后对照打印，**不作判据**；
    // 真正抓垫片化的判据是下方 (b)「图内说明符 MUST 以原始形态保留」。
    const legacyHits = legacyShimStringScan(distDir);
    console.log(`  [对照] 旧字符串检测（__vite-browser-external 字面量）命中 ${legacyHits.length} 个文件（已实测检测力为 0，不作判据）`);
    if (legacyHits.length > 0) console.log(`        命中文件：${legacyHits.join(', ')}`);

    // (a) 产物不得引入未声明的裸说明符 —— MUST 覆盖**两个 bundle**。
    //     R-cr-3 教训：只查 indexBundle 时，向 dist/cli.js 注入未声明依赖（如 lodash-stray）
    //     仍会 PASS；覆盖面对齐「无遗漏」方向（lib 图 + CLI 图都查）。
    const indexBundle = bundleSpecifiers([join(distDir, 'index.mjs'), join(distDir, 'index.cjs')]);
    const cliBundlePath = join(distDir, 'cli.js');
    const cliBundle = existsSync(cliBundlePath) ? bundleSpecifiers([cliBundlePath]) : null;
    const undeclaredIndex = indexBundle.bare.filter((s) => !isExternalSpecifier(s));
    if (undeclaredIndex.length > 0) problems.push(`产物出现未在 external 列表中的裸说明符（index bundle）：${undeclaredIndex.join(', ')}`);
    const undeclaredCli = cliBundle ? cliBundle.bare.filter((s) => !isExternalSpecifier(s)) : [];
    if (undeclaredCli.length > 0) problems.push(`产物出现未在 external 列表中的裸说明符（CLI bundle）：${undeclaredCli.join(', ')}`);

    // (b) 图内说明符 MUST 以原始形态保留（H5-S503 的机械抓取点）
    const libGraph = graphSpecifiers(join(srcDir, 'index.mjs'));
    const libCheck = analyzeProductSignatures({ graphBare: libGraph.bare, bundleBare: indexBundle.bare });
    console.log(`  lib 图（src/index.mjs 可达 ${libGraph.files.length} 文件）裸说明符 ${libGraph.bare.length} 个：${libGraph.bare.join(', ')}`);
    console.log(`  产物（index.mjs + index.cjs）保留裸说明符 ${indexBundle.bare.length} 个：${indexBundle.bare.join(', ')}`);
    if (libCheck.missing.length > 0) problems.push(`lib 产物缺失图内说明符（被垫片化或被打包）：${libCheck.missing.join(', ')}`);
    if (cliBundle) {
      const cliGraph = graphSpecifiers(join(srcDir, 'cli', 'cli.mjs'));
      const cliCheck = analyzeProductSignatures({ graphBare: cliGraph.bare, bundleBare: cliBundle.bare });
      console.log(`  CLI 图裸说明符 ${cliGraph.bare.length} 个；产物（cli.js + 其相对依赖 ${cliBundle.files.length} 文件）保留 ${cliBundle.bare.length} 个`);
      if (cliCheck.missing.length > 0) problems.push(`CLI 产物缺失图内说明符：${cliCheck.missing.join(', ')}`);
    } else if (strict) {
      problems.push('dist/cli.js 不存在（CLI 构建产物缺失）');
    }
  }

  if (problems.length > 0) {
    console.log('FAIL:');
    for (const p of problems) console.log('  - ' + p);
    console.log('verdict=FAIL');
    process.exit(1);
  }
  console.log(`EXTERNALS_OK 双向校验通过：${EXTERNAL_MODULES.length} 项 external 均有引用点、${bare.length} 个裸说明符均已被覆盖；判据自检 ${selfPassed}/${selfCases.length} 通过`);
  console.log('verdict=PASS');
  process.exit(0);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) main();
