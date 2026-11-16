import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type {
  ChainEntry, ClaudeLimit, CliStatus, Collapsed, Job, PanelData, SessionBeat, Snapshot, View,
} from '../types'

// The Luna pane, conveyor edition: limits of every provider, the executor chains with the active one marked, every
// executor's jobs (Codex, Gemini, Claude subagents), the orchestration editor and CLI updates.
// Data: `node ~/.claude/scripts/luna-overview.mjs` every POLL_MS + $.session.usage(); settings through
// `node ~/.claude/scripts/conveyor/exec.mjs config …`; updates through `node ~/.claude/scripts/conveyor/cli-update.mjs`.

const PANE = 'luna-panel'
const TITLE = 'Luna'
const COMMAND = 'luna'
/** This installed pane sends this session's heartbeat; a preview copy (luna-panel-next) sets this false. */
const WRITE_BEAT = true
const POLL_MS = 5000
const IDLE_POLL_MS = 20_000

const EMPTY: PanelData = { snapshot: null, claude: [], error: '', polledAt: 0, sessionId: '' }
const VIEW0: View = {
  tab: 'overview', editTier: null, filter: 'all', confirm: null, busy: null, note: null, cli: null,
  draftModel: '', draftProvider: 'gemini', draftEfforts: 'low,medium,high', presetName: '',
}
const data = atom({ plugin: 'luna-panel', key: 'data' } as const, EMPTY)
const collapsed = atom({ plugin: 'luna-panel', key: 'collapsed' } as const, {} as Collapsed)
const view = atom({ plugin: 'luna-panel', key: 'view' } as const, VIEW0, { shape: 'view-1' })

// ---- Words -----------------------------------------------------------------------------------------------------

const TIER_RU: Record<string, string> = { complex: 'Сложное', simple: 'Простое', review: 'Ревью', scout: 'Разведка' }
const TIER_HINT: Record<string, string> = {
  complex: 'реализация, отладка, рефакторинг',
  simple: 'механика, шаблонные правки',
  review: 'критики и ревью',
  scout: 'поиск и чтение',
}
const PANEL_RU: Record<string, string> = { design: 'Проектирование', review: 'Ревью', judge: 'Судья' }
const EFFORTS_ALL = ['low', 'medium', 'high', 'xhigh', 'max']
const STATE_RU: Record<string, string> = {
  running: 'работает', queued: 'в очереди', starting: 'старт', 'waiting-daemon': 'ждёт место',
  'waiting-ram': 'ждёт память', 'waiting-lock': 'ждёт старт', unavailable: 'недоступен', stalled: 'завис',
  failed: 'ошибка', done: 'готово', incomplete: 'неполный',
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

function clock(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''
}

function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} ГБ`
}

function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} млн`
  if (n >= 1e3) return `${Math.round(n / 1e3)} тыс`
  return `${n}`
}

/** A model as a person names it, version kept so a new release never looks like the old one: Sol 6.1, Luna 6,
 *  Gemini Flash, Sonnet. Unknown ids are shown as they are. */
function modelName(provider: string | undefined, model: string): string {
  const m = model || ''
  const gpt = /^gpt-([\d.]+)-(sol|luna|terra|astra)$/i.exec(m)
  if (gpt) {
    const fam = gpt[2] ?? ''
    return `${fam.charAt(0).toUpperCase()}${fam.slice(1)} ${gpt[1] ?? ''}`.trim()
  }
  if (provider === 'claude' || /^(opus|sonnet|haiku|fable)$/i.test(m)) return m.charAt(0).toUpperCase() + m.slice(1)
  const gem = /^gemini-([\d.]+)-(\w+?)(?:-(low|medium|high))?$/i.exec(m)
  if (gem) {
    const fam = gem[2] ?? ''
    // The -low/-medium/-high suffix is the effort, shown next to the name, never inside it.
    return `Gemini ${fam.charAt(0).toUpperCase()}${fam.slice(1)}`
  }
  return m || '—'
}

function providerOf(j: Job): 'codex' | 'gemini' {
  return j.provider === 'gemini' || /^gemini/i.test(j.model) ? 'gemini' : 'codex'
}

function jobName(out: string): string {
  const parts = out.split(/[\\/]/).filter(Boolean)
  const base = (parts.pop() ?? out).replace(/\.out\.md$|\.md$/i, '')
  // A generic file name (out.md, result.md) says nothing: name the job after its folder instead.
  return /^(out|result|output|res|answer)$/i.test(base) && parts.length ? parts.pop() ?? base : base
}

function severity(percentUsed: number): 'success' | 'warning' | 'error' {
  if (percentUsed >= 90) return 'error'
  if (percentUsed >= 70) return 'warning'
  return 'success'
}

function windowName(kind: string, mins: number | null | undefined): string {
  if (kind === 'five_hour' || mins === 300) return '5 ч'
  if (kind === 'seven_day' || mins === 10080) return 'неделя'
  if (kind === 'spend_limit') return 'бюджет'
  if (mins) return mins >= 1440 ? `${Math.round(mins / 1440)} д` : `${Math.round(mins / 60)} ч`
  return kind
}

/** Why a chain entry is skipped, in Russian, from the dispatcher's English reason. */
function reasonRu(reason: string): string {
  const r = reason || ''
  const pct = /(\d+)% ≥ (\d+)%/.exec(r)
  if (pct) return `${pct[1]}% ≥ порога ${pct[2]}%`
  if (/quota/i.test(r)) return `квота${/until (\S+)/i.test(r) ? ` до ${clock(/until (\S+)/i.exec(r)?.[1])}` : ''}`
  if (/region/i.test(r)) return 'регион'
  if (/auth/i.test(r)) return 'вход'
  if (/checksum/i.test(r)) return 'бинарь изменился'
  if (/missing|not found/i.test(r)) return 'не установлен'
  return r.replace(/^unavailable:?\s*/i, '')
}

function oneLine(text: unknown, max = 80): string {
  const first = String(text ?? '').split(/\r?\n/)[0] ?? ''
  const clean = first.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function toolDetail(tool: string, input: Record<string, unknown>): string {
  const base = (p: unknown) => String(p ?? '').split(/[\\/]/).pop() ?? ''
  if (tool === 'Bash') return oneLine(input.command)
  if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool)) return base(input.file_path ?? input.notebook_path)
  if (tool === 'Grep' || tool === 'Glob') return oneLine(input.pattern, 60)
  if (tool === 'Agent' || tool === 'Task') return oneLine(input.description, 60)
  if (tool === 'WebFetch') { try { return new URL(String(input.url)).host } catch { return '' } }
  if (tool === 'WebSearch') return oneLine(input.query, 60)
  return ''
}

