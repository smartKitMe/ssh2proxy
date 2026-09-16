import { defineConfig } from 'vite';
import { isExternalSpecifier } from './scripts/check-externals.mjs';

// 产物命名契约（缺陷 D-121 / D-122）：
// 1) ESM 入口 = dist/index.mjs，CJS 入口 = dist/index.cjs，二者文件名互异，不再坍缩成同名单 index.js；
// 2) 根包 "type": "module"，故 CJS 产物 MUST 用 .cjs 扩展名，否则在发布形态下 require 必抛
//    "ReferenceError: exports is not defined in ES module scope"；
// 3) MUST NOT 在 rollupOptions.output 里再写 entryFileNames/chunkFileNames：
//    它们会覆盖 lib.fileName，把 es/cjs 两种格式压成同一个名字（D-122 的根因），
//    chunk/asset 命名交回 Vite 的按格式默认值。
//
// external 契约（H5-S503 / H6-S508 修复）：**单一真源**。
// 名单与匹配函数只定义在 scripts/check-externals.mjs，本文件与 scripts/build-cli.mjs 都从这里引用；
// 原先两份逐字重复的 15 项列表（已实际漂移：url 被误删、https 成幽灵、net 不覆盖 node:net）不再存在。
// 匹配函数负责：`node:` 前缀归一、子路径（pkg/sub）、相对路径排除。
export default defineConfig({
  build: {
    outDir: 'dist',
    lib: {
      entry: 'src/index.mjs',
      // lib.name 仅在 umd/iife 格式下被 Vite 使用；本工程 formats 只有 es/cjs，
      // 声明它属「看似生效实则无效」的死配置（D-121 附带观察），故不声明。
      fileName: (format) => (format === 'es' ? 'index.mjs' : 'index.cjs'),
      formats: ['es', 'cjs']
    },
    rollupOptions: {
      external: isExternalSpecifier,
      output: {
        // 本工程 lib / CLI 两类构建都不产出 css、图片等静态资源，此配置当前**无产物消费者**
        // （惰性配置），保留以固定资源命名契约。
        assetFileNames: '[name].[ext]'
      }
    }
  },
  resolve: {
    extensions: ['.mjs', '.js']
  }
});
