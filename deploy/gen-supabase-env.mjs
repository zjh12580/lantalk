#!/usr/bin/env node
/* ============================================================================
 * gen-supabase-env.mjs —— 为自托管 Supabase 生成 .env（含正确的 JWT 密钥）
 * ----------------------------------------------------------------------------
 * 为什么要脚本：Supabase 的 ANON_KEY / SERVICE_ROLE_KEY 不是随机串，
 * 而是**用 JWT_SECRET 签出来的 JWT**，手抄极易搞错；POSTGRES_PASSWORD、
 * VAULT_ENC_KEY 等也需要强随机值。
 *
 * 用法：
 *   node gen-supabase-env.mjs --domain chat.example.com --dir /opt/supabase
 *
 * 行为：
 *   1. 若 --dir/.env 已存在 → 直接退出（不覆盖，保护已有密钥）
 *   2. 从 --dir/.env.example 复制为底（若不存在则用内置精简模板）
 *   3. 覆盖关键键：密码 / JWT_SECRET / ANON_KEY / SERVICE_ROLE_KEY /
 *      SITE_URL / API_EXTERNAL_URL / SUPABASE_PUBLIC_URL / SMTP 等
 *   4. 打印生成的 ANON_KEY（供 cloud/runtime-config.js 使用）
 * ==========================================================================*/
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const DOMAIN = arg('domain', '');
const DIR = arg('dir', '/opt/supabase');
const SMTP_HOST = arg('smtp-host', '');
const SMTP_PORT = arg('smtp-port', '587');
const SMTP_USER = arg('smtp-user', '');
const SMTP_PASS = arg('smtp-pass', '');
const SMTP_FROM = arg('smtp-from', SMTP_USER || 'noreply@' + DOMAIN);
if (!DOMAIN) {
  console.error('缺少 --domain，例如 --domain chat.example.com');
  process.exit(1);
}

const envPath = path.join(DIR, '.env');
if (fs.existsSync(envPath)) {
  console.log('[gen-env] ' + envPath + ' 已存在，跳过（不覆盖既有密钥）');
  process.exit(0);
}

const rnd = (n = 32) => crypto.randomBytes(n).toString('base64url').replace(/[^A-Za-z0-9]/g, '').slice(0, n);

function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function signJwt(payload, secret) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const data = header + '.' + body;
  const sig = crypto.createHmac('sha256', secret).update(data).digest();
  return data + '.' + b64url(sig);
}

const JWT_SECRET = rnd(48);
const ANON_KEY = signJwt(
  { role: 'anon', iss: 'supabase', iat: 1700000000, exp: 2000000000 },
  JWT_SECRET,
);
const SERVICE_ROLE_KEY = signJwt(
  { role: 'service_role', iss: 'supabase', iat: 1700000000, exp: 2000000000 },
  JWT_SECRET,
);

const PUBLIC_URL = 'https://' + DOMAIN + '/sb';

