# Tutorials

See [Tutorials](./navigation.md). The [coverage index](../navigation.md) identifies translated bodies and remaining Chinese-only guides.

- [Chinese documentation](../../zh/tutorial/navigation.md)
- [Start a Benchmark integration with the bundled Skill (Chinese)](../../zh/how-to/evaluation/benchmarks/onboard-custom-benchmark.md#21-使用自动接入-skill): provide the Agent Insight project address and official Benchmark source; the Skill compares its versioned protocol snapshot with the target before discovering runtime capabilities. Validation then covers endpoint contracts, real segments and a full end-to-end run. Live validation is a separate requirement from package self-tests.
- [English documentation status](https://gitcode.com/openeuler/agent-insight/blob/master/docs/en/README.md)
- [Migration review (Chinese)](https://gitcode.com/openeuler/agent-insight/blob/master/design/platform/docs-migration/migration-review.md)

OpenCode compatibility: updated Agent Insight resident clients support Skill snapshot isolation and read-only trigger analysis on OpenCode 1.x and 2.x (native validation: 2.1.4). Skill case generation and A/B require snapshot capability; trigger analysis additionally requires routing capability. If capabilities are missing, check the resident client version and reported capabilities; upgrading OpenCode alone is insufficient. See the [Chinese execution guide](../../zh/explanation/evaluation/skills/overview.md#opencode-执行兼容性).
