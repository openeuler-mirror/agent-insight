# SWE-bench Verified 的 Docker 镜像与缓存空间说明

## 问题一：500 个 case 使用的 Docker 镜像都不一样吗？

是的。按照 SWE-bench 的最终评测镜像（instance/eval image）口径，在同一个 CPU 架构下，SWE-bench Verified 的 500 个 case 对应 **500 个不同名称的评测镜像**。

每个 case 都有唯一的 `instance_id`，最终镜像名称中包含该 ID，例如：

```text
swebench/sweb.eval.x86_64.astropy_1776_astropy-13236:latest
```

因此：

```text
500 个 case = 500 个具名的 instance/eval 镜像（每种 CPU 架构）
```

这里需要注意：

- “500 个不同镜像”指 500 个不同的最终镜像名称；它们并不是 500 套完全独立、互不共享的数据。
- Docker 镜像采用分层存储，多个 case 会共享 base 层和 environment 层，因此不能直接把 `docker images` 显示的每个镜像大小相加来计算物理占用。
- 同一个 case 在评测不同模型或不同预测 patch 时可以复用同一个 instance 镜像。模型 patch 是创建容器后再注入并应用的，不需要为每次预测重新构建镜像。
- 如果同时准备 `x86_64` 和 `arm64` 两种架构，它们是两套不同的镜像；通常讨论的 500 个镜像是指单一架构，主要是 `x86_64`。

整体分层关系可以简化为：

```text
少量共享 Base 镜像
        ↓
若干共享 Environment 镜像
        ↓
500 个 case 专属 Instance 镜像
```

参考资料：

- [SWE-bench TestSpec 中的镜像命名实现](https://github.com/SWE-bench/SWE-bench/blob/main/swebench/harness/test_spec/test_spec.py)
- [SWE-bench Docker 三层镜像结构说明](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/docker_setup.md#understanding-swe-benchs-docker-usage)
- [Epoch SWE-bench 镜像仓库：Verified x86_64 镜像覆盖 500/500](https://github.com/epoch-research/SWE-bench#how-to-use-our-image-registry)

## 问题二：为什么只缓存 base 要约 120GB，而缓存 base + env 却只要约 100GB？

这不是因为 base 镜像比 base + env 更大，而是原表格混用了两种不同的空间口径：

- `base` 行的 `~120GB during run` 指完成评测时建议准备的**运行峰值可用空间**。
- `env` 行的 `~100GB` 指评测完成后，base 和 environment 镜像的**常驻缓存空间**。

两者不能直接比较。

即使设置 `cache_level=base`，评测过程中仍然需要临时创建 environment 和 instance 镜像：

```text
构建/读取 base
    ↓
临时构建 environment
    ↓
临时构建 instance
    ↓
启动容器并运行测试
    ↓
删除 environment 和 instance 镜像
```

所以 `base` 模式在评测结束后只保留 base 镜像，但运行过程中仍需为临时 environment、instance、容器可写层和 Docker 构建缓存预留空间。这就是“最终保留很少”但“运行时仍建议至少有约 120GB 可用空间”的原因。

`env` 模式则会在评测后继续保留 base 和 environment 镜像，历史估算约为 100GB；运行时还要临时创建 instance 镜像，所以其峰值空间同样会高于 100GB，旧版说明也建议为非 `instance` 模式准备约 120GB 可用空间。

更合理的表述如下：

| Cache level | 评测后保留内容 | 历史估算的常驻空间 | 运行时可用空间建议 |
| --- | --- | ---: | ---: |
| `none` | 基本不保留 | 很小 | 约 120GB 或更多 |
| `base` | 仅 base | 明显小于 base + env | 约 120GB 或更多 |
| `env` | base + environment | 约 100GB | 约 120GB 或更多 |
| `instance` | base + environment + 全部 instance | 最高，旧资料约 2TB | 取决于实际镜像集合 |

这些数字是旧版 harness 的粗略估算，不是固定值。实际空间会受以下因素影响：

- 评测的数据集和 case 数量；
- CPU 架构；
- `max_workers` 并发数；
- Docker build cache 和容器可写层；
- 镜像版本及其 layer 复用程度；
- 是否使用优化过的第三方镜像仓库。

查看 Docker 的真实物理占用应使用：

```bash
docker system df -v
```

不要直接把 `docker images` 中各行显示的 SIZE 相加，因为共享 layer 会被重复计算。

参考资料：

- [SWE-bench Docker Setup Guide](https://github.com/SWE-bench/SWE-bench/blob/main/docs/guides/docker_setup.md#cache-level-configuration)
- [SWE-bench 早期 Docker 评测说明](https://github.com/yetlinghao/live-swebench/blob/main/docs/20240627_docker/README.md#choosing-the-right-cache_level)
- [Epoch 对 SWE-bench 镜像共享层和实际空间的分析](https://epoch.ai/latest/swebench-docker#impact-on-size)

## 补充：数据集文件与 Docker 镜像不是一回事

SWE-bench Verified 在 Hugging Face 上的数据集文件本身只有约 **6.31MB**，包含 500 条 case 的 issue、commit、patch、测试信息和镜像引用。真正占用大量磁盘的是执行评测所需的代码仓库、依赖和 Docker 镜像。

根据 Epoch 对共享 layer 去重后的统计：

- 原始 SWE-bench Verified 500 个镜像约为 **189GiB**；
- Epoch 优化后的镜像集合约为 **30GiB**。

参考资料：

- [SWE-bench Verified 数据集页面](https://huggingface.co/datasets/SWE-bench/SWE-bench_Verified)
- [Epoch 镜像空间统计](https://epoch.ai/latest/swebench-docker#impact-on-size)
