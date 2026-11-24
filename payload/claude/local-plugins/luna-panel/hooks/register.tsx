import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderChildren } from 'claude-code'

import type {
  ChainEntry, ClaudeLimit, CliStatus, CodexAccount, CodexLimits, Collapsed, Job, LimitWindow, MlaiState, PanelData,
  SessionBeat, Snapshot, View,
} from '../types'

// The Luna pane, conveyor edition: limits of every provider, the executor chains with the active one marked, every
// executor's jobs (Codex, Claude subagents), the orchestration editor and CLI updates.
// Data: the Luna collector snapshot and $.session.usage(); settings through
// `node ~/.claude/scripts/conveyor/exec.mjs config …`; updates through `node ~/.claude/scripts/conveyor/cli-update.mjs`.

const PANE = 'luna-panel'
const TITLE = 'Luna'
const COMMAND = 'luna'
const POLL_MS = 5000
const BEAT_MS = 20_000
const STALE_MS = 30_000
const COLLECTOR_HINT = 'сборщик не отвечает — запустите: node ~/.claude/scripts/luna-collector.mjs start'

const EMPTY: PanelData = { snapshot: null, claude: [], error: '', polledAt: 0, sessionId: '' }
const VIEW0: View = {
  tab: 'overview', editTier: null, filter: 'all', confirm: null, busy: null, note: null, cli: null,
  draftModel: '', draftProvider: 'codex', draftEfforts: 'low,medium,high', presetName: '',
}
const data = atom({ plugin: 'luna-panel', key: 'data' } as const, EMPTY)
const collapsed = atom({ plugin: 'luna-panel', key: 'collapsed' } as const, {} as Collapsed)
const view = atom({ plugin: 'luna-panel', key: 'view' } as const, VIEW0, { shape: 'view-1' })

// ---- Words -----------------------------------------------------------------------------------------------------

const TIER_RU: Record<string, string> = {
  complex: 'Сложное', simple: 'Простое', review: 'Ревью', scout: 'Разведка', architect: 'Архитектура', approach: 'Подход', planner: 'План',
}
const TIER_HINT: Record<string, string> = {
  complex: 'реализация, отладка, рефакторинг',
  simple: 'механика, шаблонные правки',
  review: 'критики и ревью',
  scout: 'поиск и чтение',
  architect: 'ревью сложной архитектуры и задач, что ходят по кругу',
  approach: 'ревью подхода для средних задач',
  planner: 'технический план сложной архитектуры по фактам',
}
const PANEL_RU: Record<string, string> = {
  design: 'Арена (проектирование)', review: 'Ревью (interrogate)', judge: 'Судьи', architect: 'Эскизы архитектуры',
}
const PANEL_SHORT: Record<string, string> = { design: 'Арена', review: 'Ревью', judge: 'Судьи', architect: 'Архитектура' }
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

/** Time left with minutes even across days, leading empty units dropped: "6д 2ч 13м", "4ч 0м", "37м", "<1м". */
function timeLeft(totalS: number): string {
  const m = Math.floor(Math.max(0, totalS) / 60)
  if (m < 1) return '<1м'
  const d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60
  return d ? `${d}д ${h}ч ${mm}м` : h ? `${h}ч ${mm}м` : `${mm}м`
}

const dayStart = (t: Date) => new Date(t.getFullYear(), t.getMonth(), t.getDate()).getTime()

/** A reset as the local wall clock: "15:57" today, "завтра 09:00", "пн 15:57" within the week, else "1 дек 15:57". */
function wallClock(t: number, now: number): string {
  const at = new Date(t)
  const time = at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
  const days = Math.round((dayStart(at) - dayStart(new Date(now))) / 86_400_000)
  if (days <= 0) return time
  if (days === 1) return `завтра ${time}`
  if (days < 6) return `${at.toLocaleDateString('ru-RU', { weekday: 'short' })} ${time}`
  return `${at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace('.', '')} ${time}`
}

type Reset = { at: string; left: string }

/** When a limit window resets and how long until then; null when unknown or already past. */
function resetOf(iso: string | null | undefined, now: number): Reset | null {
  const t = iso ? Date.parse(iso) : NaN
  if (!Number.isFinite(t) || t <= now) return null
  return { at: wallClock(t, now), left: timeLeft((t - now) / 1000) }
}

function clock(iso: string | null | undefined): string {
  const t = iso ? Date.parse(iso) : NaN
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : ''
}

function gb(mb: number): string {
  return `${(mb / 1024).toFixed(1)} ГБ`
}

function credits(n: number): string {
  return n >= 10 ? `${Math.round(n)}` : n >= 1 ? n.toFixed(1) : n.toFixed(2)
}

function tokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)} млн`
  if (n >= 1e3) return `${Math.round(n / 1e3)} тыс`
  return `${n}`
}

/** A model as a person names it, version kept so a new release never looks like the old one: Sol 6.1, Luna 6,
 *  Gemini Flash, Sonnet. Unknown ids are shown as they are. */
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/** ML AI Code ids as a person says them: Pixis Sol, ML Sonnet 5.5, ML GLM 5.3; a non-Pixis model gets an "ML" prefix
 *  so the Astra on ML AI never reads as Codex's Astra. */
function mlaiName(m: string): string {
  const pixis = /^pixis(?:-(\w+))?$/i.exec(m)
  if (pixis) return pixis[1] ? `Pixis ${cap(pixis[1])}` : 'Pixis'
  const own = /^(?:ml-ai|mlai)-(\w+)$/i.exec(m)
  if (own) return `ML ${cap(own[1] ?? '')}`
  const gpt = /^gpt-([\d.]+)-(\w+)$/i.exec(m)
  const claude = /^claude-(\w+)-([\d.]+)$/i.exec(m)
  const other = /^([a-z]+)-([\d.]+)$/i.exec(m)
  const base = gpt ? `${cap(gpt[2] ?? '')} ${gpt[1]}` : claude ? `${cap(claude[1] ?? '')} ${claude[2]}`
    : other ? `${(other[1] ?? '').length <= 3 ? (other[1] ?? '').toUpperCase() : cap(other[1] ?? '')} ${other[2]}` : m
  return `ML ${base}`
}

const PROVIDER_RU: Record<string, string> = { mlai: 'ML AI', codex: 'Codex', claude: 'Claude', gemini: 'Gemini' }

function modelName(provider: string | undefined, model: string): string {
  const m = model || ''
  if (provider === 'mlai') return mlaiName(m)
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

function providerOf(j: Job): 'mlai' | 'codex' | 'gemini' {
  if (j.provider === 'mlai') return 'mlai'
  return j.provider === 'gemini' || /^gemini/i.test(j.model) ? 'gemini' : 'codex'
}

/** How the ML AI Code sign-in stands: it lasts 7 days, so the pane warns two days ahead. */
function mlaiSignIn(m: MlaiState | null | undefined, now: number):
  { text: string; level: 'ok' | 'soon' | 'warning' | 'error'; leftS: number | null } | null {
  if (!m) return null
  if (!m.installed) return { text: 'не установлен', level: 'warning', leftS: null }
  if (!m.signedIn) {
    return m.reason === 'sign-in expired'
      ? { text: 'вход истёк', level: 'error', leftS: 0 }
      : { text: 'нет входа', level: 'warning', leftS: null }
  }
  const t = m.expiresAt ? Date.parse(m.expiresAt) : NaN
  if (!Number.isFinite(t)) return { text: 'вход есть', level: 'ok', leftS: null }
  const leftS = (t - now) / 1000
  if (leftS <= 0) return { text: 'вход истёк', level: 'error', leftS: 0 }
  return { text: `вход до ${wallClock(t, now)}`, level: leftS < 48 * 3600 ? 'soon' : 'ok', leftS }
}

const MLAI_LOGIN = 'MLAI_NO_BROWSER=1 ~/.claude/tools/mlai/node_modules/.bin/mlai login'

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
  const busy = /sessions busy \((\d+)\/(\d+)\)/.exec(r)
  if (busy) return `заняты все сессии (${busy[1]}/${busy[2]})`
  if (/sign-in expired/i.test(r)) return 'вход истёк'
  if (/not signed in/i.test(r)) return 'нет входа'
  if (/not installed/i.test(r)) return 'не установлен'
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

// ---- What needs the person ---------------------------------------------------------------------------------------

type Alert = { level: 'error' | 'warning'; text: string }

/** The snapshot's Codex accounts with the fields the pane reads; a malformed entry is dropped, not guessed. */
function codexAccountsOf(s: Snapshot): CodexAccount[] {
  return (Array.isArray(s.codexAccounts) ? s.codexAccounts : [])
    .filter((a): a is CodexAccount => !!a && typeof a.id === 'string' && typeof a.label === 'string')
}

function attentionItems(d: PanelData): Alert[] {
  const s = d.snapshot
  const out: Alert[] = []
  if (!s) return d.error ? [{ level: 'warning', text: 'Нет данных от сборщика' }] : []
  const free = s.ram.freeMb
  if (free !== null) {
    if (free < 1024) out.push({ level: 'error', text: `Мало памяти: ${gb(free)}, новые задачи ждут` })
    else if (free < 2048) out.push({ level: 'warning', text: `Памяти немного: ${gb(free)}` })
  }
  const jobs = s.jobs.filter(j => providerOf(j) !== 'gemini')
  for (const j of jobs) {
    if (j.state === 'running' && (j.idleS ?? 0) >= 900) {
      out.push({ level: 'error', text: `${modelName(j.provider, j.model)} «${jobName(j.out)}» молчит ${duration(j.idleS ?? 0)}` })
    }
  }
  const starved = jobs.filter(j => j.state === 'waiting-ram').length
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
  const accounts = codexAccountsOf(s)
  if (accounts.length > 1) {
    for (const a of accounts) if (!a.loggedIn) out.push({ level: 'warning', text: `Codex «${a.label || a.id}»: нет входа` })
    if (accounts.every(a => a.exhausted || !a.loggedIn)) {
      out.push({ level: 'warning', text: 'Все аккаунты Codex на пороге: задачи идут на Claude' })
    }
  } else if (s.codexLimits?.reached) out.push({ level: 'error', text: 'Лимит Codex исчерпан' })
  // ML AI Code matters only while some chain or panel uses it.
  const usesMlai = [...Object.values(o?.chains ?? {}), ...Object.values(o?.panels ?? {})].some(c => c.some(x => x.provider === 'mlai'))
  const sign = usesMlai ? mlaiSignIn(s.mlai, d.polledAt || Date.now()) : null
  if (sign && sign.level !== 'ok') {
    const text = sign.level === 'soon' ? `ML AI: вход истекает через ${timeLeft(sign.leftS ?? 0)}, войдите заново`
      : sign.text === 'не установлен' ? 'ML AI не установлен: задачи идут на Codex'
      : `ML AI: ${sign.text}, задачи идут на Codex`
    out.push({ level: sign.level === 'error' ? 'error' : 'warning', text })
  }
  if (d.error) out.push({ level: 'warning', text: `Данные не обновляются: ${d.error.slice(0, 80)}` })
  return out.sort((a, b) => (a.level === 'error' ? 0 : 1) - (b.level === 'error' ? 0 : 1))
}

// ---- Polling -------------------------------------------------------------------------------------------------------

async function claudeHome($: EngineInterface): Promise<string> {
  const home = await $.env.get('USERPROFILE') || await $.env.get('HOME')
  if (home) return `${home.replace(/\\/g, '/').replace(/\/+$/, '')}/.claude`
  const installed = $.plugin.root.replace(/\\/g, '/').match(/^(.*\/\.claude)\/(?:local-plugins|plugins)\//i)
  if (installed?.[1]) return installed[1]
  throw new Error('Не найден домашний каталог Claude')
}

function parseSnapshot(text: string): Snapshot {
  const s = JSON.parse(text) as Snapshot | null
  if (s?.version !== 2 || !Number.isFinite(Date.parse(s.collector?.publishedAt)) ||
      !s.ram || !s.daemon || !Array.isArray(s.jobs) || !Array.isArray(s.claudeLimits)) {
    throw new Error('Некорректный снимок сборщика')
  }
  return s
}

function mergeClaudeLimits(own: ClaudeLimit[], shared: ClaudeLimit[], now: number): ClaudeLimit[] {
  const out = new Map<string, ClaudeLimit>()
  for (const limit of [...own, ...shared]) {
    if (!out.has(limit.kind) && (!limit.resetsAt || Date.parse(limit.resetsAt) > now)) out.set(limit.kind, limit)
  }
  return [...out.values()]
}

async function currentSessionId($: EngineInterface): Promise<string> {
  const fromEnv = await $.env.get('CLAUDE_CODE_SESSION_ID')
  if (fromEnv) return fromEnv
  try { return (await $.session.id()) ?? '' } catch { return '' }
}

async function currentLimits($: EngineInterface): Promise<ClaudeLimit[]> {
  try { return (await $.session.usage()).rateLimits ?? [] } catch { return [] }
}

// ---- Actions: settings and updates (each one a CLI run; the result becomes a one-line note) -----------------------

type ActionResult = { ok: boolean; note: string }

async function runJson($: EngineInterface, script: string, args: string[], timeoutMs: number):
  Promise<ActionResult & { json?: unknown }> {
  try {
    const run = await $.process.run(['node', `${await claudeHome($)}/scripts/conveyor/${script}`, ...args], { timeoutMs })
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
  const r = await runJson($, 'exec.mjs', [...args, '--actor', 'panel'], 30_000)
  const at = await $.clock.now()
  await update($, view, prev => ({
    ...(prev ?? VIEW0), busy: null,
    note: { text: r.ok ? okText : `Не применено: ${r.note}`, level: (r.ok ? 'success' : 'error') as 'success' | 'error', at },
  }))
}

let catalogBusy = false

async function refreshCatalog($: EngineInterface): Promise<void> {
  if (catalogBusy) return
  catalogBusy = true
  try {
    // 120 s: room for exec.mjs's own limits (Codex 15 s, then the cache; 15 s per Claude Code binary scanned).
    const r = await runJson($, 'exec.mjs', ['catalog', 'refresh', '--provider', 'all', '--actor', 'panel'], 120_000)
    const names = r.ok && /^added /.test(r.note) ? r.note.replace(/^added /, '').replace(/;.*$/, '').split(/,\s*/) : []
    const added = names.map(x => { const [p, m] = x.split('/'); return m ? modelName(p, m) : x }).join(', ')
    const text = !r.ok ? `Поиск моделей: ${r.note}` : added ? `В каталог добавлены: ${added}` : 'Новых моделей нет'
    const level = (r.ok ? 'success' : 'warning') as 'success' | 'warning'
    await update($, view, prev => ({ ...(prev ?? VIEW0), note: { text, level, at: Date.now() } }))
  } finally { catalogBusy = false }
}

let cliLoading = false

async function loadCli($: EngineInterface, refresh: boolean): Promise<void> {
  if (cliLoading) return
  cliLoading = true
  try {
    await update($, view, prev => ({ ...(prev ?? VIEW0), busy: 'cli-status' }))
    const r = await runJson($, 'cli-update.mjs', ['status', '--json', ...(refresh ? ['--refresh'] : [])], 45_000)
    const cli = (r.json as CliStatus | undefined)
    await update($, view, prev => ({
      ...(prev ?? VIEW0), busy: null, cli: cli?.codex || cli?.agy ? cli : prev?.cli ?? null,
      ...(r.ok ? {} : { note: { text: `Проверка обновлений: ${r.note}`, level: 'warning' as const, at: Date.now() } }),
    }))
  } finally { cliLoading = false }
}

async function runUpdate($: EngineInterface, what: string, extra: string[]): Promise<void> {
  await update($, view, prev => ({ ...(prev ?? VIEW0), busy: `update-${what}`, confirm: null }))
  const r = await runJson($, 'cli-update.mjs', [...extra, '--confirm'], 600_000)
  await update($, view, prev => ({
    ...(prev ?? VIEW0), busy: null,
    note: { text: r.ok ? `Обновлено: ${r.note}` : `Не обновлено: ${r.note}`, level: (r.ok ? 'success' : 'error') as 'success' | 'error', at: Date.now() },
  }))
  await loadCli($, false)
}

// ---- Hooks -----------------------------------------------------------------------------------------------------------

let ticker: ReturnType<EngineInterface['clock']['every']> | null = null
let paneOpen: boolean | null = null
let visible = false
let generation = 0
let reading = false
let sendingBeat = false
let lastBeatAt = -Infinity

function markHidden(): void {
  visible = false
  generation++
  lastBeatAt = -Infinity
}

function stopTicker(): void {
  markHidden()
  ticker?.cancel()
  ticker = null
}

async function checkVisibility($: EngineInterface, epoch: number): Promise<boolean> {
  if (!ticker || epoch !== generation) return false
  const panes = await $.ui.panes().catch(() => [])
  if (!ticker || epoch !== generation) return false
  const shown = panes.some(p => p.id === PANE && p.isPlaced && p.isShown)
  if (!shown && visible) markHidden()
  visible = shown
  return shown
}

async function refreshSnapshot($: EngineInterface, epoch: number): Promise<void> {
  reading = true
  try {
    let snapshot: Snapshot | null = null
    let error = ''
    try {
      const home = await claudeHome($)
      const run = await $.env.get('LUNA_RUN_DIR')
      if (!await checkVisibility($, epoch)) return
      const path = `${run || `${home}/luna-run`}/collector/snapshot.json`
      snapshot = parseSnapshot(await $.fs.read(path))
    } catch (caught) {
      error = oneLine((caught as Error)?.message ?? caught, 200) || 'снимок сборщика недоступен'
    }
    if (epoch !== generation) return
    const [own, sessionId, now] = await Promise.all([currentLimits($), currentSessionId($), $.clock.now()])
    if (!await checkVisibility($, epoch)) return
    if (snapshot && now - Date.parse(snapshot.collector?.publishedAt) > STALE_MS) error = 'снимок сборщика устарел'
    // The newest data wins: a stale snapshot just read is still newer than the one shown before.
    const latest = snapshot ?? (await read($, data))?.snapshot ?? null
    await update($, data, prev => epoch !== generation ? prev ?? EMPTY : {
      snapshot: latest,
      claude: mergeClaudeLimits(own, latest?.claudeLimits ?? [], now),
      error,
      polledAt: now,
      sessionId,
    })
  } finally { reading = false }
}

async function sendBeat($: EngineInterface, epoch: number, now: number): Promise<void> {
  sendingBeat = true
  lastBeatAt = now
  try {
    const run = await $.env.get('LUNA_RUN_DIR')
    const path = `${run || `${await claudeHome($)}/luna-run`}/collector/discovery.json`
    if (!await checkVisibility($, epoch)) return
    const { version, port, token } = JSON.parse(await $.fs.read(path))
    if (version !== 1 || !Number.isInteger(port) || port < 1 || port > 65535 ||
        typeof token !== 'string' || !/^[a-f0-9]{32}$/i.test(token)) return
    const [sessionId, limits] = await Promise.all([currentSessionId($), currentLimits($)])
    if (!sessionId || !await checkVisibility($, epoch)) return
    await $.http.fetch(`http://127.0.0.1:${port}/beat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-luna-token': token },
      body: JSON.stringify({ sessionId, visible: true, limits }),
    })
  } catch {
    // Discovery may be absent or replaced while the collector starts.
  } finally { sendingBeat = false }
}

