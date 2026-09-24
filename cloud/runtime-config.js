/* ============================================================================
 * runtime-config.js —— 运行时配置（默认：平台模式）
 * ----------------------------------------------------------------------------
 * 本文件入库时保持「平台模式」，不会影响线上 WorkBuddy 部署。
 * 自托管部署时，由 deploy/setup-server.sh 生成一份覆盖版本，
 * 内容形如：
 *   window.__LT_CONFIG__ = {
 *     mode: 'selfhost',
 *     endpoint: 'https://chat.example.com',          // 仅用于展示/兼容，shim 不依赖
 *     publishableKey: 'lt-self-hosted',
 *     supabaseUrl: 'https://chat.example.com/sb',     // Supabase 对外地址
 *     supabaseAnonKey: 'eyJhbGciOi...',               // anon key
 *     apiBase: '',                                    // 空串 = 同源
 *     bucket: 'chat'
 *   };
 * ==========================================================================*/
window.__LT_CONFIG__ = window.__LT_CONFIG__ || { mode: 'platform' };
