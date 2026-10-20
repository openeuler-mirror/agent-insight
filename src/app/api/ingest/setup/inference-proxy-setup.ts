export const INFERENCE_PROXY_UNIX_SETUP_BLOCK = `# Stage the optional inference runtime without enrolling model endpoints.
if [ "$INSTALL_OPENCODE" = "true" ] || [ "$INSTALL_QODER" = "true" ]; then
    echo "采集安装不改写模型地址。模型转发需安装后单独执行显式配置命令。"
    if ! (
        set -e
        INFERENCE_PROXY_AGENTS=""
        if [ "$INSTALL_OPENCODE" = "true" ]; then INFERENCE_PROXY_AGENTS="opencode"; fi
        if [ "$INSTALL_QODER" = "true" ]; then
            if [ -n "$INFERENCE_PROXY_AGENTS" ]; then INFERENCE_PROXY_AGENTS="$INFERENCE_PROXY_AGENTS,qoder"; else INFERENCE_PROXY_AGENTS="qoder"; fi
        fi
        INFERENCE_PROXY_ROOT="$AGENT_INSIGHT_HOME/inference-versions"
        mkdir -p "$INFERENCE_PROXY_ROOT" || exit 1
        INFERENCE_PROXY_STAGE=$(mktemp -d "$INFERENCE_PROXY_ROOT/release.XXXXXX") || exit 1
        INFERENCE_PROXY_PUBLISHED=false
        trap 'if [ "$INFERENCE_PROXY_PUBLISHED" != "true" ]; then rm -rf -- "$INFERENCE_PROXY_STAGE"; fi' EXIT
        for component in inference_gateway.mjs inference_config.mjs inference_proxy.mjs model-proxy.sh; do
            if ! curl -fsSL "$AGENT_INSIGHT_BASE_URL/api/setup?component=$component" -o "$INFERENCE_PROXY_STAGE/$component"; then
                echo "Inference proxy component download failed: $component" >&2
                exit 1
            fi
            if [ "$component" = "model-proxy.sh" ]; then
                sh -n "$INFERENCE_PROXY_STAGE/$component" || exit 1
            elif ! node --check "$INFERENCE_PROXY_STAGE/$component"; then
                echo "Inference proxy component validation failed: $component" >&2
                exit 1
            fi
            chmod 600 "$INFERENCE_PROXY_STAGE/$component" || exit 1
        done
        node -p 'process.execPath' > "$INFERENCE_PROXY_STAGE/node-path"
        chmod 600 "$INFERENCE_PROXY_STAGE/node-path"
        if ! node --input-type=commonjs - "$INFERENCE_PROXY_STAGE" "$AGENT_INSIGHT_HOME/inference-runtime" << 'INFERENCE_PROXY_PUBLISH_EOF'
const fs = require('node:fs');
const path = require('node:path');
const [version, target] = process.argv.slice(2);
const temporary = target + '.tmp.' + process.pid;
const wrapper = path.join(path.dirname(target), 'model-proxy.sh');
const wrapperTemporary = wrapper + '.tmp.' + process.pid;
try {
    for (const destination of [target, wrapper]) {
        let current;
        try { current = fs.lstatSync(destination); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (current && !current.isSymbolicLink()) throw new Error('Existing runtime entry is not a managed symlink; move it aside before retrying: ' + destination);
    }
    fs.symlinkSync('inference-runtime/model-proxy.sh', wrapperTemporary);
    fs.renameSync(wrapperTemporary, wrapper);
    fs.symlinkSync(version, temporary, 'dir');
    fs.renameSync(temporary, target);
} catch (error) {
    process.stderr.write('Inference proxy publication failed: ' + error.message + '\\n');
    process.exitCode = 1;
} finally {
    try { fs.unlinkSync(temporary); } catch {}
    try { fs.unlinkSync(wrapperTemporary); } catch {}
}
INFERENCE_PROXY_PUBLISH_EOF
        then
            exit 1
        fi
        INFERENCE_PROXY_PUBLISHED=true
        if [ -n "$SETUP_WORKING_DIR" ]; then cd "$SETUP_WORKING_DIR" || exit 1; fi
        if ! AGENT_INSIGHT_API_KEY="$FINAL_KEY" node "$AGENT_INSIGHT_HOME/inference-runtime/inference_proxy.mjs" prepare "$AGENT_INSIGHT_HOME" "$INFERENCE_PROXY_AGENTS"; then
            echo "Inference proxy installation failed; inspect the error above before retrying." >&2
            exit 1
        fi
        echo "模型转发工具已准备，未新增接管任何模型地址。"
        echo "启用或同步模型转发（先进入 Agent 项目目录）："
        printf 'sh "%s/model-proxy.sh" %s\\n' "$AGENT_INSIGHT_HOME" "$INFERENCE_PROXY_AGENTS"
    ); then
        echo "Agent Insight setup failed while installing the inference proxy." >&2
        exit 1
    fi
fi`;
