# Architecture

```text
ChatGPT / MCP Host ── stdio ──> OpenFish MCP Server ──> Playwright Runtime
                                                        │
Chrome Side Panel ── localhost HTTP bridge ─────────────┘
                                                        │
                                        Local Chromium OR remote CDP
```

## Planned milestones
- 1.0.0: local browser runtime, MCP tools, Chrome side panel, safe page inspection.
- 1.0.1: optional Ollama local-model planning, structured page context, review-only action plans.
- 1.1.0: robust selector discovery, accessibility-tree snapshots, screenshots in MCP responses.
- 1.2.0: explicit task planner, step-by-step approvals, retry and timeout policy.
- 1.3.0: optional hosted browser worker, authentication, isolated sessions and task queue.
- 1.4.0: scheduled workflows and change monitoring.

## Security boundaries
The local bridge binds to `127.0.0.1`, not all network interfaces. Before public deployment, add authentication, origin allowlists, CSRF protection, per-user browser contexts, quotas, audit logs, and secret management. Do not expose an unauthenticated Playwright endpoint to the public internet.


## Browser library (v2.2.0)
The browser bridge persists bookmarks, top-level navigation history, reading-list entries, and per-URL tab organization metadata under the local OpenFish data directory. It is local-first; history and bookmarks are not uploaded to the Cloudflare relay. Library mutations are available through REST and MCP tools, with explicit approval required for removals, history clearing, and tab organization. Grouping is metadata-based for Playwright tabs and is not native Chromium tab-group UI.


## Diagnostics and recovery (v2.3.0)
Diagnostics are attached to Playwright pages and held in bounded in-memory buffers (100 events per page). They omit URL query strings and fragments. Page content extraction and performance inspection are read-only. Recently closed tabs are retained in the session memory (up to 10); restoring a tab requires explicit approval. Diagnostics and recovery state are not uploaded to the relay or persisted across bridge restarts.


## Workspaces, downloads, and privacy (v2.4.0)
Workspace snapshots persist only public tab URLs and titles; restore creates new tabs and does not attempt to restore cookies, form values, or in-memory page state. Managed downloads are written beneath `.openfish/downloads`, use sanitized generated filenames, require an explicitly approved unique visible link, and are capped at 25 MB per file and 500 MB total managed files. Deleting a managed download checks that its stored path remains inside the managed directory. Session privacy clearing requires approval and clears cookies plus per-page web storage/cache/service-worker/IndexedDB data in the selected isolated browser context. It does not clear the separate OpenFish browser library.


## Command center and portable backups (v2.5.0)
The side-panel command palette is a local UI feature. Browser-library export includes only local library records and workspace metadata; it excludes cookies, browser session credentials, and downloaded file contents/paths. Import is a merge operation, capped at 1 MB, with every URL revalidated through the shared public HTTP(S) URL validator. The import endpoint requires explicit approval.
