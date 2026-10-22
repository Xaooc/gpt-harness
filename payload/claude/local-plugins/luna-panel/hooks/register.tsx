import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type { ClaudeLimit, Collapsed, Job, LimitWindow, PanelData, SessionBeat, Snapshot } from '../types'

// Live status of the Luna/Codex job system: RAM, Claude + Codex limits, the shared daemon, running jobs, the Codex build.
// Data: `node ~/.claude/scripts/luna-overview.mjs` (one JSON object) every POLL_MS, plus $.session.usage() for Claude limits.

const PANE = 'luna-panel'
const TITLE = 'Luna'
const POLL_MS = 5000
const EMPTY: PanelData = { snapshot: null, claude: [], error: '', polledAt: 0, sessionId: '' }
const data = atom({ plugin: 'luna-panel', key: 'data' } as const, EMPTY)
const collapsed = atom({ plugin: 'luna-panel', key: 'collapsed' } as const, { build: false } as Collapsed)

const STATE_RU: Record<string, string> = {
  running: 'работает',
  queued: 'в очереди',
  starting: 'старт',
  'waiting-daemon': 'ждёт место',
  'waiting-ram': 'ждёт память',
  'waiting-lock': 'ждёт старт',
}

function duration(totalS: number): string {
  const s = Math.max(0, Math.round(totalS))
  if (s < 60) return `${s}с`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}м`
  const h = Math.floor(m / 60)
  if (h < 48) return `${h}ч ${m % 60}м`
  return `${Math.floor(h / 24)}д ${h % 24}ч`
}

function resetsIn(iso: string | null | undefined, now: number): string {
  if (!iso) return ''
  const t = Date.parse(iso)
  return Number.isFinite(t) ? `сброс через ${duration((t - now) / 1000)}` : ''
}

function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} ГБ`
}

function modelLabel(model: string): string {
  if (/sol/i.test(model)) return 'Sol'
  if (/luna/i.test(model)) return 'Luna'
  return model || '—'
}

function jobName(out: string): string {
  const base = out.split(/[\\/]/).pop() ?? out
  return base.replace(/\.out\.md$|\.md$/i, '')
}

function severity(percentUsed: number): 'success' | 'warning' | 'error' {
  if (percentUsed >= 90) return 'error'
  if (percentUsed >= 70) return 'warning'
  return 'success'
}

function windowName(kind: string, mins: number | null | undefined): string {
  if (kind === 'five_hour' || mins === 300) return '5 часов'
  if (kind === 'seven_day' || mins === 10080) return 'неделя'
  if (kind === 'spend_limit') return 'бюджет'
  if (mins) return mins >= 1440 ? `${Math.round(mins / 1440)} д` : `${Math.round(mins / 60)} ч`
  return kind
}

let polling = false
let beatNote = ''
let pollStartedAt = 0
let ticker: { cancel: () => void } | null = null

// One poll at a time: under heavy load a run can take seconds, and stacked runs would only make it worse. A poll stuck
// for more than 20 s (a hung call) no longer blocks the next ones: the flag expires.
async function poll($: EngineInterface): Promise<void> {
  const now = Date.now()
  if (polling && now - pollStartedAt < 20_000) return
  polling = true
  pollStartedAt = now
  try { await pollOnce($) } finally { polling = false }
}

// The periodic poll is armed once per module load, from whichever entry point runs first: a mod loaded into a session
// that has already started never sees session.start. The tick only fires the poll; it never waits on it.
function ensureTicker($: EngineInterface): void {
  if (ticker) return
  ticker = $.clock.every(POLL_MS, () => { void tick($) })
}

// Every 5 s while the pane is on screen; otherwise every 20 s, enough for the status line and the heartbeat (state
// changes still poll at once through queueBeat). Four sessions polling every 5 s with nobody looking only cost RAM/CPU.
const IDLE_POLL_MS = 20_000

async function tick($: EngineInterface): Promise<void> {
  if ((await $.clock.now()) - lastPollAt < IDLE_POLL_MS) {
    let shown = false
    try { shown = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced && p.isShown) } catch {}
    if (!shown) return
  }
  await poll($)
}

