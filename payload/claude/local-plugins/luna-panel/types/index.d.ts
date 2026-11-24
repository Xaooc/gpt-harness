// Shapes read from the Luna collector snapshot and the explicit CLI status action.

export type LimitWindow = { usedPercent: number; windowMins: number | null; resetsAt: string | null }

export type CodexLimits = {
  v: number
  at: string
  ageS: number
  planType: string | null
  reached: string | null
  primary: LimitWindow | null
  secondary: LimitWindow | null
}

/** One registered Codex account, in preference order. `active` is the account the next Codex job starts on. */
export type CodexAccount = {
  id: string
  label: string
  active: boolean
  loggedIn: boolean
  /** Past the threshold, held by hysteresis, or marked (quota/auth) until `mark.until`. */
  exhausted: boolean
  /** Fresh limits were read (≤ 30 min old). */
  known: boolean
  reason: string | null
  mark: { reason: string; until: string } | null
  limits: CodexLimits | null
}

export type DaemonJob = {
  id: string
  state: string
  model: string
  effort: string
  sandbox: string
  owner: string
  ageS: number
  cwd: string
  reason: string
}

export type Job = {
  out: string
  state: string
  model: string
  effort: string
  sandbox: string
  engine: string
  ageS: number
  dir: string
  error: string
  queuePos: number | null
  owner: string
  /** `codex` (Sol, Luna), `mlai` (ML AI Code) or `gemini`; absent from older collectors (then Codex). */
  provider?: string
  /** The executor account when it is not the main one. */
  account?: string
  idleS?: number | null
  activity?: { kind: 'command' | 'thinking' | 'editing' | 'writing' | 'starting' | 'queued' | 'unknown'; text: string; sinceS: number }
}

export type SessionBeat = {
  v: 1
  sessionId: string
  name: string
  cwd: string
  updatedAt: number
  state: 'thinking' | 'tool' | 'idle'
  tool: { name: string; detail: string; since: number } | null
  turnSince: number
  idleSince: number
  agents: { id: string; description: string; since: number }[]
  /** The session's step list (desktop update_plan / CLI TodoWrite), when it has one. */
  plan?: {
    total: number
    done: number
    current: string | null
    items: { content: string; status: 'pending' | 'in_progress' | 'completed' }[]
    updatedAt: number
  } | null
  /** Background shell commands and monitors still running in the session. */
  background?: { id: string; kind: 'command' | 'monitor' | 'executor'; text: string; since: number }[]
  limits?: ClaudeLimit[]
}

export type ChainEntry = {
  provider: string
  model: string
  effort: string
  available: boolean
  reason: string
  selected?: boolean
}

export type Seat = ChainEntry & { seat: number }

export type CatalogModel = { model: string; efforts: string[] }

export type Orchestration = {
  chains: Record<string, ChainEntry[]>
  panels: Record<string, Seat[]>
  threshold: {
    switch_percent: number; hysteresis_percent: number; windows: string[]
    /** Every account is past the threshold: Codex jobs go to the next executor (Claude). */
    switched: boolean
    active?: string | null
  }
  marks: Record<string, { until: string; reason: string }>
  presets: { name: string; label: string }[]
  catalog: Record<string, CatalogModel[]>
  configError: string | null
}

export type Switch = { at: string; tier: string; from: string; to: string; reason: string }

export type QuotaBucket = { name: string; model?: string; usedPercent?: number; remainingFraction?: number; resetAt?: string }

export type GeminiState = {
  available: boolean
  reason: string
  tokensToday: number
  jobsToday: number
  /** From conveyor/gemini-quota.mjs when the collector provides it. */
  quota?: { available: boolean; buckets: QuotaBucket[]; at?: string; reason?: string; lastExhaustedAt?: string | null } | null
  mcp: {
    configured: boolean
    activeItems?: number
    adaptiveLimit?: number
    configuredLimit?: number
    at?: string
  } | null
}

/** One ML AI Code account: its own sign-in, two session slots and, optionally, its own VPN exit (proxy). */
export type MlaiAccount = {
  id: string
  label: string
  home?: string
  proxy?: string | null
  signedIn: boolean
  expiresAt: string | null
  reason: string | null
  slots: { limit: number; used: number; holders?: { index: number; out: string | null; at: string | null }[] }
  mark: { reason: string; until: string } | null
}

/** ML AI Code (`mlai`): sign-in, the session slots, today's jobs. Billed in credits, not tokens. The top-level fields
 *  sum every account; `accounts` is absent from collectors older than the multi-account release. */
