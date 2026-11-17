---
title: "在 OpenShift 上部署服务端"
description: "使用 UBI9 镜像、PVC 和 HTTPS Route 部署 Agent Insight，包含 Developer Sandbox 构建、客户端接入、验收与排障。"
keywords: ["Agent Insight", "OpenShift", "UBI9", "Developer Sandbox", "PVC", "部署"]
changefreq: "monthly"
---

# 在 OpenShift 上部署服务端

本指南将 Agent Insight 部署为一个服务端实例，通过 HTTPS 访问，数据保存在 PVC。OpenShift 可以理解为带有镜像构建、安全策略、存储和应用入口管理的 Kubernetes 平台；应用仍使用容器镜像运行。

使用仓根的 [`Dockerfile.openshift`](../../../../Dockerfile.openshift) 制作镜像，以 [`deploy/openshift.yaml`](../../../../deploy/openshift.yaml) 声明运行资源。这份 YAML 是 PVC、Deployment、Service、Route 四类资源的清单，`oc apply` 将其应用到选定项目。

## 1. 确认部署范围与前置条件

当前实测范围为 **amd64、SQLite 单实例、`Recreate` 更新策略、`restricted-v2` SCC**，包含 Developer Sandbox 公网 Route 访问。ARM64、SQLite 多副本共享、OpenGauss 运行依赖和只读根文件系统不在本镜像的已验证范围内。

| 项目 | 需要准备的内容 |
| --- | --- |
| OpenShift 项目 | 企业集群的目标项目，或已激活的 Developer Sandbox 项目；可以创建 Deployment、Service、Route、PVC |
| 本机工具 | 与集群兼容的 `oc`、Python 3、Git；本地构建镜像时另需 Docker，运行镜像自检时另需 Node.js |
| 镜像 | 节点可拉取的 UBI9 交付镜像，记录 tag 和实际 digest；私有仓库需拉取凭据 |
| 运行配额 | 模板 requests：500m CPU、2Gi 内存、1Gi 临时存储；limits：2 CPU、4Gi 内存、4Gi 临时存储 |
| 持久化 | 默认 5Gi、`ReadWriteOnce` PVC；有默认 StorageClass，或在清单中指定获准的 StorageClass |
| 网络 | 浏览器和 Agent 客户端可访问 Route；服务端及执行客户端分别可访问其使用的模型和外部服务 |

构建 Pod 的资源配额需要额外计算，不能只核对运行 Pod。Sandbox 使用平台分配的现有项目，无需创建新集群或申请集群管理员权限。

## 2. 登录并选择项目

从控制台用户名菜单选择 **Copy login command → Display Token**，在本机终端执行提供的 `oc login` 命令。Token 和 kubeconfig 保留在本机，不写入文档、仓库或镜像。

下文命令使用 Bash，从包含上述 Dockerfile 和模板的仓库根目录执行：

```bash
export AI_PROJECT='your-project'
oc whoami
oc project "$AI_PROJECT"
oc auth can-i create deployments.apps
oc auth can-i create services
oc auth can-i create routes.route.openshift.io
oc auth can-i create persistentvolumeclaims
oc get resourcequota
oc get limitrange
```

创建权限应返回 `yes`。节点架构和可用 StorageClass 由集群管理员确认；普通 Sandbox 账号无法查询部分集群级资源时，不能据此认定集群没有存储或节点。

## 3. 准备可拉取的镜像

### 已有交付镜像

设置真实的仓库引用；以下域名、仓库和 tag 只是示例。验收通过后优先使用固定 digest 部署：

```bash
export AI_IMAGE='registry.example.com/team/agent-insight:ubi9-release'
```

`docker load` 只导入本机 Docker，不能让 OpenShift 节点直接使用该镜像。离线包需要先导入并推送到集群可访问的仓库，再设置 `AI_IMAGE`。

私有仓库可使用包含有效 registry auth 的本地 Docker 配置文件创建拉取 Secret，再关联到模板使用的 `default` ServiceAccount：

```bash
oc create secret generic agent-insight-registry \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/absolute/path/to/registry-auth.json
oc secrets link default agent-insight-registry --for=pull
```

