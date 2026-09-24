#!/usr/bin/env bash
# ============================================================================
# setup-server.sh —— 云聊自托管一键部署（Debian / Ubuntu）
# ----------------------------------------------------------------------------
# 在一台**干净的** Linux 服务器上执行，它会：
#   1. 安装 Docker、Node 22、Caddy、git、postgresql-client
#   2. 拉取本项目代码到 /opt/lantalk
#   3. 部署自托管 Supabase（官方 docker compose）到 /opt/supabase/docker
#   4. 生成密钥、启动数据库、导入业务表结构（schema.sql + bootstrap.sql）
#   5. 生成 cloud/runtime-config.js（让前端切到自托管）
#   6. 注册 systemd 服务（跑 cloud/server.js）+ Caddy 反代 + 自动 HTTPS
#
# 用法（把 chat.example.com 换成你的域名，必须已解析到本机公网 IP）：
#   sudo DOMAIN=chat.example.com bash deploy/setup-server.sh
#
# 可重复执行：已存在的密钥 / 目录 / 服务都不会被覆盖。
# ============================================================================
set -euo pipefail

DOMAIN="${DOMAIN:-}"
REPO="${REPO:-https://github.com/zjh12580/lantalk.git}"
BRANCH="${BRANCH:-main}"
# 可选：配置真实 SMTP，否则登录验证码只进本地捕获器（不真发邮件）
SMTP_HOST="${SMTP_HOST:-}"
SMTP_PORT="${SMTP_PORT:-587}"
SMTP_USER="${SMTP_USER:-}"
SMTP_PASS="${SMTP_PASS:-}"
SMTP_FROM="${SMTP_FROM:-}"
APP_DIR=/opt/lantalk
SB_DIR=/opt/supabase
SB_COMPOSE="$SB_DIR/docker"
NODE_BIN=/usr/bin/node

