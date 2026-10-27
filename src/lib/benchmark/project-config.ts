import { loadProjectConfig } from '../../../packages/project-config/index.cjs'
import { runtimePackageRoot } from '@/lib/runtime/package-root'

export function platformBenchmarkConfig() {
  return loadProjectConfig('platform', { root: runtimePackageRoot() }).benchmarks
}