// 关键键 → 值。值里有空格/特殊字符的已按需加引号（Supabase .env 支持引号）。
const OVERRIDES = {
  // --- 面板与站点 ---
  DASHBOARD_USERNAME: 'lantalk',
  DASHBOARD_PASSWORD: rnd(24),
  SITE_URL: 'https://' + DOMAIN,
  ADDITIONAL_REDIRECT_URLS: 'https://' + DOMAIN + '/**,http://localhost:3000/**',
  SUPABASE_PUBLIC_URL: PUBLIC_URL,
  API_EXTERNAL_URL: PUBLIC_URL,

  // --- 数据库 ---
  POSTGRES_PASSWORD: rnd(32),
  POSTGRES_HOST: 'db',
  POSTGRES_DB: 'postgres',

  // --- 鉴权 ---
  JWT_SECRET,
  JWT_EXPIRY: '3600',
  ANON_KEY,
  SERVICE_ROLE_KEY,
  SECRET_KEY_BASE: rnd(48),
  VAULT_ENC_KEY: rnd(32),
  PG_META_CRYPTO_KEY: rnd(32),

  // --- 注册与邮箱 ---
  // 放开注册；邮箱验证码走 GoTrue，默认模板里要包含 {{ .Token }}
  DISABLE_SIGNUP: 'false',
  ENABLE_EMAIL_SIGNUP: 'true',
  // true = 无需点邮件确认即可登录（我们走 OTP 验证码，不依赖确认链接）
  ENABLE_EMAIL_AUTOCONFIRM: 'true',
  ENABLE_PHONE_SIGNUP: 'false',
  ENABLE_ANONYMOUS_USERS: 'false',
  MAILER_AUTOCONFIRM: 'true',
  MAILER_OTP_EXP: '3600',
  MAILER_OTP_LENGTH: '6',
  GOTRUE_MAILER_OTP_LENGTH: '6',

  // --- 反代端口：Supabase 全家桶只在 127.0.0.1 上开，对外由 Caddy 统一入口 ---
  KONG_HTTP_PORT: '8000',
  KONG_HTTPS_PORT: '8443',

  // --- 发信（登录验证码）---
  // 不传 --smtp-host 时保持 .env.example 的默认（本地 inbucket 捕获器），
  // 邮件不会外发，可在 http://<IP>:9000 查看 —— 仅够联调，正式用必须配真实 SMTP。
  SMTP_ADMIN_EMAIL: SMTP_FROM,
  SMTP_SENDER_NAME: "Let's Talk",
  ...(SMTP_HOST
    ? {
        SMTP_HOST,
        SMTP_PORT,
        SMTP_USER,
        SMTP_PASS: '"' + SMTP_PASS + '"',   // 密码含特殊字符，加引号防解析截断
        SMTP_PROTOCOL: 'smtp',
      }
    : {}),

  // --- 存储 ---
  STORAGE_BACKEND: 'file',
  FILE_SIZE_LIMIT: '52428800',

  // --- 关闭自托管环境里用不到的组件（省内存，小服务器友好）---
  FUNCTIONS_VERIFY_JWT: 'false',
};

const EXAMPLE = path.join(DIR, '.env.example');
let lines = [];
if (fs.existsSync(EXAMPLE)) {
  lines = fs.readFileSync(EXAMPLE, 'utf8').split('\n');
} else {
  console.log('[gen-env] 未找到 .env.example，使用内置精简模板');
  lines = Object.keys(OVERRIDES).map((k) => k + '=');
}

const seen = new Set();
const out = lines.map((line) => {
  const m = /^([A-Z0-9_]+)=/.exec(line);
  if (!m) return line;
  const k = m[1];
  if (!(k in OVERRIDES)) return line;
  seen.add(k);
  return k + '=' + OVERRIDES[k];
});
// .env.example 里没有、但我们需要的键，追加到末尾
const missing = Object.keys(OVERRIDES).filter((k) => !seen.has(k));
if (missing.length) {
  out.push('', '### 由 gen-supabase-env.mjs 追加');
  missing.forEach((k) => out.push(k + '=' + OVERRIDES[k]));
}

fs.writeFileSync(envPath, out.join('\n'), 'utf8');
fs.chmodSync(envPath, 0o600);

console.log('[gen-env] 已写入 ' + envPath + '（权限 600）');
console.log('[gen-env] SUPABASE_PUBLIC_URL = ' + PUBLIC_URL);
console.log('[gen-env] ANON_KEY = ' + ANON_KEY);
console.log('');
console.log('—— 下一步：把下面这段写进 cloud/runtime-config.js ——');
console.log('window.__LT_CONFIG__ = {');
console.log("  mode: 'selfhost',");
console.log("  endpoint: 'https://" + DOMAIN + "',");
console.log("  publishableKey: 'lt-self-hosted',");
console.log("  supabaseUrl: '" + PUBLIC_URL + "',");
console.log("  supabaseAnonKey: '" + ANON_KEY + "',");
console.log("  apiBase: '',");
console.log("  bucket: 'chat',");
console.log('};');
