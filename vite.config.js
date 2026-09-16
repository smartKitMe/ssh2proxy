import { defineConfig } from 'vite';

// 产物命名契约（缺陷 D-121 / D-122）：
// 1) ESM 入口 = dist/index.mjs，CJS 入口 = dist/index.cjs，二者文件名互异，不再坍缩成同名单 index.js；
// 2) 根包 "type": "module"，故 CJS 产物 MUST 用 .cjs 扩展名，否则在发布形态下 require 必抛
//    "ReferenceError: exports is not defined in ES module scope"；
// 3) MUST NOT 在 rollupOptions.output 里再写 entryFileNames/chunkFileNames：
//    它们会覆盖 lib.fileName，把 es/cjs 两种格式压成同一个名字（D-122 的根因），
//    chunk/asset 命名交回 Vite 的按格式默认值。
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
      // external 逐项判定（判据：src 非测试代码中存在 import 引用点；由
      // artifacts/check-externals.mjs 做「无幽灵 + 无遗漏」双向机械校验）：
      //   ssh2           ← src/core/ssh-tunnel.mjs:1
      //   socks          ← src/core/socks-proxy.mjs:1、src/core/socks-tunnel.mjs:1
      //   express        ← src/app.mjs:2
      //   commander      ← src/cli/cli.mjs:3
      //   cors           ← src/app.mjs:1
      //   helmet         ← src/app.mjs:3
      //   winston        ← src/middleware/logger.mjs:1
      //   worker_threads ← src/core/worker-manager.mjs:1
      //   http / https   ← src/app.mjs:4 与 src/app.mjs 内联实现（startHttpProxy / createHttpProxyServer；
      //                     同名方法，非该独立模块 —— 后者已由 C5 作为死码删除，R-3 修正）
      //   net            ← src/app.mjs:5
      //   events         ← src/core/ssh-tunnel.mjs:2、src/core/socks-tunnel.mjs:2
      //   crypto         ← src/middleware/auth.mjs:1
      //   path           ← src/cli/cli.mjs:5
      //   fs/promises    ← src/cli/cli.mjs:4、src/core/pac-service.mjs:1
      // 已删除的幽灵项（src 零引用，同 C1-07 登记的幽灵运行时依赖一类）：'fs'（源码只用
      // fs/promises）、util、os、zlib、buffer。注意 'fs' 与 'fs/promises' 是不同说明符，
      // 不可互相替代，故只删 'fs'、保留 'fs/promises'。
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
      output: {
        // 本工程 lib / CLI 两类构建都不产出 css、图片等静态资源，此配置当前**无产物消费者**
        // （惰性配置，审查门发现②），已登记 handoff/known_issues.md；保留以固定资源命名契约。
        assetFileNames: '[name].[ext]'
      }
    }
  },
  resolve: {
    extensions: ['.mjs', '.js']
  }
});