export type MlaiState = {
  installed: boolean
  signedIn: boolean
  /** When the device sign-in expires (7 days after `mlai login`). */
  expiresAt: string | null
  /** 'not installed' | 'not signed in' | 'sign-in expired' | null */
  reason: string | null
  slots: { limit: number; used: number; holders: { index: number; out: string; at: string }[] }
  /** Whether a chain entry on mlai would run now, and why not. */
  available: boolean
  availability: string
  mark: { reason: string; until: string } | null
  jobsToday: number
  creditsToday: number
  accounts?: MlaiAccount[]
}

export type ProviderTokens ={ total: number; input?: number; output?: number; cached?: number }

export type Usage = {
  at?: string
  stale?: boolean
  today?: { claude?: ProviderTokens; codex?: ProviderTokens; gemini?: ProviderTokens }
  week?: { claude?: ProviderTokens; codex?: ProviderTokens; gemini?: ProviderTokens }
  days?: { date: string; claude?: number | ProviderTokens; codex?: number | ProviderTokens; gemini?: number | ProviderTokens }[]
  byModel7d?: { provider: string; model: string; total: number }[]
  byProject7d?: { project: string; total: number; provider?: string; claude?: number; codex?: number; gemini?: number }[]
  topJobs?: { provider: string; model?: string; name: string; project?: string; total: number; at?: string }[]
  notes?: string[]
}

export type SectionName = 'ram' | 'daemon' | 'jobs' | 'sessions' | 'codexLimits' | 'orchestration' | 'usage' | 'gemini' | 'mlai' | 'cli' | 'catalog'

export type SectionStatus = {
  attemptAt: string | null
  okAt: string | null
  staleAfterMs: number
  status: 'ok' | 'stale' | 'error' | 'unavailable'
  reason: string | null
}

export type Snapshot = {
  v: number
  version: 2
  at: string
  collector: { pid: number; instance: string; seq: number; publishedAt: string }
  sections: Record<SectionName, SectionStatus>
  cli: CliStatus | null
  claudeLimits: SharedClaudeLimit[]
  truncated?: true
  ram: { freeMb: number | null; totalMb: number | null }
  daemon: {
    running: boolean
    healthy?: boolean
    appServer?: string | null
    pid?: number
    uptimeS?: number
    max?: number | null
    runningJobs?: number
    queuedJobs?: number
    owners?: { owner: string; running: number; queued: number }[]
    jobs?: DaemonJob[]
  }
  jobs: Job[]
  codexLimits: CodexLimits | null
  /** Every registered account; absent from collectors older than the two-account release. */
  codexAccounts?: CodexAccount[] | null
  build: { line: string; building: boolean; exeAt: string | null } | null
  sessions?: SessionBeat[]
  orchestration?: Orchestration | null
  switches?: Switch[]
  gemini?: GeminiState | null
  /** Absent from collectors older than the ML AI Code release. */
  mlai?: MlaiState | null
  usage?: Usage | null
}

export type ClaudeLimit = { kind: string; percentUsed: number; resetsAt?: string | null }
export type SharedClaudeLimit = ClaudeLimit & { resetsAt: string | null; observedAt: string; sessionId: string }

export type CliStatus = {
  codex?: {
    installed?: string | null
    latest?: string | null
    expectedByHarness?: string | null
    updateAvailable?: boolean
    busy?: { jobs: number; reason: string } | null
  }
  agy?: {
    installed?: string | null
    sha256?: string | null
    checksumOk?: boolean
    latest?: string | null
    latestUrl?: string | null
    updateAvailable?: boolean
    busy?: { jobs: number; reason: string } | null
    rollbackAvailable?: boolean
    reason?: string
  }
  checkedAt?: string
}

export type PanelData = {
  snapshot: Snapshot | null
  claude: ClaudeLimit[]
  error: string
  polledAt: number
  sessionId: string
  beatNote?: string
}

export type Collapsed = Record<string, boolean>

/** Which tab is open, which tier's inline editor is open, the job filter, a pending confirmation and the last result. */
export type View = {
  tab: 'overview' | 'usage' | 'settings' | 'updates'
  editTier: string | null
  filter: 'all' | 'mlai' | 'codex' | 'gemini' | 'claude'
  confirm: { key: string; until: number } | null
  busy: string | null
  note: { text: string; level: 'success' | 'warning' | 'error'; at: number } | null
  cli: CliStatus | null
  draftModel: string
  draftProvider: string
  draftEfforts: string
  presetName: string
}

declare module 'claude-code' {
  interface PluginState {
    'luna-panel': { data: PanelData; collapsed: Collapsed; view: Shaped<View> }
  }
}
