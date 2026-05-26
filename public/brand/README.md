# Brand Assets

> Static logo / brand assets for Agent Insight. **Not yet referenced from the app** — see [`docs/design/brand.md`](../../docs/design/brand.md) for the application plan.

| File | Use |
| --- | --- |
| `logo-mark.svg` | 32×32 indigo-gradient mark with `Ai` letters. Primary brand mark. |
| `logo-mark-mono.svg` | Single-color version using `currentColor`. Use on colored backgrounds or when the gradient would clash. |
| `logo-wordmark.svg` | Mark + "Agent Insight" wordmark on one line. For login / marketing / footer. |
| `favicon.svg` | Square mark optimized for 16–48px (slightly larger letters than `logo-mark.svg`). |

**Don't edit these files in isolation.** All four must stay visually consistent — if you change the gradient stops, update all of them in the same PR and re-export `favicon.ico` (TODO: not yet generated).

See [`docs/design/brand.md`](../../docs/design/brand.md) §2 for clear-space, do/don't rules, and the rationale behind the gradient choice.