async function pollOnce($: EngineInterface): Promise<void> {
  const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
  const sessionId = await currentSessionId($)
  const script = `${home.replace(/\\/g, '/')}/.claude/scripts/luna-overview.mjs`
  let snapshot: Snapshot | null = null
  let error = ''
  try {
    lastBeatPoll = Date.now()
    const payload = await beatPayload($)
    beatNote = payload ? '' : `нет ID сессии (${beatSessionId ? 'неподходящий: ' + beatSessionId.slice(0, 40) : 'пусто'})`
    const run = await $.process.run(['node', script, ...(payload ? ['--beat'] : [])],
      { timeoutMs: 12_000, ...(payload ? { stdin: payload } : {}) })
    if (run.exitCode === 0 && run.stdout.trim()) snapshot = JSON.parse(run.stdout) as Snapshot
    else error = (run.stderr || `exit ${run.exitCode}`).trim().slice(0, 200)
    if (payload && snapshot && !(snapshot.sessions ?? []).some(b => b.sessionId === beatSessionId)) {
      beatNote = 'пульс отправлен, но сборщик его не сохранил'
    }
  } catch (caught) {
    error = String((caught as Error)?.message ?? caught).slice(0, 200)
  }
  let claude: ClaudeLimit[] = []
  try {
    claude = (await $.session.usage()).rateLimits ?? []
    if (claude.length) lastLimits = claude
  } catch {
    // no reading yet
  }
  const polledAt = await $.clock.now()
  await update($, data, prev => ({
    snapshot: snapshot ?? prev?.snapshot ?? null,
    claude: claude.length > 0 ? claude : prev?.claude ?? [],
    error,
    polledAt,
    sessionId,
    beatNote,
  }))
  lastPollAt = polledAt
  if (!statusCleared) { // an earlier build pinned a one-line status under the prompt; the pane replaces it
    statusCleared = true
    $.ui.status(undefined)
  }
}

let statusCleared = false
let lastPollAt = 0
let closedByPerson = false

// ---- This session's heartbeat (read by every session's pane through the collector) -------------------------
// What Claude itself is doing here: thinking, running a tool, or waiting for the person; plus running subagents.
// Module state on purpose: it describes this process only and is rebuilt by the next events after a reload.
const beat: Omit<SessionBeat, 'v' | 'sessionId' | 'name' | 'cwd' | 'updatedAt'> & { cwd: string } = {
  state: 'idle', tool: null, turnSince: 0, idleSince: Date.now(), agents: [], cwd: '',
}
let beatSessionId = ''
// Claude rate limits as this session last read them, shared through the heartbeat (the tray widget shows them).
let lastLimits: ClaudeLimit[] = []

function oneLine(text: unknown, max = 80): string {
  const first = String(text ?? '').split(/\r?\n/)[0] ?? ''
  const clean = first.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

// A short, safe description of a tool call: never the full content, only what helps recognise the step.
function toolDetail(tool: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => String(p ?? '').split(/[\\/]/).pop() ?? ''
  if (tool === 'Bash' || tool === 'PowerShell') return oneLine(input.command)
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool)) return base(input.file_path ?? input.notebook_path)
  if (tool === 'Grep' || tool === 'Glob') return oneLine(input.pattern, 60)
  if (tool === 'Agent' || tool === 'Task') return oneLine(input.description, 60)
  if (tool === 'WebFetch') { try { return new URL(String(input.url)).host } catch { return '' } }
  if (tool === 'WebSearch') return oneLine(input.query, 60)
  return ''
}

// ---- What needs the person (the pane's top block and the band above the prompt) ----------------------------
type Alert = { level: 'error' | 'warning'; text: string }

