export const INFERENCE_PROXY_UNIX_SETUP_BLOCK = `# Install the local inference proxy after collector credentials are configured.
if [ "$INSTALL_OPENCODE" = "true" ] || [ "$INSTALL_QODER" = "true" ]; then
    echo "安装将改写 OpenCode / Qoder 模型配置和 Qoder CLI 启动入口。请先自行备份全局、项目及自定义配置；不提供自动备份、卸载或配置回退，失败也可能已修改部分文件。" >&2
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
        for component in inference_gateway.mjs inference_config.mjs inference_proxy.mjs; do
            if ! curl -fsSL "$AGENT_INSIGHT_BASE_URL/api/setup?component=$component" -o "$INFERENCE_PROXY_STAGE/$component"; then
                echo "Inference proxy component download failed: $component" >&2
                exit 1
            fi
            if ! node --check "$INFERENCE_PROXY_STAGE/$component"; then
                echo "Inference proxy component validation failed: $component" >&2
                exit 1
            fi
            chmod 600 "$INFERENCE_PROXY_STAGE/$component" || exit 1
        done
        if ! node --input-type=commonjs - "$INFERENCE_PROXY_STAGE" "$AGENT_INSIGHT_HOME/inference-runtime" << 'INFERENCE_PROXY_PUBLISH_EOF'
const fs = require('node:fs');
const [version, target] = process.argv.slice(2);
const temporary = target + '.tmp.' + process.pid;
try {
    let current;
    try { current = fs.lstatSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (current && !current.isSymbolicLink()) throw new Error('Existing inference-runtime is not a managed symlink; move it aside before retrying.');
    fs.symlinkSync(version, temporary, 'dir');
    fs.renameSync(temporary, target);
} catch (error) {
    process.stderr.write('Inference proxy publication failed: ' + error.message + '\\n');
    process.exitCode = 1;
} finally {
    try { fs.unlinkSync(temporary); } catch {}
}
INFERENCE_PROXY_PUBLISH_EOF
        then
            exit 1
        fi
        INFERENCE_PROXY_PUBLISHED=true
        if [ -n "$SETUP_WORKING_DIR" ]; then cd "$SETUP_WORKING_DIR" || exit 1; fi
        if ! AGENT_INSIGHT_API_KEY="$FINAL_KEY" node "$AGENT_INSIGHT_HOME/inference-runtime/inference_proxy.mjs" install "$AGENT_INSIGHT_HOME" "$INFERENCE_PROXY_AGENTS"; then
            echo "Inference proxy installation failed; inspect the error above before retrying." >&2
            exit 1
        fi
        echo "Local inference proxy runtime installed. Model configuration coverage is reported separately."
    ); then
        echo "Agent Insight setup failed while installing the inference proxy." >&2
        exit 1
    fi
fi`;
