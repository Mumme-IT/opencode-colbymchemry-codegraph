# opencode-colbymchemry-codegraph

OpenCode server + TUI plugin for `@colbymchenry/codegraph` MCP setup, index sync, and status visibility.

## Commands

| Task | Command |
|---|---|
| Typecheck | `npm run typecheck` |
| Build | `npm run build` |
| Package preview | `npm pack --dry-run` |

## Release Flow

- Bump `version` in `package.json` and `package-lock.json`.
- Commit release changes.
- Create matching tag: `git tag vX.Y.Z`.
- Push branch and tag: `git push && git push origin vX.Y.Z`.
- GitHub Actions publishes tagged releases to npm.
- Do not run `npm publish` locally.

## Notes

- Publish workflow: `.github/workflows/publish.yml`.
- Tag format: `v*`.
- Workflow runs typecheck, sets package version from tag, builds, then publishes.
