#!/usr/bin/env sh
# 浅浅 qianqian · 一键启动（macOS / Linux）
# 用法： ./start-qianqian.sh          默认 3000 端口
#        ./start-qianqian.sh 3200     指定端口
#        ./start-qianqian.sh --setup-only   只初始化，不启动
set -e
cd "$(dirname "$0")"

PORT=3000
SETUP_ONLY=0
case "${1:-}" in
  --setup-only) SETUP_ONLY=1 ;;
  "") ;;
  *) PORT="$1" ;;
esac

echo
echo "  =========================================="
echo "    浅浅 qianqian  ·  一键启动"
echo "  =========================================="
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  [x] 没有检测到 Node.js，请先安装 Node.js 22 或更高版本：https://nodejs.org/"
  exit 1
fi
echo "  [OK] Node.js $(node -v)"

if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo "  [!] 已从模板生成 .env.local，请填写 DATABASE_URL 后重新运行本脚本。"
  [ "${QIANQIAN_NO_AUTO_OPEN:-0}" = "1" ] || "${EDITOR:-vi}" .env.local
fi

if [ ! -d node_modules ]; then
  echo "  [..] 首次运行，正在安装依赖，大约 1 分钟..."
  npm install --no-audit --no-fund
fi
echo "  [OK] 依赖就绪"

echo "  [..] 正在初始化数据库（自动建库 / 建表 / 建账号）..."
npm run setup

if [ "$SETUP_ONLY" = "1" ]; then
  echo "  [OK] 初始化完成。要启动应用，请再运行一次本脚本。"
  exit 0
fi

echo "  [..] 正在启动：http://localhost:$PORT   （按 Ctrl+C 停止）"
echo
npm run dev -- --port "$PORT"
