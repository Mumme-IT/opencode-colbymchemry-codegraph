import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { execFile, spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SKILLS_DIR = resolve(__dirname, "..", "skills")

type CodeGraphState = "ready" | "initializing" | "syncing" | "needs_init" | "missing_binary" | "error"
type AutoInitMode = "always" | "ask" | "never"

interface PluginOptions {
  autoInit?: AutoInitMode | boolean
  autoSync?: boolean
  codegraphCommand?: string
  injectMcp?: boolean
  slimMcp?: boolean
  syncDebounceMs?: number
}

interface ResolvedOptions {
  autoInit: AutoInitMode
  autoSync: boolean
  command: string
  injectMcp: boolean
  slimMcp: boolean
  syncDebounceMs: number
}

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

type CodeGraphMcpConfig = Record<string, unknown>

const STATE_DIR = join(homedir(), ".local", "state", "opencode", "colbymchenry-codegraph")
const STATUS_DIR = join(STATE_DIR, "projects")
const LEGACY_STATUS_FILE = join(STATE_DIR, "status.json")
const GLOBAL_OPENCODE_CONFIG = join(homedir(), ".config", "opencode", "opencode.json")
const DEFAULT_SYNC_DEBOUNCE_MS = 4_000
const EDIT_TOOL_NAMES = new Set(["edit", "write", "patch", "apply_patch"])
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const MCP_EXTENSION_KEYS = new Set(["slim"])

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true })
}

function normalizeOptions(options: PluginOptions = {}, project = process.cwd()): ResolvedOptions {
  return {
    autoInit: normalizeAutoInit(options.autoInit),
    autoSync: options.autoSync !== false,
    command: options.codegraphCommand ?? findBundledCodeGraphCommand(project) ?? "codegraph",
    injectMcp: options.injectMcp !== false,
    slimMcp: options.slimMcp === true,
    syncDebounceMs: options.syncDebounceMs ?? DEFAULT_SYNC_DEBOUNCE_MS,
  }
}

function defaultCodeGraphMcpConfig(options: ResolvedOptions): CodeGraphMcpConfig {
  const config: CodeGraphMcpConfig = {
    type: "local",
    command: [options.command, "serve", "--mcp"],
    enabled: true,
  }
  if (options.slimMcp) config.slim = true
  return config
}

function mergeCodeGraphMcpConfig(current: unknown, options: ResolvedOptions): CodeGraphMcpConfig {
  const defaults = defaultCodeGraphMcpConfig(options)
  if (!isObjectRecord(current)) return defaults
  return { ...defaults, ...stripMcpExtensionKeys(current) }
}

function stripMcpExtensionKeys(config: Record<string, unknown>): CodeGraphMcpConfig {
  const sanitized = { ...config }
  for (const key of MCP_EXTENSION_KEYS) delete sanitized[key]
  return sanitized
}

function hasSupportedSlimMcpConfig(project: string): boolean {
  let isSupported: boolean | undefined
  for (const path of configPaths(project)) {
    isSupported = readCodeGraphSlimSupport(path) ?? isSupported
  }
  return isSupported === true
}

function configPaths(project: string): string[] {
  return uniquePaths([GLOBAL_OPENCODE_CONFIG, join(project, "opencode.json")])
}

function readCodeGraphSlimSupport(path: string): boolean | undefined {
  if (!existsSync(path)) return undefined
  try {
    const config = tryParseJson(readFileSync(path, "utf8"))
    const codegraph = config?.mcp?.codegraph
    if (!isObjectRecord(codegraph)) return undefined
    if (codegraph.slim !== true) return false
    return hasMcpTransport(codegraph)
  } catch {
    return undefined
  }
}

function hasMcpTransport(config: Record<string, unknown>): boolean {
  if (config.type === "remote") return typeof config.url === "string"
  if (config.type === "local") return hasMcpCommand(config)
  return typeof config.url === "string" || hasMcpCommand(config)
}