async function tick($: EngineInterface): Promise<void> {
  const epoch = generation
  const now = await $.clock.now()
  if (!await checkVisibility($, epoch)) return
  if (!sendingBeat && now - lastBeatAt >= BEAT_MS) void sendBeat($, epoch, now)
  if (!reading) await refreshSnapshot($, epoch)
}

async function startTicker($: EngineInterface): Promise<void> {
  if (ticker || !paneOpen) return
  // The engine also disposes this timer when the hooks module unloads.
  ticker = $.clock.every(POLL_MS, () => { void tick($).catch(() => {}) })
  await tick($).catch(() => {})
}

async function openPane($: EngineInterface): Promise<void> {
  const epoch = generation
  paneOpen = true
  await $.ui.open({ id: PANE, title: TITLE })
  if (epoch === generation) await startTicker($)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({ name: COMMAND, description: 'Open the Luna pane (limits, executors, settings, updates)' })
    void openPane($).catch(() => {})
    return started
  })

  on('command.run', { command: COMMAND }, async $ => {
    await openPane($)
    return { text: 'Luna pane opened.' }
  })

  on('session.attach', async ($, e, next) => {
    const epoch = generation
    const attached = await next(e)
    if (epoch === generation) void startTicker($)
    return attached
  })

  on('session.detach', async ($, e, next) => {
    stopTicker()
    const epoch = generation
    const detached = await next(e)
    if (e.reason === 'detach' && (await $.session.surfaces()).length && epoch === generation) void startTicker($)
    return detached
  })

  on('session.end', ($, e, next) => {
    if (e.reason !== 'clear') {
      paneOpen = false
      stopTicker()
    }
    return next(e)
  })

  on('ui.close', { id: PANE }, ($, e, next) => {
    paneOpen = false
    stopTicker()
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // A reloaded module can inherit a pane without receiving session.start.
    if (paneOpen === null) {
      paneOpen = true
      void startTicker($)
    }
    const els = $.ui.resolve(e)
    const { Box, Text, Button, Select, Input } = els
    // Svg exists on the remote surfaces only; the terminal gets text meters instead.
    const Svg = 'Svg' in els ? els.Svg : null
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
      // Gemini is out of the owner's setup: its catalog entries are kept on disk but never offered.
      for (const [provider, models] of Object.entries(o?.catalog ?? {}).filter(([p]) => p !== 'gemini')) {
        for (const m of models) all.push({ value: `${provider}|${m.model}`, label: modelName(provider, m.model) })
      }
      // A label two providers share gets its provider, so the list stays unambiguous.
      const dup = new Set(all.map(x => x.label).filter((l, i, a) => a.indexOf(l) !== i))
      const opts = all.map(x => (dup.has(x.label) ? { ...x, label: `${x.label} · ${x.value.split('|')[0]}` } : x))
      return opts.length ? opts : [{ value: '', label: 'каталог пуст' }]
    }

    // `where` names the chain or panel (['--tier', t] | ['--panel', p]); a tier entry is addressed by --index, a
    // panel seat by --seat (exec.mjs rejects the other flag).
    const EntryRow = ({ where, index, entry, count }: { where: string[]; index: number; entry: ChainEntry; count: number }) => {
      const id = `${where.join('-')}-${index}`
      const isTier = where[0] === '--tier'
      const at = [isTier ? '--index' : '--seat', String(index)]
      const setEntry = (provider: string, model: string, effort: string) => {
        const ok = effortsOf(provider, model)
        const eff = ok.includes(effort) ? effort : ok[ok.length - 1] ?? effort
        void act($, `set-${id}`, ['config', 'set-entry', ...where, ...at,
          '--provider', provider, '--model', model, '--effort', eff], `${modelName(provider, model)} · ${eff}`)
      }
      const menu = [{ value: '-', label: '⋯' },
        ...(index > 0 ? [{ value: 'up', label: '↑ выше' }] : []),
        ...(index < count - 1 ? [{ value: 'down', label: '↓ ниже' }] : []),
        ...(count > 1 ? [{ value: 'rm', label: '✕ убрать' }] : [])]
      const onMenu = (value: string) => {
        if (value === 'up' || value === 'down') {
          void act($, `mv-${id}`, ['config', 'move-entry', ...where, ...at,
            '--to', String(value === 'up' ? index - 1 : index + 1)], 'Порядок изменён')
        } else if (value === 'rm') {
          void act($, `rm-${id}`, ['config', 'remove-entry', ...where, ...at], isTier ? 'Убрано из цепочки' : 'Место убрано')
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
            {menu.length > 1 ? (
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
      // Fallbacks are the entries after the one that runs; skipped entries before it are named in the warning line.
      const rest = active ? chain.slice(chain.indexOf(active) + 1) : chain
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
        <Text size="footnote">{accounts.length > 1 ? 'Смена аккаунта Codex при' : 'Codex → Claude при'}</Text>
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
      const free = snap?.ram.freeMb ?? undefined
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
              onPress={() => void setView({ tab: 'updates' })} />
          </Box>
          {d.error ? <Text size="caption" color="warning" wrap="wrap">{COLLECTOR_HINT}</Text> : null}
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

    // Gemini is out of the owner's setup: leftover Gemini jobs are not shown (and never labelled as another provider).
    const jobs = (snap.jobs ?? []).filter(j => providerOf(j) !== 'gemini')
    const accounts = codexAccountsOf(snap)
    const codex = snap.codexLimits ?? accounts[0]?.limits ?? null
    const mlai = snap.mlai ?? null
    const room = Math.max(4, (e.viewport?.rows ?? 40) - 30)

    // ---- Overview ----

    // Every limit window on its own line: provider · window · percent · thin bar · when it resets and how long until.
    // The fixed columns take ~35 cells and the reset ("через 6д 2ч 13м · пн 15:57") ~28 more, so a narrower pane
    // puts the reset on its own line under the row: both the time left and the wall clock always stay visible.
    const cols = (e.props as { bodyColumns?: number } | undefined)?.bodyColumns ?? 44
    const resetInline = cols >= 64
    const resetText = (r: Reset) => `через ${r.left} · ${r.at}`
    const LimitLine = ({ provider, window: win, pct, reset, note, color, showName }: {
      provider: string; window: string; pct: number | null; reset?: Reset | null; note?: string
      color?: 'success' | 'warning' | 'error'; showName: boolean
    }) => {
      const c = color ?? severity(pct ?? 0)
      const right = [note, reset && resetInline ? resetText(reset) : ''].filter(Boolean).join(' · ')
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box width={7} flexShrink={0}><Text size="footnote" weight={showName ? 'medium' : 'regular'}>{showName ? provider : ''}</Text></Box>
            <Box width={7} flexShrink={0}><Text size="caption" color="subtle">{win}</Text></Box>
            <Box width={5} flexShrink={0} justifyContent="flex-end">
              <Text size="footnote" weight="medium" color={pct === null ? 'subtle' : c} tabular>{pct === null ? '—' : `${Math.round(pct)}%`}</Text>
            </Box>
            <Box flexShrink={0}>{pct === null ? <Text size="caption"> </Text> : <Bar pct={pct} color={c} />}</Box>
            <Box flexGrow={1} flexShrink={1}><Text size="caption" color="subtle" wrap="truncate-end">{right}</Text></Box>
          </Box>
          {reset && !resetInline ? (
            <Box paddingLeft={8}><Text size="caption" color="subtle" wrap="truncate-end">↻ {resetText(reset)}</Text></Box>
          ) : null}
        </Box>
      )
    }

    const hysteresisPct = o?.threshold?.hysteresis_percent ?? 5
    const windowsOf = (l: CodexLimits | null | undefined) => [l?.primary, l?.secondary]
      .filter((x): x is LimitWindow => !!x).sort((a, b) => (a.windowMins ?? 0) - (b.windowMins ?? 0))
    const CodexWindows = ({ limits, showName }: { limits: CodexLimits | null | undefined; showName: boolean }) => {
      const windows = windowsOf(limits)
      if (limits?.reached) {
        // An exhausted account still says when it comes back: the fullest window is the one holding it.
        const binding = [...windows].sort((a, b) => b.usedPercent - a.usedPercent)[0]
        return <LimitLine provider="Codex" showName={showName} window={binding ? windowName('', binding.windowMins) : ''} pct={100}
          color="error" note="исчерпан" reset={resetOf(binding?.resetsAt, now)} />
      }
      if (!windows.length) return <LimitLine provider="Codex" showName={showName} window="" pct={null} note="нет данных" />
      return (
        <Box flexDirection="column">
          {windows.map((w, i) => (
            <LimitLine provider="Codex" showName={showName && i === 0} window={windowName('', w.windowMins)} pct={w.usedPercent}
              color={w.usedPercent >= thresholdPct ? 'warning' : severity(w.usedPercent)} reset={resetOf(w.resetsAt, now)} />
          ))}
        </Box>
      )
    }

    // What an account is doing now, in the words of the selection rule: working, in reserve, past the threshold,
    // held by hysteresis, or marked after a quota/auth error.
    const accountState = (a: CodexAccount): { text: string; color: 'success' | 'warning' | 'error' | 'subtle' } => {
      if (!a.loggedIn) return { text: 'нет входа', color: 'warning' }
      if (a.mark && Date.parse(a.mark.until) > now) {
        return { text: `${a.mark.reason === 'auth' ? 'ошибка входа' : 'квота'} до ${clock(a.mark.until)}`, color: 'error' }
      }
      if (a.exhausted) {
        const top = Math.max(0, ...windowsOf(a.limits).map(w => w.usedPercent))
        return { text: top >= thresholdPct ? `≥ порога ${thresholdPct}%` : `ждёт ≤ ${thresholdPct - hysteresisPct}%`, color: 'warning' }
      }
      return a.active ? { text: '● сейчас', color: 'success' } : { text: 'в запасе', color: 'subtle' }
    }

    // ML AI Code has no usage windows: what limits it is two sessions at a time and a 7-day sign-in. One row in the
    // same columns as the limit rows (name · what · count · bar · state), a hint under it only when action is needed.
    const MlaiLines = ({ m }: { m: MlaiState }) => {
      const sign = mlaiSignIn(m, now)
      const limit = m.slots?.limit ?? 2
      const used = Math.min(m.slots?.used ?? 0, limit)
      const full = used >= limit
      const mark = m.mark && Date.parse(m.mark.until) > now ? m.mark : null
      const markText = mark ? `${mark.reason === 'auth' ? 'ошибка входа' : mark.reason === 'quota' ? 'лимит тарифа' : 'сбой запуска'} до ${clock(mark.until)}` : ''
      const stateColor = mark || sign?.level === 'error' ? 'error' : sign && sign.level !== 'ok' ? 'warning' : 'subtle'
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" alignItems="center" gap={1}>
            <Box width={7} flexShrink={0}><Text size="footnote" weight="medium">ML AI</Text></Box>
            <Box width={7} flexShrink={0}><Text size="caption" color="subtle">сессии</Text></Box>
            <Box width={5} flexShrink={0} justifyContent="flex-end">
              <Text size="footnote" weight="medium" color={full ? 'warning' : 'success'} tabular>{`${used}/${limit}`}</Text>
            </Box>
            <Box flexShrink={0}><Bar pct={limit ? (used / limit) * 100 : 0} color={full ? 'warning' : 'success'} /></Box>
            <Box flexGrow={1} flexShrink={1}>
              <Text size="caption" color={stateColor} wrap="truncate-end">{markText || sign?.text || ''}</Text>
            </Box>
          </Box>
          {full ? (
            <Box paddingLeft={8}><Text size="caption" color="subtle" wrap="truncate-end">обе заняты: новые задачи идут дальше по цепочке</Text></Box>
          ) : null}
          {m.installed && sign && sign.level !== 'ok' ? (
            <Box paddingLeft={8}><Text size="caption" color="subtle" wrap="wrap">войти: {MLAI_LOGIN}</Text></Box>
          ) : null}
        </Box>
      )
    }

    const Limits = () => {
      const claude = d.claude.filter(l => l.kind !== 'spend_limit' || l.percentUsed > 0)
        .sort((a, b) => (a.kind === 'five_hour' ? -1 : b.kind === 'five_hour' ? 1 : 0))
      const today = usage?.today
      return (
        <Section title="Лимиты">
          <Box flexDirection="column">
          {claude.length ? claude.map((l, i) => (
            <LimitLine provider="Claude" showName={i === 0} window={windowName(l.kind, null)} pct={l.percentUsed} reset={resetOf(l.resetsAt, now)} />
          )) : <LimitLine provider="Claude" showName window="" pct={null} note="после первого ответа" />}
          </Box>
          <Rule />
          {accounts.length > 1 ? accounts.map((a, i) => {
            const state = accountState(a)
            const age = !a.known && a.limits ? ` · замер ${duration(a.limits.ageS)} назад` : ''
            return (
              <Box flexDirection="column" key={`acct-${a.id}`}>
                <Box flexDirection="row" alignItems="center" gap={1}>
                  <Box width={7} flexShrink={0}><Text size="footnote" weight="medium">{i === 0 ? 'Codex' : ''}</Text></Box>
                  <Box flexShrink={1}><Text size="footnote" wrap="truncate-end">{a.label || a.id}</Text></Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text size="caption" color={state.color} wrap="truncate-end">{state.text}<Text color="subtle">{age}</Text></Text>
                  </Box>
                </Box>
                <CodexWindows limits={a.limits} showName={false} />
              </Box>
            )
          }) : <CodexWindows limits={codex} showName />}
          {mlai ? <Box flexDirection="column"><Rule /><MlaiLines m={mlai} /></Box> : null}
          {today ? (
            <Box paddingTop={0}>
              <Button key="today-usage" plain onPress={() => void setView({ tab: 'usage' })}>
                <Text size="caption" color="subtle" wrap="truncate-end">
                  сегодня  Claude {tokens(tok(today.claude))} · Codex {tokens(tok(today.codex))} ток.
                  {mlai?.jobsToday ? ` · ML AI ${credits(mlai.creditsToday)} кр.` : ''}  ›
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
      // Collapsed by default: the complex tier stays visible as the one-line summary; the state is remembered.
      const open = folded['exec'] === undefined ? false : !folded['exec']
      const tiers = Object.entries(o.chains)
      const lead = tiers.find(([tier]) => tier === 'complex') ?? tiers[0]
      const blocked = tiers.filter(([, chain]) => chain.length > 0 && !chain.some(c => c.available)).length
      const panelCount = Object.keys(o.panels ?? {}).length
      const plural = (n: number, one: string, few: string, many: string) =>
        n % 10 === 1 && n % 100 !== 11 ? one : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? few : many
      const more = [
        tiers.length > 1 ? `ещё ${tiers.length - 1} ${plural(tiers.length - 1, 'уровень', 'уровня', 'уровней')}` : '',
        panelCount ? `${panelCount} ${plural(panelCount, 'панель', 'панели', 'панелей')}` : '',
      ].filter(Boolean).join(' · ')
      return (
        <Card>
          <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={1}>
            <Button key="fold-exec" plain onPress={() => void update($, collapsed, prev => ({ ...(prev ?? {}), exec: open }))}>
              <Text size="caption" weight="semibold" color="subtle">{'ИСПОЛНИТЕЛИ'}{open ? '  ⌄' : '  ›'}</Text>
            </Button>
            <Link id="exec-settings" label="настройки" tone="quiet" onPress={() => void setView({ tab: 'settings' })} />
          </Box>
          {!open ? (
            <Box flexDirection="column">
              {lead ? <TierLine tier={lead[0]} chain={lead[1]} /> : null}
              {more || blocked ? (
                <Button key="fold-exec-more" plain onPress={() => void update($, collapsed, prev => ({ ...(prev ?? {}), exec: open }))}>
                  <Text size="caption" color="subtle" wrap="truncate-end">
                    {more}{blocked ? <Text color="error">{`${more ? ' · ' : ''}без исполнителя: ${blocked}`}</Text> : null}
                  </Text>
                </Button>
              ) : null}
            </Box>
          ) : null}
          {open ? tiers.map(([tier, chain], i) => (
            <Box flexDirection="column" key={`tl-${tier}`}>{i > 0 ? <Rule /> : null}<TierLine tier={tier} chain={chain} /></Box>
          )) : null}
          {open && Object.keys(o.panels ?? {}).length ? (
            <Box flexDirection="column" marginTop={1}>
              <Text size="caption" color="subtle">Панели · все места работают одновременно</Text>
              {Object.entries(o.panels ?? {}).map(([name, seats]) => (
                <Box flexDirection="row" gap={1} key={`pl-${name}`}>
                  <Box width={11} flexShrink={0}><Text size="footnote" color="subtle">{PANEL_SHORT[name] ?? name}</Text></Box>
                  <Box flexGrow={1} flexShrink={1}>
                    <Text size="footnote" wrap="truncate-end">
                      {seats.map((seat, i) => (
                        <Text color={seat.available ? undefined : 'warning'}>{`${i ? ' · ' : ''}${modelName(seat.provider, seat.model)}`}</Text>
                      ))}
                    </Text>
                  </Box>
                </Box>
              ))}
            </Box>
          ) : null}
          {recent && last ? (
            <Text size="caption" color="subtle" wrap="wrap">
              {clock(last.at)} {TIER_RU[last.tier] ?? last.tier}: {PROVIDER_RU[last.from] ?? last.from} → {PROVIDER_RU[last.to] ?? last.to}{last.reason ? ` (${reasonRu(last.reason)})` : ''}
            </Text>
          ) : null}
        </Card>
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
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" justifyContent="space-between" gap={1}>
            <Text size="footnote" wrap="truncate-end" dimColor={!isRunning}>
              <Text color={quiet ?? (isRunning ? 'success' : 'warning')}>{isRunning ? '▶' : '◷'} </Text>
              <Text color="subtle">{PROVIDER_RU[providerOf(j)] ?? 'Codex'} </Text>
              <Text weight="medium">{modelName(j.provider, j.model)}</Text>
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

    const background = (b?: SessionBeat) => b?.background ?? []

    // The session's plan: progress, the step in work, and what is left, in one or two quiet lines.
    const PlanLine = ({ plan }: { plan: NonNullable<SessionBeat['plan']> }) => {
      const finished = plan.done >= plan.total
      const next = plan.items.find(i => i.status === 'pending')
      return (
        <Box flexDirection="column">
          <Box flexDirection="row" gap={1}>
            <Text size="caption" color={finished ? 'success' : 'subtle'} tabular>{`${plan.done}/${plan.total}`}</Text>
            <Text size="footnote" wrap="truncate-end" dimColor={finished}>
              {finished ? 'план выполнен' : plan.current ?? (next ? `дальше: ${next.content}` : 'план')}
            </Text>
          </Box>
          {!finished && plan.current && next ? (
            <Box paddingLeft={4}><Text size="caption" color="subtle" wrap="truncate-end">{`дальше: ${next.content}`}</Text></Box>
          ) : null}
        </Box>
      )
    }

    const Jobs = () => {
      const beats = snap.sessions ?? []
      const counts = {
        codex: jobs.filter(j => providerOf(j) === 'codex' && j.state === 'running').length,
        mlai: jobs.filter(j => providerOf(j) === 'mlai' && j.state === 'running').length,
        claude: beats.reduce((n, b) => n + (b.agents?.length ?? 0) + background(b).length, 0),
      }
      const filter = v.filter === 'gemini' ? 'all' : v.filter
      // An executor filter shows that executor's jobs only: no Claude plans or agents.
      const executorOnly = filter === 'codex' || filter === 'mlai'
      const showJob = (j: Job) => filter === 'all' || filter === providerOf(j)
      const showAgents = filter === 'all' || filter === 'claude'
      const visible = jobs.filter(showJob)
      const ids = [...new Set([...beats.map(b => b.sessionId), ...visible.map(j => j.owner).filter(Boolean)])]
      const all = ids.map(id => ({ id, beat: beats.find(b => b.sessionId === id), jobs: visible.filter(j => j.owner === id) }))
      // Sessions in the snapshot are verified live by the collector: a quiet one is waiting, not gone.
      const busyNow = (g: (typeof all)[number]) => !!g.beat && g.beat.state !== 'idle'
      const planOpen = (b?: SessionBeat) => !!b?.plan && b.plan.total > 0 && b.plan.done < b.plan.total
      const withWork = all.filter(g => g.jobs.length || (showAgents && ((g.beat?.agents?.length ?? 0) > 0 || background(g.beat).length > 0))
        || (!executorOnly && planOpen(g.beat)) || busyNow(g) || g.id === d.sessionId)
        .sort((a, b) => (a.id === d.sessionId ? -1 : b.id === d.sessionId ? 1 : 0) || (b.jobs.length - a.jobs.length))
      const idle = all.filter(g => !withWork.includes(g) && g.beat && now - g.beat.updatedAt <= 15 * 60_000)
      const orphans = visible.filter(j => !j.owner)
      return (
        <Box flexDirection="column">
          <Head text="Задачи" right={
            <Box flexDirection="row" gap={0}>
              <Chip id="f-all" label="все" active={v.filter === 'all'} onPress={() => void setView({ filter: 'all' })} />
              {mlai || counts.mlai ? (
                <Chip id="f-mlai" label={`ML AI ${counts.mlai}`} active={v.filter === 'mlai'} onPress={() => void setView({ filter: 'mlai' })} />
              ) : null}
              <Chip id="f-codex" label={`Codex ${counts.codex}`} active={v.filter === 'codex'} onPress={() => void setView({ filter: 'codex' })} />
              <Chip id="f-claude" label={`Claude ${counts.claude}`} active={v.filter === 'claude'} onPress={() => void setView({ filter: 'claude' })} />
            </Box>
          } />
          {withWork.length === 0 && orphans.length === 0 ? (
            <Text size="footnote" color="subtle">{v.filter === 'all' ? 'Сейчас ничего не выполняется.' : 'Таких задач нет.'}</Text>
          ) : null}
          {withWork.map(g => {
            const b = g.beat
            const isMe = g.id === d.sessionId
            const name = b?.name || projectOfJobs(g.jobs) || (isMe ? 'эта сессия' : 'без папки')
            const state = !b ? '' : b.state === 'thinking' ? 'думает' : b.state === 'tool' && b.tool ? b.tool.name : 'ждёт вас'
            const stateColor = b?.state === 'thinking' ? 'claude' : b?.state === 'idle' ? 'warning' : 'subtle'
            const id = `s-${g.id}`
            const open = !folded[id]
            const plan = !executorOnly && b?.plan && b.plan.total > 0 ? b.plan : null
            // Executor launches already have their own Codex row; the shell that waits for them adds nothing.
            const bg = showAgents ? background(b).filter(x => x.kind !== 'executor' || g.jobs.length === 0) : []
            const work = g.jobs.length + (showAgents ? b?.agents?.length ?? 0 : 0) + bg.length
            const summary = [plan ? `${plan.done}/${plan.total}` : '', work ? `${work} в работе` : ''].filter(Boolean).join(' · ')
            return (
              <Card>
                <Box flexDirection="row" justifyContent="space-between" gap={1}>
                  <Button key={`fold-${id}`} plain onPress={toggle(id)}>
                    <Text size="footnote" weight="semibold" wrap="truncate-end">{name}
                      <Text size="caption" weight="regular" color="subtle">{isMe ? '  эта' : ''}{open ? '' : `  ${summary || 'нет задач'} ›`}</Text>
                    </Text>
                  </Button>
                  <Text size="caption" color={stateColor}>{state}</Text>
                </Box>
                {open ? (
                  <Box flexDirection="column" paddingLeft={1}>
                    {plan ? <PlanLine plan={plan} /> : null}
                    {bg.map(x => (
                      <Box flexDirection="row" justifyContent="space-between" gap={1}>
                        <Text size="footnote" wrap="truncate-end"><Text color="subtle">{x.kind === 'monitor' ? '◉ монитор ' : '⟳ фон '}</Text>{x.text || 'команда'}</Text>
                        <Text size="caption" color="subtle" tabular>{duration((now - x.since) / 1000)}</Text>
                      </Box>
                    ))}
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
      ] as const
      const today = usage.today ?? {}
      const week = usage.week ?? {}
      const days = (usage.days ?? []).slice(-7)
      const dayTotal = (x: (typeof days)[number]) => tok(x.claude) + tok(x.codex)
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
      // Only the providers shown above count, so every share is a share of the displayed week (Gemini history is left out).
      const byModel = (usage.byModel7d ?? []).filter(m => m.provider !== 'gemini')
      const byProject = (usage.byProject7d ?? [])
        // A row without the per-provider split may include Gemini: it cannot be a share of this week, so it is left out.
        .map(p => ({ ...p, total: (p.claude ?? 0) + (p.codex ?? 0) }))
        .filter(p => p.total > 0).sort((a, b) => b.total - a.total)
      const topJobs = (usage.topJobs ?? []).filter(j => j.provider === 'codex' || j.provider === 'claude')
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

          {byModel.length ? (
            <Section title="По моделям · 7 дней">
              {byModel.slice(0, 6).map(m => <Row label={modelName(m.provider, m.model).slice(0, 9)} value={tokens(m.total)} sub={pct(m.total, weekAll)} />)}
            </Section>
          ) : null}
          {byProject.length ? (
            <Section title="По проектам · 7 дней">
              {byProject.slice(0, 6).map(p => <Row label={shortProject(p.project).slice(0, 9)} value={tokens(p.total)} sub={pct(p.total, weekAll)} />)}
            </Section>
          ) : null}
          {topJobs.length ? (
            <Section title="Самые тяжёлые задачи">
              {topJobs.slice(0, 5).map(j => (
                <Row label={j.provider === 'codex' ? 'Codex' : 'Claude'} value={tokens(j.total)}
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
              <Text size="footnote">{accounts.length > 1 ? 'Аккаунт снова в работе при' : 'Обратно на Codex при'}</Text>
              <Select key="hysteresis" value={String(hysteresisPct)}
                options={[0, 3, 5, 10, 15].map(p => ({ value: String(p), label: `≤ ${thresholdPct - p}%` }))}
                onSelect={value => void act($, 'hyst', ['config', 'threshold', '--percent', String(thresholdPct), '--hysteresis', value], `Обратно при ≤ ${thresholdPct - Number(value)}%`)} />
            </Box>
            <Text size="caption" color="subtle" wrap="wrap">
              {accounts.length > 1
                ? `Задачи Codex идут на первый аккаунт, пока его лимит ниже ${thresholdPct}%, потом на следующий; когда все дошли до ${thresholdPct}%, задачи уходят на Claude (Sol → Sonnet, Luna → Haiku). Аккаунт возвращается в работу, когда расход опустится до ${thresholdPct - hysteresisPct}%. Начатая задача всегда доделывается на своём аккаунте.`
                : `Когда лимит Codex доходит до ${thresholdPct}%, задачи Codex уходят на Claude (Sol → Sonnet, Luna → Haiku). Назад на Codex — когда расход опустится до ${thresholdPct - hysteresisPct}%: запас не даёт прыгать туда-сюда у самого порога.`}
            </Text>
            <Box flexDirection="column" paddingTop={1}>
              <Text size="footnote" weight="medium">Аккаунты Codex</Text>
              {accounts.length ? accounts.map((a, i) => {
                const state = accountState(a)
                return (
                  <Box flexDirection="row" gap={1} key={`set-acct-${a.id}`}>
                    <Text size="footnote" color="subtle" tabular>{`${i + 1}.`}</Text>
                    <Box flexShrink={1}><Text size="footnote" wrap="truncate-end">{a.label || a.id}</Text></Box>
                    <Text size="caption" color={state.color}>{state.text}</Text>
                  </Box>
                )
              }) : <Text size="footnote" color="subtle">один, основной (~/.codex)</Text>}
              {accounts.length < 2 ? (
                <Text size="caption" color="subtle" wrap="wrap">
                  Второй аккаунт: node ~/.claude/scripts/codex-accounts.mjs add second, затем вход по команде, которую она напечатает.
                </Text>
              ) : null}
            </Box>
            {mlai ? (
              <Box flexDirection="column" paddingTop={1}>
                <Text size="footnote" weight="medium">ML AI Code</Text>
                <MlaiLines m={mlai} />
                <Text size="caption" color="subtle" wrap="wrap">
                  {`Стоит в цепочке там, куда его поставили (обычно первым). Одновременно идут не больше ${mlai.slots?.limit ?? 2} сессий: когда все заняты, задача сразу идёт к следующему в цепочке, без ожидания. Вход действует 7 дней. Начатая задача на другого исполнителя не переносится.`}
                </Text>
              </Box>
            ) : null}
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
          <Fold id="set-panels" title="Панели — все места сразу" byDefault>
            <Text size="caption" color="subtle" wrap="wrap">
              Не путать с цепочками выше: в цепочке работает первый доступный исполнитель, а в панели — все места одновременно.
              Ревью — рецензенты interrogate, Арена — параллельные варианты решения, Судьи — сравнение вариантов.
            </Text>
            {Object.entries(o.panels ?? {}).map(([name, seats]) => (
              <Box flexDirection="column" key={`sp-${name}`} paddingTop={1}>
                <Text size="footnote" color="subtle">{PANEL_RU[name] ?? name}</Text>
                {seats.map((s, i) => <EntryRow where={['--panel', name]} index={i} entry={s} count={seats.length} />)}
                <Box paddingLeft={3}>
                  <Link id={`add-seat-${name}`} label="+ место"
                    onPress={() => {
                      const [p, m] = modelOptions()[0]?.value.split('|') ?? []
                      if (p && m) {
                        void act($, `add-seat-${name}`, ['config', 'add-entry', '--panel', name, '--provider', p, '--model', m,
                          '--effort', effortsOf(p, m).slice(-1)[0] ?? 'high'], 'Место добавлено')
                      }
                    }} />
                </Box>
              </Box>
            ))}
          </Fold>
          <Fold id="set-catalog" title="Каталог моделей" byDefault={false}>
            {Object.entries(o.catalog ?? {}).filter(([p]) => p !== 'gemini').map(([p, models]) => (
              <Box flexDirection="row" gap={1} key={`cat-${p}`}>
                <Box width={7} flexShrink={0}><Text size="footnote" color="subtle">{PROVIDER_RU[p] ?? p}</Text></Box>
                <Box flexGrow={1} flexShrink={1}><Text size="footnote" wrap="wrap">{models.map(m => modelName(p, m.model)).join(' · ')}</Text></Box>
              </Box>
            ))}
            <Box flexDirection="row" alignItems="center" gap={1} paddingTop={1}>
              <Select key="draft-provider" value={v.draftProvider} options={['mlai', 'codex', 'claude'].map(p => ({ value: p, label: PROVIDER_RU[p] ?? p }))}
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
            <Link id="catalog-refresh" label="найти новые модели ML AI, Codex и Claude"
              onPress={() => void refreshCatalog($)} />
          </Fold>
        </Box>
      )
    }

    // ---- Updates tab ----

    const updates = () => {
      const collected = snap?.cli
      const c = v.cli && !(Date.parse(collected?.checkedAt ?? '') > Date.parse(v.cli.checkedAt ?? ''))
        ? v.cli : collected
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
          <Box paddingTop={1}>
            <Text size="caption" color="subtle" wrap="wrap">Codex ставится, когда демон свободен.</Text>
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
