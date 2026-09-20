#!/usr/bin/env bash
# LanTalk 启动脚本（Linux / macOS）
# 用法:
#   ./start.sh          前台运行（Ctrl+C 停止）
#   ./start.sh -d       后台运行，日志写入 lantalk.log
#   PORT=8080 ./start.sh 指定端口
set -e
cd "$(dirname "$0")"
PORT="${PORT:-3000}"

if ! command -v node >/dev/null 2>&1; then
  echo "错误：未检测到 Node.js"
  echo "请先安装 Node.js 16+，例如："
  echo "  Ubuntu/Debian:  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt install -y nodejs"
  echo "  CentOS/RHEL:    curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash - && sudo yum install -y nodejs"
  echo "  或直接用系统源： sudo apt install -y nodejs npm"
  exit 1
fi

NODE_MAJOR=$(node -v | sed 's/^v//' | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 16 ]; then
  echo "错误：Node.js 版本过低（当前 $(node -v)），需要 16 及以上"
  exit 1
fi

mkdir -p data
echo "启动端口: $PORT"

if [ "$1" = "-d" ]; then
  if [ -f lantalk.pid ] && kill -0 "$(cat lantalk.pid)" 2>/dev/null; then
    echo "LanTalk 已在运行（PID $(cat lantalk.pid)），如需重启请先执行 ./stop.sh"
    exit 0
  fi
  nohup node server.js > lantalk.log 2>&1 &
  echo $! > lantalk.pid
  sleep 1
  echo "已在后台启动，PID $(cat lantalk.pid)，日志：lantalk.log"
  grep -E "http://" lantalk.log || true
else
  exec node server.js
fi