function hasMcpCommand(config: Record<string, unknown>): boolean {
  return Array.isArray(config.command) || typeof config.command === "string"
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function findBundledCodeGraphCommand(project: string): string | undefined {
  for (const directory of bundledBinDirectories(project)) {
    const command = join(directory, codeGraphExecutableName())
    if (existsSync(command)) return command
  }
  return undefined
}

function bundledBinDirectories(project: string): string[] {
  return uniquePaths([
    ...moduleBinDirectories(),
    join(project, "node_modules", ".bin"),
    join(process.cwd(), "node_modules", ".bin"),
  ])
}

function moduleBinDirectories(): string[] {
  const directories: string[] = []
  let current = MODULE_DIR
  for (let depth = 0; depth < 5; depth++) {
    directories.push(join(current, "node_modules", ".bin"))
    directories.push(join(current, ".bin"))
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }
  return directories
}

function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths)]
}

function codeGraphExecutableName(): string {
  return process.platform === "win32" ? "codegraph.cmd" : "codegraph"
}

function normalizeAutoInit(value: PluginOptions["autoInit"]): AutoInitMode {
  if (value === true) return "always"
  if (value === false) return "never"
  return value ?? "always"
}

function hasCodeGraphIndex(project: string): boolean {
  return existsSync(join(project, ".codegraph"))
}

function hasCodeGraphConfig(project: string): boolean {
  const configPath = join(project, "codegraph.json")
  if (!existsSync(configPath)) return false
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"))
    return config?.enabled === true
  } catch {
    return false
  }
}

function projectStatusKey(project: string): string {
  return createHash("sha256").update(project).digest("hex")
}

function statusFile(project: string): string {
  return join(STATUS_DIR, `${projectStatusKey(project)}.json`)
}

function readStatusFile(path: string): StatusFile | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return undefined
  }
}

function loadLegacyStatus(project: string): StatusFile | undefined {
  const legacy = readStatusFile(LEGACY_STATUS_FILE)
  return legacy?.project === project ? legacy : undefined
}

function loadStatus(project: string): StatusFile {
  return readStatusFile(statusFile(project))
    ?? loadLegacyStatus(project)
    ?? status(project, "needs_init", "CodeGraph not checked yet")
}

function status(project: string, state: CodeGraphState, message: string): StatusFile {
  return { project, state, message, updatedAt: Date.now() }
}

function readyStatus(project: string, current?: Partial<StatusFile>): StatusFile {
  return { ...current, ...status(project, "ready", "CodeGraph ready") }
}

function writeStatus(next: StatusFile): void {
  const path = statusFile(next.project)
  ensureDir(dirname(path))
  writeFileSync(path, JSON.stringify(next, null, 2), "utf8")
}

function shortText(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, " ")
  return trimmed.length > 240 ? `${trimmed.slice(0, 237)}...` : trimmed
}

