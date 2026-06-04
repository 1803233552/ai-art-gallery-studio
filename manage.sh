#!/usr/bin/env bash
# ============================================================
#  AI 创意工坊 - 管理脚本
#  用法: chmod +x manage.sh && ./manage.sh
#  兼容: Debian/Ubuntu/CentOS/RHEL/Alpine/Arch/macOS
# ============================================================
set -euo pipefail

# ---- 防御：禁用系统 command-not-found 处理器 ----
# 某些系统（Ubuntu/Debian）的 command-not-found 是 Python 脚本
# 如果系统 Python 损坏/缺失，bash 会把 Python 代码当 shell 执行，产生大量错误
# 这里直接禁用它，改用我们自己的静默处理
unset -f command_not_found_handle 2>/dev/null || true
command_not_found_handle() { printf "命令未找到: %s\n" "$1" >&2; return 127; }

# ---- 常量 ----
APP_NAME="AI 创意工坊"
REQUIRED_PY="3.11"

# ---- 路径自适应（兼容 macOS 无 readlink -f）----
_realpath() {
    local f="$1"
    if command -v realpath &>/dev/null; then realpath "$f"
    elif command -v readlink &>/dev/null && readlink -f "$f" &>/dev/null; then readlink -f "$f"
    else cd "$(dirname "$f")" && echo "$(pwd)/$(basename "$f")"; fi
}
SCRIPT_PATH="$(_realpath "${BASH_SOURCE[0]}")"
APP_DIR="$(dirname "$SCRIPT_PATH")"
PID_FILE="$APP_DIR/.service.pid"
LOG_FILE="$APP_DIR/logs/app.log"

# ---- 颜色（自动检测终端能力）----
if [ -t 1 ] && command -v tput &>/dev/null && [ "$(tput colors 2>/dev/null || echo 0)" -ge 8 ]; then
    R=$(tput setaf 1) G=$(tput setaf 2) Y=$(tput setaf 3) B=$(tput setaf 4)
    C=$(tput setaf 6) W=$(tput setaf 7) BOLD=$(tput bold) RST=$(tput sgr0)
else
    R="" G="" Y="" B="" C="" W="" BOLD="" RST=""
fi

# ---- 日志函数 ----
info()  { printf "%s[INFO]%s  %s\n"  "${G}" "${RST}" "$*"; }
warn()  { printf "%s[WARN]%s  %s\n"  "${Y}" "${RST}" "$*"; }
err()   { printf "%s[ERR]%s   %s\n"  "${R}" "${RST}" "$*"; }
title() { printf "\n%s%s>>> %s%s\n"  "${BOLD}" "${C}" "$*" "${RST}"; }

