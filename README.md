# opencode-colbymchemry-codegraph

OpenCode server + TUI plugin for [colbymchenry/codegraph](https://github.com/colbymchenry/codegraph).

## Features

| Layer | Behavior |
|---|---|
| Server plugin | Injects CodeGraph MCP config, initializes missing repo index, syncs after edit-like tools |
| TUI plugin | Shows CodeGraph state in sidebar: ready, initializing, syncing, missing binary, error |
| Native tools | `codegraph-plugin-status`, `codegraph-plugin-init`, `codegraph-plugin-sync` |

## Install

Add server plugin to `opencode.json`:

```json
{
  "plugin": ["opencode-colbymchemry-codegraph"]
}
```

Add TUI plugin to `tui.json`:

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["opencode-colbymchemry-codegraph/tui"]
}
```

No `npm install` step required. opencode resolves plugin packages from config.

The plugin depends on `@colbymchenry/codegraph` and prefers its bundled binary. Set `codegraphCommand` only to use a custom binary.

Restart opencode after config changes.

## Options

Tuple form:

```json
{
  "plugin": [
    [
      "opencode-colbymchemry-codegraph",
      {
        "autoInit": "always",
        "autoSync": true,
        "injectMcp": true,
        "codegraphCommand": "codegraph",
        "syncDebounceMs": 4000
      }
    ]
  ]
}
```

| Option | Default | Description |
|---|---:|---|
| `autoInit` | `"always"` | `"always"`, `"ask"`, `"never"`; `true` maps to `"always"`, `false` maps to `"never"` |
| `autoSync` | `true` | Debounced `codegraph sync` after edit/write/patch and common mutating shell commands |
| `injectMcp` | `true` | Adds `mcp.codegraph` with `codegraph serve --mcp` |
| `codegraphCommand` | bundled binary, then `"codegraph"` | Custom binary name or absolute path |
| `syncDebounceMs` | `4000` | Delay before post-edit sync |

## Status File

Server plugin writes:

```text
~/.local/state/opencode/colbymchenry-codegraph/status.json
```

TUI plugin reads same file via OpenCode file API, so it works for local and remote TUI sessions.

## Development

```sh
npm install
bun run build
```

Local server plugin output is copied to `.opencode/plugins/codegraph.js` after build.