function stripAnsi(text: string): string {
  return text.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

function parseNumber(label: string, text: string): number | undefined {
  const match = text.match(new RegExp(`^\\s*${escapeRegExp(label)}\\s*:\\s*(\\d+)`, "im"))
  return match ? Number(match[1]) : undefined
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function parseTextField(label: string, text: string): string | undefined {
  const match = text.match(new RegExp(`^\\s*${escapeRegExp(label)}\\s*:\\s*(.+)$`, "im"))
  return match?.[1]?.trim()
}

function parseNamedCounts(heading: string, text: string): Record<string, number> | undefined {
  const counts: Record<string, number> = {}
  let active = false
  for (const line of text.split("\n")) {
    if (line.trim().startsWith(heading)) {
      active = true
      continue
    }
    if (active && !parseCountLine(line, counts)) break
  }
  return Object.keys(counts).length ? counts : undefined
}

function parseCountLine(line: string, counts: Record<string, number>): boolean {
  if (!line.trim()) return false
  const match = line.trim().match(/^([\w:-]+)\s+(\d+)$/)
  if (!match) return false
  counts[match[1]] = Number(match[2])
  return true
}

function parseStatusOutput(project: string, output: string): StatusFile {
  const parsed = tryParseJson(output)
  if (parsed) return fromJsonStatus(project, parsed)
  const text = stripAnsi(output)
  const next = readyStatus(project)
  next.files = parseNumber("files", text)
  next.symbols = parseNumber("symbols", text) ?? parseNumber("nodes", text)
  next.edges = parseNumber("edges", text)
  next.databaseSize = parseTextField("DB Size", text)
  next.backend = parseTextField("Backend", text)
  next.journal = parseTextField("Journal", text)
  next.nodesByKind = parseNamedCounts("Nodes by Kind", text)
  next.filesByLanguage = parseNamedCounts("Files by Language", text)
  return next
}

function tryParseJson(text: string): any | null {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function fromJsonStatus(project: string, value: any): StatusFile {
  const next = readyStatus(project)
  next.files = numericField(value, ["files", "fileCount"])
  next.symbols = numericField(value, ["symbols", "symbolCount", "nodes"])
  next.edges = numericField(value, ["edges", "edgeCount"])
  next.databaseSize = textField(value, ["databaseSize", "dbSize"])
  next.backend = textField(value, ["backend"])
  next.journal = textField(value, ["journal", "journalMode"])
  next.nodesByKind = countMapField(value, ["nodesByKind", "nodeKinds"])
  next.filesByLanguage = countMapField(value, ["filesByLanguage", "languages"])
  return next
}

function numericField(value: any, names: string[]): number | undefined {
  for (const name of names) {
    const found = value?.[name]
    if (typeof found === "number") return found
  }
  return undefined
}

function textField(value: any, names: string[]): string | undefined {
  for (const name of names) {
    const found = value?.[name]
    if (typeof found === "string") return found
  }
  return undefined
}

function countMapField(value: any, names: string[]): Record<string, number> | undefined {
  for (const name of names) {
    const found = value?.[name]
    if (isCountMap(found)) return found
  }
  return undefined
}

function isCountMap(value: unknown): value is Record<string, number> {
  if (!value || typeof value !== "object") return false
  return Object.values(value).every((count) => typeof count === "number")
}

function getToolName(input: any): string {
  return input?.tool ?? input?.name ?? input?.properties?.tool ?? ""
}

function isMutatingTool(input: any): boolean {
  const name = getToolName(input)
  if (EDIT_TOOL_NAMES.has(name)) return true
  if (name !== "bash") return false
  return mutatesViaShell(String(input?.args?.command ?? ""))
}

function mutatesViaShell(command: string): boolean {
  return /\b(git\s+(pull|checkout|switch|merge|rebase|apply)|npm\s+(install|update)|bun\s+(install|update))\b/.test(command)
}

function execCodeGraph(command: string, args: string[], cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { cwd, timeout: 15_000 }, (error, stdout, stderr) => {
      if (error) reject(new Error(shortText(stderr || error.message)))
      else resolve(stdout)
    })
  })
}

class CodeGraphController {
  private timer: ReturnType<typeof setTimeout> | undefined
  private running = false

  constructor(private project: string, private options: ResolvedOptions) {}

  async start(): Promise<void> {
    if (!hasCodeGraphConfig(this.project)) {
      writeStatus(status(this.project, "needs_init", 'Add codegraph.json { "enabled": true } to activate'))
      return
    }
    if (!(await this.hasBinary())) return
    if (hasCodeGraphIndex(this.project)) await this.refreshStatus()
    else this.handleMissingIndex()
  }

  scheduleSync(reason: string): void {
    if (!this.options.autoSync) return
    clearTimeout(this.timer)
    this.timer = setTimeout(() => void this.sync(reason), this.options.syncDebounceMs)
  }

  async init(reason = "manual"): Promise<string> {
    if (this.running) return "CodeGraph already busy."
    this.runLongTask("initializing", ["init", "-i"], `Initializing (${reason})`)
    return "CodeGraph initialization started."
  }

  async sync(reason = "manual"): Promise<string> {
    if (this.running) return "CodeGraph already busy."
    if (!hasCodeGraphIndex(this.project)) return this.init(reason)
    this.runLongTask("syncing", ["sync"], `Syncing (${reason})`)
    return "CodeGraph sync started."
  }

  currentStatus(): StatusFile {
    return loadStatus(this.project)
  }

  private async hasBinary(): Promise<boolean> {
    try {
      await execCodeGraph(this.options.command, ["--version"], this.project)
      return true
    } catch (error) {
      writeStatus(status(this.project, "missing_binary", String(error)))
      return false
    }
  }

  private handleMissingIndex(): void {
    if (this.options.autoInit === "always") void this.init("startup")
    else writeStatus(status(this.project, "needs_init", "Run codegraph init -i"))
  }

  private async refreshStatus(): Promise<void> {
    try {
      const output = await execCodeGraph(this.options.command, ["status"], this.project)
      writeStatus(parseStatusOutput(this.project, output))
    } catch (error) {
      writeStatus(readyStatus(this.project, this.currentStatus()))
    }
  }

