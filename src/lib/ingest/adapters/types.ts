import type { InvokedSkill } from "@/lib/shared/interaction-utils"

export type CanonicalInteraction = any
export type SessionMergeStrategy = "monotonic" | "snapshot-replace"

export interface FrameworkDescriptor {
  id: string
  aliases?: string[]
  label: string
  onboard: "plugin" | "env" | "watcher"
  platform?: string
}

export interface FrameworkAdapter {
  readonly descriptor: FrameworkDescriptor
  readonly sessionMergeStrategy?: SessionMergeStrategy
  normalizeForStorage?(interactions: CanonicalInteraction[]): CanonicalInteraction[]
  extractSkills?(normalized: CanonicalInteraction[]): InvokedSkill[]
}
