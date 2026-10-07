#!/usr/bin/env sh
# DeepSeek Folder 一键启动（macOS / Linux）：数据服务器 + 打开浏览器
# 数据会自动保存到本目录的 deepseek-folder-data.json
cd "$(dirname "$0")"

if command -v python3 >/dev/null 2>&1; then
  PY=python3
elif command -v python >/dev/null 2>&1; then
  PY=python
else
  echo "[错误] 未找到 Python 3，请先安装。"
  exit 1
fi

echo "正在启动 DeepSeek Folder 数据服务器（端口 8000）..."
"$PY" server.py &
sleep 1

URL="http://127.0.0.1:8000/"
if command -v xdg-open >/dev/null 2>&1; then
  xdg-open "$URL" >/dev/null 2>&1
elif command -v open >/dev/null 2>&1; then
  open "$URL" >/dev/null 2>&1
else
  echo "请在浏览器打开： $URL"
fi