  private runLongTask(state: "initializing" | "syncing", args: string[], message: string): void {
    this.running = true
    writeStatus(status(this.project, state, message))
    const child = spawn(this.options.command, args, { cwd: this.project, stdio: ["ignore", "pipe", "pipe"] })
    this.watchProcess(child, state)
  }

  private watchProcess(child: ReturnType<typeof spawn>, state: "initializing" | "syncing"): void {
    let stderr = ""
    child.stderr?.on("data", (chunk) => { stderr += String(chunk) })
    child.on("error", (error) => this.finishWithError(error))
    child.on("close", (code) => void this.finishProcess(code, state, stderr))
  }

  private async finishProcess(code: number | null, state: CodeGraphState, stderr: string): Promise<void> {
    this.running = false
    if (code === 0) return this.finishSuccess(state)
    writeStatus(status(this.project, "error", shortText(stderr || `codegraph exited ${code}`)))
  }

  private async finishSuccess(state: CodeGraphState): Promise<void> {
    await this.refreshStatus()
    const current = this.currentStatus()
    if (state === "syncing") current.lastSyncAt = Date.now()
    writeStatus(current)
  }

  private finishWithError(error: Error): void {
    this.running = false
    writeStatus(status(this.project, "error", shortText(error.message)))
  }
}

function formatStatus(file: StatusFile): string {
  const lines = [`State: ${file.state}`, `Project: ${file.project}`, `Message: ${file.message}`]
  if (file.files !== undefined) lines.push(`Files: ${file.files}`)
  if (file.symbols !== undefined) lines.push(`Symbols: ${file.symbols}`)
  return lines.join("\n")
}

function createStatusTool(controller: CodeGraphController) {
  return tool({
    description: "Show CodeGraph plugin state for current project.",
    args: {},
    async execute(_args, ctx) {
      ctx.metadata({ title: "codegraph plugin status" })
      return formatStatus(controller.currentStatus())
    },
  })
}

function createInitTool(controller: CodeGraphController) {
  return tool({
    description: "Initialize CodeGraph for current project and build index.",
    args: {},
    async execute(_args, ctx) {
      ctx.metadata({ title: "codegraph init" })
      return controller.init("tool")
    },
  })
}

function createSyncTool(controller: CodeGraphController) {
  return tool({
    description: "Synchronize current project's CodeGraph index.",
    args: {},
    async execute(_args, ctx) {
      ctx.metadata({ title: "codegraph sync" })
      return controller.sync("tool")
    },
  })
}

function reminder(file: StatusFile): string {
  if (file.state === "ready") return "Use CodeGraph MCP tools before grep/read for architecture or impact questions. Load skill `mcp-codegraph` to see available tools."
  if (file.state === "missing_binary") return "CodeGraph binary missing. Install @colbymchenry/codegraph."
  if (file.state === "needs_init") return `CodeGraph not ready: ${file.message} Load skill \`codegraph-plugin\` for setup steps.`
  return `CodeGraph state: ${file.state}. ${file.message}`
}

const CodeGraphPlugin: Plugin = async (input, rawOptions) => {
  const options = normalizeOptions(rawOptions as PluginOptions, input.directory)
  const controller = new CodeGraphController(input.directory, options)
  const isSlimManaged = hasSupportedSlimMcpConfig(input.directory)
  await controller.start()

  return {
    config: async (cfg: any) => {
      cfg.skills = cfg.skills || {}
      cfg.skills.paths = cfg.skills.paths || []
      if (!cfg.skills.paths.includes(SKILLS_DIR)) {
        cfg.skills.paths.push(SKILLS_DIR)
      }

      if (!options.injectMcp) return
      cfg.mcp = cfg.mcp || {}
      if (isSlimManaged) {
        delete cfg.mcp.codegraph
        return
      }
      cfg.mcp.codegraph = mergeCodeGraphMcpConfig(cfg.mcp.codegraph, options)
    },
    tool: {
      "codegraph-plugin-status": createStatusTool(controller),
      "codegraph-plugin-init": createInitTool(controller),
      "codegraph-plugin-sync": createSyncTool(controller),
    },
    "tool.execute.after": async (event: any) => {
      if (isMutatingTool(event)) controller.scheduleSync(getToolName(event))
    },
    "experimental.chat.system.transform": async (_input, output) => {
      output.system.push(`<system-reminder>${reminder(controller.currentStatus())}</system-reminder>`)
    },
  }
}

export { CodeGraphPlugin }
export default CodeGraphPlugin