function attentionItems(d: PanelData): Alert[] {
  const s = d.snapshot
  const out: Alert[] = []
  if (!s) return d.error ? [{ level: 'warning', text: 'Нет данных о Codex' }] : []
  const free = s.ram.freeMb
  if (free < 1024) out.push({ level: 'error', text: `Мало памяти: ${gb(free)} — новые задания ждут` })
  else if (free < 2048) out.push({ level: 'warning', text: `Памяти немного: ${gb(free)}` })
  for (const j of s.jobs) {
    if (j.state === 'running' && (j.idleS ?? 0) >= 900) {
      out.push({ level: 'error', text: `${modelLabel(j.model)} «${jobName(j.out)}» молчит ${duration(j.idleS ?? 0)} — похоже, завис` })
    }
  }
  const starved = s.jobs.filter(j => j.state === 'waiting-ram').length
  if (starved) out.push({ level: 'warning', text: `${starved} ${starved === 1 ? 'задание ждёт' : 'заданий ждут'} памяти` })
  if (s.daemon.running && s.daemon.healthy === false) out.push({ level: 'error', text: 'Демон Codex не отвечает' })
  else if (s.daemon.running && s.daemon.appServer === 'down') out.push({ level: 'warning', text: 'Codex перезапускается' })
  const limit = (label: string, pct: number) => {
    if (pct >= 90) out.push({ level: 'error', text: `Лимит ${label}: ${Math.round(pct)}%` })
    else if (pct >= 75) out.push({ level: 'warning', text: `Лимит ${label}: ${Math.round(pct)}%` })
  }
  for (const l of d.claude) if (l.kind !== 'spend_limit') limit(`Claude · ${windowName(l.kind, null)}`, l.percentUsed)
  const c = s.codexLimits
  if (c?.reached) out.push({ level: 'error', text: 'Лимит Codex исчерпан' })
  else {
    if (c?.primary) limit(`Codex · ${windowName('', c.primary.windowMins)}`, c.primary.usedPercent)
    if (c?.secondary) limit(`Codex · ${windowName('', c.secondary.windowMins)}`, c.secondary.usedPercent)
  }
  if (d.error) out.push({ level: 'warning', text: `Данные не обновляются: ${d.error.slice(0, 80)}` })
  return out.sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1))
}

