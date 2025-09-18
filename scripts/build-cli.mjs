import { build } from 'vite';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

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
        formats: ['cjs']
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
}

buildCli().catch(err => {
  console.error('CLI build failed:', err);
  process.exit(1);
});