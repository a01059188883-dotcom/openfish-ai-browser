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