function describeCommand(raw: string): { text: string; isRaw: boolean } {
  let cmd = raw.trim().replace(/^\S*?(?:sh|bash|dash|zsh)\s+(?:-\w+\s+)*/i, '').replace(/^["']|["']$/g, '')
  cmd = cmd.replace(/^(?:cd\s+\S+\s*&&\s*)+/, '').trim()
  cmd = cmd.replace(/^(?:(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '').trim()
  cmd = cmd.replace(/^(?:cd\s+\S+\s*&&\s*)+/, '').trim()
  const has = (re: RegExp) => re.test(cmd)
  if (has(/\b(pytest|pytest_gate|vitest|jest|mocha|playwright test|cargo test|go test|node --test)\b|\b(npm|pnpm|yarn|bun) (run )?test/)) {
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
  if (/^File /.test(raw)) return { text: `файл ${raw.slice(5)}`, isRaw: false }
  if (has(/^python3?\s+-(\s|$)|^python3?\s+-c\b/)) return { text: 'выполняет скрипт Python', isRaw: false }
  if (has(/^node\s+-(e|p)\b|^node\s+--input-type/)) return { text: 'выполняет скрипт Node', isRaw: false }
  return { text: cmd, isRaw: true }
}

function projectOfJobs(jobs: Job[]): string {
  const dirs = jobs.map(j => (j.dir || '').replace(/\\/g, '/').replace(/\/+$/, '')).filter(Boolean)
    .map(d => d.replace(/\/\.claude\/worktrees\/[^/]+$/, '').replace(/\/\.worktrees\/[^/]+$/, ''))
  if (!dirs.length) return ''
  const base = (d: string) => d.split('/').filter(Boolean).pop() ?? ''
  const parent = (d: string) => d.split('/').slice(0, -1).join('/')
  const first = dirs[0] ?? ''
  if (dirs.every(d => d === first)) return base(first)
  if (dirs.every(d => parent(d) === parent(first))) return base(parent(first))
  return base(first)
}

function sessionName(cwd: string): string {
  if (!cwd || /scratch-workspaces/i.test(cwd)) return ''
  return cwd.split(/[\\/]/).filter(Boolean).pop() ?? ''
}

// ---- What needs the person ---------------------------------------------------------------------------------------

type Alert = { level: 'error' | 'warning'; text: string }

function attentionItems(d: PanelData): Alert[] {
  const s = d.snapshot
  const out: Alert[] = []
  if (!s) return d.error ? [{ level: 'warning', text: 'Нет данных от сборщика' }] : []
  const free = s.ram.freeMb
  if (free < 1024) out.push({ level: 'error', text: `Мало памяти: ${gb(free)}, новые задачи ждут` })
  else if (free < 2048) out.push({ level: 'warning', text: `Памяти немного: ${gb(free)}` })
  for (const j of s.jobs) {
    if (j.state === 'running' && (j.idleS ?? 0) >= 900) {
      out.push({ level: 'error', text: `${modelName(j.provider, j.model)} «${jobName(j.out)}» молчит ${duration(j.idleS ?? 0)}` })
    }
  }
  const starved = s.jobs.filter(j => j.state === 'waiting-ram').length
  if (starved) out.push({ level: 'warning', text: `${starved} ${starved === 1 ? 'задача ждёт' : 'задач ждут'} памяти` })
  if (s.daemon.running && s.daemon.healthy === false) out.push({ level: 'error', text: 'Демон Codex не отвечает' })
  const o = s.orchestration
  if (o?.configError) out.push({ level: 'error', text: `Конфиг оркестрации: ${o.configError.slice(0, 80)}` })
  for (const [tier, chain] of Object.entries(o?.chains ?? {})) {
    if (chain.length && !chain.some(c => c.available)) out.push({ level: 'error', text: `${TIER_RU[tier] ?? tier}: нет доступных исполнителей` })
  }
  for (const l of d.claude) {
    if (l.kind !== 'spend_limit' && l.percentUsed >= 90) {
      out.push({ level: 'error', text: `Claude · ${windowName(l.kind, null)}: ${Math.round(l.percentUsed)}%` })
    }
  }
  if (s.codexLimits?.reached) out.push({ level: 'error', text: 'Лимит Codex исчерпан' })
  if (d.error) out.push({ level: 'warning', text: `Данные не обновляются: ${d.error.slice(0, 80)}` })
  return out.sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1))
}

// ---- Polling -------------------------------------------------------------------------------------------------------

let polling = false
let pollStartedAt = 0
let ticker: { cancel: () => void } | null = null
let lastPollAt = 0
let closedByPerson = false
let homeDir = ''

async function home($: EngineInterface): Promise<string> {
  if (homeDir) return homeDir
  let h = await $.env.get('HOME')
  if (!h) {
    const result = await $.process.run(['node', '-p', 'require("os").homedir()'], { timeoutMs: 2000 })
    h = result.stdout.trim()
  }
  homeDir = h.replace(/\\/g, '/')
  return homeDir
}

async function poll($: EngineInterface): Promise<void> {
  const now = Date.now()
  if (polling && now - pollStartedAt < 20_000) return
  polling = true
  pollStartedAt = now
  try { await pollOnce($) } finally { polling = false }
}

function ensureTicker($: EngineInterface): void {
  if (ticker) return
  ticker = $.clock.every(POLL_MS, () => { void tick($) })
}

async function tick($: EngineInterface): Promise<void> {
  if ((await $.clock.now()) - lastPollAt < IDLE_POLL_MS) {
    let shown = false
    try { shown = (await $.ui.panes()).some(p => p.id === PANE && p.isPlaced && p.isShown) } catch {}
    if (!shown) return
  }
  await poll($)
}

/**
 * Claude's limits are per account, so a window this session's usage lacks (the desktop often reports only the week)
 * is taken from the freshest other session's heartbeat, as long as that window has not reset since.
 */
function mergeClaudeLimits(own: ClaudeLimit[], beats: SessionBeat[], now: number): ClaudeLimit[] {
  const out = new Map(own.map(l => [l.kind, l]))
  const fresh = beats.filter(b => b.limits?.length && now - b.updatedAt < 6 * 3600_000).sort((a, b) => b.updatedAt - a.updatedAt)
  for (const b of fresh) {
    for (const l of b.limits ?? []) {
      const resets = l.resetsAt ? Date.parse(l.resetsAt) : NaN
      if (!out.has(l.kind) && !(Number.isFinite(resets) && resets <= now)) out.set(l.kind, l)
    }
  }
  return [...out.values()]
}

async function pollOnce($: EngineInterface): Promise<void> {
  const h = await home($)
  const sessionId = await currentSessionId($)
  let snapshot: Snapshot | null = null
  let error = ''
  try {
    const payload = WRITE_BEAT ? await beatPayload($) : ''
    const run = await $.process.run(['node', `${h}/.claude/scripts/luna-overview.mjs`, ...(payload ? ['--beat'] : [])],
      { timeoutMs: 12_000, ...(payload ? { stdin: payload } : {}) })
    if (run.exitCode === 0 && run.stdout.trim()) snapshot = JSON.parse(run.stdout) as Snapshot
    else error = (run.stderr || `exit ${run.exitCode}`).trim().slice(0, 200)
  } catch (caught) {
    error = String((caught as Error)?.message ?? caught).slice(0, 200)
  }
  let claude: ClaudeLimit[] = []
  try {
    claude = (await $.session.usage()).rateLimits ?? []
    if (claude.length) lastLimits = claude
  } catch {}
  const polledAt = await $.clock.now()
  await update($, data, prev => ({
    snapshot: snapshot ?? prev?.snapshot ?? null,
    claude: mergeClaudeLimits(claude.length > 0 ? claude : prev?.claude ?? [], (snapshot ?? prev?.snapshot)?.sessions ?? [], polledAt),
    error,
    polledAt,
    sessionId,
  }))
  lastPollAt = polledAt
  if (Date.now() - cliLoadedAt > 3600_000) void loadCli($, false, true)
}

// ---- Actions: settings and updates (each one a CLI run; the result becomes a one-line note) -----------------------

type ActionResult = { ok: boolean; note: string }

async function runJson($: EngineInterface, argv: string[], timeoutMs: number): Promise<ActionResult & { json?: unknown }> {
  try {
    const run = await $.process.run(argv, { timeoutMs })
    // The whole output is one JSON document (pretty-printed or not); else its last line is.
    const out = run.stdout.trim()
    const lines = out.split(/\r?\n/).filter(Boolean)
    let json: unknown
    try { json = JSON.parse(out) } catch { try { json = JSON.parse(lines[lines.length - 1] ?? '') } catch {} }
    const j = json as { ok?: boolean; note?: string; reason?: string } | undefined
    const ok = run.exitCode === 0 && (j?.ok ?? true)
    const note = j?.note || j?.reason || (ok ? 'готово' : oneLine(run.stderr || `код ${run.exitCode}`, 140))
    return { ok, note, json }
  } catch (caught) {
    return { ok: false, note: oneLine((caught as Error)?.message ?? caught, 140) }
  }
}

async function act($: EngineInterface, key: string, args: string[], okText: string): Promise<void> {
  const v = await read($, view)
  if (v?.busy) return
  await update($, view, prev => ({ ...(prev ?? VIEW0), busy: key, confirm: null }))
  const h = await home($)
  const r = await runJson($, ['node', `${h}/.claude/scripts/conveyor/exec.mjs`, ...args, '--actor', 'panel'], 30_000)
  const at = await $.clock.now()
  await update($, view, prev => ({
    ...(prev ?? VIEW0), busy: null,
    note: { text: r.ok ? okText : `Не применено: ${r.note}`, level: (r.ok ? 'success' : 'error') as 'success' | 'error', at },
  }))
  await poll($)
}

let cliLoadedAt = 0
let cliLoading = false

// Versions load by themselves when the pane first draws and every hour after, quietly; the button forces a refresh.
async function loadCli($: EngineInterface, refresh: boolean, quiet = false): Promise<void> {
  if (cliLoading) return
  cliLoading = true
  cliLoadedAt = Date.now()
  try { await loadCliOnce($, refresh, quiet) } finally { cliLoading = false }
}

async function loadCliOnce($: EngineInterface, refresh: boolean, quiet: boolean): Promise<void> {
  if (!quiet) await update($, view, prev => ({ ...(prev ?? VIEW0), busy: 'cli-status' }))
  const h = await home($)
  const r = await runJson($, ['node', `${h}/.claude/scripts/conveyor/cli-update.mjs`, 'status', '--json',
    ...(refresh ? ['--refresh'] : [])], 45_000)
  const cli = (r.json as CliStatus | undefined)
  await update($, view, prev => ({
    ...(prev ?? VIEW0), busy: quiet ? prev?.busy ?? null : null, cli: cli?.codex || cli?.agy ? cli : prev?.cli ?? null,
    ...(r.ok || quiet ? {} : { note: { text: `Проверка обновлений: ${r.note}`, level: 'warning' as const, at: Date.now() } }),
  }))
}

async function runUpdate($: EngineInterface, what: string, extra: string[]): Promise<void> {
  await update($, view, prev => ({ ...(prev ?? VIEW0), busy: `update-${what}`, confirm: null }))
  const h = await home($)
  const r = await runJson($, ['node', `${h}/.claude/scripts/conveyor/cli-update.mjs`, ...extra, '--confirm'], 600_000)
  await update($, view, prev => ({
    ...(prev ?? VIEW0), busy: null,
    note: { text: r.ok ? `Обновлено: ${r.note}` : `Не обновлено: ${r.note}`, level: (r.ok ? 'success' : 'error') as 'success' | 'error', at: Date.now() },
  }))
  await loadCli($, false)
}

// ---- Heartbeat (only the installed panel writes it) ------------------------------------------------------------------

const beat: Omit<SessionBeat, 'v' | 'sessionId' | 'name' | 'cwd' | 'updatedAt'> & { cwd: string } = {
  state: 'idle', tool: null, turnSince: 0, idleSince: Date.now(), agents: [], cwd: '',
}
let beatSessionId = ''
let lastLimits: ClaudeLimit[] = []
let queuedBeat = false
let lastBeatPoll = 0

async function currentSessionId($: EngineInterface): Promise<string> {
  const fromEnv = (await $.env.get('CLAUDE_CODE_SESSION_ID')) ?? ''
  if (fromEnv) return fromEnv
  try { return (await $.session.id()) ?? '' } catch { return '' }
}

async function initBeat($: EngineInterface, cwd?: string): Promise<void> {
  if (!beatSessionId) beatSessionId = await currentSessionId($)
  if (cwd) beat.cwd = cwd
  if (!beat.cwd) {
    try {
      const r = await $.process.run(['node', '-e', 'process.stdout.write(process.cwd())'], { timeoutMs: 5000 })
      if (r.exitCode === 0) beat.cwd = r.stdout.trim()
    } catch {}
  }
}

function queueBeat($: EngineInterface): void {
  if (!WRITE_BEAT || queuedBeat) return
  queuedBeat = true
  const wait = Math.max(0, 1000 - (Date.now() - lastBeatPoll))
  $.clock.after(wait, () => { queuedBeat = false; void poll($) })
}

async function beatPayload($: EngineInterface): Promise<string> {
  await initBeat($)
  lastBeatPoll = Date.now()
  if (!beatSessionId || !/^[A-Za-z0-9._-]{1,128}$/.test(beatSessionId)) return ''
  const out: SessionBeat = {
    v: 1, sessionId: beatSessionId, name: sessionName(beat.cwd), cwd: beat.cwd, updatedAt: Date.now(),
    state: beat.state, tool: beat.tool, turnSince: beat.turnSince, idleSince: beat.idleSince, agents: beat.agents,
    ...(lastLimits.length ? { limits: lastLimits } : {}),
  }
  return JSON.stringify(out)
}

// ---- Hooks -----------------------------------------------------------------------------------------------------------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: 'Open the Luna pane (limits, executors, settings, updates)' })
    if (e.cwd) beat.cwd = e.cwd
    queueBeat($)
    void $.ui.open({ id: PANE, title: TITLE })
    void poll($)
    ensureTicker($)
    return started
  })

  on('turn.start', async ($, e, next) => {
    if (!e.agentId) { beat.state = 'thinking'; beat.tool = null; beat.turnSince = Date.now(); queueBeat($) }
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

  on('command.run', { command: COMMAND }, async $ => {
    closedByPerson = false
    ensureTicker($)
    await poll($)
    await $.ui.open({ id: PANE, title: TITLE })
    return { text: 'Luna pane opened.' }
  })

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
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Select, Input } = els
    // Svg exists on the remote surfaces only; the terminal gets text meters instead.
    const Svg = 'Svg' in els ? els.Svg : null
    ensureTicker($)
    const d = (await read($, data)) ?? EMPTY
    const folded = (await read($, collapsed)) ?? {}
    const v = (await read($, view)) ?? VIEW0
    const now = d.polledAt || Date.now()
    const snap = d.snapshot
    const o = snap?.orchestration ?? null
    const isTerminal = e.surface === 'terminal' || !Svg
    const setView = (patch: Partial<View>) => update($, view, prev => ({ ...(prev ?? VIEW0), ...patch }))
    const toggle = (id: string) => () => update($, collapsed, prev => ({ ...(prev ?? {}), [id]: !(prev ?? {})[id] }))
    const busy = v.busy
    // A press that needs a second press within 8 s (updates, removals): the first one arms it.
    const armed = (key: string) => !!v.confirm && v.confirm.key === key && v.confirm.until > Date.now()
    const confirmThen = (key: string, run: () => void) => () => {
      if (armed(key)) run()
      else void setView({ confirm: { key, until: Date.now() + 8000 } })
    }

    // ---- Building blocks ----
    // Designed for the docked pane (~44 columns): one line per fact, fixed label columns, meters 4 px thin.
    // Sizes: footnote for rows, caption for secondary facts; colour only for state; one accent for "runs now".

    const HEX = { success: '#3fb950', warning: '#d29922', error: '#f85149', track: '#8b949e40' } as const
    const Bar = ({ pct, color, w = 64 }: { pct: number; color: 'success' | 'warning' | 'error'; w?: number }) => {
      const p = Math.max(0, Math.min(100, pct))
      if (!Svg) {
        const cells = 8
        const fill = Math.round((p / 100) * cells)
        return <Text size="caption" color={color}>{'▰'.repeat(fill)}<Text color="subtle">{'▱'.repeat(cells - fill)}</Text></Text>
      }
      const fillW = Math.max(p > 0 ? 2 : 0, Math.round((p / 100) * w))
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="4" viewBox="0 0 ${w} 4">`
        + `<rect width="${w}" height="4" rx="2" fill="${HEX.track}"/>`
        + (fillW ? `<rect width="${fillW}" height="4" rx="2" fill="${HEX[color]}"/>` : '') + '</svg>'
      return <Svg source={svg} alt={`${Math.round(p)}%`} width={w} height={4} />
    }

    // Sections are cards (the round border the session cards of the Luna pane use); groups inside a card are split by
    // a faint dashed rule. A Head is a title that stands above a run of cards (the task list).
    const Head = ({ text, right }: { text: string; right?: RenderChildren }) => (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1} marginTop={1}>
        <Text size="caption" weight="semibold" color="subtle">{text.toUpperCase()}</Text>
        {right ?? null}
      </Box>
    )
    const Card = ({ children }: { children: RenderChildren }) => (
      <Box flexDirection="column" borderStyle="round" borderColor="promptBorder" paddingX={1} marginTop={1}>{children}</Box>
    )
    const Section = ({ title, right, children }: { title: string; right?: RenderChildren; children: RenderChildren }) => (
      <Card>
        <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
          <Text size="caption" weight="semibold" color="subtle">{title.toUpperCase()}</Text>
          {right ?? null}
        </Box>
        {children}
      </Card>
    )

    // A hairline between rows. A text rule, not an Svg: the desktop drew a 1 px Svg invisibly, and text renders on
    // every surface; it is truncated to the pane's width.
    // A faint dashed rule between groups inside a card.
    const Rule = ({ inset = 0 }: { inset?: number }) => (
      <Box paddingLeft={inset} flexDirection="column">
        <Text size="caption" color="subtle" dimColor wrap="truncate-end">{'┈'.repeat(200)}</Text>
      </Box>
    )

    const Link = ({ id, label, onPress, tone }: { id: string; label: string; onPress: () => void; tone?: 'danger' | 'quiet' }) => (
      <Button key={id} plain onPress={onPress}>
        <Text size="caption" color={tone === 'danger' ? 'error' : tone === 'quiet' ? 'subtle' : 'suggestion'}>{label}</Text>
      </Button>
    )

    const Tab = ({ id, label, active, onPress, hotkey }: {
      id: string; label: string; active: boolean; onPress: () => void; hotkey: string
    }) => (
      <Button key={id} plain hotkey={hotkey} onPress={onPress}>
        <Text size="footnote" weight={active ? 'semibold' : 'regular'} color={active ? 'text' : 'subtle'} underline={active}>{label}</Text>
      </Button>
    )

    const Chip = ({ id, label, active, onPress }: { id: string; label: string; active: boolean; onPress: () => void }) => (
      <Button key={id} plain onPress={onPress}>
        <Text size="caption" weight={active ? 'semibold' : 'regular'} color={active ? 'text' : 'subtle'} inverse={active}>{` ${label} `}</Text>
      </Button>
    )

    // ---- Settings editors (shared by the overview's inline editor and the settings tab) ----

    const effortsOf = (provider: string, model: string) =>
      o?.catalog?.[provider]?.find(m => m.model === model)?.efforts ?? EFFORTS_ALL
    const modelOptions = () => {
      const all: { value: string; label: string }[] = []
      for (const [provider, models] of Object.entries(o?.catalog ?? {})) {
        for (const m of models) all.push({ value: `${provider}|${m.model}`, label: modelName(provider, m.model) })
      }
      // A label two providers share gets its provider, so the list stays unambiguous.
      const dup = new Set(all.map(x => x.label).filter((l, i, a) => a.indexOf(l) !== i))
      const opts = all.map(x => (dup.has(x.label) ? { ...x, label: `${x.label} · ${x.value.split('|')[0]}` } : x))
      return opts.length ? opts : [{ value: '', label: 'каталог пуст' }]
    }

    const EntryRow = ({ where, index, entry, count }: { where: string[]; index: number; entry: ChainEntry; count: number }) => {
      const id = `${where.join('-')}-${index}`
      const setEntry = (provider: string, model: string, effort: string) => {
        const ok = effortsOf(provider, model)
        const eff = ok.includes(effort) ? effort : ok[ok.length - 1] ?? effort
        void act($, `set-${id}`, ['config', 'set-entry', ...where, '--index', String(index),
          '--provider', provider, '--model', model, '--effort', eff], `${modelName(provider, model)} · ${eff}`)
      }
      const isTier = where[0] === '--tier'
      const menu = [{ value: '-', label: '⋯' },
        ...(index > 0 ? [{ value: 'up', label: '↑ выше' }] : []),
        ...(index < count - 1 ? [{ value: 'down', label: '↓ ниже' }] : []),
        ...(count > 1 ? [{ value: 'rm', label: '✕ убрать' }] : [])]
      const onMenu = (value: string) => {
        if (value === 'up' || value === 'down') {
          void act($, `mv-${id}`, ['config', 'move-entry', ...where, '--index', String(index),
            '--to', String(value === 'up' ? index - 1 : index + 1)], 'Порядок изменён')
        } else if (value === 'rm') {
          void act($, `rm-${id}`, ['config', 'remove-entry', ...where, '--index', String(index)], 'Убрано из цепочки')
        }
      }
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box width={2} flexShrink={0}>
              <Text size="caption" color={entry.selected ? 'success' : entry.available ? 'subtle' : 'warning'} tabular>
                {entry.selected ? '●' : entry.available ? `${index + 1}` : '✕'}
              </Text>
            </Box>
            <Box flexGrow={1} flexShrink={1} minWidth={12}>
              <Select key={`model-${id}`} options={modelOptions()} value={`${entry.provider}|${entry.model}`}
                onSelect={value => { const [p, m] = value.split('|'); if (p && m) setEntry(p, m, entry.effort) }} />
            </Box>
            <Box flexShrink={0}>
              <Select key={`effort-${id}`} options={effortsOf(entry.provider, entry.model).map(x => ({ value: x, label: x }))}
                value={entry.effort} onSelect={value => setEntry(entry.provider, entry.model, value)} />
            </Box>
            {isTier && menu.length > 1 ? (
              <Box flexShrink={0}><Select key={`menu-${id}`} options={menu} value="-" onSelect={onMenu} /></Box>
            ) : null}
          </Box>
          {!entry.available ? (
            <Box paddingLeft={3}><Text size="caption" color="warning">пропускается: {reasonRu(entry.reason)}</Text></Box>
          ) : null}
        </Box>
      )
    }

    const TierEditor = ({ tier }: { tier: string }) => {
      const chain = o?.chains?.[tier] ?? []
      const first = modelOptions()[0]?.value.split('|') ?? []
      return (
        <Box flexDirection="column" paddingLeft={1} paddingTop={1} paddingBottom={1} gap={0}>
          {chain.map((c, i) => <EntryRow where={['--tier', tier]} index={i} entry={c} count={chain.length} />)}
          <Box paddingLeft={3} paddingTop={0}>
            <Link id={`add-${tier}`} label="+ запасной"
              onPress={() => {
                if (first[0] && first[1]) {
                  void act($, `add-${tier}`, ['config', 'add-entry', '--tier', tier, '--provider', first[0],
                    '--model', first[1], '--effort', effortsOf(first[0], first[1]).slice(-1)[0] ?? 'high'], 'Добавлен запасной')
                }
              }} />
          </Box>
        </Box>
      )
    }

    // One tier as a single line: label column, what runs now in bold, fallbacks small, a chevron that opens the editor.
    const TierLine = ({ tier, chain }: { tier: string; chain: ChainEntry[] }) => {
      const open = v.editTier === tier
      const active = chain.find(c => c.selected)
      const rest = chain.filter(c => c !== active)
      const skipped = chain.filter(c => !c.available)
      return (
        <Box flexDirection="column" key={`tier-${tier}`}>
          <Box flexDirection="row" gap={1}>
            <Box width={11} flexShrink={0}>
              <Button key={`edit-label-${tier}`} plain onPress={() => void setView({ editTier: open ? null : tier })}>
                <Text size="footnote" color="subtle">{TIER_RU[tier] ?? tier}</Text>
              </Button>
            </Box>
            <Box flexGrow={1} flexShrink={1}>
            <Button key={`edit-${tier}`} plain onPress={() => void setView({ editTier: open ? null : tier })}>
            <Text size="footnote" wrap="truncate-end">
              {active ? (
                <Text><Text weight="semibold">{modelName(active.provider, active.model)}</Text><Text color="subtle"> {active.effort}</Text></Text>
              ) : <Text color="error">нет доступных</Text>}
              {rest.length ? <Text size="caption" color="subtle">{`  → ${rest.map(c => modelName(c.provider, c.model)).join(' → ')}`}</Text> : null}
              <Text color="subtle">{open ? '  ⌄' : '  ›'}</Text>
            </Text>
            </Button>
            </Box>
          </Box>
          {skipped.length && !open ? (
            <Box paddingLeft={12}>
              <Text size="caption" color="warning" wrap="wrap">
                {skipped.map(c => `${modelName(c.provider, c.model)}: ${reasonRu(c.reason)}`).join(' · ')}
              </Text>
            </Box>
          ) : null}
          {open ? <TierEditor tier={tier} /> : null}
        </Box>
      )
    }

    const thresholdPct = o?.threshold?.switch_percent ?? 80
    const ThresholdRow = () => (
      <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
        <Text size="footnote">Codex → Claude при</Text>
        <Select key="threshold" value={String(thresholdPct)}
          options={[50, 60, 70, 75, 80, 85, 90, 95, 100].map(p => ({ value: String(p), label: `${p}%` }))}
          onSelect={value => void act($, 'threshold', ['config', 'threshold', '--percent', value], `Порог ${value}%`)} />
        {o?.threshold?.switched ? <Text size="caption" color="warning">сейчас на Claude</Text> : null}
      </Box>
    )

    const PresetRow = () => (
      <Box flexDirection="row" flexWrap="wrap" alignItems="center" gap={1}>
        {(o?.presets ?? []).map(p => (
          <Button key={`preset-${p.name}`} label={p.label || p.name}
            onPress={() => void act($, `preset-${p.name}`, ['config', 'preset', p.name], `Пресет «${p.label || p.name}»`)} />
        ))}
        <Link id="undo" label="↶ отменить" onPress={() => void act($, 'undo', ['config', 'undo'], 'Последнее изменение отменено')} />
      </Box>
    )

    const alerts = attentionItems(d)
    const usage = snap?.usage ?? null
    const tok = (x: number | { total: number } | undefined) => (typeof x === 'number' ? x : x?.total ?? 0)

    // ---- Header ----
    const Header = () => {
      const hasError = alerts.some(a => a.level === 'error')
      const color = alerts.length === 0 ? 'success' : hasError ? 'error' : 'warning'
      const text = alerts.length === 0 ? 'в порядке' : hasError ? 'проблема' : 'внимание'
      const free = snap?.ram.freeMb
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Text size="footnote"><Text weight="semibold">Luna</Text><Text color={color}>  ● {text}</Text></Text>
            <Text size="caption" color="subtle" tabular>
              {busy ? 'применяю… ' : ''}{free !== undefined ? `ОЗУ ${gb(free)} · ` : ''}
              {new Date(now).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}
            </Text>
          </Box>
          <Box flexDirection="row" gap={2} paddingTop={1}>
            <Tab id="tab-overview" hotkey="1" label="Обзор" active={v.tab === 'overview'} onPress={() => void setView({ tab: 'overview' })} />
            <Tab id="tab-usage" hotkey="2" label="Расход" active={v.tab === 'usage'} onPress={() => void setView({ tab: 'usage' })} />
            <Tab id="tab-settings" hotkey="3" label="Настройки" active={v.tab === 'settings'} onPress={() => void setView({ tab: 'settings' })} />
            <Tab id="tab-updates" hotkey="4" label="Версии" active={v.tab === 'updates'}
              onPress={() => { void setView({ tab: 'updates' }); if (!v.cli) void loadCli($, false) }} />
          </Box>
          {v.note && Date.now() - v.note.at < 15_000 ? (
            <Box paddingTop={1}><Text size="caption" color={v.note.level} wrap="wrap">{v.note.level === 'success' ? `✓ Сохранено: ${v.note.text}` : v.note.text}</Text></Box>
          ) : null}
        </Box>
      )
    }

    if (!snap) {
      return (
        <Box flexDirection="column" paddingX={1} paddingTop={1}>
          <Header />
          <Box paddingTop={1}><Text size="footnote" color="subtle">{d.error ? `Нет данных: ${d.error}` : 'Загружаю состояние…'}</Text></Box>
        </Box>
      )
    }

    const jobs = snap.jobs
    const codex = snap.codexLimits
    const gem = snap.gemini
    const room = Math.max(4, (e.viewport?.rows ?? 40) - 30)

    // ---- Overview ----

    // Every limit window on its own line: provider · window · percent · thin bar · when it resets.
    const LimitLine = ({ provider, window: win, pct, right, color, showName }: {
      provider: string; window: string; pct: number | null; right?: string; color?: 'success' | 'warning' | 'error'; showName: boolean
    }) => {
      const c = color ?? severity(pct ?? 0)
      return (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box width={7} flexShrink={0}><Text size="footnote" weight={showName ? 'medium' : 'regular'}>{showName ? provider : ''}</Text></Box>
          <Box width={7} flexShrink={0}><Text size="caption" color="subtle">{win}</Text></Box>
          <Box width={5} flexShrink={0} justifyContent="flex-end">
            <Text size="footnote" weight="medium" color={pct === null ? 'subtle' : c} tabular>{pct === null ? '—' : `${Math.round(pct)}%`}</Text>
          </Box>
          <Box flexShrink={0}>{pct === null ? <Text size="caption"> </Text> : <Bar pct={pct} color={c} />}</Box>
          <Box flexGrow={1} flexShrink={1}><Text size="caption" color="subtle" wrap="truncate-end">{right ?? ''}</Text></Box>
        </Box>
      )
    }

    const resetShort = (iso: string | null | undefined) => {
      const t = iso ? Date.parse(iso) : NaN
      if (!Number.isFinite(t)) return ''
      const left = (t - now) / 1000
      if (left <= 0) return ''
      if (left < 86400) return `↻ ${new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
      return `↻ ${new Date(t).toLocaleDateString('ru-RU', { weekday: 'short' })} ${new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`
    }

    const Limits = () => {
      const claude = d.claude.filter(l => l.kind !== 'spend_limit' || l.percentUsed > 0)
        .sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : 0))
      const cx = [codex?.primary, codex?.secondary].filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => (a.windowMins ?? 0) - (b.windowMins ?? 0))
      const q = gem?.quota
      // Gemini's own windows; `3p-*` are Antigravity's quotas for other vendors' models, which the harness never uses.
      const allBuckets = q?.available ? q.buckets : []
      const own = allBuckets.filter(x => /^gemini/i.test(x.name))
      const buckets = (own.length ? own : allBuckets)
        .sort((x, y) => (/5h/.test(x.name) ? -1 : /5h/.test(y.name) ? 1 : 0))
      const bucketName = (name: string) => (/5h/.test(name) ? '5 ч' : /week/.test(name) ? 'неделя' : name.replace(/^gemini-/, '').slice(0, 7))
      const today = usage?.today
      return (
        <Section title="Лимиты">
          <Box flexDirection="column">
          {claude.length ? claude.map((l, i) => (
            <LimitLine provider="Claude" showName={i === 0} window={windowName(l.kind, null)} pct={l.percentUsed} right={resetShort(l.resetsAt)} />
          )) : <LimitLine provider="Claude" showName window="" pct={null} right="после первого ответа" />}
          </Box>
          <Rule />
          <Box flexDirection="column">
          {codex?.reached ? <LimitLine provider="Codex" showName window="" pct={100} color="error" right="исчерпан" />
            : cx.length ? cx.map((w, i) => (
              <LimitLine provider="Codex" showName={i === 0} window={windowName('', w.windowMins)} pct={w.usedPercent}
                color={w.usedPercent >= thresholdPct ? 'warning' : severity(w.usedPercent)}
                right={w.usedPercent >= thresholdPct ? `≥ порога ${thresholdPct}%` : resetShort(w.resetsAt) || `порог ${thresholdPct}%`} />
            )) : <LimitLine provider="Codex" showName window="" pct={null} right="нет данных" />}
          </Box>
          <Rule />
          <Box flexDirection="column">
          {buckets.length ? buckets.map((b, i) => {
            const used = b.usedPercent ?? (b.remainingFraction !== undefined ? (1 - b.remainingFraction) * 100 : null)
            return <LimitLine provider="Gemini" showName={i === 0} window={bucketName(b.name)} pct={used} right={resetShort(b.resetAt)} />
          }) : (
            <LimitLine provider="Gemini" showName window="квота" pct={null}
              color={gem?.available === false ? 'error' : 'success'}
              right={!gem ? 'нет данных' : !gem.available ? `недоступен: ${reasonRu(gem.reason)}`
                : q?.lastExhaustedAt ? `исчерпывался ${clock(q.lastExhaustedAt)}` : q?.reason ? 'остаток не прочитан' : 'нет данных о квоте'} />
          )}
          </Box>
          {today ? (
            <Box paddingTop={0}>
              <Button key="today-usage" plain onPress={() => void setView({ tab: 'usage' })}>
                <Text size="caption" color="subtle" wrap="truncate-end">
                  сегодня  Claude {tokens(tok(today.claude))} · Codex {tokens(tok(today.codex))} · Gemini {tokens(tok(today.gemini))} ток.  ›
                </Text>
              </Button>
            </Box>
          ) : null}
        </Section>
      )
    }

    const Alerts = () => alerts.length ? (
      <Box flexDirection="column" paddingTop={1} gap={0}>
        {alerts.map(a => <Text size="footnote" color={a.level} wrap="wrap">{a.level === 'error' ? '▲' : '●'} {a.text}</Text>)}
      </Box>
    ) : null

    const Executors = () => {
      if (!o) return <Text size="caption" color="subtle">Оркестрация не настроена</Text>
      const last = snap.switches?.[0]
      const recent = last && now - Date.parse(last.at) < 6 * 3600_000
      return (
        <Section title="Исполнители" right={<Link id="exec-settings" label="настройки" tone="quiet" onPress={() => void setView({ tab: 'settings' })} />}>
          {Object.entries(o.chains).map(([tier, chain], i) => (
            <Box flexDirection="column" key={`tl-${tier}`}>{i > 0 ? <Rule /> : null}<TierLine tier={tier} chain={chain} /></Box>
          ))}
          {recent && last ? (
            <Text size="caption" color="subtle" wrap="wrap">
              {clock(last.at)} {TIER_RU[last.tier] ?? last.tier}: {last.from} → {last.to}{last.reason ? ` (${reasonRu(last.reason)})` : ''}
            </Text>
          ) : null}
        </Section>
      )
    }

    const JobRow = ({ j }: { j: Job }) => {
      const isRunning = j.state === 'running'
      const idle = isRunning ? j.idleS ?? null : null
      const quiet = idle !== null && idle >= 900 ? 'error' : idle !== null && idle >= 300 ? 'warning' : null
      const a = j.activity
      const cmd = a?.kind === 'command' ? describeCommand(a.text) : null
      const doing = !isRunning || !a ? '' : cmd ? cmd.text
        : a.kind === 'thinking' ? 'думает' : a.kind === 'editing' ? `правит${a.text ? ` ${a.text}` : ''}`
        : a.kind === 'writing' ? 'пишет ответ' : a.kind === 'starting' ? 'запускается' : a.text || ''
      const prov = providerOf(j)
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text size="footnote" wrap="truncate-end" dimColor={!isRunning}>
              <Text color={quiet ?? (isRunning ? 'success' : 'warning')}>{isRunning ? '▶' : '◷'} </Text>
              <Text color={prov === 'gemini' ? 'suggestion' : 'subtle'}>{prov === 'gemini' ? 'Gemini' : 'Codex'} </Text>
              <Text weight="medium">{modelName(j.provider, j.model).replace(/^Gemini /, '')}</Text>
              <Text color="subtle"> {j.effort} </Text>{jobName(j.out)}
            </Text>
            <Text size="caption" color={quiet ?? 'subtle'} tabular>
              {quiet ? `тихо ${duration(idle ?? 0)}` : isRunning ? duration(j.ageS) : `${STATE_RU[j.state] ?? j.state} ${duration(j.ageS)}`}
            </Text>
          </Box>
          {doing ? <Box paddingLeft={2}><Text size="caption" color="subtle" wrap="truncate-end">{doing}</Text></Box> : null}
        </Box>
      )
    }

    const Jobs = () => {
      const beats = snap.sessions ?? []
      const counts = {
        codex: jobs.filter(j => providerOf(j) === 'codex' && j.state === 'running').length,
        gemini: jobs.filter(j => providerOf(j) === 'gemini' && j.state === 'running').length,
        claude: beats.reduce((n, b) => n + (b.agents?.length ?? 0), 0),
      }
      const showJob = (j: Job) => v.filter === 'all' || v.filter === providerOf(j)
      const showAgents = v.filter === 'all' || v.filter === 'claude'
      const visible = jobs.filter(showJob)
      const ids = [...new Set([...beats.map(b => b.sessionId), ...visible.map(j => j.owner).filter(Boolean)])]
      const all = ids.map(id => ({ id, beat: beats.find(b => b.sessionId === id), jobs: visible.filter(j => j.owner === id) }))
      const busyNow = (g: (typeof all)[number]) => !!g.beat && now - g.beat.updatedAt <= 60_000 && g.beat.state !== 'idle'
      const withWork = all.filter(g => g.jobs.length || (showAgents && (g.beat?.agents?.length ?? 0) > 0) || busyNow(g) || g.id === d.sessionId)
        .sort((a, b) => (a.id === d.sessionId ? -1 : b.id === d.sessionId ? 1 : 0) || (b.jobs.length - a.jobs.length))
      const idle = all.filter(g => !withWork.includes(g) && g.beat && now - g.beat.updatedAt <= 15 * 60_000)
      const orphans = visible.filter(j => !j.owner)
      return (
        <Box flexDirection="column">
          <Head text="Задачи" right={
            <Box flexDirection="row" gap={0}>
              <Chip id="f-all" label="все" active={v.filter === 'all'} onPress={() => void setView({ filter: 'all' })} />
              <Chip id="f-codex" label={`Codex ${counts.codex}`} active={v.filter === 'codex'} onPress={() => void setView({ filter: 'codex' })} />
              <Chip id="f-gemini" label={`Gemini ${counts.gemini}`} active={v.filter === 'gemini'} onPress={() => void setView({ filter: 'gemini' })} />
              <Chip id="f-claude" label={`Claude ${counts.claude}`} active={v.filter === 'claude'} onPress={() => void setView({ filter: 'claude' })} />
            </Box>
          } />
          {withWork.length === 0 && orphans.length === 0 ? (
            <Text size="footnote" color="subtle">{v.filter === 'all' ? 'Сейчас ничего не выполняется.' : 'Таких задач нет.'}</Text>
          ) : null}
          {withWork.map(g => {
            const b = g.beat
            const isMe = g.id === d.sessionId
            const stale = !b || now - b.updatedAt > 60_000
            const name = b?.name || projectOfJobs(g.jobs) || (isMe ? 'эта сессия' : 'без папки')
            const state = !b ? '' : stale ? 'неактивна' : b.state === 'thinking' ? 'думает' : b.state === 'tool' && b.tool ? b.tool.name : 'ждёт вас'
            const stateColor = !stale && b?.state === 'thinking' ? 'claude' : !stale && b?.state === 'idle' ? 'warning' : 'subtle'
            const id = `s-${g.id}`
            const open = !folded[id]
            return (
              <Card>
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Button key={`fold-${id}`} plain onPress={toggle(id)}>
                    <Text size="footnote" weight="semibold" wrap="truncate-end">{name}
                      <Text size="caption" weight="regular" color="subtle">{isMe ? '  эта' : ''}{open ? '' : `  ${g.jobs.length} ›`}</Text>
                    </Text>
                  </Button>
                  <Text size="caption" color={stateColor}>{state}</Text>
                </Box>
                {open ? (
                  <Box flexDirection="column" paddingLeft={1}>
                    {showAgents ? (b?.agents ?? []).map(a => (
                      <Box flexDirection="row" justifyContent="space-between" gap={1}>
                        <Text size="footnote" wrap="truncate-end"><Text color="claude">◇ Claude </Text>{a.description || 'агент'}</Text>
                        <Text size="caption" color="subtle" tabular>{duration((now - a.since) / 1000)}</Text>
                      </Box>
                    )) : null}
                    {g.jobs.slice(0, room).map((j, i) => (
                      <Box flexDirection="column" key={`j-${j.out}`}><JobRow j={j} /></Box>
                    ))}
                    {g.jobs.length > room ? <Text size="caption" color="subtle">и ещё {g.jobs.length - room}</Text> : null}
                  </Box>
                ) : null}
              </Card>
            )
          })}
          {orphans.length ? (
            <Card>
              <Text size="footnote" weight="semibold">Без сессии</Text>
              <Box flexDirection="column" paddingLeft={1}>{orphans.slice(0, room).map((j, i) => (
                <Box flexDirection="column" key={`o-${j.out}`}><JobRow j={j} /></Box>
              ))}</Box>
            </Card>
          ) : null}
          {idle.length && v.filter === 'all' ? (
            <Box flexDirection="column" marginTop={1} paddingX={1}>
              <Text size="caption" color="subtle" wrap="wrap">
                ещё {idle.length} без задач: {idle.map(g => g.beat?.name || 'без папки').join(', ')}
              </Text>
            </Box>
          ) : null}
        </Box>
      )
    }

    const overview = () => (
      <Box flexDirection="column">
        <Alerts />
        <Limits />
        <Executors />
        <Jobs />
      </Box>
    )

    // ---- Usage tab ----

    const usageTab = () => {
      if (!usage) {
        return <Box paddingTop={1}><Text size="footnote" color="subtle">Сводка расхода появится после первого сбора (около минуты).</Text></Box>
      }
      const PROV = [
        { key: 'claude', name: 'Claude', hex: '#d97757' },
        { key: 'codex', name: 'Codex', hex: '#8b949e' },
        { key: 'gemini', name: 'Gemini', hex: '#4c8df6' },
      ] as const
      const today = usage.today ?? {}
      const week = usage.week ?? {}
      const days = (usage.days ?? []).slice(-7)
      const dayTotal = (x: (typeof days)[number]) => tok(x.claude) + tok(x.codex) + tok(x.gemini)
      const max = Math.max(1, ...days.map(dayTotal))
      // Seven stacked columns, one per day, providers in their own colour; drawn as one small SVG.
      const W = 220
      const H = 56
      const colW = Math.floor(W / Math.max(7, days.length)) - 6
      let rects = ''
      days.forEach((x, i) => {
        let y = H
        for (const p of PROV) {
          const h = Math.round((tok(x[p.key]) / max) * (H - 2))
          if (h > 0) { y -= h; rects += `<rect x="${i * (colW + 6)}" y="${y}" width="${colW}" height="${h}" rx="2" fill="${p.hex}"/>` }
        }
      })
      const chart = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${rects}</svg>`
      const Row = ({ label, value, sub, hex }: { label: string; value: string; sub?: string; hex?: string }) => (
        <Box flexDirection="row" alignItems="center" gap={1}>
          <Box width={9} flexShrink={0}><Text size="footnote">{hex && !isTerminal ? <Text color="subtle">■ </Text> : ''}{label}</Text></Box>
          <Box width={10} flexShrink={0} justifyContent="flex-end"><Text size="footnote" weight="medium" tabular>{value}</Text></Box>
          <Box flexGrow={1} flexShrink={1}><Text size="caption" color="subtle" wrap="truncate-end">{sub ?? ''}</Text></Box>
        </Box>
      )
      // Folder-derived names carry the parent folder (dev-kriminalist, work-jewel); the project name is enough here.
      const shortProject = (name: string | undefined) => (name || 'без папки').replace(/^(?:dev|work|home|projects?)-/, '')
      // Claude sessions are named by their id; a date says more to a person than a UUID.
      const jobTitle = (name: string, at?: string) => (/^[0-9a-f]{8}-[0-9a-f]{4}-/.test(name)
        ? `сессия ${at ? new Date(at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }) : ''}`.trim() : name)
      const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '')
      const todayAll = PROV.reduce((n, p) => n + tok(today[p.key]), 0)
      const weekAll = PROV.reduce((n, p) => n + tok(week[p.key]), 0)
      return (
        <Box flexDirection="column">
          <Section title="Сегодня" right={<Text size="caption" color="subtle" tabular>{tokens(todayAll)} ток.{usage.stale ? ' · обновляю' : ''}</Text>}>
          {PROV.map(p => {
            const t = today[p.key]
            const cached = t?.cached && tok(t) ? `кеш ${Math.round((t.cached / tok(t)) * 100)}%` : ''
            return <Row label={p.name} hex={p.hex} value={tokens(tok(t))}
              sub={[pct(tok(t), todayAll), t?.output ? `вывод ${tokens(t.output)}` : '', cached].filter(Boolean).join(' · ')} />
          })}

          <Text size="caption" color="subtle" wrap="wrap">Кеш — повторно прочитанный контекст диалога: он и есть почти весь расход Claude и стоит в разы дешевле новых токенов.</Text>
          </Section>

          <Section title="7 дней" right={<Text size="caption" color="subtle" tabular>{tokens(weekAll)} ток.</Text>}>
          {Svg && days.length ? (
            <Box flexDirection="column">
              <Svg source={chart} alt={`токены за 7 дней: ${days.map(x => tokens(dayTotal(x))).join(', ')}`} width={W} height={H} />
              <Text size="caption" color="subtle" tabular>
                {days.map(x => new Date(`${x.date}T12:00:00`).toLocaleDateString('ru-RU', { weekday: 'short' }).padEnd(4, ' ')).join(' ')}
              </Text>
              <Text size="caption" color="subtle">
                {PROV.map(p => `■ ${p.name}`).join('   ')}
              </Text>
            </Box>
          ) : (
            days.map(x => <Row label={x.date.slice(5)} value={tokens(dayTotal(x))} />)
          )}
          {PROV.map(p => <Row label={p.name} value={tokens(tok(week[p.key]))} sub={pct(tok(week[p.key]), weekAll)} />)}
          </Section>

          {(usage.byModel7d ?? []).length ? (
            <Section title="По моделям · 7 дней">
              {(usage.byModel7d ?? []).slice(0, 6).map(m => <Row label={modelName(m.provider, m.model).slice(0, 9)} value={tokens(m.total)} sub={pct(m.total, weekAll)} />)}
            </Section>
          ) : null}
          {(usage.byProject7d ?? []).length ? (
            <Section title="По проектам · 7 дней">
              {(usage.byProject7d ?? []).slice(0, 6).map(p => <Row label={shortProject(p.project).slice(0, 9)} value={tokens(p.total)} sub={pct(p.total, weekAll)} />)}
            </Section>
          ) : null}
          {(usage.topJobs ?? []).length ? (
            <Section title="Самые тяжёлые задачи">
              {(usage.topJobs ?? []).slice(0, 5).map(j => (
                <Row label={j.provider === 'gemini' ? 'Gemini' : j.provider === 'codex' ? 'Codex' : 'Claude'} value={tokens(j.total)}
                  sub={`${jobTitle(j.name, j.at)}${j.project ? ` · ${shortProject(j.project)}` : ''}`} />
              ))}
            </Section>
          ) : null}
          {(usage.notes ?? []).map(n => <Box paddingTop={1}><Text size="caption" color="subtle" wrap="wrap">{n}</Text></Box>)}
        </Box>
      )
    }

    // ---- Settings tab: an accordion, one tier open at a time ----

    const settings = () => {
      if (!o) return <Text size="footnote" color="subtle">Нет конфигурации оркестрации.</Text>
      const Fold = ({ id, title, byDefault, children, right }: {
        id: string; title: string; byDefault: boolean; children: RenderChildren; right?: RenderChildren
      }) => {
        const open = folded[id] === undefined ? byDefault : !folded[id]
        return (
          <Card>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center">
              <Button key={`fold-${id}`} plain onPress={() => void update($, collapsed, prev => ({ ...(prev ?? {}), [id]: open }))}>
                <Text size="caption" weight="semibold" color="subtle">{title.toUpperCase()}{open ? '  ⌄' : '  ›'}</Text>
              </Button>
              {right ?? null}
            </Box>
            {open ? <Box flexDirection="column" paddingTop={0}>{children}</Box> : null}
          </Card>
        )
      }
      return (
        <Box flexDirection="column">
          <Fold id="set-tiers" title="Модели по задачам" byDefault>
            <Text size="caption" color="subtle" wrap="wrap">Первый доступный сверху выполняет задачу; нажмите на строку, чтобы изменить.</Text>
            {Object.entries(o.chains).map(([tier, chain], i) => (
              <Box flexDirection="column" key={`ts-${tier}`}>{i > 0 ? <Rule /> : null}<TierLine tier={tier} chain={chain} /></Box>
            ))}
          </Fold>
          <Fold id="set-auto" title="Автопереключение и пресеты" byDefault>
            <ThresholdRow />
            <Box flexDirection="row" alignItems="center" gap={1} flexWrap="wrap">
              <Text size="footnote">Обратно на Codex при</Text>
              <Select key="hysteresis" value={String(o.threshold?.hysteresis_percent ?? 5)}
                options={[0, 3, 5, 10, 15].map(p => ({ value: String(p), label: `≤ ${thresholdPct - p}%` }))}
                onSelect={value => void act($, 'hyst', ['config', 'threshold', '--percent', String(thresholdPct), '--hysteresis', value], `Обратно на Codex при ≤ ${thresholdPct - Number(value)}%`)} />
            </Box>
            <Text size="caption" color="subtle" wrap="wrap">
              {`Когда лимит Codex доходит до ${thresholdPct}%, задачи Codex уходят на Claude (Sol → Sonnet, Luna → Haiku). Назад на Codex — когда расход опустится до ${thresholdPct - (o.threshold?.hysteresis_percent ?? 5)}%: запас не даёт прыгать туда-сюда у самого порога.`}
            </Text>
            <Box paddingTop={1}><PresetRow /></Box>
            <Box paddingTop={1}>
              <Input key="preset-name" placeholder="сохранить как пресет…" value={v.presetName}
                onInput={value => void setView({ presetName: value })} submitLabel="сохранить"
                onSubmit={value => {
                  const label = value.trim()
                  if (!label) return
                  const slug = label.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '-').replace(/^-|-$/g, '').slice(0, 32) || 'preset'
                  void act($, 'save-preset', ['config', 'save-preset', '--name', slug, '--label', label], `Пресет «${label}» сохранён`)
                  void setView({ presetName: '' })
                }} />
            </Box>
          </Fold>
          <Fold id="set-panels" title="Панели ревью" byDefault={false}>
            {Object.entries(o.panels ?? {}).map(([name, seats]) => (
              <Box flexDirection="column" key={`sp-${name}`} paddingTop={1}>
                <Text size="footnote" color="subtle">{PANEL_RU[name] ?? name}</Text>
                {seats.map((s, i) => <EntryRow where={['--panel', name, '--seat', String(i)]} index={i} entry={s} count={seats.length} />)}
              </Box>
            ))}
          </Fold>
          <Fold id="set-catalog" title="Каталог моделей" byDefault={false}>
            {Object.entries(o.catalog ?? {}).map(([p, models]) => (
              <Box flexDirection="row" gap={1} key={`cat-${p}`}>
                <Box width={7} flexShrink={0}><Text size="footnote" color="subtle">{p}</Text></Box>
                <Box flexGrow={1} flexShrink={1}><Text size="footnote" wrap="wrap">{models.map(m => modelName(p, m.model)).join(' · ')}</Text></Box>
              </Box>
            ))}
            <Box flexDirection="row" alignItems="center" gap={1} paddingTop={1}>
              <Select key="draft-provider" value={v.draftProvider} options={['codex', 'gemini', 'claude'].map(p => ({ value: p, label: p }))}
                onSelect={value => void setView({ draftProvider: value })} />
              <Box flexGrow={1} minWidth={14}>
                <Input key="draft-model" placeholder="id новой модели" value={v.draftModel}
                  onInput={value => void setView({ draftModel: value })} submitLabel="добавить"
                  onSubmit={value => {
                    const model = value.trim()
                    if (!model) return
                    void act($, 'catalog-add', ['catalog', 'add', '--provider', v.draftProvider, '--model', model, '--efforts', v.draftEfforts],
                      `Модель ${modelName(v.draftProvider, model)} добавлена`)
                    void setView({ draftModel: '' })
                  }} />
              </Box>
            </Box>
            <Box paddingTop={0}>
              <Input key="draft-efforts" label="effort" value={v.draftEfforts} placeholder="low,medium,high"
                onInput={value => void setView({ draftEfforts: value.replace(/\s+/g, '') })} submitLabel="ок"
                onSubmit={value => void setView({ draftEfforts: value.replace(/\s+/g, '') })} />
            </Box>
            <Link id="catalog-refresh" label="найти новые модели Gemini"
              onPress={() => void act($, 'catalog-refresh', ['catalog', 'refresh', '--provider', 'gemini'], 'Каталог Gemini обновлён')} />
          </Fold>
        </Box>
      )
    }

    // ---- Updates tab ----

    const updates = () => {
      const c = v.cli
      const Card = ({ id, name, installed, latest, note, can, onUpdate, extra }: {
        id: string; name: string; installed?: string | null; latest?: string | null; note?: string; can: boolean
        onUpdate: () => void; extra?: RenderChildren
      }) => {
        const fresh = !!latest && !!installed && latest !== installed
        return (
          <Box flexDirection="column" marginTop={1}>
            <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
              <Text size="footnote">
                <Text weight="semibold">{name}</Text>
                <Text color="subtle" tabular>  {installed ?? '…'}</Text>
                {fresh ? <Text color="success" tabular>  → {latest}</Text> : null}
              </Text>
              {fresh && can ? (
                <Button key={`upd-${id}`} variant={armed(`upd-${id}`) ? 'primary' : undefined}
                  label={busy === `update-${id}` ? 'обновляю…' : armed(`upd-${id}`) ? 'точно?' : 'обновить'}
                  onPress={confirmThen(`upd-${id}`, onUpdate)} />
              ) : (
                <Text size="caption" color={fresh ? 'warning' : installed ? 'success' : 'subtle'}>
                  {!installed ? 'проверяю' : fresh ? 'есть новее' : 'актуальна'}
                </Text>
              )}
            </Box>
            {note ? <Text size="caption" color="subtle" wrap="wrap">{note}</Text> : null}
            {extra ?? null}
          </Box>
        )
      }
      const cx = c?.codex
      const ag = c?.agy
      return (
        <Box flexDirection="column">
          <Head text={c?.checkedAt ? `проверено в ${clock(c.checkedAt)}` : 'версии'}
            right={<Link id="cli-refresh" label={busy === 'cli-status' ? 'проверяю…' : 'проверить'} onPress={() => void loadCli($, true)} />} />
          <Card id="codex" name="Codex CLI" installed={cx?.installed} latest={cx?.latest} can={!cx?.busy?.reason}
            note={[
              cx?.busy?.reason ? `ждёт свободного демона: ${cx.busy.jobs} задач в работе` : '',
              cx?.expectedByHarness && cx.latest && cx.expectedByHarness !== cx.latest ? `харнесс закреплён на ${cx.expectedByHarness}` : '',
            ].filter(Boolean).join(' · ')}
            onUpdate={() => void runUpdate($, 'codex', ['update', 'codex', ...(cx?.latest ? ['--version', cx.latest] : [])])} />
          <Card id="agy" name="Antigravity" installed={ag?.installed} latest={ag?.latest} can={!ag?.busy?.reason}
            note={[
              ag?.checksumOk === false ? 'сумма бинаря не совпадает: Gemini отключён' : ag?.checksumOk ? 'сумма закреплена' : '',
              ag?.busy?.reason ? `занят: ${ag.busy.reason}` : '',
            ].filter(Boolean).join(' · ')}
            onUpdate={() => void runUpdate($, 'agy', ['update', 'agy', ...(ag?.latestUrl ? ['--url', ag.latestUrl] : [])])}
            extra={ag?.rollbackAvailable ? (
              <Link id="agy-rollback" tone="danger" label={armed('rollback-agy') ? 'точно откатить?' : 'откатить на прошлую версию'}
                onPress={confirmThen('rollback-agy', () => void runUpdate($, 'agy-rollback', ['rollback', 'agy']))} />
            ) : undefined} />
          <Box paddingTop={1}>
            <Text size="caption" color="subtle" wrap="wrap">Codex ставится, когда демон свободен; Antigravity проверяется запуском до замены и откатывается при ошибке.</Text>
          </Box>
        </Box>
      )
    }

    return (
      <Box flexDirection="column" paddingX={1} paddingTop={1}>
        <Header />
        {v.tab === 'overview' ? overview() : v.tab === 'usage' ? usageTab() : v.tab === 'settings' ? settings() : updates()}
      </Box>
    )
  })
}
