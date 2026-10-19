const { bootstrapDataset } = require('./bootstrap-dataset.cjs')

bootstrapDataset({
  key: 'zsoft-l1',
  name: 'ZSoft L1',
  args: ['scripts/benchmark/ensure-dataset.ts', '--benchmark', 'zsoft-l1'],
  describeFailure: () => [
    '自动准备或数据库导入失败',
    '请检查 config/benchmark/platform.local.yaml 中 benchmarks.zsoft-l1.dataset.source、revision；网络受限时可指定本机官方目录，具体查看 ZSoft 部署指南。',
  ],
})
