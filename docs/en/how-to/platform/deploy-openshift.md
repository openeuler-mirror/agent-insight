---
title: "Deploy the server on OpenShift"
description: "Deploy Agent Insight with a UBI9 image, PVC and HTTPS Route, including Developer Sandbox builds, clients, acceptance and troubleshooting."
keywords: ["Agent Insight", "OpenShift", "UBI9", "Developer Sandbox", "PVC", "deployment"]
changefreq: "monthly"
---

# Deploy the server on OpenShift

This guide runs one Agent Insight server, exposes it over HTTPS and stores runtime data on a PVC. OpenShift builds on Kubernetes with image builds, security policies, storage and application ingress management. The application still runs as a container image.

Build with [`Dockerfile.openshift`](../../../../Dockerfile.openshift) and deploy with [`deploy/openshift.yaml`](../../../../deploy/openshift.yaml). The YAML declares a PVC, Deployment, Service and Route; `oc apply` applies them to the selected project.

## 1. Scope and prerequisites

The verified scope is **amd64, one SQLite instance, Recreate updates and the restricted-v2 SCC**, including public Route access in Developer Sandbox. ARM64, multiple replicas sharing SQLite, OpenGauss runtime dependencies and a read-only root filesystem remain outside this image's verified scope.

| Item | Requirement |
| --- | --- |
| Project | An enterprise project or activated Developer Sandbox project with permission to create Deployments, Services, Routes and PVCs |
| Local tools | A cluster-compatible `oc`, Python 3 and Git; Docker for local image builds, and Node.js for image checks |
| Image | A UBI9 delivery image reachable by cluster nodes; record its tag and resolved digest, and provide private-registry credentials if needed |
| Runtime quota | Template requests: 500m CPU, 2Gi memory, 1Gi ephemeral storage; limits: 2 CPU, 4Gi memory, 4Gi ephemeral storage |
| Storage | A 5Gi ReadWriteOnce PVC by default, with a default or explicitly approved StorageClass |
| Network | Browsers and Agent clients can reach the Route; the server and execution clients can each reach their required models and external services |

Account for build Pod resources separately. In Sandbox, use the allocated project; creating a cluster or requesting cluster-admin access is unnecessary for this procedure.

## 2. Log in and select the project

In the console user menu, select **Copy login command → Display Token** and run the supplied `oc login` command locally. Keep tokens and kubeconfig files on your machine, outside documentation, source control and images.

Use Bash and run from the repository root containing the Dockerfile and deployment template:

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

Creation checks should return `yes`. Ask the administrator to confirm node architecture and available StorageClasses. Restricted access to cluster-wide resources does not mean that a Sandbox cluster has no storage or nodes.

## 3. Prepare a pullable image

### Use a delivery image

Replace the example registry, repository and tag with a real reference. Prefer an immutable digest after acceptance:

```bash
export AI_IMAGE='registry.example.com/team/agent-insight:ubi9-release'
```

`docker load` imports into the local Docker engine only. For an offline archive, load it and push to a registry reachable by cluster nodes before setting `AI_IMAGE`.

For a private registry, create a pull Secret from a local Docker config containing usable registry authentication, then link it to the template's `default` ServiceAccount:

```bash
oc create secret generic agent-insight-registry \
  --type=kubernetes.io/dockerconfigjson \
  --from-file=.dockerconfigjson=/absolute/path/to/registry-auth.json
oc secrets link default agent-insight-registry --for=pull
```

A config that only refers to a desktop credential helper is insufficient for cluster authentication. Reuse an existing Secret where available; link it to the relevant account when using a dedicated ServiceAccount. See Red Hat's [image management guide](https://docs.redhat.com/en/documentation/openshift_container_platform/4.19/html/images/managing-images).

### Build from source

On a build host with Docker:

```bash
docker build --platform linux/amd64 -f Dockerfile.openshift \
  --build-arg SOURCE_REVISION="$(git rev-parse HEAD)" \
  -t "$AI_IMAGE" .
node scripts/verify-openshift-image.cjs "$AI_IMAGE"
docker push "$AI_IMAGE"
```

