---
name: codegraph-plugin
description: >
  Use when setting up codegraph for a project, enabling the codegraph plugin,
  initializing or syncing the index, or checking plugin status.
  Triggers on: codegraph-plugin-init, codegraph-plugin-sync, codegraph.json, enable codegraph.
---

# codegraph-plugin

## Opt-in

Plugin only activates when `codegraph.json` exists at project root with `enabled: true`:

```json
{ "enabled": true }
```

Without this file, plugin is dormant — no auto-init, no status tracking, no MCP tools.

## Tools

| Tool | Action |
|---|---|
| `codegraph-plugin-status` | Check current index state |
| `codegraph-plugin-init` | Initialize index (creates `.codegraph/`) |
| `codegraph-plugin-sync` | Re-index after code changes |

## Workflow

1. Create `codegraph.json` at project root: `{ "enabled": true }`
2. Run `codegraph-plugin-init`
3. Once state is `ready`, load skill `mcp-codegraph` and use MCP tools

## States

| State | Meaning |
|---|---|
| `ready` | Index up-to-date, MCP tools available |
| `needs_init` | `.codegraph/` missing — run `codegraph-plugin-init` |
| `initializing` | Init in progress |
| `syncing` | Sync in progress |
| `missing_binary` | Install `@colbymchenry/codegraph` globally |
| `error` | Check status message for details |
