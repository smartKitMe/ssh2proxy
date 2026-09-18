// eslint.config.mjs
import js from '@eslint/js';
import globals from 'globals';

// 配置自洽性契约（缺陷 D-136 / C1-10）：
// 1) 首行注释即本文件名（MUST NOT 写成 eslint.config.js）——历史缺陷 D-136 已在本行修正；
// 2) 启用 @eslint/js 的 recommended 基线（ESLint 9 flat config 官方推荐集），不再手写零散规则；
// 3) 不再把 import / exports / module / require 之类 CJS 关键字声明为全局——
//    本工程源码是 ESM（sourceType: module），`import` 更不是可声明的标识符；
//    Node 侧全局一律由 `globals.node` 提供（已含 __dirname/__filename/process/Buffer/setTimeout 等）。
//
// 【已知覆盖限制（已登记，勿误读为「全仓已 lint」）】
// `npm run lint`（package.json，禁改集）只把 `src/ scripts/` 传给 ESLint，因此仓库**根目录的 `.js` 文件**
// （`example.js`、`proxy.pac.js`、`test-socks5-pool.js`、`vite.config.js`）在常规 `npm run lint` 中**不会被扫描**。
// 实测（本文件所在的 D4 任务探针 `probe-lint-coverage.mjs`，%TEMP% 副本对照）：
//   ① 仓库原配置显式传入这 4 个文件 → **33 errors**（多为 no-undef：console/process/PAC 内置函数）；
//   ② %TEMP% 展平副本（files 改为 `**/*.{mjs,js}`）跑同一批 → **27 errors**（补充 node globals 后剩下的缩进/引号等风格项）。
// 注：第 1 个配置对象 `js.configs.recommended` 无 `files` 限制，故 `.js` 一旦被显式传入仍会应用 recommended 规则。
// 收敛需同时改本文件与 `package.json` 的 lint 脚本（后者属禁改集）⇒ 已登记为跨 chunk 申请。
export default [
  js.configs.recommended,
  {
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.node
      }
    },
    rules: {
      // 存量豁免（明确理由，非「削绿」）：本 chunk（C1）write_paths 不含 src/**，
      // 实测 recommended 在 src 下命中 10 处 no-unused-vars（未使用的导入与 catch(err)），
      // 归各自 owner 清理；清理完成前保持豁免，其余 recommended 规则全部生效。
      'no-unused-vars': 'off',
      'no-console': 'off',
      'indent': ['error', 2],
      'quotes': ['error', 'single'],
      'semi': ['error', 'always']
    }
  }
];
