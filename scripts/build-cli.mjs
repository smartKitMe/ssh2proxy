import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFile, writeFile } from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function buildCli() {
  await build({
    build: {
      outDir: 'dist',
      emptyOutDir: false, // 不清空输出目录
      lib: {
        entry: resolve(__dirname, '../src/cli/cli.mjs'),
        name: 'ssh2proxy-cli',
        fileName: () => 'cli.js',
        formats: ['es']  // 使用ES模块格式而不是CommonJS
      },
      rollupOptions: {
        external: [
          'ssh2', 
          'socks', 
          'express', 
          'worker_threads',
          'http',
          'https',
          'net',
          'fs',
          'fs/promises',
          'events',
          'crypto',
          'util',
          'os',
          'path',
          'zlib',
          'buffer',
          'commander',
          'cors',
          'helmet',
          'winston',
          'dotenv',
          'url'
        ],
        output: {
          entryFileNames: '[name].js',
          chunkFileNames: '[name].js',
          assetFileNames: '[name].[ext]'
        }
      }
    },
    resolve: {
      extensions: ['.mjs', '.js']
    }
  });
  
  // 在生成的文件开头添加shebang行
  const cliPath = resolve(__dirname, '../dist/cli.js');
  const content = await readFile(cliPath, 'utf-8');
  if (!content.startsWith('#!/usr/bin/env node')) {
    await writeFile(cliPath, '#!/usr/bin/env node\n' + content);
  }
}

buildCli().catch(err => {
  console.error('CLI build failed:', err);
  process.exit(1);
});