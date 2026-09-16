import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile, writeFile } from 'fs/promises';
import { existsSync, mkdirSync, symlinkSync, rmSync } from 'fs';
import { execFileSync } from 'child_process';
import { tmpdir } from 'os';
import { isExternalSpecifier, graphSpecifiers, bundleSpecifiers, analyzeProductSignatures } from './check-externals.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

/** 运行产物 CLI 并返回 stdout（失败时抛出带 stdout/stderr 的错误）。 */
function runBuiltCli(args) {
  try {
    return execFileSync(process.execPath, [resolve(projectRoot, 'dist/cli.js'), ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    const stdout = error.stdout ? String(error.stdout).trim() : '';
    const stderr = error.stderr ? String(error.stderr).trim() : '';
    throw new Error(`dist/cli.js ${args.join(' ')} 运行失败（exit=${error.status ?? '?'}）stdout=[${stdout}] stderr=[${stderr}]`);
  }
}

async function buildCli() {
  await build({
    // configFile: false —— MUST。若让 Vite 载入根 vite.config.js，其 build.lib.formats
    // (['es','cjs']) 会与本文件的 formats(['es']) 合并，CLI 构建会同时产出 es 与 cjs 两份
    // 同名 cli.js，后写的 CJS 覆盖前者；在根包 "type": "module" 下 bin 入口将变成
    // 「.js 扩展名的 CJS」，npx ssh2proxy / npm start 直接崩（D-121 同类坍缩）。
    // 关掉配置合并后，本函数的 inline 配置是 CLI 构建的唯一真源。
    // 注意：external **不在**此列——它来自 scripts/check-externals.mjs（单一真源，见下）。
    configFile: false,
    root: projectRoot,
    build: {
      outDir: 'dist',
      emptyOutDir: false, // 不清空输出目录
      lib: {
        entry: resolve(__dirname, '../src/cli/cli.mjs'),
        // lib.name 仅 umd/iife 需要，本构建只有 es 格式，故不声明（避免死配置）。
        fileName: () => 'cli.js',
        formats: ['es']  // 使用ES模块格式而不是CommonJS
      },
      rollupOptions: {
        // external = 单一真源（scripts/check-externals.mjs）：覆盖 node: 前缀、子路径，
        // 并已补回被误删的 'url'（src/cli/cli.mjs 用 pathToFileURL）、剔除幽灵 'https'。
        external: isExternalSpecifier,
        output: {
          // H2-S502 修复：动态 import('../app.mjs') 会把 CLI 拆成 chunk，入口守卫
          // （`import.meta.url === pathToFileURL(argv[1])`）在 chunk 中恒 false ⇒ main() 从不调用。
          // 单文件化后守卫在 dist/cli.js 顶层执行，argv[1] 与 import.meta.url 一致，入口必然运行。
          inlineDynamicImports: true,
          assetFileNames: '[name].[ext]'
        }
      }
    },
    resolve: {
      extensions: ['.mjs', '.js']
    }
  });

  const pkg = JSON.parse(await readFile(resolve(projectRoot, 'package.json'), 'utf-8'));

  // ---- 产物守卫（bin 入口 MUST 真实可用；三类历史缺陷的机械防线）----
  const cliPath = resolve(projectRoot, 'dist/cli.js');
  let content = await readFile(cliPath, 'utf-8');

  // ① 格式守卫（D-121/D-137）：.js 产物在 type:module 下必须是 ESM
  if (/module\.exports\s*=/.test(content) || /(^|[^.\w])exports\.\w/.test(content)) {
    throw new Error('dist/cli.js 是 CJS 产物，但根包是 "type": "module"：bin 入口在发布形态下不可加载（产物格式坍缩）');
  }
  // ② 垫片守卫（H5-S503 / R3）：**功能性判据**，不是字符串扫描。
  //    实测：真实坏产物中 `__vite-browser-external` 字面量出现 0 次（vite 把未 external 的 node 内置
  //    内联成空对象 `const Z = {}`）⇒ 字符串检测恒不触发、检测力为 0。此处改为对 CLI 产物做
  //    「图内说明符 MUST 以原始形态保留」检查（与 scripts/check-externals.mjs 同源逻辑）。
  const cliGraphSpecs = graphSpecifiers(resolve(__dirname, '../src/cli/cli.mjs'));
  const cliBundleSpecs = bundleSpecifiers([cliPath]);
  const cliSignature = analyzeProductSignatures({ graphBare: cliGraphSpecs.bare, bundleBare: cliBundleSpecs.bare });
  if (cliSignature.missing.length > 0) {
    throw new Error(`dist/cli.js 缺失图内说明符（被 vite 垫片化或被打包）：${cliSignature.missing.join(', ')}`);
  }
  // ③ shebang
  if (!content.startsWith('#!/usr/bin/env node')) {
    content = '#!/usr/bin/env node\n' + content;
    await writeFile(cliPath, content);
  }
  // ④ 相对依赖存在性
  const relRefs = [...new Set([...content.matchAll(/['"]\.\/([\w.-]+\.(?:js|cjs|mjs))['"]/g)].map((m) => m[1]))];
  for (const rel of relRefs) {
    if (!existsSync(resolve(projectRoot, 'dist', rel))) {
      throw new Error('dist/cli.js 引用不存在的产物: ' + rel);
    }
  }
  // ⑤ 入口守卫真实验证（H2-S502）：不再只查静态特征，而是真的把运行起来看输出
  const versionOut = runBuiltCli(['--version']).trim();
  if (!versionOut) {
    throw new Error('node dist/cli.js --version 输出为空：入口守卫未生效（main() 未执行）');
  }
  if (versionOut !== pkg.version) {
    throw new Error(`node dist/cli.js --version 输出 ${versionOut} ≠ package.json version ${pkg.version}`);
  }
  const helpOut = runBuiltCli(['--help']);
  if (!helpOut.includes('--http-port')) {
    throw new Error('node dist/cli.js --help 未输出预期选项（--http-port），帮助文本不可用');
  }

  // ⑥ 别名路径断言（R-cr-2，与 H2-S502 同形）：经 junction/别名路径调用时入口守卫 MUST 同样成立。
  //    反例（审查门实测）：`node <别名>/dist/cli.js --version` 空输出 + exit 0 —— argv[1] 是别名路径、
  //    import.meta.url 是真实路径，未 realpath 归一时比较恒 false ⇒ main() 静默不执行。
  //    本断言把该兄弟路径纳入每次构建的机械防线（junction 用后即清，遵守 cmd /c rmdir 不带 /S）。
  const aliasRoot = resolve(tmpdir(), `d2-cli-alias-${process.pid}-${Date.now()}`);
  let aliasVersion = '';
  try {
    mkdirSync(aliasRoot, { recursive: true });
    const aliasLink = resolve(aliasRoot, 'room');
    symlinkSync(projectRoot, aliasLink, 'junction');
    aliasVersion = execFileSync(process.execPath, [resolve(aliasLink, 'dist', 'cli.js'), '--version'], {
      cwd: aliasRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    }).trim();
    if (aliasVersion !== pkg.version) {
      throw new Error(`别名路径调用 --version 输出 ${aliasVersion || '(空)'} ≠ ${pkg.version}（入口守卫对路径别名不鲁棒）`);
    }
    // 反向确认：真实路径调用在同一构建内仍成立（两侧都归一，不应有回归）
    const realVersion = runBuiltCli(['--version']).trim();
    if (realVersion !== pkg.version) {
      throw new Error(`真实路径调用 --version 输出 ${realVersion} ≠ ${pkg.version}`);
    }
  } finally {
    // junction MUST 用 rmdir（不带 /S）删除，避免顺着链接删掉真实内容
    try { execFileSync('cmd', ['/c', 'rmdir', resolve(aliasRoot, 'room')], { stdio: 'ignore' }); } catch { /* ignore */ }
    try { rmSync(aliasRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  console.log(`CLI build OK: dist/cli.js (ESM + shebang, 单文件), 相对依赖=[${relRefs.join(', ')}], --version=${versionOut}, --help 含 --http-port, 别名(junction)调用 --version=${aliasVersion}`);
}

buildCli().catch(err => {
  console.error('CLI build failed:', err);
  process.exit(1);
});
