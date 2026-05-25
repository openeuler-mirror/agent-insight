#!/usr/bin/env bash
# 此脚本用于包装 skill-optimizer main.py，自动处理环境依赖与执行。
# 支持并行环境检查以加速启动过程。

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" &> /dev/null && pwd)"
OPT_DIR="$(dirname "$SCRIPT_DIR")"
VENV_DIR="$OPT_DIR/.opt"

# 并行模式标志（默认启用，可通过 --serial 禁用）
PARALLEL_MODE=true
RUN_CONNECTIVITY=true

# 解析参数
for arg in "$@"; do
    if [ "$arg" == "--serial" ]; then
        PARALLEL_MODE=false
    elif [ "$arg" == "--skip-connectivity" ]; then
        RUN_CONNECTIVITY=false
    fi
done

# 如果没有传递任何参数，提供默认帮助或行为，避免报错
# 不过原逻辑直接传 "$@" 给 main.py，这里先过滤一下
args_to_pass=()
for arg in "$@"; do
    if [ "$arg" != "--serial" ] && [ "$arg" != "--skip-connectivity" ]; then
        args_to_pass+=("$arg")
    fi
done

# 1. 检查有没有安装 uv
if ! command -v uv &> /dev/null; then
    echo "⚠️ 错误: 未找到 'uv' 命令。"
    echo "Skill Optimizer 需要 'uv' 作为高性能的 Python 环境管理器。"
    echo "请执行以下命令进行安装："
    echo "curl -LsSf https://astral.sh/uv/install.sh | sh"
    echo "安装完成后，请打开一个新终端重试。"
    exit 1
fi

cd "$OPT_DIR"

# 设置虚拟环境变量，让 uv 能识别
export VIRTUAL_ENV="$VENV_DIR"
export PATH="$VENV_DIR/bin:$PATH"

# 并行环境设置函数
run_parallel_setup() {
    echo "⏳ [并行模式] 正在初始化环境..."
    
    local deps_pid
    local config_pid
    local conn_pid=""
    local deps_status=0
    local config_status=0
    local conn_status=0
    local deps_log=$(mktemp)
    local config_log=$(mktemp)
    local conn_log=$(mktemp)
    
    # 任务1: 安装/更新依赖（后台运行）
    (
        if [ ! -d "$VENV_DIR" ]; then
            echo "  [依赖] 创建虚拟环境..." >> "$deps_log"
            uv venv "$VENV_DIR" >> "$deps_log" 2>&1
        fi
        echo "  [依赖] 安装/更新依赖包..." >> "$deps_log"
        uv pip install -r requirements.txt >> "$deps_log" 2>&1
        echo "  [依赖] ✅ 完成" >> "$deps_log"
    ) &
    deps_pid=$!
    
    # 任务2: 检测模型配置（后台运行，并行执行）
    (
        echo "  [配置] 检测模型配置..." >> "$config_log"
        uv run scripts/model_config_detector.py >> "$config_log" 2>&1 || true
        echo "  [配置] ✅ 完成" >> "$config_log"
    ) &
    config_pid=$!
    
    if [ "$RUN_CONNECTIVITY" = true ]; then
        (
            while kill -0 $config_pid 2>/dev/null; do
                sleep 0.1
            done
            echo "  [连通性] 检测模型连通性..." >> "$conn_log"
            if command -v python3 &> /dev/null; then
                python3 scripts/test_model_connectivity.py --env-file "$OPT_DIR/.env" >> "$conn_log" 2>&1
            else
                python scripts/test_model_connectivity.py --env-file "$OPT_DIR/.env" >> "$conn_log" 2>&1
            fi
            echo "  [连通性] ✅ 完成" >> "$conn_log"
        ) &
        conn_pid=$!
    fi

    # 显示进度指示器
    echo "  ⏳ 等待任务完成..."
    if [ -t 1 ]; then
        local spinner='⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏'
        local i=0
        while kill -0 $deps_pid 2>/dev/null || kill -0 $config_pid 2>/dev/null || ( [ -n "$conn_pid" ] && kill -0 $conn_pid 2>/dev/null ); do
            i=$(( (i+1) % 10 ))
            printf "\r  %s 处理中..." "${spinner:$i:1}"
            sleep 0.1
        done
        printf "\r  ✅ 所有任务完成    \n"
    else
        while kill -0 $deps_pid 2>/dev/null || kill -0 $config_pid 2>/dev/null || ( [ -n "$conn_pid" ] && kill -0 $conn_pid 2>/dev/null ); do
            sleep 0.5
        done
        echo "  ✅ 所有任务完成"
    fi
    
    # 等待任务完成并获取状态
    wait $deps_pid || deps_status=$?
    wait $config_pid || config_status=$?
    if [ -n "$conn_pid" ]; then
        wait $conn_pid || conn_status=$?
    fi
    
    # 显示任务结果
    if [ $deps_status -ne 0 ]; then
        echo "❌ [依赖] 设置失败:"
        cat "$deps_log"
    fi
    
    # 配置检测失败不阻塞（可能需要手动配置）
    if [ $config_status -ne 0 ]; then
        echo "⚠️  [配置] 自动检测未完成，可能需要手动配置"
    fi

    if [ -n "$conn_pid" ] && [ $conn_status -ne 0 ]; then
        echo ""
        echo "__CONNECTIVITY_FAILED__"
        cat "$conn_log"
    fi
    
    # 清理临时文件
    rm -f "$deps_log" "$config_log" "$conn_log"
    
    if [ $deps_status -ne 0 ]; then
        return 1
    fi
    
    if [ -n "$conn_pid" ] && [ $conn_status -ne 0 ]; then
        return 2
    fi
    
    echo "✅ 环境准备完毕！"
    return 0
}

