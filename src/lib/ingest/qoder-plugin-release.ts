export const QODER_JETBRAINS_PACKAGE_URL_ENV =
  "AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL"

/**
 * Default precompiled JetBrains package used when the Agent Insight host does
 * not have a JDK/Gradle toolchain. Deployments can override this with
 * AGENT_INSIGHT_QODER_JETBRAINS_PACKAGE_URL, for example after the package is
 * promoted to an official openEuler release.
 */
export const DEFAULT_QODER_JETBRAINS_PACKAGE_URL =
  "https://api.gitcode.com/api/v5/repos/wangxin-2026/agent-insight/releases/qoder-cn-collector-test-v0.1.0/attach_files/agent-insight-qoder-jetbrains-0.1.9.zip/download"

export function configuredQoderJetBrainsPackageUrl(): string {
  const value = String(
    process.env[QODER_JETBRAINS_PACKAGE_URL_ENV]
      || DEFAULT_QODER_JETBRAINS_PACKAGE_URL,
  ).trim()

  try {
    const parsed = new URL(value)
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? value
      : ""
  } catch {
    return ""
  }
}