文件应包含可供集群使用的认证数据，不能仅引用本机桌面凭据助手。已有 Secret 可直接复用；使用专用 ServiceAccount 时，关联到该账号。具体权限见红帽的[镜像管理说明](https://docs.redhat.com/en/documentation/openshift_container_platform/4.19/html/images/managing-images)。

### 从源码构建

有 Docker 的构建机可执行：

```bash
docker build --platform linux/amd64 -f Dockerfile.openshift \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t "$AI_IMAGE" .
node scripts/verify-openshift-image.cjs "$AI_IMAGE"
docker push "$AI_IMAGE"
```

构建使用当前工作区；有未提交改动时，另行记录工作区差异，不能只用 `SOURCE_REVISION` 标签代表完整源码。基础镜像替换、DNF 派生补丁、Python/npm 锁定依赖和扫描验收见[镜像发布](./release-docker-image.md#构建-ubi9openshift-交付候选)。没有本地 Docker 时，可使用下文的[集群内构建](#8-developer-sandbox-集群内构建可选)。

## 4. 渲染并应用部署清单

保留仓库模板中的通用占位符，将环境专属配置写入临时副本：

```bash
export AI_DEPLOY_DIR="$(mktemp -d)"
python3 - <<'PY'
import os
from pathlib import Path

image = os.environ['AI_IMAGE']
assert image and not any(c.isspace() for c in image), 'AI_IMAGE must be one image reference'
source = Path('deploy/openshift.yaml').read_text()
placeholder = 'registry.example.com/agent-insight:openshift-ubi9-replace-me'
assert source.count(placeholder) == 1, 'Check the deployment template version'
target = Path(os.environ['AI_DEPLOY_DIR']) / 'agent-insight.local.yaml'
target.write_text(source.replace(placeholder, image))
print(target)
PY
```

应用前检查副本：按集群实际情况设置 PVC 容量、`storageClassName`、资源配额及 `nodeSelector`。默认选择 `amd64` 节点；修改架构前先准备并验证对应架构镜像。新增 `storageClassName` 应放在 **PVC 的 `spec`** 中；已有 PVC 的存储类别不能当作普通配置随意切换。

```bash
oc apply -f "$AI_DEPLOY_DIR/agent-insight.local.yaml"
oc rollout status deployment/agent-insight --timeout=300s
oc get deployment,pod,service,route,pvc -l app=agent-insight
```

模板固定一个副本，使用 `Recreate` 避免两个应用实例同时使用同一运行根。PVC 挂载到 `/data/agent-insight`，SQLite 位于 `/data/agent-insight/data/witty_insight.db`；HOME、XDG 目录、客户端运行资料也在运行根下。备份应覆盖[运行目录与数据库](./backup-and-restore.md)，不能只备份镜像。

模板不指定固定 `runAsUser`，由 SCC 分配非 root UID，同时禁止权限提升、删除 capabilities 并使用 `RuntimeDefault` seccomp。镜像保留 UID 0 是为了客户派生构建执行 `dnf update`，Pod 运行身份由 SCC 决定；使用本模板无需申请 `anyuid` 或特权。机制见红帽的[SCC 管理说明](https://docs.redhat.com/en/documentation/openshift_container_platform/4.19/html/authentication_and_authorization/managing-pod-security-policies)。

## 5. 检查 HTTPS、运行身份与持久化

```bash
export AI_ROUTE="$(oc get route agent-insight -o jsonpath='{.spec.host}')"
printf 'https://%s\n' "$AI_ROUTE"
curl --fail --show-error --silent "https://$AI_ROUTE/login" >/dev/null
oc logs deployment/agent-insight --tail=100
oc exec deployment/agent-insight -- id
oc get pods -l app=agent-insight \
  -o jsonpath='{range .items[*]}{.metadata.name}{" SCC="}{.metadata.annotations.openshift\.io/scc}{"\n"}{end}'
oc exec deployment/agent-insight -- node -e \
  'const fs=require("fs");const p="/data/agent-insight/.write-check-"+Date.now();fs.writeFileSync(p,"ok");fs.unlinkSync(p);console.log("runtime volume writable")'
oc exec deployment/agent-insight -- python3 -c \
  'import sys,yaml,pydantic; print(sys.version.split()[0],yaml.__version__,pydantic.__version__)'
```

预期为登录 HTTP 成功、Pod Ready、非 root UID、获准的 SCC、可写运行卷，以及 Python 依赖可导入。企业自签证书应配置可信 CA；保留 TLS 校验。

浏览器使用 `https://<Route host>` 登录。先创建一条可识别的测试数据，记录其标识，再在允许短暂停机时执行：

```bash
oc rollout restart deployment/agent-insight
oc rollout status deployment/agent-insight --timeout=300s
oc get pvc agent-insight-data
```

刷新后确认原有账号、模型配置和测试数据仍存在，PVC 保持 `Bound`。这项检查保留 PVC，只重建 Pod。`WaitForFirstConsumer` 存储类别的 PVC 可能在 Pod 调度前暂时为 `Pending`。

Route 使用 edge TLS，将 HTTPS 转发到服务端 3000 端口；模板显式配置启动、就绪和存活探针。Docker HEALTHCHECK 不会自动成为 OpenShift 探针。Route 的普通请求超时为 300 秒、隧道超时为 1 小时，但上游网关和代理仍可能施加更短限制。

## 6. 接入客户端并验收业务

首页可访问只完成了基础部署检查。继续按[客户端安装](./settings/access-control.md)在 **Agent 实际运行的机器或容器**安装客户端，使用公开 HTTPS Route；模型配置见[模型注册](./settings/model-registry.md)。平台侧模型与执行客户端侧模型分别检查其网络和配置。

升级服务端镜像后，需要更新并重启已有客户端。客户端脚本不会随平台 Pod 自动升级；尚未发布到 npm 的修复应使用相应交付安装制品，不能假定安装任意 npm 旧版本就包含修复。

| 验收项 | 通过条件 |
| --- | --- |
| 模型注册 | 页面测试连接成功，保存并设为默认后，刷新可读回配置 |
| Trace | 从真实 Agent 发起任务，Trace 入库且页面可查看模型、工具和结果 |
| Skill 闭环 | 生成/上传 → 静态评估 → 实验 → 诊断 → 优化 → 候选验证 → 发布 → 再执行，结果与版本一致 |
| 控制通道 | 认证 WSS 可用；单独模拟 WSS 不可用时，轮询仍能执行一次完整任务 |
| 中断边界 | 断连和缺少 ACK 的指令得到明确超时结果；迟到确认不会启动已结束的工作 |
| RAS（需要时） | 配置可见、故障激活和检测有证据、实际中断有回执，并完成恢复与重启后持久化检查 |

客户端默认轮询等待 5 秒，可在**客户端环境**设置 `AGENT_INSIGHT_RAS_POLL_WAIT_SEC`（整数 1–30）；等待应小于实际链路空闲超时。服务端控制网关与应用共享公开端口，内部指令分发端口只监听回环地址，无需额外创建 Service/Route。详细状态语义见[客户端控制协议](../../reference/reliability/client-control-api.md)。

核心五例的定义与工具见[核心 E2E](../../../../test/e2e/README.md)。验收已部署服务时，应确认工具实际命中目标 Route 和镜像，没有另起本地平台；Mock 服务必须同时对平台和执行客户端可达。约定 001 使用真实模型、002–005 使用 Mock 时，应分别记录；Mock 通过验证流程，不代表真实模型质量。

## 7. 升级与排障

升级前备份运行目录、记录旧镜像 digest。将 `AI_IMAGE` 改为新镜像，重新执行第 4 节的渲染和应用步骤，再执行基础及业务验收。代码升级通过重建镜像完成；此 UBI9 镜像不支持 `AGENT_INSIGHT_SOURCE_DIR` 运行时源码挂载。回滚需要同时核对数据库兼容性，步骤见[升级与回滚](./upgrade-and-rollback.md)。

```bash
oc describe deployment agent-insight
oc get events --sort-by=.lastTimestamp
oc describe pvc agent-insight-data
```

Pod 启动、拉取镜像或探针异常时，再对 `oc get pods -l app=agent-insight` 返回的具体 Pod 执行 `oc describe pod <Pod名称>`；容器重启后可查看 `oc logs <Pod名称> --previous --tail=100`。

| 现象 | 优先检查 |
| --- | --- |
| `ImagePullBackOff` | 镜像引用/digest、节点到仓库网络、仓库许可和 ServiceAccount 的拉取 Secret |
| Pod `Pending` | 项目配额、节点架构选择、PVC 绑定、StorageClass 与调度事件 |
| SCC 拒绝或权限错误 | 实际 UID/SCC、卷的组权限和存储驱动；按获准策略修正，不通过放宽到特权绕过 |
| `OOMKilled` 或构建内存不足 | 运行与构建各自的 requests/limits，以及同项目并存资源的配额 |
| Route 503 / 探针失败 | Pod Ready 状态、Service 选择器、3000 端口和启动日志 |
| 页面正常但命令停留等待 | 客户端版本/在线归属、控制网关入口、WSS/轮询、ACK 超时及代理链路 |
| 关键 API 返回 404 | 源码包是否完整、构建是否选用 `Dockerfile.openshift`、运行 digest 是否为验收版本 |
| RAS 配置缺失或 Python 导入失败 | 镜像的 Python 3.11、PyYAML/Pydantic 及客户端所在环境的 RAS 安装状态 |
| Pod 更换后数据消失 | PVC 是否仍是原卷，是否挂在完整运行根，数据库路径是否被其他配置覆盖 |

每次交付按**实际镜像 digest**留存构建、自检、漏洞扫描及业务结果。已成功部署不等于全量单测或全部漏洞级别已通过准入。

## 8. Developer Sandbox 集群内构建（可选）

没有本地 Docker、但项目允许使用 BuildConfig 与集成镜像仓库时，可把已提交源码送到集群构建。流程对应红帽的[Binary 构建输入](https://docs.redhat.com/en/documentation/openshift_container_platform/4.19/html-multi/builds_using_buildconfig/understanding-buildconfigs)。本例构建资源为 500m/2Gi requests、2 CPU/6Gi limits，另加运行 Pod 的配额；不足时使用外部构建机。

先检出包含 `Dockerfile.openshift` 的目标提交。`git archive` 只包含该提交的文件，未提交修改不会进入镜像。归档包含完整源码，避免手工按目录名过滤时漏掉嵌套 API。确认 `agent-insight-ubi9` 构建资源名可用于本应用后执行：

```bash
export AI_SOURCE_REVISION="$(git rev-parse HEAD)"
export AI_BUILD_DIR="$(mktemp -d)"
mkdir "$AI_BUILD_DIR/source"
git archive "$AI_SOURCE_REVISION" | tar -x -C "$AI_BUILD_DIR/source"
cp "$AI_BUILD_DIR/source/Dockerfile.openshift.dockerignore" \
  "$AI_BUILD_DIR/source/.dockerignore"

oc apply -f - <<EOF
apiVersion: image.openshift.io/v1
kind: ImageStream
metadata:
  name: agent-insight
---
apiVersion: build.openshift.io/v1
kind: BuildConfig
metadata:
  name: agent-insight-ubi9
spec:
  runPolicy: Serial
  source:
    type: Binary
    binary: {}
  strategy:
    type: Docker
    dockerStrategy:
      dockerfilePath: Dockerfile.openshift
      buildArgs:
        - name: SOURCE_REVISION
          value: "$AI_SOURCE_REVISION"
  output:
    to:
      kind: ImageStreamTag
      name: agent-insight:ubi9-candidate
  resources:
    requests:
      cpu: 500m
      memory: 2Gi
    limits:
      cpu: "2"
      memory: 6Gi
EOF

oc start-build agent-insight-ubi9 \
  --from-dir="$AI_BUILD_DIR/source" --follow --wait
oc get builds -l buildconfig=agent-insight-ubi9
export AI_IMAGE="$(oc get istag agent-insight:ubi9-candidate -o jsonpath='{.image.dockerImageReference}')"
printf '%s\n' "$AI_IMAGE"
```

确认本次 Build 为 `Complete`，镜像引用已带实际 digest，再回到第 4 节渲染部署清单。上传目录只含选定 Git 提交；复制专用 ignore 文件到根 `.dockerignore`，使按根文件过滤上下文的 builder 也采用相同排除规则。构建需能访问 UBI RPM、npm 和 Python 包源；企业网络按[镜像发布指南](./release-docker-image.md#构建-ubi9openshift-交付候选)配置获准的软件源。

[English](../../../en/how-to/platform/deploy-openshift.md)
