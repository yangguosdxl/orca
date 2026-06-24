#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd "$(dirname "$0")" && pwd -P)
REPO_ROOT=$(CDPATH= cd "$SCRIPT_DIR/.." && pwd -P)

cd "$REPO_ROOT"

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '[构建] 失败：未找到 node，请先安装项目要求的 Node.js 版本。' >&2
  exit 1
fi

has_target=0
for arg in "$@"; do
  case "$arg" in
    --target | --target=* | --help | -h)
      has_target=1
      ;;
  esac
done

if [ "$has_target" -eq 0 ]; then
  printf '%s\n' '请选择构建目标：'
  printf '%s\n' '1) 当前平台包（默认）'
  printf '%s\n' '2) 所有平台包'
  printf '%s' '请输入选项 [1]: '
  IFS= read -r choice || choice=''
  choice=$(printf '%s' "$choice" | tr -d '\r')

  case "$choice" in
    '' | 1)
      set -- "$@" --target current
      ;;
    2)
      set -- "$@" --target all
      ;;
    *)
      printf '[构建] 失败：无效选项：%s\n' "$choice" >&2
      exit 1
      ;;
  esac
fi

exec node config/scripts/build-artifacts.mjs "$@"
