#!/usr/bin/env bash
# 停止后台运行的 LanTalk
cd "$(dirname "$0")"
if [ -f lantalk.pid ]; then
  PID=$(cat lantalk.pid)
  if kill -0 "$PID" 2>/dev/null; then
    kill "$PID" && echo "已停止 LanTalk（PID $PID）"
  else
    echo "进程 $PID 不存在，清理 pid 文件"
  fi
  rm -f lantalk.pid
else
  echo "未找到 lantalk.pid，尝试按进程名停止"
  pkill -f "node server.js" && echo "已停止" || echo "没有运行中的 LanTalk"
fi
