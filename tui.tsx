import type { TuiPlugin, TuiPluginApi, TuiPluginModule } from "@opencode-ai/plugin/tui"
import { createHash } from "node:crypto"
import { createMemo, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"

type CodeGraphState = "ready" | "initializing" | "syncing" | "needs_init" | "missing_binary" | "error"
type ThemeColor = TuiPluginApi["theme"]["current"]["text"]

interface StatusFile {
  project: string
  state: CodeGraphState
  message: string
  updatedAt: number
  lastSyncAt?: number
  files?: number
  symbols?: number
  edges?: number
  databaseSize?: string
  backend?: string
  journal?: string
  nodesByKind?: Record<string, number>
  filesByLanguage?: Record<string, number>
}

const STATUS_REL_DIR = "colbymchenry-codegraph/projects"
const LEGACY_STATUS_REL_PATH = "colbymchenry-codegraph/status.json"
const POLL_INTERVAL_MS = 2_000

function projectStatusKey(project: string): string {
  return createHash("sha256").update(project).digest("hex")
}

function statusRelativePath(project: string): string {
  return `${STATUS_REL_DIR}/${projectStatusKey(project)}.json`
}

async function readStatusFile(api: TuiPluginApi, path: string): Promise<StatusFile | null> {
  try {
    const stateDir = (api.state as any).path?.state
    if (!stateDir) return null
    const result = await (api.client.file as any).read({ path, directory: stateDir })
    const content = result?.data?.content
    return typeof content === "string" ? JSON.parse(content) : null
  } catch {
    return null
  }
}

async function readLegacyStatus(api: TuiPluginApi, project: string): Promise<StatusFile | null> {
  const legacy = await readStatusFile(api, LEGACY_STATUS_REL_PATH)
  return legacy?.project === project ? legacy : null
}

async function readStatus(api: TuiPluginApi): Promise<StatusFile | null> {
  const project = (api.state as any).path?.directory
  if (!project || typeof project !== "string") return null
  return await readStatusFile(api, statusRelativePath(project)) ?? await readLegacyStatus(api, project)
}

function relativeAge(timestamp?: number): string {
  if (!timestamp) return "never"
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  return `${Math.floor(minutes / 60)}h ago`
}

function stateLabel(state: CodeGraphState): string {
  if (state === "needs_init") return "Needs init"
  if (state === "missing_binary") return "Missing binary"
  return state[0].toUpperCase() + state.slice(1)
}

function countLabel(count: number | undefined, label: string): string | undefined {
  return typeof count === "number" ? `${count} ${label}` : undefined
}

function joinParts(parts: Array<string | undefined>): string {
  return parts.filter((part): part is string => Boolean(part)).join(" · ")
}

function statsLine(file: StatusFile): string {
  return joinParts([
    countLabel(file.files, "files"),
    countLabel(file.symbols, "nodes"),
    countLabel(file.edges, "edges"),
  ])
}

function countEntries(values: Record<string, number> | undefined): Array<[string, number]> {
  return values ? Object.entries(values) : []
}

function hasDetails(file: StatusFile | null): boolean {
  if (!file) return false
  return Boolean(statsLine(file) || file.databaseSize || file.backend || file.journal || file.nodesByKind || file.filesByLanguage)
}

function DetailLine(props: { label: string; value: string | number | undefined; muted: ThemeColor; text: ThemeColor }) {
  return (
    <Show when={props.value !== undefined && props.value !== ""}>
      <text fg={props.text} wrapMode="word">
        <span style={{ fg: props.muted }}>{props.label}: </span>{props.value}
      </text>
    </Show>
  )
}

function CountSection(props: { title: string; entries: Array<[string, number]>; muted: ThemeColor; text: ThemeColor }) {
  return (
    <Show when={props.entries.length > 0}>
      <box>
        <text fg={props.muted}>{props.title}</text>
        <For each={props.entries}>
          {([name, count]) => <text fg={props.text}>  {name}: {count}</text>}
        </For>
      </box>
    </Show>
  )
}

function StatusDetails(props: { file: StatusFile; muted: ThemeColor; text: ThemeColor }) {
  return (
    <box>
      <DetailLine label="Files" value={props.file.files} muted={props.muted} text={props.text} />
      <DetailLine label="Nodes" value={props.file.symbols} muted={props.muted} text={props.text} />
      <DetailLine label="Edges" value={props.file.edges} muted={props.muted} text={props.text} />
      <DetailLine label="DB size" value={props.file.databaseSize} muted={props.muted} text={props.text} />
      <DetailLine label="Backend" value={props.file.backend} muted={props.muted} text={props.text} />
      <DetailLine label="Journal" value={props.file.journal} muted={props.muted} text={props.text} />
      <CountSection title="Languages" entries={countEntries(props.file.filesByLanguage)} muted={props.muted} text={props.text} />
      <CountSection title="Node kinds" entries={countEntries(props.file.nodesByKind)} muted={props.muted} text={props.text} />
    </box>
  )
}

function View(props: { api: TuiPluginApi }) {
  const [status, setStatus] = createSignal<StatusFile | null>(null)
  const [open, setOpen] = createSignal(false)
  const theme = () => props.api.theme.current
  const subtitle = createMemo(() => {
    const current = status()
    if (!current) return "No status yet"
    if (current.state === "ready") return `Synced ${relativeAge(current.lastSyncAt ?? current.updatedAt)}`
    return current.message
  })

  const color = createMemo(() => {
    const state = status()?.state
    if (state === "ready") return theme().success
    if (state === "error" || state === "missing_binary") return theme().error
    if (state === "initializing" || state === "syncing") return theme().warning
    return theme().textMuted
  })

  const refresh = async () => setStatus(await readStatus(props.api))
  const toggleOpen = () => {
    if (hasDetails(status())) setOpen((current) => !current)
  }

  onMount(() => {
    void refresh()
    const interval = setInterval(() => void refresh(), POLL_INTERVAL_MS)
    onCleanup(() => clearInterval(interval))
  })

  onMount(() => {
    const off = props.api.event.on("tool.execute.after" as any, () => setTimeout(() => void refresh(), 300))
    onCleanup(off)
  })

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={toggleOpen}>
        <Show when={hasDetails(status())}>
          <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
        </Show>
        <text fg={color()}>•</text>
        <text fg={theme().text}>
          <b>CodeGraph</b>{" "}
          <span style={{ fg: theme().textMuted }}>
            <Switch fallback="Unknown">
              <Match when={status()}>{(file) => stateLabel(file().state)}</Match>
            </Switch>
          </span>
        </text>
      </box>
      <text fg={theme().textMuted} wrapMode="word">{subtitle()}</text>
      <Show when={open() && status()}>
        {(file) => <StatusDetails file={file()} muted={theme().textMuted} text={theme().text} />}
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 211,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: TuiPluginModule & { id: string } = {
  id: "colbymchenry-codegraph.sidebar",
  tui,
}

export default plugin
