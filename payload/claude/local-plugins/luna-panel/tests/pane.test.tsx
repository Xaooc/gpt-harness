import { expect, mock, test } from 'claude-code/testing'

import type { CliStatus, Snapshot } from '../types'
import snapshot from './snapshot.fixture'

const PLUGIN = 'luna-panel'
const PANE = {
  plugin: PLUGIN,
  component: 'Pane',
  requestId: PLUGIN,
  props: {
    title: 'Luna',
    isFocused: true,
    bodyColumns: 64,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

type Calls = string[][]

const START = Date.parse(snapshot.at)
const RUN_DIR = '/test/run'
const TOKEN = 'ab'.repeat(16)
const LIMITS = [{ kind: 'seven_day', percentUsed: 69, resetsAt: '2026-11-19T22:00:00.000Z' }]

function engine(on: Parameters<Parameters<typeof test>[1]>[1], calls: Calls, options: {
  snapshot?: Snapshot
  shown?: boolean
  snapshotAge?: number | 'missing' | 'malformed' | 'wrong-version'
} = {}) {
  const snap = options.snapshot ?? snapshot
  const clock = mock.clock(on, { now: START })
  const reads: string[] = []
  const beats: { at: number; url: string; init: unknown }[] = []
  const pane = { shown: options.shown ?? true, checks: 0 }
  mock.env(on, { HOME: '/home/t', LUNA_RUN_DIR: RUN_DIR })
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({ value: { startedAt: START, context: { window: 200_000 }, rateLimits: LIMITS } }))
  on('command.register', () => ({ value: { command: 'luna' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => {
    pane.shown = false
    return { value: null as unknown as void }
  })
  on('ui.panes', () => {
    pane.checks++
    return { value: [{ id: PLUGIN, title: 'Luna', isShown: pane.shown, isPlaced: true, isFocused: false }] }
  })
  on('fs.read', (_, e) => {
    reads.push(e.path)
    if (e.path === `${RUN_DIR}/collector/snapshot.json`) {
      if (options.snapshotAge === 'missing') return { deny: 'file missing' }
      if (options.snapshotAge === 'malformed') return { value: '{' }
      const age = typeof options.snapshotAge === 'number' ? options.snapshotAge : 0
      const publishedAt = new Date(clock.now() - age).toISOString()
      const version = options.snapshotAge === 'wrong-version' ? 1 : snap.version
      return { value: JSON.stringify({ ...snap, version, collector: { ...snap.collector, publishedAt } }) }
    }
    if (e.path === `${RUN_DIR}/collector/discovery.json`) {
      return { value: JSON.stringify({ ...snap.collector, version: 1, port: 12345, token: TOKEN, startedAt: snap.at }) }
    }
    return { deny: 'ENOENT' }
  })
  on('fs.exists', () => ({ value: options.snapshotAge !== 'missing' }))
  on('http.fetch', (_, e) => {
    beats.push({ at: clock.now(), url: e.url, init: e.init })
    return { value: { ok: true, status: 204, headers: {}, text: '' } }
  })
  on('process.run', (_, { argv }) => {
    calls.push([...argv])
    const out = argv.includes('status') && snap.cli ? snap.cli : {
      ok: true, changed: true, note: argv.includes('refresh') ? 'added codex/gpt-7-sol, claude/fable' : 'ok',
    }
    return { value: {
      exitCode: 0, stdout: JSON.stringify(out), stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
    } }
  })
  on('process.spawn', async function* (_, { argv }) {
    calls.push(['spawn', ...argv])
    return { deny: 'unexpected process.spawn' }
  })
  return { clock, pane, reads, beats }
}

async function opened($: Parameters<Parameters<typeof test>[1]>[0], surface: 'terminal' | 'desktop') {
  await $.command.run({ command: 'luna', args: '' })
  return $.ui.mount({ ...PANE, surface })
}

test('overview: every limit window, the active executor per tier, on every surface', async ($, on) => {
  const calls: Calls = []
  engine(on, calls)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await opened($, surface)
    expect(await ui.find({ type: 'Text', text: /Luna/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Claude$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Codex$/ })).toBeTruthy()
    // ML AI Code: its two sessions and when the 7-day sign-in ends.
    expect(await ui.find({ type: 'Text', text: /^ML AI$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^1\/2$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^вход до / })).toBeTruthy()
    // A second account gets its own row with its proxy.
    expect(await ui.find({ type: 'Text', text: /^второй$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /прокси :10820/ })).toBeTruthy()
    // Gemini is out of the owner's setup: no Gemini row in the limits.
    expect(await ui.find({ type: 'Text', text: /^Gemini$/ })).toBeFalsy()
    // The executors card starts collapsed: the complex tier stays visible as the summary, named in full.
    expect(await ui.find({ type: 'Text', text: /^Sol 6\.1$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Сложное\s*$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /все места работают одновременно/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /ещё \d+ уров/ })).toBeTruthy()
    // Claude's shared five-hour window is shown next to the local week.
    expect(await ui.find({ type: 'Text', text: /^5 ч/ })).toBeTruthy()
    // Groups inside a section card are separated by a drawn rule (text, so every surface shows it).
    expect(await ui.find({ type: 'Text', text: /^┈{20,}$/ })).toBeTruthy()
    // Expanding the card lists every tier and the panels, which run all their seats at once.
    await ui.press({ key: 'fold-exec' })
    expect(await ui.find({ type: 'Text', text: /все места работают одновременно/ })).toBeTruthy()
    await ui.press({ key: 'fold-exec' })
    // A session row shows its plan (progress, current step, next step) and its background work.
    expect(await ui.find({ type: 'Text', text: /^Чиню гейт$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^1\/4$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /дальше: Прогнать тесты/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Прогон затронутых тестов/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Ревью Astra/ })).toBeTruthy()
    await ui.unmount()
  }
})

test('limits: two Codex accounts with the active one marked; a reset says when and how long until, at any width', async ($, on) => {
  const calls: Calls = []
  const reset = new Date(START + ((2 * 24 + 3) * 60 + 5) * 60_000 + 30_000).toISOString()
  const limits = (usedPercent: number) => ({
    ...snapshot.codexLimits!, primary: { usedPercent, windowMins: 10080, resetsAt: reset }, secondary: null,
  })
  const account = { loggedIn: true, known: true, reason: null, mark: null }
  engine(on, calls, { snapshot: {
    ...snapshot,
    orchestration: { ...snapshot.orchestration!, threshold: { ...snapshot.orchestration!.threshold, switch_percent: 60 } },
    codexAccounts: [
      { ...account, id: 'main', label: 'основной', active: false, exhausted: true, limits: limits(63) },
      { ...account, id: 'second', label: 'второй', active: true, exhausted: false, limits: limits(12) },
    ],
  } })
  await $.command.run({ command: 'luna', args: '' })
  const wide = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect(await wide.find({ type: 'Text', text: /^основной$/ })).toBeTruthy()
  expect(await wide.find({ type: 'Text', text: /≥ порога 60%/ })).toBeTruthy()
  expect(await wide.find({ type: 'Text', text: /● сейчас/ })).toBeTruthy()
  expect(await wide.find({ type: 'Text', text: /^через 2д 3ч 5м · \S/ })).toBeTruthy()
  await wide.unmount()
  // A docked pane is too narrow for one line: the reset moves under its row and keeps both parts.
  const narrow = await $.ui.mount({ ...PANE, surface: 'terminal', props: { ...PANE.props, bodyColumns: 44 } })
  expect(await narrow.find({ type: 'Text', text: /^↻ через 2д 3ч 5м · \S/ })).toBeTruthy()
  await narrow.unmount()
})

test('settings: an effort pick sends set-entry with that effort; a preset applies by name', async ($, on) => {
  const calls: Calls = []
  engine(on, calls)
  const ui = await opened($, 'desktop')
  await ui.press({ key: 'tab-settings' })
  expect(await ui.find({ type: 'Text', text: /МОДЕЛИ ПО ЗАДАЧАМ/ })).toBeTruthy()
  // A tier opens its editor in place; only then do its selects exist.
  await ui.press({ key: 'edit-simple' })
  await $.ui.select({ plugin: PLUGIN, key: 'effort---tier-simple-0', value: 'medium' })
  const set = calls.find(c => c.includes('set-entry'))
  expect(set).toBeTruthy()
  expect(set?.join(' ')).toContain('--tier simple --index 0 --provider gemini --model gemini-3.8-flash --effort medium')
  expect(set).toContain('--actor')
  // A panel seat is addressed by --seat, never --index (exec.mjs rejects the mix).
  await $.ui.select({ plugin: PLUGIN, key: 'effort---panel-review-0', value: 'max' })
  const seat = calls.find(c => c.includes('set-entry') && c.includes('--panel'))
  expect(seat?.join(' ')).toContain('--panel review --seat 0 --provider codex --model gpt-6.1-sol --effort max')
  expect(seat).not.toContain('--index')
  await ui.press({ key: 'preset-save-codex' })
  expect(calls.some(c => c.join(' ').includes('config preset save-codex'))).toBe(true)
  await ui.unmount()
})

test('catalog: the refresh link looks for new models and names what joined', async ($, on) => {
  const calls: Calls = []
  engine(on, calls)
  const ui = await opened($, 'desktop')
  await ui.press({ key: 'tab-settings' })
  await ui.press({ key: 'fold-set-catalog' })
  expect(calls).toHaveLength(0)
  await ui.press({ key: 'catalog-refresh' })
  expect(calls[0]?.join(' ')).toContain('catalog refresh --provider all --actor panel')
  expect(await ui.find({ type: 'Text', text: /В каталог добавлены: Sol 7, Fable/ })).toBeTruthy()
  await ui.unmount()
})

test('updates: an update needs a second press, and the second press runs it with --confirm', async ($, on) => {
  const calls: Calls = []
  const cli: CliStatus = {
    codex: { installed: '0.164.0', latest: '0.169.0', expectedByHarness: '0.164.0', updateAvailable: true },
    agy: { installed: '1.5.9', latest: '1.5.9', checksumOk: true, updateAvailable: false },
    checkedAt: '2026-11-16T14:45:17.526Z',
  }
  engine(on, calls, { snapshot: { ...snapshot, cli } })
  const ui = await opened($, 'desktop')
  await ui.press({ key: 'tab-updates' })
  expect(calls).toHaveLength(0)
  expect(await ui.find({ key: 'upd-codex' })).toBeTruthy()
  await ui.press({ key: 'cli-refresh' })
  expect(calls[0]?.slice(-3)).toEqual(['status', '--json', '--refresh'])
  await ui.press({ key: 'upd-codex' })
  expect(calls.some(c => c.includes('update'))).toBe(false)
  await ui.press({ key: 'upd-codex' })
  const upd = calls.find(c => c.includes('update'))
  expect(upd?.join(' ')).toContain('update codex --version 0.169.0 --confirm')
  await ui.unmount()
})

test('usage: today and the week per provider, with the heaviest jobs', async ($, on) => {
  const calls: Calls = []
  const tok = (total: number) => ({ total, input: total / 2, output: total / 10, cached: total / 3 })
  engine(on, calls, { snapshot: {
    ...snapshot,
    usage: {
      at: '2026-11-16T15:17:00.000Z',
      today: { claude: tok(4_200_000), codex: tok(1_900_000), gemini: tok(6_900_000) },
      week: { claude: tok(31_000_000), codex: tok(12_000_000), gemini: tok(20_000_000) },
      days: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-11-${10 + i}`, claude: 1_000_000 * i, codex: 500_000, gemini: 2_000_000,
      })),
      byModel7d: [{ provider: 'codex', model: 'gpt-6.1-sol', total: 9_000_000 }],
      byProject7d: [{ project: 'rpg', total: 22_000_000 }],
      topJobs: [{ provider: 'codex', model: 'gpt-6.2-sol', name: 'h2fix', project: 'gpt-harness', total: 3_400_000 },
        { provider: 'gemini', model: 'gemini-3.8-flash', name: 'oldgem', project: 'gpt-harness', total: 5_000_000 }],
    },
  } })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await opened($, surface)
    await ui.press({ key: 'tab-usage' })
    expect(await ui.find({ type: 'Text', text: /^СЕГОДНЯ$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^7 ДНЕЙ$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /h2fix/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /oldgem/ })).toBeFalsy()
    await ui.unmount()
  }
})

test('collector: visible pane reads and beats for two hours without starting processes', { timeoutMs: 120_000 }, async ($, on) => {
  const calls: Calls = []
  const { clock, reads, beats } = engine(on, calls)
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('tool.call', () => ({ deny: 'simulated tool call' }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  on('agent.spawn', () => ({ model: 'test', agentId: 'test-agent' }))
  await $.session.start({ cwd: '/test/project', surface: 'terminal', isInteractive: true })
  await clock.settle()
  for (let i = 0; i < 200; i++) {
    const turnId = `turn-${i}`
    await $.turn.start({ turnId, text: 'test' })
    await $.tool.call({ tool: 'Bash', command: 'true' })
    await $.agent.spawn({ prompt: 'test', description: 'test agent' })
    await $.turn.complete({ turnId, reason: 'answer', answer: '', durationMs: 0, isAborted: false })
  }
  expect(reads).toHaveLength(2)
  expect(beats).toHaveLength(1)
  await clock.advance(2 * 60 * 60_000)
  expect(calls).toHaveLength(0)
  expect(reads.filter(path => path.endsWith('/snapshot.json'))).toHaveLength(1441)
  expect(beats).toHaveLength(361)
  expect(beats.every((beat, i) => beat.at === START + i * 20_000)).toBe(true)
  expect(beats[0]).toEqual({
    at: START,
    url: 'http://127.0.0.1:12345/beat',
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-luna-token': TOKEN },
      body: JSON.stringify({ sessionId: 'sess-1', visible: true, limits: LIMITS }),
    },
  })
})

test('collector: hiding a visible pane stops reads and beats', async ($, on) => {
  const calls: Calls = []
  const { clock, pane, reads, beats } = engine(on, calls)
  await $.command.run({ command: 'luna', args: '' })
  await clock.settle()
  expect(reads).toHaveLength(2)
  expect(beats).toHaveLength(1)
  pane.shown = false
  await clock.advance(65_000)
  expect(reads).toHaveLength(2)
  expect(beats).toHaveLength(1)
  expect(calls).toHaveLength(0)
})

test('collector: a stale or missing snapshot keeps the last data and shows the start hint without launching', async ($, on) => {
  const calls: Calls = []
  const options: { snapshotAge: number | 'missing' } = { snapshotAge: 0 }
  const { clock } = engine(on, calls, options)
  const ui = await opened($, 'desktop')
  const hint = /сборщик не отвечает — запустите: node ~\/\.claude\/scripts\/luna-collector\.mjs start/
  expect(await ui.find({ type: 'Text', text: hint })).toBeFalsy()
  for (const age of [31_000, 'missing'] as const) {
    options.snapshotAge = age
    await clock.advance(60_000)
    expect(await ui.find({ type: 'Text', text: hint })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Данные не обновляются/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Sol 6\.1$/ })).toBeTruthy()
  }
  expect(calls).toHaveLength(0)
  await ui.unmount()
})

test('collector: malformed and unsupported snapshots show the start hint in a cold pane', async ($, on) => {
  const calls: Calls = []
  const options: { snapshotAge: 'malformed' | 'wrong-version' } = { snapshotAge: 'malformed' }
  const { clock } = engine(on, calls, options)
  const ui = await opened($, 'desktop')
  expect(await ui.find({ type: 'Text', text: /luna-collector\.mjs start/ })).toBeTruthy()
  options.snapshotAge = 'wrong-version'
  await clock.advance(5000)
  expect(await ui.find({ type: 'Text', text: /luna-collector\.mjs start/ })).toBeTruthy()
  expect(calls).toHaveLength(0)
  await ui.unmount()
})

test('collector: closing the pane cancels its ticker', {
  plugins: [{
    name: 'close-pane',
    register(on) {
      on('command.run', { command: 'close-luna' }, async $ => {
        await $.ui.close({ id: 'luna-panel' })
        return { text: 'closed' }
      })
    },
  }],
}, async ($, on) => {
  const calls: Calls = []
  const { clock, pane, reads, beats } = engine(on, calls)
  await $.command.run({ command: 'luna', args: '' })
  await clock.advance(5_000)
  expect(reads).toHaveLength(3)
  await $.command.run({ command: 'close-luna', args: '' })
  const checks = pane.checks
  await clock.advance(65_000)
  expect(pane.checks).toBe(checks)
  expect(reads).toHaveLength(3)
  expect(beats).toHaveLength(1)
  expect(calls).toHaveLength(0)
})
