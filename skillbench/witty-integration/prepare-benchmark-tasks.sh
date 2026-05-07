#!/bin/bash
# =============================================================================
# Benchmark Task Preparation Script
# Copies selected tasks from the catalog (tasks/) into tasks_init/ and then
# integrates witty/opencode into each task under tasks_init/.
# =============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
TASKS_CATALOG_DIR="$REPO_ROOT/tasks"
TASKS_DIR="$REPO_ROOT/tasks_init"
CONFIG_FILE="$SCRIPT_DIR/benchmark_tasks.yaml"
CLEAN_TASKS_DIR=false
ADD_TASK_NUMBER=true

WITTY_SETUP="$SCRIPT_DIR/opencode-integration.sh"
WITTY_ENV="$SCRIPT_DIR/.env"
DOCKERFILE_TEMPLATE="$SCRIPT_DIR/Dockerfile.template"

usage() {
    cat <<EOF
Usage: $(basename "$0") [--clean] [config-file]

Options:
  --clean           Remove existing contents of skillbench/tasks before copying.
  --no-task-number  Do not append task number to skill directory names.
  -h, --help        Show this help message.

Arguments:
  config-file   Optional path to benchmark_tasks.yaml.
EOF
}

validate_file() {
    local path="$1"
    if [ ! -f "$path" ]; then
        echo "ERROR: $path not found"
        exit 1
    fi
}

validate_dir() {
    local path="$1"
    if [ ! -d "$path" ]; then
        echo "ERROR: $path not found"
        exit 1
    fi
}

while [ "$#" -gt 0 ]; do
    case "$1" in
        --clean)
            CLEAN_TASKS_DIR=true
            shift
            ;;
        --no-task-number)
            ADD_TASK_NUMBER=false
            shift
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        -*)
            echo "ERROR: Unknown option: $1"
            usage
            exit 1
            ;;
        *)
            CONFIG_FILE="$1"
            shift
            ;;
    esac
done

validate_file "$CONFIG_FILE"
validate_file "$WITTY_SETUP"
validate_file "$WITTY_ENV"
validate_file "$DOCKERFILE_TEMPLATE"
validate_dir "$TASKS_CATALOG_DIR"

mkdir -p "$TASKS_DIR"

if [ "$CLEAN_TASKS_DIR" = true ]; then
    echo "Cleaning destination tasks directory: $TASKS_DIR"
    find "$TASKS_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
    echo ""
fi

echo "Selecting benchmark tasks from config..."
echo "Config file: $CONFIG_FILE"
echo "Source tasks directory: $TASKS_CATALOG_DIR"
echo "Destination tasks directory: $TASKS_DIR"
echo ""

TASK_INDEX_FILE="$REPO_ROOT/tasks/tasks_index.json"
validate_file "$TASK_INDEX_FILE"

get_task_number() {
    local name="$1"
    python3 -c "import json; d=json.load(open('$TASK_INDEX_FILE')); print(d.get('$name', ''))"
}

COPIED_COUNT=0

while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in
        *"source:"*)
            source_path="${line#*source:}"
            source_path="$(echo "$source_path" | sed 's/^[[:space:]]*//; s/[[:space:]]*$//')"
            source_path="${source_path#skillbench/}"

            src_dir="$REPO_ROOT/$source_path"
            task_name="$(basename "$src_dir")"
            dst_dir="$TASKS_DIR/$task_name"

            if [ ! -d "$src_dir" ]; then
                echo "SKIP: $source_path - source task directory not found"
                continue
            fi

            rm -rf "$dst_dir"
            cp -a "$src_dir" "$dst_dir"
            COPIED_COUNT=$((COPIED_COUNT + 1))
            echo "[$task_name] Copied from $source_path"

            TASK_NUM=$(get_task_number "$task_name")
            if [ "$ADD_TASK_NUMBER" = true ] && [ -n "$TASK_NUM" ] && [ -d "$dst_dir/environment/skills" ]; then
                for skill_dir in "$dst_dir/environment/skills"/*/; do
                    [ -d "$skill_dir" ] || continue
                    skill_name="$(basename "$skill_dir")"
                    new_skill_name="${skill_name}-${TASK_NUM}"
                    parent_dir="$(dirname "$skill_dir")"

                    mv "$skill_dir" "$parent_dir/$new_skill_name"

                    skill_md="$parent_dir/$new_skill_name/SKILL.md"
                    if [ -f "$skill_md" ]; then
                        sed -i "s/^name: $skill_name$/name: $new_skill_name/" "$skill_md"
                        sed -i "s|/skills/$skill_name|/skills/$new_skill_name|g" "$skill_md"
                    fi

                    echo "  Renamed skill: $skill_name -> $new_skill_name"
                done
            fi
            ;;
    esac
done < "$CONFIG_FILE"

echo ""
echo "Copied $COPIED_COUNT task(s) into $TASKS_DIR"
echo ""
echo "Integrating witty into tasks..."
echo ""

INTEGRATED_COUNT=0

for task_dir in "$TASKS_DIR"/*/; do
    [ -d "$task_dir" ] || continue
    env_dir="$task_dir/environment"

    if [ ! -d "$env_dir" ]; then
        echo "SKIP: $(basename "$task_dir") - no environment/ directory"
        continue
    fi

    task_name="$(basename "$task_dir")"
    INTEGRATED_COUNT=$((INTEGRATED_COUNT + 1))

    cp "$WITTY_SETUP" "$env_dir/witty-setup.sh"
    chmod +x "$env_dir/witty-setup.sh"
    echo "[$task_name] Copied witty-setup.sh"

    task_env="$env_dir/.env"
    touch "$task_env"

    while IFS= read -r env_line || [ -n "$env_line" ]; do
        [[ -z "$env_line" || "$env_line" =~ ^# ]] && continue

        var_name="$(echo "$env_line" | cut -d'=' -f1)"
        if grep -q "^${var_name}=" "$task_env" 2>/dev/null; then
            sed -i "s|^${var_name}=.*|${env_line}|" "$task_env"
        else
            echo "$env_line" >> "$task_env"
        fi
    done < "$WITTY_ENV"
    echo "[$task_name] Merged .env"

    dockerfile="$env_dir/Dockerfile"
    if [ -f "$dockerfile" ]; then
        if grep -q '^RUN /root/witty-setup.sh' "$dockerfile"; then
            echo "[$task_name] Dockerfile already has witty integration, skipping append"
        else
            # Guarantee a separator before the appended block so we don't glue
            # onto a Dockerfile that lacks a trailing newline.
            printf '\n' >> "$dockerfile"
            grep -v '^#' "$DOCKERFILE_TEMPLATE" | grep -v '^$' >> "$dockerfile"
            echo "[$task_name] Appended Dockerfile template"
        fi
    else
        echo "[$task_name] WARNING: No Dockerfile found, skipping"
    fi

    echo ""
done

echo "========================================="
echo "Done! Copied $COPIED_COUNT task(s) and integrated witty into $INTEGRATED_COUNT task(s)."
echo "========================================="
