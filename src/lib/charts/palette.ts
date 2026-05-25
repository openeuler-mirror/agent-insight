// docs/design/foundations.md §2 (图表配色) — Chart Palette (categorical, max 8).
// Used by AgentTraceView for span-type colors and any future chart.
//
// SEMANTIC-RESERVED SLOTS — do not assign to non-status categories:
//   - Amber  → reserved for warning state (slow / pending). Reused as a span-type
//              color caused confusion with "this span has a problem". (2026-05-19)
//   - Red    → reserved for error state. Never use as a category color.
// When a chart must encode "warning / error" (e.g., error-rate series), using these
// is correct; otherwise pick from the remaining 6 slots.
export const CHART_PALETTE = [
  { name: 'indigo',  light: '#4F46E5', dark: '#818CF8' },
  { name: 'sky',     light: '#0EA5E9', dark: '#38BDF8' },
  { name: 'emerald', light: '#10B981', dark: '#34D399' },
  { name: 'amber',   light: '#F59E0B', dark: '#FBBF24' }, // RESERVED — warning only
  { name: 'red',     light: '#EF4444', dark: '#F87171' }, // RESERVED — error only
  { name: 'violet',  light: '#8B5CF6', dark: '#A78BFA' },
  { name: 'pink',    light: '#EC4899', dark: '#F472B6' },
  { name: 'teal',    light: '#14B8A6', dark: '#2DD4BF' },
] as const;

export type ChartColor = (typeof CHART_PALETTE)[number]['name'];

// Trace span-type → palette mapping (components.md §2 E.13 + foundations.md §2).
// AGENT = Indigo (primary), TASK = Sky, TOOL = Emerald, LLM = Violet (AI/model),
// SKILL = Pink, USER = neutral.
//
// LLM color history (4 iterations to converge):
//   - <= 2026-05-18: Amber → confused with warning state (amber is --warning).
//   - 2026-05-19 #1: Teal  → too close to Emerald TOOL (~15° hue), low contrast.
//   - 2026-05-19 #2: Pink  → "leans red", visually warm-aggressive for a high-frequency
//                            span type.
//   - 2026-05-19 #3: Violet — promoted from SKILL. Violet is the "AI/model/agent"
//     slot per foundations.md §2 (Tag 色板), and LLM is the most literal member of that
//     semantic. Trades: LLM-violet vs AGENT-indigo sit only ~19° apart on the hue
//     wheel, but tree position (AGENT = container with chevron, LLM = leaf event)
//     plus the chip text label disambiguates. SKILL takes Pink — it's far less
//     frequent than LLM, so the warm-color visual weight is acceptable.
export const SPAN_KIND_COLOR: Record<string, ChartColor | 'neutral'> = {
  agent: 'indigo',
  task:  'sky',
  tool:  'emerald',
  llm:   'violet',
  skill: 'pink',
  user:  'neutral',
};

// Each span-type chip uses a fixed Tailwind class-pair (subtle background + solid text
// for the type name + soft border) per foundations.md §2 (Tag 色板). We hand-pick classes that
// resolve correctly in both light & dark mode using the project tokens.
export const SPAN_KIND_CLASSES: Record<string, { chip: string; bar: string; text: string }> = {
  agent: {
    chip: 'bg-primary-subtle text-primary border-primary/30 dark:border-primary/40',
    bar:  'bg-primary',
    text: 'text-primary',
  },
  task: {
    chip: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/10 dark:text-sky-300 dark:border-sky-400/30',
    bar:  'bg-sky-500 dark:bg-sky-400',
    text: 'text-sky-700 dark:text-sky-300',
  },
  tool: {
    chip: 'bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:border-emerald-400/30',
    bar:  'bg-emerald-500 dark:bg-emerald-400',
    text: 'text-emerald-700 dark:text-emerald-300',
  },
  llm: {
    chip: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/10 dark:text-violet-300 dark:border-violet-400/30',
    bar:  'bg-violet-500 dark:bg-violet-400',
    text: 'text-violet-700 dark:text-violet-300',
  },
  skill: {
    chip: 'bg-pink-50 text-pink-700 border-pink-200 dark:bg-pink-500/10 dark:text-pink-300 dark:border-pink-400/30',
    bar:  'bg-pink-500 dark:bg-pink-400',
    text: 'text-pink-700 dark:text-pink-300',
  },
  user: {
    chip: 'bg-background-secondary text-foreground-muted border-border',
    bar:  'bg-foreground-muted',
    text: 'text-foreground-muted',
  },
};