// A shell command as a person would describe it: "запускает тесты", not "C:/…/sh.exe -c npx vitest run …".
function describeCommand(raw: string): { text: string; isRaw: boolean } {
  let cmd = raw.trim().replace(/^\S*?(?:sh|bash|pwsh|powershell)(?:\.exe)?\s+(?:-\w+\s+)*/i, '').replace(/^["']|["']$/g, '')
  cmd = cmd.replace(/^(?:cd\s+\S+\s*&&\s*)+/, '').trim()
  // Leading environment assignments (UV_CACHE_DIR=… TMPDIR=… uv run pytest) are not the command itself.
  cmd = cmd.replace(/^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '').trim()
  cmd = cmd.replace(/^(?:cd\s+\S+\s*&&\s*)+/, '').trim()
  const has = (re: RegExp) => re.test(cmd)
  if (has(/\b(pytest|vitest|jest|mocha|playwright test|cargo test|go test|node --test)\b|\b(npm|pnpm|yarn|bun) (run )?test/)) {
    return { text: 'запускает тесты', isRaw: false }
  }
  if (has(/\b(tsc|eslint|ruff|mypy|pyright|cargo (check|clippy)|biome|prettier --check)\b/)) {
    return { text: 'проверяет типы и стиль', isRaw: false }
  }
  if (has(/\b(npm|pnpm|yarn|bun) (install|ci|i|add)\b|\buv (sync|pip)\b|\bpip install\b/)) {
    return { text: 'ставит зависимости', isRaw: false }
  }
  if (has(/\b(vite build|webpack|cargo build|next build)\b|\b(npm|pnpm|yarn) (run )?build\b/)) {
    return { text: 'собирает проект', isRaw: false }
  }
  if (has(/^(rg|grep|fd|find)\b/)) return { text: 'ищет в коде', isRaw: false }
  if (has(/^(cat|sed -n|head|tail|wc|ls|type|nl)\b/)) return { text: 'читает файлы', isRaw: false }
  if (has(/^git\s+(\S+)/)) return { text: `git ${cmd.split(/\s+/)[1]}`, isRaw: false }
  return { text: cmd, isRaw: true }
}

// A session that sends no heartbeat (started before this plugin version) is still named after the project its
// Codex jobs work in: `C:/rpg/.claude/worktrees/x` → rpg; jobs in sibling folders `C:/rpg-wt/a`, `C:/rpg-wt/b` → rpg-wt.
function projectOfJobs(jobs: Job[]): string {
  const dirs = jobs.map(j => (j.dir || '').replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean)
    .map(d => d.replace(/\/\.claude\/worktrees\/[^/]+$/, '').replace(/\/\.worktrees\/[^/]+$/, ''))
  if (!dirs.length) return ''
  const base = (d: string) => d.split('/').filter(Boolean).pop() ?? ''
  const parent = (d: string) => d.split('/').slice(0, -1).join('/')
  if (dirs.every(d => d === dirs[0])) return base(dirs[0])
  if (dirs.every(d => parent(d) === parent(dirs[0]))) return base(parent(dirs[0]))
  return base(dirs[0])
}

function sessionName(cwd: string): string {
  if (!cwd || /scratch-workspaces/i.test(cwd)) return ''
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

// The session id names this session's jobs (luna.sh owner) and its heartbeat. CLAUDE_CODE_SESSION_ID reaches Bash
// commands but not plugins in the desktop app; $.session.id() returns the same id (the transcript file name).
async function currentSessionId($: EngineInterface): Promise<string> {
  const fromEnv = (await $.env.get('CLAUDE_CODE_SESSION_ID')) ?? ''
  if (fromEnv) return fromEnv
  try { return (await $.session.id()) ?? '' } catch { return '' }
}

async function initBeat($: EngineInterface, cwd?: string): Promise<void> {
  if (!beatSessionId) beatSessionId = await currentSessionId($)
  if (cwd) beat.cwd = cwd
  if (!beat.cwd) {
    try { // process.run defaults to the session's cwd: the one reliable source when the plugin loads mid-session
      const r = await $.process.run(['node', '-e', 'process.stdout.write(process.cwd())'], { timeoutMs: 5000 })
      if (r.exitCode === 0) beat.cwd = r.stdout.trim()
    } catch {}
  }
}

// The heartbeat travels to the collector on stdin with every poll (luna-overview.mjs --beat): the plugin's own
// file writes outside the project are refused, its process runs are not. So the 5 s ticker keeps it fresh, and a state
// change (turn, tool, agent) asks for an extra poll, at most one a second.
let queuedBeat = false
let lastBeatPoll = 0

// Event hooks must not keep using their `$` after they return (the engine refuses calls from a finished dispatch),
// so a hook only queues the poll on a timer, whose callback runs in a dispatch of its own; bursts coalesce into one.
function queueBeat($: EngineInterface): void {
  if (queuedBeat) return
  queuedBeat = true
  const wait = Math.max(0, 1000 - (Date.now() - lastBeatPoll))
  $.clock.after(wait, () => { queuedBeat = false; void poll($) })
}

async function beatPayload($: EngineInterface): Promise<string> {
  await initBeat($)
  if (!beatSessionId || !/^[A-Za-z0-9._-]{1,128}$/.test(beatSessionId)) return ''
  const out: SessionBeat = {
    v: 1, sessionId: beatSessionId, name: sessionName(beat.cwd), cwd: beat.cwd, updatedAt: Date.now(),
    state: beat.state, tool: beat.tool, turnSince: beat.turnSince, idleSince: beat.idleSince, agents: beat.agents,
    ...(lastLimits.length ? { limits: lastLimits } : {}),
  }
  return JSON.stringify(out)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: 'luna', description: 'Open the Luna status pane (RAM, limits, Codex jobs)' })
    if (e.cwd) beat.cwd = e.cwd
    queueBeat($)
    void $.ui.open({ id: PANE, title: TITLE })
    void poll($)
    ensureTicker($)
    return started
  })

  // Claude's own activity in this session, for every session's pane.
  on('turn.start', async ($, e, next) => {
    if (!e.agentId) {
      beat.state = 'thinking'; beat.tool = null; beat.turnSince = Date.now()
      queueBeat($)
    }
    ensureTicker($)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const done = await next(e)
    const agentId = (e as { agentId?: string }).agentId
    if (agentId) beat.agents = beat.agents.filter(a => a.id !== agentId)
    else { beat.state = 'idle'; beat.tool = null; beat.turnSince = 0; beat.idleSince = Date.now() }
    queueBeat($)
    return done
  })

  on('agent.spawn', async ($, e, next) => {
    const spawned = await next(e)
    const agentId = (spawned as { agentId?: string } | undefined)?.agentId
    if (agentId) {
      beat.agents = [...beat.agents.filter(a => a.id !== agentId),
        { id: agentId, description: oneLine(e.description, 60), since: Date.now() }].slice(-20)
      queueBeat($)
    }
    return spawned
  })

  on('tool.call', async ($, e, next) => {
    const isMain = !(e as { agentId?: string }).agentId
    if (isMain) {
      beat.state = 'tool'
      beat.tool = { name: e.tool, detail: toolDetail(e.tool, e as unknown as Record<string, unknown>), since: Date.now() }
      queueBeat($)
    }
    try {
      return await next(e)
    } finally {
      if (isMain && beat.state === 'tool') { beat.state = 'thinking'; beat.tool = null; queueBeat($) }
    }
  })

  on('command.run', { command: 'luna' }, async $ => {
    closedByPerson = false
    ensureTicker($)
    await poll($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Luna pane opened.' }
  })

  // The pane stays in front in every session without /luna. An open the plugin makes on its own is drawn only on a
  // wide surface (110-144 columns); an open answering the person's prompt is drawn at any width. So every prompt
  // re-opens the pane when it is not on screen, unless the person closed it by hand in this session (/luna undoes that).
  on('prompt.submit', async ($, e, next) => {
    const result = await next(e)
    ensureTicker($)
    if (!closedByPerson) {
      try {
        const shown = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced)
        if (!shown) await $.ui.open({ id: PANE, title: TITLE })
      } catch {}
    }
    return result
  })

  // A desktop window attaching after the session started gets the pane too (drawn there if it is wide enough).
  on('session.attach', async ($, e, next) => {
    const attached = await next(e)
    if (!closedByPerson) void $.ui.open({ id: PANE, title: TITLE })
    ensureTicker($)
    return attached
  })

  on('ui.close', { id: PANE }, async ($, e, next) => {
    if (e.origin.kind === 'person') closedByPerson = true
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    ensureTicker($)
    const d = (await read($, data)) ?? EMPTY
    const folded = (await read($, collapsed)) ?? {}
    const now = d.polledAt || Date.now()
    const snap = d.snapshot
    const toggle = (id: string) => () => update($, collapsed, prev => ({ ...(prev ?? {}), [id]: !(prev ?? {})[id] }))

    // A compact meter like the desktop's own "Контекст 67% ▬" chip: fixed width, rounded fill.
    const Meter = ({ percent, color, width = 7 }: { percent: number; color: string; width?: number }) => (
      <Box width={width} backgroundColor="promptBorder" flexShrink={0}>
        <Box width={`${Math.max(8, Math.min(100, Math.round(percent)))}%`} backgroundColor={color}>
          <Text size="caption"> </Text>
        </Box>
      </Box>
    )

    // A card in the style of the desktop sidebar: rounded frame, clickable title with a chevron, summary on the right.
    const Card = ({ id, title, summary, meter, children }: {
      id: string; title: string; summary?: string; meter?: { percent: number; color: string }; children?: RenderChildren
    }) => {
      const isOpen = children !== undefined && children !== null && !folded[id]
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1} marginBottom={1}>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Button key={`toggle-${id}`} plain onPress={toggle(id)}>
              <Text weight="semibold">{title}</Text>
              <Text color="subtle">{children === undefined || children === null ? '' : isOpen ? '  ⌄' : '  ›'}</Text>
            </Button>
            <Box flexDirection="row" alignItems="center" gap={1} flexShrink={1}>
              {summary ? <Text size="footnote" color="subtle" tabular wrap="truncate-end">{summary}</Text> : null}
              {meter ? <Meter percent={meter.percent} color={meter.color} /> : null}
            </Box>
          </Box>
          {isOpen ? <Box flexDirection="column" paddingTop={1} paddingBottom={1} gap={1}>{children}</Box> : null}
        </Box>
      )
    }

    // A dense row like "Фоновые задачи": glyph, label (truncated), right-aligned detail.
    const Row = ({ glyph, glyphColor, label, detail, dim }: {
      glyph?: string; glyphColor?: string; label: RenderChildren; detail?: string; dim?: boolean
    }) => (
      <Box flexDirection="row" justifyContent="space-between" gap={1}>
        <Text size="footnote" wrap="truncate-end" dimColor={dim}>
          {glyph ? <Text color={glyphColor ?? 'subtle'}>{glyph}  </Text> : null}
          {label}
        </Text>
        {detail ? <Text size="caption" color="subtle" tabular>{detail}</Text> : null}
      </Box>
    )

    const LimitRow = ({ label, pct, resets }: { label: string; pct: number; resets: string | null | undefined }) => (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Text size="footnote">{label}</Text>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text size="footnote" tabular weight="medium" color={severity(pct)}>{Math.round(pct)}%</Text>
            <Meter percent={pct} color={severity(pct)} width={10} />
          </Box>
        </Box>
        <Text size="caption" color="subtle">{resetsIn(resets ?? null, now)}</Text>
      </Box>
    )

    if (!snap) {
      return (
        <Box flexDirection="column" padding={1}>
          <Card id="wait" title="Luna" summary={d.error ? 'нет данных' : 'загрузка…'} />
          {d.error ? <Text size="caption" color="subtle">{d.error}</Text> : null}
        </Box>
      )
    }

    const free = snap.ram.freeMb
    const usedPct = 100 - (free / Math.max(1, snap.ram.totalMb)) * 100
    const ramColor = free < 1024 ? 'error' : free < 2048 ? 'warning' : 'success'
    const daemon = snap.daemon
    const jobs = snap.jobs
    const codex = snap.codexLimits
    const claudeLimits = d.claude.filter(l => l.kind !== 'spend_limit' || l.percentUsed > 0)
    const allPct = [
      ...claudeLimits.map(l => l.percentUsed),
      codex?.primary?.usedPercent ?? 0,
      codex?.secondary?.usedPercent ?? 0,
    ]
    const worst = Math.max(0, ...allPct)
    const room = Math.max(4, (e.viewport?.rows ?? 40) - 24)

    // One Codex job: model, name, owner-less; under it what the agent is doing now, or a stall warning.
    const JobRow = ({ j }: { j: Job }) => {
      const isRunning = j.state === 'running'
      const idle = isRunning ? j.idleS ?? null : null
      // Silence is the stall signal: amber after 5 min, red after 15 (the wrapper's own watchdog fires at 15).
      const quiet = idle !== null && idle >= 900 ? 'error' : idle !== null && idle >= 300 ? 'warning' : null
      const act = j.activity
      const cmd = act?.kind === 'command' ? describeCommand(act.text) : null
      const doing = !isRunning || !act ? '' : cmd ? (cmd.isRaw ? `выполняет: ${cmd.text}` : cmd.text)
        : act.kind === 'thinking' ? 'думает' : act.kind === 'editing' ? `правит${act.text ? `: ${act.text}` : ' файлы'}`
        : act.kind === 'writing' ? 'пишет ответ' : act.kind === 'starting' ? 'запускается' : ''
      return (
        <Box flexDirection="column">
          <Row
            glyph={isRunning ? '▶' : '◷'}
            glyphColor={quiet ?? (isRunning ? 'success' : 'warning')}
            dim={!isRunning}
            label={<Text><Text weight="medium">Codex {modelLabel(j.model)}</Text>  {jobName(j.out)}</Text>}
            detail={isRunning ? duration(j.ageS) : `${STATE_RU[j.state] ?? j.state} · ${duration(j.ageS)}`}
          />
          {quiet ? (
            <Text size="caption" color={quiet}>
              {'   '}тишина {duration(idle ?? 0)}{quiet === 'error' ? ' — похоже, завис' : ' — возможно, завис'}
            </Text>
          ) : doing ? (
            <Text size="caption" color="subtle" mono={!!cmd?.isRaw} wrap="truncate-end">{'   '}{doing}</Text>
          ) : null}
        </Box>
      )
    }

    // What Claude itself is doing in a session, from that session's heartbeat.
    const claudeSummary = (b: SessionBeat | undefined, stale: boolean, at: number): string => {
      if (!b) return 'нет данных'
      if (stale) return 'неактивна'
      if (b.state === 'tool' && b.tool) return `${b.tool.name} · ${duration((at - b.tool.since) / 1000)}`
      if (b.state === 'thinking') return `думает · ${duration((at - b.turnSince) / 1000)}`
      return `ждёт вас · ${duration((at - b.idleSince) / 1000)}`
    }
    const ClaudeRow = ({ beat: b, stale }: { beat: SessionBeat | undefined; stale: boolean }) => {
      if (!b) return <Row glyph="●" label="Claude: нет пульса (плагин ещё не загружен)" dim />
      if (stale) return <Row glyph="●" label="Claude: сессия неактивна" dim />
      const color = b.state === 'thinking' ? 'claude' : b.state === 'tool' ? 'suggestion' : 'subtle'
      const text = b.state === 'tool' && b.tool
        ? `${b.tool.name}${b.tool.detail ? `: ${b.tool.detail}` : ''}`
        : b.state === 'thinking' ? 'думает' : 'ждёт вашего ответа'
      const since = b.state === 'tool' && b.tool ? b.tool.since : b.state === 'thinking' ? b.turnSince : b.idleSince
      return (
        <Row glyph="●" glyphColor={color} dim={b.state === 'idle'}
          label={<Text><Text weight="medium">Claude</Text>  {text}</Text>} detail={duration((now - since) / 1000)} />
      )
    }

    // Group everything by Claude session: heartbeats plus Codex jobs by owner. This session first, then busy ones.
    const beats = snap.sessions ?? []
    const ids = [...new Set([...beats.map(b => b.sessionId), ...jobs.map(j => j.owner).filter(Boolean)])]
    const rank = (id: string) => {
      const b = beats.find(x => x.sessionId === id)
      if (id === d.sessionId) return 0
      if (b && b.state !== 'idle' && now - b.updatedAt <= 60_000) return 1
      return jobs.some(j => j.owner === id) ? 2 : 3
    }
    const groups = ids
      .map(id => ({ id, beat: beats.find(b => b.sessionId === id), jobs: jobs.filter(j => j.owner === id) }))
      .sort((a, b) => rank(a.id) - rank(b.id) || (b.beat?.updatedAt ?? 0) - (a.beat?.updatedAt ?? 0))
    const orphans = jobs.filter(j => !j.owner)
    const showBuild = snap.build && (snap.build.building || !snap.build.exeAt)

    const alerts = attentionItems(d)
    const hasError = alerts.some(a => a.level === 'error')
    const statusColor = alerts.length === 0 ? 'success' : hasError ? 'error' : 'warning'
    const statusText = alerts.length === 0 ? 'всё в порядке' : `требует внимания · ${alerts.length}`
    const runningAll = jobs.filter(j => j.state === 'running').length
    const waitingAll = jobs.length - runningAll
    const daemonColor = !daemon.running ? 'subtle' : daemon.healthy === false ? 'error'
      : daemon.appServer === 'down' ? 'warning' : 'success'
    const daemonText = !daemon.running ? 'спит, проснётся с первым заданием'
      : daemon.healthy === false ? 'не отвечает'
      : daemon.appServer === 'down' ? 'Codex перезапускается'
      : `${daemon.runningJobs ?? 0}${daemon.max ? `/${daemon.max}` : ''} в работе · очередь ${daemon.queuedJobs ?? 0}`

    // One resource: label on the left, value and a short meter on the right, the reset time under it when it matters.
    const ResourceRow = ({ label, value, pct, color, hint }: {
      label: string; value: string; pct: number; color: string; hint?: string
    }) => (
      <Box flexDirection="column">
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Text size="footnote">{label}</Text>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text size="footnote" tabular weight="medium" color={color}>{value}</Text>
            <Meter percent={pct} color={color} width={10} />
          </Box>
        </Box>
        {hint ? <Text size="caption" color="subtle">{hint}</Text> : null}
      </Box>
    )

    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" marginBottom={1} gap={1}>
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Text weight="semibold">Luna</Text>
            <Text size="footnote" color={statusColor}>● {statusText}</Text>
          </Box>
          <Text size="caption" color="subtle" tabular>{new Date(now).toLocaleTimeString('ru-RU')}</Text>
        </Box>

        {alerts.length > 0 ? (
          <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1} paddingY={1}
            marginBottom={1} gap={1}>
            {alerts.map(a => <Text size="footnote" color={a.level} wrap="truncate-end">● {a.text}</Text>)}
          </Box>
        ) : null}

        <Card id="resources" title="Ресурсы"
          summary={`ОЗУ ${gb(free)} · Codex ${runningAll}${waitingAll ? `+${waitingAll}` : ''}`}>
          <ResourceRow label="Память" value={`${gb(free)} свободно`} pct={usedPct} color={ramColor} />
          {claudeLimits.map(l => (
            <ResourceRow label={`Claude · ${windowName(l.kind, null)}`} value={`${Math.round(l.percentUsed)}%`}
              pct={l.percentUsed} color={severity(l.percentUsed)}
              hint={l.percentUsed >= 70 ? resetsIn(l.resetsAt ?? null, now) : undefined} />
          ))}
          {claudeLimits.length === 0 ? <Row label="Claude" detail="после первого ответа" dim /> : null}
          {codex?.primary ? (
            <ResourceRow label={`Codex · ${windowName('', codex.primary.windowMins)}`}
              value={`${Math.round(codex.primary.usedPercent)}%`} pct={codex.primary.usedPercent}
              color={severity(codex.primary.usedPercent)}
              hint={codex.primary.usedPercent >= 70 ? resetsIn(codex.primary.resetsAt, now) : undefined} />
          ) : null}
          {codex?.secondary ? (
            <ResourceRow label={`Codex · ${windowName('', codex.secondary.windowMins)}`}
              value={`${Math.round(codex.secondary.usedPercent)}%`} pct={codex.secondary.usedPercent}
              color={severity(codex.secondary.usedPercent)}
              hint={codex.secondary.usedPercent >= 70 ? resetsIn(codex.secondary.resetsAt, now) : undefined} />
          ) : null}
          {!codex ? <Row label="Codex" detail="лимиты появятся с первым заданием" dim /> : null}
          <Row glyph="◆" glyphColor={daemonColor} label="Демон Codex" detail={daemonText} />
        </Card>

        {groups.length === 0 && orphans.length === 0 ? (
          <Text size="footnote" color="subtle">Заданий Codex нет. Сессии появятся здесь, когда начнут работать.</Text>
        ) : null}

        {groups.map(g => {
          const b = g.beat
          const isMe = g.id === d.sessionId
          const stale = !b || now - b.updatedAt > 60_000
          const name = b?.name || projectOfJobs(g.jobs)
          const title = (name || (isMe ? 'Эта сессия' : 'Без папки')) + (isMe && name ? ' · эта' : '')
          const running = g.jobs.filter(j => j.state === 'running').length
          const codexPart = g.jobs.length ? ` · Codex ${running}${g.jobs.length > running ? `+${g.jobs.length - running}` : ''}` : ''
          return (
            <Card id={`s-${g.id}`} title={title} summary={`${claudeSummary(b, stale, now)}${codexPart}`}>
              <ClaudeRow beat={b} stale={stale} />
              {(b?.agents ?? []).map(a => (
                <Row glyph="◇" glyphColor="claude" label={`агент: ${a.description || 'без описания'}`}
                  detail={duration((now - a.since) / 1000)} />
              ))}
              {g.jobs.slice(0, room).map(j => <JobRow j={j} />)}
              {g.jobs.length > room ? <Text size="caption" color="subtle">и ещё {g.jobs.length - room}</Text> : null}
            </Card>
          )
        })}

        {orphans.length > 0 ? (
          <Card id="orphans" title="Прочие задачи Codex" summary={`${orphans.length}`}>
            {orphans.slice(0, room).map(j => <JobRow j={j} />)}
          </Card>
        ) : null}

        {showBuild && snap.build ? (
          <Card id="build" title="Сборка Codex" summary={snap.build.building ? 'идёт' : 'остановлена'}>
            <Text size="caption" mono wrap="truncate-end" color="subtle">{snap.build.line}</Text>
          </Card>
        ) : null}

        {d.beatNote ? (
          <Text size="caption" color="subtle" wrap="truncate-end">Статус этой сессии не отправляется: {d.beatNote}</Text>
        ) : null}
      </Box>
    )
  })

}