log()  { printf '\033[1;36m[setup]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[setup]\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m[setup]\033[0m %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "请用 root 执行：sudo DOMAIN=... bash deploy/setup-server.sh"
[ -n "$DOMAIN" ] || die "缺少域名。用法：sudo DOMAIN=chat.example.com bash deploy/setup-server.sh"

if   command -v apt-get >/dev/null; then PKG=apt
elif command -v dnf     >/dev/null; then PKG=dnf
else die "仅支持 Debian/Ubuntu（apt）或 RHEL 系（dnf）"
fi

# ---------------------------------------------------------------------------
# 1. 系统依赖
# ---------------------------------------------------------------------------
log "安装系统依赖…"
if [ "$PKG" = apt ]; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg git openssl debian-keyring debian-archive-keyring apt-transport-https >/dev/null
else
  dnf install -y -q ca-certificates curl gnupg2 git openssl >/dev/null
fi

# Docker
if ! command -v docker >/dev/null; then
  log "安装 Docker…"
  curl -fsSL https://get.docker.com | sh >/dev/null
fi
systemctl enable --now docker >/dev/null 2>&1 || true

# Node 22
if ! "$NODE_BIN" -v >/dev/null 2>&1 || [ "$("$NODE_BIN" -v | cut -d. -f1 | tr -d v)" -lt 18 ]; then
  log "安装 Node 22…"
  if [ "$PKG" = apt ]; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | bash - >/dev/null
    apt-get install -y -qq nodejs >/dev/null
  else
    curl -fsSL https://rpm.nodesource.com/setup_22.x | bash - >/dev/null
    dnf install -y -q nodejs >/dev/null
  fi
fi

# Caddy
if ! command -v caddy >/dev/null; then
  log "安装 Caddy…"
  if [ "$PKG" = apt ]; then
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
      | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
    curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
      > /etc/apt/sources.list.d/caddy-stable.list
    apt-get update -qq && apt-get install -y -qq caddy >/dev/null
  else
    dnf install -y -q 'dnf-command(copr)' >/dev/null && dnf copr enable -y @caddy/caddy >/dev/null && dnf install -y -q caddy >/dev/null
  fi
fi

# ---------------------------------------------------------------------------
# 2. 服务账号 + 拉代码
# ---------------------------------------------------------------------------
log "准备目录与账号…"
id -u lantalk >/dev/null 2>&1 || useradd -r -m -d /home/lantalk -s /usr/sbin/nologin lantalk

if [ -d "$APP_DIR/.git" ]; then
  log "更新代码（$APP_DIR）…"
  git -C "$APP_DIR" fetch --all -q && git -C "$APP_DIR" reset --hard "origin/$BRANCH" -q
elif [ -d "$APP_DIR/deploy" ]; then
  log "检测到已上传的代码（$APP_DIR），跳过 git 拉取"
else
  log "克隆代码到 $APP_DIR …"
  git clone -q --branch "$BRANCH" "$REPO" "$APP_DIR" \
    || die "拉取代码失败。若是私有仓库，请改用手动上传（见 MIGRATE-SELFHOST.md 的「方式 A」）"
fi
[ -f "$APP_DIR/deploy/setup-server.sh" ] || die "$APP_DIR 下没有项目代码，请先上传（见 MIGRATE-SELFHOST.md）"
chown -R lantalk:lantalk "$APP_DIR"

# ---------------------------------------------------------------------------
# 3. 自托管 Supabase
# ---------------------------------------------------------------------------
log "获取 Supabase 官方 docker 编排…"
if [ ! -d "$SB_DIR/.git" ]; then
  git clone -q --depth 1 --filter=blob:none --sparse https://github.com/supabase/supabase.git "$SB_DIR"
  git -C "$SB_DIR" sparse-checkout set docker >/dev/null
fi
[ -f "$SB_COMPOSE/docker-compose.yml" ] || die "未找到 $SB_COMPOSE/docker-compose.yml"

log "生成 Supabase 密钥与配置…"
GEN_ARGS=(--domain "$DOMAIN" --dir "$SB_COMPOSE")
if [ -n "$SMTP_HOST" ]; then
  GEN_ARGS+=(--smtp-host "$SMTP_HOST" --smtp-port "$SMTP_PORT" --smtp-user "$SMTP_USER" --smtp-pass "$SMTP_PASS")
  [ -n "$SMTP_FROM" ] && GEN_ARGS+=(--smtp-from "$SMTP_FROM")
fi
node "$APP_DIR/deploy/gen-supabase-env.mjs" "${GEN_ARGS[@]}" > /tmp/gen-env.out
cat /tmp/gen-env.out

# ⚠️ 必须注入自定义邮件模板：GoTrue 内置模板只有「点链接登录」，没有 6 位数字验证码，
#    而前端登录框要填验证码 —— 不改模板用户直接就登不进去。
log "安装邮件模板与编排增强…"
mkdir -p "$SB_COMPOSE/templates"
cp "$APP_DIR/deploy/templates/"*.html "$SB_COMPOSE/templates/"
cp "$APP_DIR/deploy/docker-compose.override.yml" "$SB_COMPOSE/docker-compose.override.yml"

if [ -z "$SMTP_HOST" ]; then
  warn "未配置 SMTP：登录验证码不会真发邮件，只进本地捕获器。"
  warn "  联调查看：http://$DOMAIN:9000 （或 ssh 隧道到本机 9000 端口）"
  warn "  正式使用请配真实 SMTP，重跑本脚本并带上 SMTP_HOST / SMTP_USER / SMTP_PASS。"
fi

# 调整 Kong 只监听本机（对外统一由 Caddy 入口）
ENVF="$SB_COMPOSE/.env"
grep -q '^KONG_HTTP_PORT=8000' "$ENVF" || sed -i 's/^KONG_HTTP_PORT=.*/KONG_HTTP_PORT=8000/' "$ENVF"

log "启动 Supabase（首次拉镜像约 3-8 分钟）…"
(cd "$SB_COMPOSE" && docker compose pull -q && docker compose up -d)

log "等待数据库就绪…"
for i in $(seq 1 90); do
  if (cd "$SB_COMPOSE" && docker compose exec -T db pg_isready -U postgres >/dev/null 2>&1); then break; fi
  [ "$i" = 90 ] && die "数据库 90 次探测仍未就绪，查看：cd $SB_COMPOSE && docker compose logs db"
  sleep 3
done

# ---------------------------------------------------------------------------
# 4. 导入表结构
# ---------------------------------------------------------------------------
log "导入业务表结构…"
dc() { (cd "$SB_COMPOSE" && docker compose exec -T db psql -U postgres -d postgres -v ON_ERROR_STOP=1 "$@"); }
dc -f - < "$APP_DIR/cloud/schema.sql"
dc -f - < "$APP_DIR/deploy/bootstrap.sql"

# ---------------------------------------------------------------------------
# 5. 生成前端运行时配置（切到自托管）
# ---------------------------------------------------------------------------
ANON_KEY=$(grep -m1 '^ANON_KEY=' "$ENVF" | cut -d= -f2-)
log "写入 cloud/runtime-config.js …"
cat > "$APP_DIR/cloud/runtime-config.js" <<EOF
/* 由 deploy/setup-server.sh 生成于 $(date -Iseconds) —— 自托管模式 */
window.__LT_CONFIG__ = {
  mode: 'selfhost',
  endpoint: 'https://$DOMAIN',
  publishableKey: 'lt-self-hosted',
  supabaseUrl: 'https://$DOMAIN/sb',
  supabaseAnonKey: '$ANON_KEY',
  apiBase: '',
  bucket: 'chat',
};
EOF
chown lantalk:lantalk "$APP_DIR/cloud/runtime-config.js"

# ---------------------------------------------------------------------------
# 6. 应用服务 + 反代
# ---------------------------------------------------------------------------
if [ ! -f "$APP_DIR/cloud/.llm.json" ]; then
  warn "⚠️  未发现 cloud/.llm.json（大模型密钥，不入 Git）—— 小美将无法工作！"
  warn "    请上传：scp cloud/.llm.json root@$DOMAIN:$APP_DIR/cloud/  然后 systemctl restart lantalk"
fi
[ -f "$APP_DIR/cloud/.llm.json.example" ] && [ ! -f "$APP_DIR/cloud/.llm.json" ] \
  && cp "$APP_DIR/cloud/.llm.json.example" "$APP_DIR/cloud/.llm.json" \
  && chown lantalk:lantalk "$APP_DIR/cloud/.llm.json" \
  && warn "已放置 .llm.json 模板，记得填入真实 api_key 再重启服务"

log "注册 systemd 服务…"
cp "$APP_DIR/deploy/lantalk.service" /etc/systemd/system/lantalk.service
systemctl daemon-reload
systemctl enable --now lantalk
sleep 2
systemctl is-active --quiet lantalk || die "应用启动失败：journalctl -u lantalk -n 50 --no-pager"

log "配置 Caddy 反代…"
sed "s/chat\.example\.com/$DOMAIN/g" "$APP_DIR/deploy/Caddyfile" > /etc/caddy/Caddyfile
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy 2>/dev/null || true
systemctl enable --now caddy >/dev/null 2>&1 || true
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# 防火墙放行（若启用 ufw / firewalld）
command -v ufw >/dev/null && ufw allow 80,443/tcp >/dev/null 2>&1 || true
command -v firewall-cmd >/dev/null && firewall-cmd --permanent --add-service=http --add-service=https >/dev/null 2>&1 && firewall-cmd --reload >/dev/null 2>&1 || true

# ---------------------------------------------------------------------------
# 7. 自检
# ---------------------------------------------------------------------------
log "自检…"
sleep 3
APP_CODE=$(curl -s -o /dev/null -w '%{http_code}' -H 'Host: '"$DOMAIN" http://127.0.0.1:3000/ || echo 000)
SB_CODE=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8000/rest/v1/ || echo 000)
CHAT_JSON=$(curl -s -H 'Host: '"$DOMAIN" http://127.0.0.1:3000/api/chat || echo '{}')

cat <<EOF

============================================================================
✅ 部署完成
----------------------------------------------------------------------------
  站点地址      https://$DOMAIN
  应用自检      HTTP $APP_CODE      （200 = 正常）
  Supabase 自检 HTTP $SB_CODE      （401/200 = 网关活着）
  小美通道      $CHAT_JSON

  常用命令
    应用日志    journalctl -u lantalk -f
    重启应用    systemctl restart lantalk
    Supabase    cd $SB_COMPOSE && docker compose ps / logs -f
    更新代码    cd $APP_DIR && git pull && systemctl restart lantalk

  ⚠️ 如果 https 打不开：确认域名已解析到本机公网 IP、安全组放行 80/443，
     并查看 Caddy 是否签发成功：journalctl -u caddy -n 50 --no-pager
============================================================================
EOF
