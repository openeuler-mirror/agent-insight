# Viewing and Importing Traces

> The Chinese documentation (`docs/zh/how-to/observability/view-traces.md`) is the authoritative source. This page is a condensed English mirror of the trace viewing and import workflows.

## Viewing traces

The trace list supports filtering by agent, framework, user tags, and keywords. Click a row to open the trace detail; browser back returns to the list with the previous filters and page preserved. After a successful import, the same back/forward behavior applies to the imported trace's detail page.

## Batch importing traces

Use **Import Trace** in the top-right corner of the trace list. You can select multiple JSON files exported from Agent Insight, or drag and drop them onto the import window. Limits: 50 MB and 500 execution nodes per file.

Each file is imported independently — one file failing never interrupts the others. The window shows overall progress plus a per-file status: **Waiting / Importing / Imported / Failed / Stopped**, with filters for all, succeeded, failed, and not-imported.

- Imports belong to the current user. Non-conflicting original IDs are kept; only IDs already present in the target database are remapped, and parent-child relations plus session references are rewritten together. OTel trace/span IDs are preserved.
- Failed rows show a short reason; **View reason** expands the details. Recoverable failures (network or service temporarily unavailable) support per-item retry and batch retry of recoverable failures; permanent failures (validation errors, oversized files) offer no retry. Retrying never re-imports files that already succeeded.
- **Stop remaining imports** immediately stops files that have not started; the file currently importing finishes normally. **Cancel** asks for confirmation; confirming closes the window immediately while started imports finish in the background and pending files never start. Already-imported data is kept and never rolled back by stop or cancel.
- **View trace** on a succeeded row opens the trace detail in a new browser tab, using the real imported trace identifier (after ID remapping).
