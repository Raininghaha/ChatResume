#!/bin/bash
cd "$(dirname "$0")" || exit 1

# GUI 启动的进程 PATH 只有 /usr/bin:/bin，node 和 claude 常常在别处
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo "❌ 没找到 node，请先安装 Node.js（建议 22+）"
  read -r -p "按回车退出…"
  exit 1
fi

if ! command -v claude >/dev/null 2>&1; then
  echo "⚠️  没找到 claude CLI，对话功能将不可用"
  echo "   确认 Claude Code 已安装并在 PATH 中"
  echo
fi

# 首次运行要 npm install 才能把 workspace 软链起来。
# 整个项目零外部依赖，所以这一步离线也能过。
if [ ! -e node_modules/@resume-chat/core ]; then
  echo "首次运行，准备依赖…"
  if ! npm install --no-audit --no-fund --prefer-offline >/dev/null 2>&1; then
    echo "❌ 依赖准备失败，请在项目目录手动执行 npm install"
    read -r -p "按回车退出…"
    exit 1
  fi
fi

PORT="${PORT:-8790}"

# 端口被占用时自动 +1（服务端也会兜一层，这里是为了知道该 open 哪个地址）
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
done

# --no-open：浏览器由下面的 open 负责，不然会弹两个标签页
PORT="$PORT" node packages/ui/server.js --no-open &
SERVER_PID=$!

cleanup() {
  kill "$SERVER_PID" 2>/dev/null
  exit 0
}
trap cleanup INT TERM

for _ in $(seq 1 40); do
  if curl -s -o /dev/null "http://localhost:$PORT/"; then break; fi
  sleep 0.15
done

open "http://localhost:$PORT"

echo
echo "resume-chat 运行中 → http://localhost:$PORT"
echo "关闭此窗口或按 Ctrl+C 结束服务"
wait "$SERVER_PID"
