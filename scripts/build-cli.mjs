import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function buildCli() {
  await build({
    // configFile: false —— MUST。若让 Vite 载入根 vite.config.js，其 build.lib.formats
    // (['es','cjs']) 会与本文件的 formats(['es']) 合并，CLI 构建会同时产出 es 与 cjs 两份
    // 同名 cli.js，后写的 CJS 覆盖前者；在根包 "type": "module" 下 bin 入口将变成
    // 「.js 扩展名的 CJS」，npx ssh2proxy / npm start 直接崩（D-121 同类坍缩）。
    // 关掉配置合并后，本函数的 inline 配置是 CLI 构建的唯一真源。
    configFile: false,
    root: resolve(__dirname, '..'),
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
        // external 逐项判定同 vite.config.js（判据：src 非测试代码的 import 引用点；
        // 由 artifacts/check-externals.mjs 双向机械校验）。CLI 依赖图（src/cli/cli.mjs）
        // 实际用到：commander / path / fs/promises + 经 ../app.mjs 引入的 express、cors、
        // helmet、winston、ssh2、socks、net、http、https、events、crypto、worker_threads。
        // 已删除的幽灵项（src 零引用）：C1-07 登记的幽灵运行时依赖、url（仅 build 脚本自身
        // 与测试使用）、'fs'（源码只用 fs/promises）、util、os、zlib、buffer。
        external: [
          'ssh2', 
          'socks', 
          'express', 
          'worker_threads',
          'http',
          'https',
          'net',
          'fs/promises',
          'events',
          'crypto',
          'path',
          'commander',
          'cors',
          'helmet',
          'winston'
        ],
        // 不再在 output 里写 entryFileNames/chunkFileNames：它们会覆盖 lib.fileName，
        // 造成「声明名 ≠ 实际名」的第二处真源；chunk 命名交回 Vite 默认。
        output: {
          assetFileNames: '[name].[ext]'
        }
      }
    },
    resolve: {
      extensions: ['.mjs', '.js']
    }
  });
  
  // 产物守卫：bin 入口 MUST 真实可加载（D-137 / D-121 的机械防线）
  const cliPath = resolve(__dirname, '../dist/cli.js');
  let content = await readFile(cliPath, 'utf-8');
  if (/module\.exports\s*=/.test(content) || /(^|[^.\w])exports\.\w/.test(content)) {
    throw new Error('dist/cli.js 是 CJS 产物，但根包是 "type": "module"：bin 入口在发布形态下不可加载（产物格式坍缩）');
  }
  if (!content.startsWith('#!/usr/bin/env node')) {
    content = '#!/usr/bin/env node\n' + content;
    await writeFile(cliPath, content);
  }
  const relRefs = [...new Set([...content.matchAll(/['"]\.\/([\w.-]+\.(?:js|cjs|mjs))['"]/g)].map(m => m[1]))];
  for (const rel of relRefs) {
    if (!existsSync(resolve(__dirname, '../dist', rel))) {
      throw new Error('dist/cli.js 引用不存在的产物: ' + rel);
    }
  }
  console.log('CLI build OK: dist/cli.js (ESM + shebang), 相对依赖=[' + relRefs.join(', ') + ']');
}

buildCli().catch(err => {
  console.error('CLI build failed:', err);
  process.exit(1);
});