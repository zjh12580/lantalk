/**
 * ESLint 配置 —— 刻意保持最小。
 *
 * 项目主体是 cloud/index.html（约 4700 行单文件前端，含 <style> 与 <script>）。
 * ESLint 不能直接解析 .html，因此：
 *   · .js / .mjs        → 正常 lint
 *   · cloud/index.html  → 见 scripts/lint-html.mjs，抽出内联 <script> 后交给 ESLint
 *
 * 只开两条真正能抓到 bug 的规则：
 *   no-unused-vars  死代码（项目里确实攒了一批）
 *   no-undef        拼错变量名 / 漏声明
 * 未启用 eslint:recommended —— 等拆分成多模块后再逐步加严，避免一次性几千条噪音。
 */
module.exports = {
  root: true,
  env: {
    browser: true,
    es2022: true,
    node: true,
  },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
  // 第三方全局：这些不是拼写错误，而是外部 SDK 注入的全局量。
  // 显式声明，才能让 no-undef 保持在「一报就是真 bug」的可信度上。
  globals: {
    OneSignal: 'readonly',          // OneSignal Web Push SDK（cdn.onesignal.com），见 index.html 内联初始化
    OneSignalDeferred: 'readonly',
  },
  rules: {
    'no-unused-vars': ['warn', {
      args: 'after-used',
      argsIgnorePattern: '^_',
      caughtErrors: 'none',
      varsIgnorePattern: '^_',
    }],
    'no-undef': 'error',
    'no-constant-condition': 'off',
  },
  ignorePatterns: [
    'node_modules/',
    'cloud/assets/',
    '*.min.js',
  ],
  overrides: [
    {
      // 测试脚本里允许声明但不立刻使用的辅助函数
      files: ['cloud/test-*.js'],
      rules: {
        'no-unused-vars': 'off',
      },
    },
    {
      // 内联脚本是脚本作用域（非模块），允许顶层 return 之外的宽松写法
      files: ['**/*.inline.js'],
      parserOptions: { sourceType: 'script' },
      rules: {
        // 单文件里的内联脚本用 var 声明全局查找表，允许暂时未引用
        'no-unused-vars': 'off',
      },
    },
  ],
};
