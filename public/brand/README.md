# Agent Insight — Brand assets

## Files

| File | Use case |
|------|----------|
| `favicon.svg` | Browser tab, 16/32/48px — minimum-detail variant |
| `mark-only.svg` | Standalone symbol, social avatars, when text isn't needed |
| `logo-horizontal-light.svg` | Website header, light backgrounds, emails, docs |
| `logo-horizontal-dark.svg` | Dark mode site, dark-themed materials |
| `app-icon.svg` | iOS/macOS/PWA app icon, 256×256 with rounded container |

## Color palette

| Token | Hex | Use |
|-------|-----|-----|
| Primary teal | `#0F766E` | Logo mark, primary brand color, CTA buttons (light mode) |
| Teal · dark | `#5EEAD4` | Logo mark in dark mode, accents on dark backgrounds |
| Accent amber | `#F59E0B` | Magnifying glass highlight, focus / attention states |
| Amber · dark | `#FBBF24` | Same accent, dark-mode variant |
| Ink | `#1A1A1A` | Body text, "Insight" wordmark on light bg |
| Canvas | `#FAFAF7` | Off-white background, warmer than pure white |
| Dark canvas | `#0F0F14` | Dark mode background |

## Typography

- **Wordmark + UI**: Inter (700 for "Agent", 300 for "Insight")
- **Code, logs, traces**: JetBrains Mono 400

## Sizing rules

- **Minimum favicon**: 16px (the simplified `favicon.svg`, not the full mark)
- **Minimum full lockup**: 120px wide — below that, use `mark-only.svg`
- **Clear space**: leave padding equal to the height of one node (~4px at small sizes) on all sides

## Concept

The mark is a **trace path** (nodes connected by line = agent execution steps) with a **magnifying glass** focused on one node — capturing the product's core promise: see and inspect every step of your agent's run.

- Teal = trust, technical, data
- Amber = the lens, the moment of insight, the highlight
