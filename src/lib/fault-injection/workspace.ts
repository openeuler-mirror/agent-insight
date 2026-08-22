/** Logical workspace markers for FI tasks (server never expands ~ to its own homedir). */
export const FI_WORKSPACE_DEFAULT = '__default__'

export function normalizeFiWorkspaceInput(raw: unknown): string {
  if (typeof raw !== 'string') return FI_WORKSPACE_DEFAULT
  const trimmed = raw.trim()
  if (!trimmed || trimmed === '~' || trimmed.startsWith('~/') || trimmed === FI_WORKSPACE_DEFAULT) {
    return FI_WORKSPACE_DEFAULT
  }
  return trimmed
}

/**
 * Resolve logical workspace on the **client** machine only.
 * Server must not call this with its own homedir for remote workers.
 */
export function resolveFiWorkspaceOnClient(
  logical: string,
  workspaceBase: string,
  pathJoin: (...parts: string[]) => string = (...parts) => parts.join('/').replace(/\/+/g, '/'),
  pathResolve: (...parts: string[]) => string = pathJoin,
): string {
  const value = (logical || FI_WORKSPACE_DEFAULT).trim()
  if (!value || value === FI_WORKSPACE_DEFAULT) return workspaceBase
  if (value.startsWith('~/')) {
    // Client installers should expand ~ before calling; keep as join fallback
    return pathJoin(workspaceBase, value.slice(2))
  }
  if (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) return value
  return pathResolve(workspaceBase, value)
}