# ---- 进程管理工具 ----
get_pid()    { [ -f "$PID_FILE" ] && cat "$PID_FILE" || echo ""; }
is_running() {
    local pid; pid=$(get_pid)
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

read_port() {
    # 从 config.yaml 的 server 段提取 port 值
    local cfg="$APP_DIR/config.yaml"
    if [ -f "$cfg" ]; then
        local p
        # 1. 用 sed 截取 server: 到下一个顶级段之间的内容
        # 2. 匹配 port: 行，先去掉 # 注释，再提取第一个数字串
        p=$(sed -n '/^server:/,/^[a-zA-Z]/{ /^\s*port:/p; }' "$cfg" 2>/dev/null \
            | head -1 | sed 's/#.*//' | grep -oE '[0-9]+' | head -1)
        [ -n "$p" ] && echo "$p" || echo "8100"
    else echo "8100"; fi
}

read_db_type() {
    # 从 config.yaml 的 database 段提取 type 值
    # 用 sed 先截取 database: 到下一个顶级段之间的内容，再提取 type
    local cfg="$APP_DIR/config.yaml"
    if [ -f "$cfg" ]; then
        local t
        t=$(sed -n '/^database:/,/^[a-zA-Z]/{ /^\s*type:/p; }' "$cfg" 2>/dev/null \
            | head -1 | sed 's/.*type:\s*//; s/["\x27 ]//g; s/#.*//' | tr '[:upper:]' '[:lower:]')
        [ -n "$t" ] && echo "$t" || echo "sqlite"
    else echo "sqlite"; fi
}

# 根据 config.yaml 构建 uv sync 的额外参数
_build_extras() {
    local db_type; db_type=$(read_db_type)
    local extras=""
    if [ "$db_type" = "mysql" ]; then
        extras="--extra mysql"
    fi
    echo "$extras"
}

# ---- PATH 扩展（覆盖常见安装位置）----
_load_uv_env() {
    # uv 安装脚本会把二进制放到 ~/.local/bin 或 ~/.cargo/bin
    # 并生成 env 文件，这里统一加载
    for envf in "$HOME/.local/bin/env" "$HOME/.cargo/env"; do
        # shellcheck disable=SC1090
        [ -f "$envf" ] && . "$envf" 2>/dev/null || true
    done
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:/usr/local/bin:$PATH"
}
_load_uv_env

# ============================================================
#  安装 uv（如果缺失）
# ============================================================
ensure_uv() {
    if command -v uv &>/dev/null; then return 0; fi
    title "安装 uv 包管理器"
    if command -v curl &>/dev/null; then
        curl -LsSf https://astral.sh/uv/install.sh | sh
    elif command -v wget &>/dev/null; then
        wget -qO- https://astral.sh/uv/install.sh | sh
    else
        err "未找到 curl 或 wget，请先安装其中之一"
        return 1
    fi
    # 重新加载环境（uv 安装器会写入 env 文件）
    _load_uv_env
    if ! command -v uv &>/dev/null; then
        err "uv 安装失败，请参考 https://docs.astral.sh/uv/getting-started/installation/"
        return 1
    fi
    info "uv $(uv --version) 安装成功"
}

# ============================================================
#  安装 / 重装环境
# ============================================================
do_install() {
    title "安装 / 重装运行环境"
    ensure_uv || return 1

    cd "$APP_DIR"

    # 读取 config.yaml 自动检测所需的可选依赖
    local extras; extras=$(_build_extras)
    local db_type; db_type=$(read_db_type)

    if [ -n "$extras" ]; then
        info "检测到 database.type=$db_type，将自动安装对应驱动"
    fi

    info "创建虚拟环境 + 安装依赖（Python >=$REQUIRED_PY，由 uv 托管）..."
    # UV_PYTHON_PREFERENCE=managed：让 uv 自动下载管理 Python，不污染系统
    # shellcheck disable=SC2086
    UV_PYTHON_PREFERENCE=managed uv sync --no-dev $extras 2>&1 | tail -5

    if [ -d "$APP_DIR/.venv" ]; then
        info "环境就绪 ✔"
        local pyver
        pyver=$("$APP_DIR/.venv/bin/python" --version 2>/dev/null || echo "unknown")
        info "  Python : $pyver"
        info "  uv     : $(uv --version)"
        info "  venv   : $APP_DIR/.venv"
        info "  数据库 : $db_type"
    else
        err "安装失败：.venv 未创建"
        return 1
    fi
}

# ============================================================
#  启动服务
# ============================================================
do_start() {
    title "启动 $APP_NAME"
    if is_running; then
        warn "服务已在运行 (PID: $(get_pid))"
        return 0
    fi

    ensure_uv || return 1

    # 环境不存在时自动安装
    if [ ! -d "$APP_DIR/.venv" ]; then
        warn ".venv 不存在，自动安装依赖..."
        do_install || { err "自动安装失败"; return 1; }
    fi

    mkdir -p "$APP_DIR/logs"
    cd "$APP_DIR"

    info "正在启动..."
    nohup env UV_PYTHON_PREFERENCE=managed uv run python -m app.main \
        >> "$LOG_FILE" 2>&1 &
    local pid=$!
    echo "$pid" > "$PID_FILE"

    # 等待进程实际启动（最多 8 秒）
    local waited=0
    while [ $waited -lt 8 ]; do
        sleep 1; waited=$((waited + 1))
        if ! kill -0 "$pid" 2>/dev/null; then
            err "进程已退出，请查看日志: $LOG_FILE"
            rm -f "$PID_FILE"
            return 1
        fi
    done

    local port; port=$(read_port)
    info "启动成功 ✔"
    info "  PID  : $pid"
    info "  端口 : $port"
    info "  日志 : $LOG_FILE"
    info "  访问 : http://0.0.0.0:${port}"
}

# ============================================================
#  停止服务
# ============================================================
do_stop() {
    title "停止 $APP_NAME"
    if ! is_running; then
        warn "服务未在运行"
        rm -f "$PID_FILE"
        return 0
    fi

    local pid; pid=$(get_pid)
    info "发送 SIGTERM → PID $pid"
    kill "$pid" 2>/dev/null || true

    # 优雅等待退出（最多 10 秒，超时 SIGKILL）
    local waited=0
    while [ $waited -lt 10 ] && kill -0 "$pid" 2>/dev/null; do
        sleep 1; waited=$((waited + 1))
    done

    if kill -0 "$pid" 2>/dev/null; then
        warn "进程未响应，强制终止..."
        kill -9 "$pid" 2>/dev/null || true
        sleep 1
    fi

    rm -f "$PID_FILE"
    info "服务已停止 ✔"
}

# ============================================================
#  重启服务
# ============================================================
do_restart() {
    title "重启 $APP_NAME"
    if is_running; then
        do_stop
        sleep 1
    fi
    do_start
}

# ============================================================
#  查看日志（实时跟踪，Ctrl+C 退出）
# ============================================================
do_logs() {
    title "查看日志（Ctrl+C 退出）"
    if [ ! -f "$LOG_FILE" ]; then
        warn "日志文件不存在: $LOG_FILE"
        return 0
    fi
    tail -100f "$LOG_FILE"
}

# ============================================================
#  状态栏
# ============================================================
show_status() {
    local status_text status_color
    if is_running; then
        local pid; pid=$(get_pid)
        status_text="运行中 (PID: $pid)"
        status_color="${G}"
    else
        status_text="未运行"
        status_color="${R}"
        # 清理残留 PID 文件
        rm -f "$PID_FILE"
    fi

    local port; port=$(read_port)

    printf "\n"
    printf "%s╔══════════════════════════════════════╗%s\n" "${BOLD}${B}" "${RST}"
    printf "%s║     ✨ AI 创意工坊 管理面板         ║%s\n" "${BOLD}${B}" "${RST}"
    printf "%s╠══════════════════════════════════════╣%s\n" "${BOLD}${B}" "${RST}"
    printf "%s║%s %-17s %s%-17s%s%s║%s\n" \
           "${BOLD}${B}" "${RST}" " 状态:" "${status_color}${BOLD}" "$status_text" "${RST}" "${BOLD}${B}" "${RST}"
    if is_running; then
    printf "%s║%s  端口: %-29s%s║%s\n" \
           "${BOLD}${B}" "${RST}" "$port" "${BOLD}${B}" "${RST}"
    fi
    printf "%s╠══════════════════════════════════════╣%s\n" "${BOLD}${B}" "${RST}"
    printf "%s║%s  1) 启动服务                       %s║%s\n" "${BOLD}${B}" "${RST}" "${BOLD}${B}" "${RST}"
    printf "%s║%s  2) 重启服务                       %s║%s\n" "${BOLD}${B}" "${RST}" "${BOLD}${B}" "${RST}"
    printf "%s║%s  3) 停止服务                       %s║%s\n" "${BOLD}${B}" "${RST}" "${BOLD}${B}" "${RST}"
    printf "%s║%s  4) 查看日志                       %s║%s\n" "${BOLD}${B}" "${RST}" "${BOLD}${B}" "${RST}"
    printf "%s║%s  9) 安装 / 重装环境                %s║%s\n" "${BOLD}${B}" "${RST}" "${BOLD}${B}" "${RST}"
    printf "%s║%s  0) 退出脚本                       %s║%s\n" "${BOLD}${B}" "${RST}" "${BOLD}${B}" "${RST}"
    printf "%s╚══════════════════════════════════════╝%s\n" "${BOLD}${B}" "${RST}"
}

# ============================================================
#  主循环
# ============================================================
main() {
    cd "$APP_DIR"

    # 支持命令行直接调用: ./manage.sh start|stop|restart|logs|install
    case "${1:-}" in
        start)   do_start;   exit $?;;
        stop)    do_stop;    exit $?;;
        restart) do_restart; exit $?;;
        logs)    do_logs;    exit $?;;
        install) do_install; exit $?;;
    esac

    # 交互式菜单
    while true; do
        show_status
        printf "\n  请输入选项: "
        read -r choice
        case "$choice" in
            1) do_start   ;;
            2) do_restart ;;
            3) do_stop    ;;
            4) do_logs    ;;
            9) do_install ;;
            0|q|Q) printf "\n"; info "再见 👋\n"; exit 0;;
            *) warn "无效选项: $choice";;
        esac
        printf "\n  按 Enter 返回菜单..."; read -r _
    done
}

main "$@"
