import path from 'node:path'

export function runtimePackageRoot(): string {
  const configured = String(process.env.AGENT_INSIGHT_PACKAGE_ROOT || '').trim()
  return path.resolve(configured || process.cwd())
}
