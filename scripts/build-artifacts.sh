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
has_rebuild=0
has_help=0
for arg in "$@"; do
  case "$arg" in
    --target | --target=*)
      has_target=1
      ;;
    --help | -h)
      has_target=1
      has_help=1
      ;;
    --rebuild)
      has_rebuild=1
      ;;
  esac
done

if [ "$has_help" -eq 1 ]; then
  printf '%s\n' '用法：sh scripts/build-artifacts.sh [--target current|all|win|mac|linux] [--dry-run] [--rebuild]'
  printf '%s\n' '说明：默认执行完整重建（等同追加 --rebuild），避免复用过期 out/ 编译输出。'
  printf '%s\n' '如需增量打包，请直接执行：node config/scripts/build-artifacts.mjs [--target current|all|win|mac|linux] [--dry-run]'
  printf '%s\n' '安全边界：只执行本地构建，不发布、不打 tag、不 push。'
  exit 0
fi

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

# Why: stale out/ output can silently package old source; the public wrapper
# should favor a fresh build unless the lower-level script is invoked directly.
if [ "$has_rebuild" -eq 0 ] && [ "$has_help" -eq 0 ]; then
  set -- "$@" --rebuild
fi

exec node config/scripts/build-artifacts.mjs "$@"