# 串行环境设置函数（原有逻辑）
run_serial_setup() {
    if [ ! -d "$VENV_DIR" ]; then
        echo "⏳ 正在初始化隔离的 Python 虚拟环境 (.opt)..."
        uv venv "$VENV_DIR"
        echo "⏳ 正在安装底层依赖项..."
        uv pip install -r requirements.txt
        echo "✅ 环境依赖准备完毕！"
    else
        uv pip install -r requirements.txt > /dev/null 2>&1 || {
            echo "⏳ 正在更新底层依赖项..."
            uv pip install -r requirements.txt
        }
    fi

    uv run scripts/model_config_detector.py > /dev/null 2>&1 || true
    if [ "$RUN_CONNECTIVITY" = true ]; then
        local conn_output
        if command -v python3 &> /dev/null; then
            conn_output=$(python3 scripts/test_model_connectivity.py --env-file "$OPT_DIR/.env" 2>&1)
        else
            conn_output=$(python scripts/test_model_connectivity.py --env-file "$OPT_DIR/.env" 2>&1)
        fi
        local conn_exit=$?
        echo "$conn_output"
        if [ $conn_exit -ne 0 ]; then
            echo ""
            echo "__CONNECTIVITY_FAILED__"
            return 2
        fi
    fi
}

# 快速检查函数（已有虚拟环境时）
run_fast_check() {
    # 并行验证依赖和配置
    if [ "$PARALLEL_MODE" = true ]; then
        local deps_pid
        local config_pid
        local conn_pid=""
        local deps_status=0
        local config_status=0
        local conn_status=0
        
        # 后台验证依赖
        (
            uv pip install -r requirements.txt > /dev/null 2>&1
        ) &
        deps_pid=$!

        (
            uv run scripts/model_config_detector.py > /dev/null 2>&1 || true
        ) &
        config_pid=$!

        if [ "$RUN_CONNECTIVITY" = true ]; then
            (
                while kill -0 $config_pid 2>/dev/null; do
                    sleep 0.1
                done
                if command -v python3 &> /dev/null; then
                    python3 scripts/test_model_connectivity.py --env-file "$OPT_DIR/.env" > /dev/null 2>&1
                else
                    python scripts/test_model_connectivity.py --env-file "$OPT_DIR/.env" > /dev/null 2>&1
                fi
            ) &
            conn_pid=$!
        fi
        
        # 等待完成
        wait $deps_pid || deps_status=$?
        wait $config_pid || config_status=$?
        if [ -n "$conn_pid" ]; then
            wait $conn_pid || conn_status=$?
        fi
        
        if [ $deps_status -ne 0 ]; then
            echo "⏳ 正在更新依赖..."
            uv pip install -r requirements.txt
        fi

        if [ $config_status -ne 0 ]; then
            echo "⚠️  [配置] 自动检测未完成，可能需要手动配置"
        fi

        if [ -n "$conn_pid" ] && [ $conn_status -ne 0 ]; then
            echo ""
            echo "__CONNECTIVITY_FAILED__"
            return 2
        fi
    else
        uv pip install -r requirements.txt > /dev/null 2>&1 || {
            echo "⏳ 正在更新底层依赖项..."
            uv pip install -r requirements.txt
        }

        uv run scripts/model_config_detector.py > /dev/null 2>&1 || true
        if [ "$RUN_CONNECTIVITY" = true ]; then
            local conn_output
            if command -v python3 &> /dev/null; then
                conn_output=$(python3 scripts/test_model_connectivity.py --env-file "$OPT_DIR/.env" 2>&1)
            else
                conn_output=$(python scripts/test_model_connectivity.py --env-file "$OPT_DIR/.env" 2>&1)
            fi
            local conn_exit=$?
            echo "$conn_output"
            if [ $conn_exit -ne 0 ]; then
                echo ""
                echo "__CONNECTIVITY_FAILED__"
                return 2
            fi
        fi
    fi
}

# 主逻辑
setup_result=0
if [ ! -d "$VENV_DIR" ]; then
    # 首次运行
    if [ "$PARALLEL_MODE" = true ]; then
        run_parallel_setup || setup_result=$?
    else
        run_serial_setup || setup_result=$?
    fi
else
    # 已有虚拟环境，快速检查
    run_fast_check || setup_result=$?
fi

if [ $setup_result -eq 2 ]; then
    exit 2
elif [ $setup_result -ne 0 ]; then
    exit 1
fi

echo "🚀 正在启动 Skill Optimizer..."
uv run scripts/main.py "${args_to_pass[@]}"
