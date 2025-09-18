import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    outDir: 'dist',
    lib: {
      entry: 'src/index.mjs',
      name: 'ssh2proxy',
      fileName: (format) => `index.${format}.js`,
      formats: ['es', 'cjs']
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
        'dotenv'
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