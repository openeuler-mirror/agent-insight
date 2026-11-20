# Viewing and Importing Traces

> The Chinese documentation (`docs/zh/how-to/observability/view-traces.md`) is the authoritative source. This page is a condensed English mirror of the trace viewing and import workflows.

## Viewing traces

The trace list supports filtering by agent, framework, user tags, and keywords. Click a row to open the trace detail; browser back returns to the list with the previous filters and page preserved. After a successful import, the same back/forward behavior applies to the imported trace's detail page.

New accounts no longer receive built-in example traces, and startup removes examples injected by older versions. If any remain, an administrator's all-user list shows at most three, preferring the administrator's own records. Other users' real traces remain visible. Selecting a specific user or opening a trace directly still shows that user's complete records.

## Batch importing traces

Use **Import Trace** in the top-right corner of the trace list. You can select multiple JSON files exported from Agent Insight, or drag and drop them onto the import window. Limits: 50 MB and 500 execution nodes per file.

Each file is imported independently — one file failing never interrupts the others. The window shows overall progress plus a per-file status: **Waiting / Importing / Imported / Failed / Stopped**, with filters for all, succeeded, failed, and not-imported.

- Imports belong to the current user. Non-conflicting original IDs are kept; only IDs already present in the target database are remapped, and parent-child relations plus session references are rewritten together. OTel trace/span IDs are preserved.
- Failed rows show a short reason; **View reason** expands the details. Recoverable failures (network or service temporarily unavailable) support per-item retry and batch retry of recoverable failures; permanent failures (validation errors, oversized files) offer no retry. Retrying never re-imports files that already succeeded.
- **Stop remaining imports** immediately stops files that have not started; the file currently importing finishes normally. **Cancel** asks for confirmation; confirming closes the window immediately while started imports finish in the background and pending files never start. Already-imported data is kept and never rolled back by stop or cancel.
- **View trace** on a succeeded row opens the trace detail in a new browser tab, using the real imported trace identifier (after ID remapping).

## DeepSeek Harness existing-data first version

The right pane has Overview, Context, Adjacent diff and Events tabs. The original SPAN tree is preserved; panes scroll independently. Previous/Next preserves the tab.

Category trends use only validated dsh-context 0.85.1 facts projections. Category tokens are approximate estimates, separate from provider usage. Missing projections stay unknown; additional request-member byte/token capture is not a fallback.

Adjacent comparisons require a validated same-session delta with an adjacent base. They show projected node counts and estimated tokens, not full membership or body differences. Missing history, incompatible versions, identity mismatches and invalid bases remain explicit. Member-capture fallback is excluded.

Events retain projected seq/kind/tokens, count/grossTokens and available from/to model names. Their request interval does not establish causality. Summary bodies and complete pruned items are unavailable in the current adapter output. Model events without model identities are explicitly unverified switches.

The collector does not register request/body capture hooks. Existing projection access requires the matching plugin and connection service, independent of member-capture settings. Restart Harness to load changes. Reading/transporting existing data is new integration work, not evidence that old OTLP already contained it. Historical enhanced-body APIs remain governed but are not exposed in this first-version dashboard.

Existing-source detail: delta.viewNodes and facts.nodes.archive provide node metadata and at most 80 characters of the first text block, not full requests or summaries. Archived gone markers identify replacement nodes; association with compaction/pruning is approximate. Tool bodies are usually absent. Preview copies require authenticated loading, redaction, existing quotas and a maximum seven-day TTL. No additional Agent request capture is registered.
### Issue 381 live verification update

On 2026-11-20, a new real Harness Headless session automatically exported requests #18 and #26 and linked them to two LLM steps. The second projection added one assistant node and one bash-result node. Overview preserves the original node details before context changes. The entire-session empty state explicitly refers to the available Trace window.

These are existing dsh-context projected nodes and estimated tokens, not complete model request bodies. Preview loading requires Trace authorization; absent tool-result bodies remain unavailable. Subsequent runs in the same session verified model changes #40/#86, native manual compaction #50, and prune #75 produced by a controlled invocation of the installed native pruning methods. The before/after intervals are #26→#44, #44→#62 and #70→#89. This is not acceptance of the default 0.8 automatic pressure path: the Web profile does not mount toolResultPruner.

The original native summary/checkpoint records contain the public API constraint, but the current dashboard exposes only an 80-character dsh-context preview. Full constraint verification in the customer page remains incomplete. A pruning replacement also overwrites the original tool completion timestamp and inflates its duration; that issue remains unresolved.
