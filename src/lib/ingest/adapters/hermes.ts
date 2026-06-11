import type { FrameworkAdapter } from "./types"

export const hermesAdapter: FrameworkAdapter = {
  descriptor: {
    id: "hermes",
    label: "Hermes",
    onboard: "plugin",
    platform: "hermes",
  },
  sessionMergeStrategy: "snapshot-replace",
}
