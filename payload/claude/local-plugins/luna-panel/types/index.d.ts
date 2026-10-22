// Shapes produced by ~/.claude/scripts/luna-overview.mjs (v1) and read by the pane.

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
  /** Seconds since the job's log last grew (null: no log). */
  idleS?: number | null
  /** What the agent is doing now, from the tail of its log. */
  activity?: { kind: 'command' | 'thinking' | 'editing' | 'writing' | 'starting' | 'queued' | 'unknown'; text: string; sinceS: number }
}

/**
 * A Claude session's heartbeat, written by the luna-panel plugin of THAT session to
 * ~/.claude/luna-run/sessions/<sessionId>.json and read by every session's pane (via the collector).
 */
export type SessionBeat = {
  v: 1
  sessionId: string
  /** Folder name of the session's cwd; '' for a session with no project folder. */
  name: string
  cwd: string
  /** ms epoch of the last write; the collector drops beats older than 15 min. */
  updatedAt: number
  /** What Claude itself is doing in that session now. */
  state: 'thinking' | 'tool' | 'idle'
  /** For state 'tool': the tool and a short detail (a Bash command's first line, a file name, an agent description). */
  tool: { name: string; detail: string; since: number } | null
  /** When the current turn began (0 when idle); idleSince when the last turn ended. */
  turnSince: number
  idleSince: number
  /** Claude subagents currently running in that session. */
  agents: { id: string; description: string; since: number }[]
}

export type Snapshot = {
  v: number
  at: string
  ram: { freeMb: number; totalMb: number }
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
  build: { line: string; building: boolean; exeAt: string | null } | null
  /** Heartbeats of every live Claude session (collector v1 + sessions). */
  sessions?: SessionBeat[]
}

export type ClaudeLimit = { kind: string; percentUsed: number; resetsAt?: string }

export type PanelData = {
  snapshot: Snapshot | null
  claude: ClaudeLimit[]
  error: string
  polledAt: number
  sessionId: string
  /** Heartbeat diagnostics: '' ok, else why this session's beat was not sent. */
  beatNote?: string
}

/** Which cards are collapsed, by card id (memory, limits, daemon, jobs, build). */
export type Collapsed = Record<string, boolean>

declare module 'claude-code' {
  interface PluginState {
    'luna-panel': { data: PanelData; collapsed: Collapsed }
  }
}
