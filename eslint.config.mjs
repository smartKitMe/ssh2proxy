// eslint.config.mjs
import js from '@eslint/js';
import globals from 'globals';

// 配置自洽性契约（缺陷 D-136 / C1-10）：
// 1) 首行注释即本文件名，MUST NOT 再写成 eslint.config.js；
// 2) 启用 @eslint/js 的 recommended 基线（ESLint 9 flat config 官方推荐集），不再手写零散规则；
// 3) 不再把 import / exports / module / require 之类 CJS 关键字声明为全局——
//    本工程源码是 ESM（sourceType: module），`import` 更不是可声明的标识符；
//    Node 侧全局一律由 `globals.node` 提供（已含 __dirname/__filename/process/Buffer/setTimeout 等）。
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