This builds the current working tree. Record uncommitted changes separately; the `SOURCE_REVISION` label alone does not identify a modified tree. Base-image overrides, DNF patch builds, Python/npm dependency locks and scan acceptance are covered in the [image release guide (Chinese)](../../../zh/how-to/platform/release-docker-image.md#构建-ubi9openshift-交付候选). Without local Docker, use the optional [in-cluster build](#8-developer-sandbox-in-cluster-build-optional).

## 4. Render and apply the deployment manifest

Keep generic placeholders in the repository template. Write environment-specific values into a temporary copy:

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

Review the generated file before applying it. Adjust PVC capacity, `storageClassName`, quota settings and `nodeSelector` for the cluster. The template selects amd64 nodes; prepare and validate the matching image before changing architecture. Add `storageClassName` under the **PVC spec**. Changing an existing PVC's storage class requires a storage migration rather than an ordinary configuration update.

```bash
oc apply -f "$AI_DEPLOY_DIR/agent-insight.local.yaml"
oc rollout status deployment/agent-insight --timeout=300s
oc get deployment,pod,service,route,pvc -l app=agent-insight
```

The template uses one replica and Recreate updates to prevent two application instances from using the same runtime root. The PVC mounts at `/data/agent-insight`; SQLite is at `/data/agent-insight/data/witty_insight.db`. HOME, XDG directories and client runtime assets also reside beneath the runtime root. Back up [runtime files and the database](./backup-and-restore.md), not just the image.

The template leaves `runAsUser` unset so the SCC assigns a non-root UID. It also disables privilege escalation, drops capabilities and selects RuntimeDefault seccomp. The image retains UID 0 for downstream `dnf update` builds; the SCC determines the running Pod's identity. This template needs no anyuid or privileged SCC grant. See Red Hat's [SCC management guide](https://docs.redhat.com/en/documentation/openshift_container_platform/4.19/html/authentication_and_authorization/managing-pod-security-policies).

## 5. Check HTTPS, runtime identity and persistence

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

Expect successful login HTTP, a Ready Pod, a non-root UID, the approved SCC, a writable runtime volume and importable Python dependencies. Configure trusted CA certificates for enterprise certificates while retaining TLS verification.

Open `https://<Route host>` in a browser. Create identifiable test data and record its ID. During an allowed interruption window, restart the Pod:

```bash
oc rollout restart deployment/agent-insight
oc rollout status deployment/agent-insight --timeout=300s
oc get pvc agent-insight-data
```

After refreshing, confirm that the account, model configuration and recorded data remain, with the PVC still Bound. This check preserves the PVC and replaces the Pod. A WaitForFirstConsumer volume may remain Pending until a Pod is scheduled.

The Route terminates edge TLS and forwards to server port 3000. The template configures startup, readiness and liveness probes explicitly; Docker HEALTHCHECK does not become an OpenShift probe automatically. Route request and tunnel timeouts are 300 seconds and one hour respectively; upstream proxies may impose shorter limits.

## 6. Connect clients and accept business workflows

A reachable homepage completes only the initial deployment check. Install clients in the **machine or container where the Agent runs**, using the public HTTPS Route. Follow [client installation (Chinese)](../../../zh/how-to/platform/settings/access-control.md) and [model registration (Chinese)](../../../zh/how-to/platform/settings/model-registry.md). Check server-side and client-side model connectivity and configuration separately.

Update and restart existing clients after upgrading the server image. Replacing a platform Pod does not replace installed client scripts. For fixes that have not been published to npm, use their corresponding delivered installer artifacts; an older npm version does not acquire those changes automatically.

| Check | Acceptance condition |
| --- | --- |
| Model registration | Connection test succeeds; saved default configuration survives reload |
| Trace | A real Agent task is ingested, showing model calls, tools and results |
| Skill lifecycle | Generate/upload → static evaluation → experiment → diagnosis → optimization → candidate verification → publish → rerun, with consistent results and versions |
| Control transport | Authenticated WSS works; a separate run with WSS unavailable completes a task through polling |
| Interruption boundary | Disconnected deliveries and missing ACKs reach explicit timeout states; late acceptance cannot start completed work |
| RAS, when required | Configuration is available, activation/detection evidence and actual interruption receipts exist, and recovery plus persistence checks succeed |

Polling defaults to five seconds. Set `AGENT_INSIGHT_RAS_POLL_WAIT_SEC` to an integer from 1 to 30 in the **client environment**, below the measured idle timeout of the access path. The control gateway shares the public application port. Its internal dispatcher binds to loopback and needs no extra Service or Route. See the [client control protocol](../../reference/reliability/client-control-api.md).

Definitions and tools for the five cases are in the [core E2E guide](../../../../test/e2e/README.md). For deployed-service acceptance, confirm that the runner uses the intended Route and image instead of starting a local platform. A model mock must be reachable from both the platform and execution client. When using a real model for 001 and mocks for 002–005, record those modes separately: mock results validate workflow behavior, not real-model quality.

## 7. Upgrade and troubleshoot

Back up runtime data and record the old image digest. Set `AI_IMAGE` to the new reference, repeat section 4 to render and apply the manifest, and repeat infrastructure and business acceptance. Application changes require an image rebuild; this UBI9 image does not support mounted-source mode through `AGENT_INSIGHT_SOURCE_DIR`. Check database compatibility before rollback; see [upgrade and rollback](./upgrade-and-rollback.md).

```bash
oc describe deployment agent-insight
oc get events --sort-by=.lastTimestamp
oc describe pvc agent-insight-data
```

For image pull, startup or probe failures, run `oc describe pod <pod-name>` on the Pod listed by `oc get pods -l app=agent-insight`. After a container restart, inspect `oc logs <pod-name> --previous --tail=100`.

| Symptom | Check first |
| --- | --- |
| ImagePullBackOff | Reference/digest, node-to-registry network, registry access and the ServiceAccount pull Secret |
| Pending Pod | Quota, architecture selector, PVC binding, StorageClass and scheduling events |
| SCC rejection or permission error | Effective UID/SCC, volume group permissions and storage driver; correct them within the approved policy |
| OOMKilled or build memory failure | Separate runtime/build requests and limits, plus the quota for coexisting resources |
| Route 503 or failed probes | Pod readiness, Service selector, port 3000 and startup logs |
| Homepage works but commands wait | Client version/ownership, gateway entrypoint, WSS/polling, ACK timeout and upstream proxies |
| Critical API returns 404 | Complete source archive, selected Dockerfile and the accepted running image digest |
| Missing RAS config or failed Python import | Image Python 3.11/PyYAML/Pydantic and RAS installation in the actual client environment |
| Data disappears after Pod replacement | Original PVC, complete runtime-root mount and overridden database paths |

Retain build, image-check, scan and business results for each **actual image digest**. Successful deployment does not imply that full-suite tests or every vulnerability severity has passed admission.

## 8. Developer Sandbox in-cluster build (optional)

When the project permits BuildConfig and an integrated image registry, submit committed source without local Docker. This uses Red Hat's [Binary build inputs](https://docs.redhat.com/en/documentation/openshift_container_platform/4.19/html-multi/builds_using_buildconfig/understanding-buildconfigs). The example build requests 500m CPU/2Gi memory and limits 2 CPU/6Gi memory, in addition to the runtime Pod. Use an external builder if quota is insufficient.

Check out the intended commit containing `Dockerfile.openshift`. `git archive` includes that commit only, without uncommitted changes. Use complete source rather than hand-filtering directory names, which can omit nested API routes. Confirm that the `agent-insight-ubi9` build resource name is available for this application:

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

Confirm that the submitted Build is Complete and the image reference contains the resolved digest, then return to section 4. The upload directory contains the selected commit only. Copying the dedicated ignore file to root `.dockerignore` also applies the exclusion rules to builders that read that root file. Builds need access to UBI RPM repositories, npm and Python packages; configure approved sources as described in the [image release guide (Chinese)](../../../zh/how-to/platform/release-docker-image.md#构建-ubi9openshift-交付候选).

[中文权威版本](../../../zh/how-to/platform/deploy-openshift.md)
