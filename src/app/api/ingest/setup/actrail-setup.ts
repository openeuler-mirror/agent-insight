export const ACTRAIL_UNIX_SETUP_BLOCK = `# 6.65 Configure AcTrail otel-http exporter
ACTRAIL_SETUP_OK=false
if [ "$INSTALL_ACTRAIL" = "true" ]; then
    configure_actrail_export() {
        ACTRAIL_INSIGHT_KEY="\${FINAL_KEY:-\${AGENT_INSIGHT_API_KEY:-}}"
        ACTRAIL_INSIGHT_HOST="\${FINAL_HOST:-\${AGENT_INSIGHT_HOST:-}}"
        if [ -z "$ACTRAIL_INSIGHT_KEY" ]; then
            echo "⚠️  AcTrail 上报需要 API Key；配置后请重新运行 setup。"
            return 1
        fi

        ACTRAILD_BIN="\${ACTRAILD_BIN:-}"
        if [ -z "$ACTRAILD_BIN" ]; then
            ACTRAILD_BIN=$(command -v actraild 2>/dev/null || true)
        fi
        if [ -z "$ACTRAILD_BIN" ]; then
            echo "⚠️  未找到 actraild。Agent Insight 不安装 AcTrail，请先完成 AcTrail 安装后重新运行 setup。"
            return 1
        fi

        ACTRAIL_OPERATOR_CONFIG="\${ACTRAIL_OPERATOR_CONFIG:-/etc/actrail/actraild.conf}"
        if [ ! -f "$ACTRAIL_OPERATOR_CONFIG" ]; then
            echo "⚠️  未找到 AcTrail 配置：$ACTRAIL_OPERATOR_CONFIG"
            echo "   使用自定义路径时，请先设置 ACTRAIL_OPERATOR_CONFIG。"
            return 1
        fi

        ACTRAIL_OTEL_MANIFEST=""
        if [ -n "\${ACTRAIL_PLUGIN_DIR:-}" ]; then
            ACTRAIL_OTEL_MANIFEST="$ACTRAIL_PLUGIN_DIR/otel-http/otel-http.plugin.toml"
            [ -f "$ACTRAIL_OTEL_MANIFEST" ] || ACTRAIL_OTEL_MANIFEST=""
        fi
        if [ -z "$ACTRAIL_OTEL_MANIFEST" ]; then
            for candidate in \
                "$HOME/.actrail/plugins/otel-http/otel-http.plugin.toml" \
                "/usr/share/actrail/plugins/otel-http/otel-http.plugin.toml" \
                "/etc/actrail/plugins/otel-http/otel-http.plugin.toml"; do
                if [ -f "$candidate" ]; then
                    ACTRAIL_OTEL_MANIFEST="$candidate"
                    break
                fi
            done
        fi
        if [ -z "$ACTRAIL_OTEL_MANIFEST" ]; then
            echo "⚠️  未找到 AcTrail 官方 otel-http 插件。请升级或重新安装 AcTrail 后再运行 setup。"
            echo "   非默认安装目录可通过 ACTRAIL_PLUGIN_DIR 指定。"
            return 1
        fi

        case "$ACTRAIL_INSIGHT_HOST" in
            http://*|https://*) ACTRAIL_OTEL_HOST="$ACTRAIL_INSIGHT_HOST" ;;
            *) ACTRAIL_OTEL_HOST="http://$ACTRAIL_INSIGHT_HOST" ;;
        esac
        ACTRAIL_OTEL_ENDPOINT="\${ACTRAIL_OTEL_HOST%/}/api/ingest/otel/v1/traces"
        case "$ACTRAIL_OTEL_ENDPOINT" in
            http://*) ACTRAIL_ALLOW_INSECURE=true ;;
            *) ACTRAIL_ALLOW_INSECURE=false ;;
        esac

        ACTRAIL_INSIGHT_DIR="$HOME/.agent-insight/actrail"
        ACTRAIL_OTEL_CONFIG="$ACTRAIL_INSIGHT_DIR/otel-http.config.toml"
        mkdir -p "$ACTRAIL_INSIGHT_DIR"
        chmod 0700 "$ACTRAIL_INSIGHT_DIR"
        ACTRAIL_OTEL_ENDPOINT="$ACTRAIL_OTEL_ENDPOINT" \
        ACTRAIL_OTEL_API_KEY="$ACTRAIL_INSIGHT_KEY" \
        ACTRAIL_ALLOW_INSECURE="$ACTRAIL_ALLOW_INSECURE" \
        node > "$ACTRAIL_OTEL_CONFIG" <<'ACTRAIL_CONFIG_EOF'
const quote = value => JSON.stringify(value ?? '');
const lines = [
  'endpoint = ' + quote(process.env.ACTRAIL_OTEL_ENDPOINT),
  'allow_insecure = ' + process.env.ACTRAIL_ALLOW_INSECURE,
  'encoding = "protobuf"',
  'compression = "none"',
  'attribute_mode = "full"',
  'queue_capacity = 1024',
  'batch_max_spans = 64',
  'batch_timeout_ms = 1000',
  'connect_timeout_ms = 1000',
  'request_timeout_ms = 5000',
  'retry_max_attempts = 3',
  'retry_backoff_ms = 200',
  'shutdown_flush_deadline_ms = 3000',
  '',
  '[[headers]]',
  'name = "x-witty-api-key"',
  'value = ' + quote(process.env.ACTRAIL_OTEL_API_KEY),
  '',
  '[action_kinds]',
  'default = false',
  '',
  '"process.exec" = false',
  '"process.exit" = false',
  '"agent.identity" = true',
  '"agent.exit" = true',
  '"file.modify" = false',
  '"file.read" = false',
  '"file.write" = false',
  '"file.bulk_read" = false',
  '"fs.enumerate" = false',
  '"http.message" = false',
  '"llm.call" = true',
  '"llm.request" = true',
  '"llm.response" = true',
  '"llm.tool_call" = true',
  '"llm.tool_result" = true',
  '"mcp.tool_call" = true',
  '"mcp.request" = true',
  '"mcp.response" = true',
  '"mcp.stdin" = true',
  '"mcp.stdout" = true',
  '"sse.stream" = false',
  '"sse.event" = false',
  '"enforcement.decision" = false',
  '"process.fork_attempt" = false',
  '"agent.invocation" = true',
  '"command.invocation" = false',
];
process.stdout.write(lines.join('\\n') + '\\n');
ACTRAIL_CONFIG_EOF
        chmod 0600 "$ACTRAIL_OTEL_CONFIG"

        if [ "$(id -u)" -eq 0 ]; then
            ACTRAIL_PRIVILEGE=""
        elif command -v sudo >/dev/null 2>&1; then
            ACTRAIL_PRIVILEGE="sudo"
        else
            echo "⚠️  AcTrail 插件控制需要 root 权限，但当前环境没有 sudo。"
            return 1
        fi

        ACTRAIL_OPERATOR_CANDIDATE="$ACTRAIL_INSIGHT_DIR/actraild.conf.agent-insight"
        ACTRAIL_OPERATOR_BACKUP="$ACTRAIL_INSIGHT_DIR/actraild.conf.before-agent-insight"
        if ! $ACTRAIL_PRIVILEGE env ACTRAIL_OPERATOR_CONFIG="$ACTRAIL_OPERATOR_CONFIG" \
            node > "$ACTRAIL_OPERATOR_CANDIDATE" <<'ACTRAIL_OPERATOR_EOF'
const fs = require('fs');
const source = fs.readFileSync(process.env.ACTRAIL_OPERATOR_CONFIG, 'utf8');
const newline = String.fromCharCode(10);
const lines = source.replace(/\\r\\n/g, newline).split(newline);

function tableName(line) {
  const match = line.match(/^\\s*\\[([^\\[\\]]+)\\]\\s*(?:#.*)?$/);
  return match ? match[1].trim() : '';
}

function upsertTable(name, values) {
  let start = lines.findIndex(line => tableName(line) === name);
  if (start < 0) {
    if (lines.length > 0 && lines[lines.length - 1].trim()) lines.push('');
    lines.push('[' + name + ']');
    start = lines.length - 1;
  }

  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (tableName(lines[index])) {
      end = index;
      break;
    }
  }

  for (const [key, value] of Object.entries(values)) {
    const keyPattern = new RegExp('^\\\\s*' + key + '\\\\s*=');
    let existing = -1;
    for (let index = start + 1; index < end; index += 1) {
      if (keyPattern.test(lines[index])) {
        existing = index;
        break;
      }
    }
    const rendered = key + ' = ' + value;
    if (existing >= 0) {
      lines[existing] = rendered;
    } else {
      lines.splice(end, 0, rendered);
      end += 1;
    }
  }
}

upsertTable('agent_invocation', {
  enabled: 'true',
});
upsertTable('semantic_retention.l0_llm_call', {
  enabled: 'true',
  request_content: '"canonical_blocks"',
  request_body_export: '"canonical_json"',
  request_body_export_max_bytes: '131072',
  tool_calls: '"assembled_json"',
  tool_result_content_export: '"canonical_json"',
  tool_result_content_export_max_bytes: '131072',
});

while (lines.length > 1 && !lines[lines.length - 1].trim()) lines.pop();
process.stdout.write(lines.join(newline) + newline);
ACTRAIL_OPERATOR_EOF
        then
            echo "⚠️  无法生成 AcTrail 守护进程数据导出配置。"
            return 1
        fi
        chmod 0600 "$ACTRAIL_OPERATOR_CANDIDATE"

        if ! $ACTRAIL_PRIVILEGE "$ACTRAILD_BIN" --config "$ACTRAIL_OPERATOR_CANDIDATE" init >/dev/null; then
            echo "⚠️  当前 actraild 不支持 Agent Insight 所需的完整请求和工具结果导出配置，请升级 AcTrail。"
            return 1
        fi

        ACTRAIL_OPERATOR_CHANGED=false
        if ! cmp -s "$ACTRAIL_OPERATOR_CANDIDATE" "$ACTRAIL_OPERATOR_CONFIG"; then
            if ! $ACTRAIL_PRIVILEGE cp -p "$ACTRAIL_OPERATOR_CONFIG" "$ACTRAIL_OPERATOR_BACKUP"; then
                echo "⚠️  无法备份 AcTrail 守护进程配置。"
                return 1
            fi
            if ! $ACTRAIL_PRIVILEGE cp "$ACTRAIL_OPERATOR_CANDIDATE" "$ACTRAIL_OPERATOR_CONFIG"; then
                echo "⚠️  无法更新 AcTrail 守护进程配置。"
                return 1
            fi
            ACTRAIL_OPERATOR_CHANGED=true
        fi

        if [ "$ACTRAIL_OPERATOR_CHANGED" = "true" ] && \
            $ACTRAIL_PRIVILEGE "$ACTRAILD_BIN" --config "$ACTRAIL_OPERATOR_CONFIG" status >/dev/null 2>&1; then
            if ! $ACTRAIL_PRIVILEGE "$ACTRAILD_BIN" --config "$ACTRAIL_OPERATOR_CONFIG" restart >/dev/null; then
                $ACTRAIL_PRIVILEGE cp "$ACTRAIL_OPERATOR_BACKUP" "$ACTRAIL_OPERATOR_CONFIG" || true
                $ACTRAIL_PRIVILEGE "$ACTRAILD_BIN" --config "$ACTRAIL_OPERATOR_CONFIG" restart >/dev/null 2>&1 || true
                echo "⚠️  AcTrail 守护进程重新加载失败，已恢复原配置。"
                return 1
            fi
        fi

        ACTRAIL_OTEL_INSTANCE="agent-insight.otel-http"
        if $ACTRAIL_PRIVILEGE "$ACTRAILD_BIN" --config "$ACTRAIL_OPERATOR_CONFIG" plugin status --instance "$ACTRAIL_OTEL_INSTANCE" >/dev/null 2>&1; then
            if ! $ACTRAIL_PRIVILEGE "$ACTRAILD_BIN" --config "$ACTRAIL_OPERATOR_CONFIG" plugin unload --instance "$ACTRAIL_OTEL_INSTANCE" --persist >/dev/null 2>&1; then
                $ACTRAIL_PRIVILEGE "$ACTRAILD_BIN" --config "$ACTRAIL_OPERATOR_CONFIG" plugin unload --instance "$ACTRAIL_OTEL_INSTANCE" >/dev/null 2>&1 || return 1
            fi
        fi
        if ! $ACTRAIL_PRIVILEGE "$ACTRAILD_BIN" --config "$ACTRAIL_OPERATOR_CONFIG" plugin load \
            --manifest "$ACTRAIL_OTEL_MANIFEST" \
            --plugin-config "$ACTRAIL_OTEL_CONFIG" \
            --instance "$ACTRAIL_OTEL_INSTANCE" \
            --persist; then
            echo "⚠️  AcTrail otel-http 插件加载失败。请确认 actraild 正在运行且版本支持 [[headers]]。"
            return 1
        fi

        ACTRAIL_SETUP_OK=true
        echo "✅ 已完成 AcTrail 数据对接配置"
        echo "   守护进程配置：$ACTRAIL_OPERATOR_CONFIG"
        echo "   上报插件配置：$ACTRAIL_OTEL_CONFIG"
        echo "   上报地址：$ACTRAIL_OTEL_ENDPOINT"
    }

    configure_actrail_export || true
fi`;

export const ACTRAIL_WINDOWS_SETUP_BLOCK = `# 6.65 AcTrail runs on Linux/WSL
$ACTRAIL_SETUP_OK = $false
if ($INSTALL_ACTRAIL) {
    Write-Warning "AcTrail 仅支持 Linux/WSL。请在运行 AcTrail 的 WSL 终端执行 Unix curl setup，以配置 otel-http 上报。"
}`;
