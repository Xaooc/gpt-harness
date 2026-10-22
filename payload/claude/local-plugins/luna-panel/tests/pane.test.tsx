import { expect, mock, test } from 'claude-code/testing'

import type { PanelData } from '../types'

const PANE = { component: 'Pane', requestId: 'luna-panel', props: { bodyColumns: 48 } } as const
const NOW = Date.parse('2026-10-21T12:00:00Z')

const SAMPLE: PanelData = {
  sessionId: 'sess-aaaaaaaa-1111',
  polledAt: NOW,
  error: '',
  claude: [
    { kind: 'five_hour', percentUsed: 42, resetsAt: '2026-10-21T14:30:00Z' },
    { kind: 'seven_day', percentUsed: 93, resetsAt: '2026-10-25T00:00:00Z' },
  ],
  snapshot: {
    v: 1,
    at: '2026-10-21T12:00:00Z',
    ram: { freeMb: 900, totalMb: 16226 },
    daemon: {
      running: true, pid: 1, uptimeS: 120, max: 12, runningJobs: 2, queuedJobs: 1,
      owners: [
        { owner: 'sess-aaaaaaaa-1111', running: 1, queued: 1 },
        { owner: 'sess-bbbbbbbb-2222', running: 1, queued: 0 },
      ],
      jobs: [],
    },
    jobs: [
      { out: 'C:/x/fix-auth.out.md', state: 'running', model: 'gpt-6.1-sol', effort: 'high', sandbox: 'workspace-write',
        engine: 'daemon', ageS: 340, dir: 'C:/repo', error: '', queuePos: null, owner: 'sess-aaaaaaaa-1111', idleS: 4,
        activity: { kind: 'command', text: 'rg -n auth src/', sinceS: 4 } },
      { out: 'C:/x/stuck.out.md', state: 'running', model: 'gpt-6-luna', effort: 'low', sandbox: 'read-only',
        engine: 'exec', ageS: 1200, dir: 'C:/repo', error: '', queuePos: null, owner: 'sess-bbbbbbbb-2222', idleS: 960 },
      { out: 'C:/x/scout.out.md', state: 'queued', model: 'gpt-6-luna', effort: 'medium', sandbox: 'read-only',
        engine: 'daemon', ageS: 20, dir: 'C:/repo', error: '', queuePos: 1, owner: 'sess-aaaaaaaa-1111' },
    ],
    codexLimits: {
      v: 1, at: '2026-10-21T11:58:00Z', ageS: 120, planType: 'pro', reached: null,
      primary: { usedPercent: 12, windowMins: 300, resetsAt: '2026-10-21T15:00:00Z' },
      secondary: { usedPercent: 71, windowMins: 10080, resetsAt: '2026-10-27T00:00:00Z' },
    },
    build: { line: 'Compiling codex-cli v0.162.1', building: true, exeAt: null },
    sessions: [
      { v: 1, sessionId: 'sess-aaaaaaaa-1111', name: 'my-app', cwd: 'C:/code/my-app', updatedAt: NOW - 2000,
        state: 'thinking', tool: null, turnSince: NOW - 90_000, idleSince: 0,
        agents: [{ id: 'ag1', description: 'Explore auth flow', since: NOW - 60_000 }] },
      { v: 1, sessionId: 'sess-bbbbbbbb-2222', name: 'shop-api', cwd: 'C:/code/shop-api', updatedAt: NOW - 3000,
        state: 'tool', tool: { name: 'Bash', detail: 'npm test', since: NOW - 12_000 }, turnSince: NOW - 40_000,
        idleSince: 0, agents: [] },
    ],
  },
}

test('pane draws every section from a snapshot on desktop and terminal', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/tester', CLAUDE_CODE_SESSION_ID: SAMPLE.sessionId })
  let argv: readonly string[] = []
  on('process.run', async (_$, e) => {
    argv = e.argv
    return { value: { exitCode: 0, stdout: JSON.stringify(SAMPLE.snapshot), stderr: '', isStdoutTruncated: false,
      isStderrTruncated: false } }
  })
  on('session.usage', async () => ({ value: { startedAt: NOW, rateLimits: SAMPLE.claude, context: { window: 200000 } } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  await $.command.run({ command: 'luna', args: '' } as never)
  expect(argv.join(' ')).toContain('/.claude/scripts/luna-overview.mjs')
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'luna-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^Память$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Мало памяти/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Claude · 5 часов/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^93%$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Codex · неделя/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^my-app · эта$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^shop-api$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /агент: Explore auth flow/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Bash: npm test/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /думает · 1м/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /fix-auth/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /в очереди/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /выполняет: rg -n auth src\// })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /тишина 16м — похоже, завис/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /Compiling codex-cli/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^Предел$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^12 заданий одновременно$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^1 в работе · 1 ждут$/ })).toBeDefined()
    await ui.press({ key: 'toggle-limits' })
    expect(await ui.find({ type: 'Text', text: /Claude · 5 часов/ })).toBeUndefined()
    await ui.press({ key: 'toggle-limits' })
    expect(await ui.find({ type: 'Text', text: /Claude · 5 часов/ })).toBeDefined()
    await ui.unmount()
  }
})

test('pane shows a waiting message before the first snapshot', async $ => {
  for (const surface of ['desktop', 'terminal'] as const) {
    const ui = await $.ui.mount({ plugin: 'luna-panel', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /загрузка|нет данных/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the periodic poll keeps running after /luna, even with no session.start', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/tester', CLAUDE_CODE_SESSION_ID: SAMPLE.sessionId })
  let runs = 0
  on('process.run', async (_$, e) => {
    if (e.argv.some(a => a.endsWith('luna-overview.mjs'))) runs += 1
    return { value: { exitCode: 0, stdout: JSON.stringify(SAMPLE.snapshot), stderr: '', isStdoutTruncated: false,
      isStderrTruncated: false } }
  })
  on('session.usage', async () => ({ value: { startedAt: NOW, rateLimits: [], context: { window: 200000 } } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.panes', async () => ({ value: [{ id: 'luna-panel', title: 'Luna', isShown: true, isFocused: false,
    isPlaced: true }] }) as never)
  await $.command.run({ command: 'luna', args: '' } as never)
  const afterCommand = runs
  await clock.advance(5_000)
  await clock.advance(5_000)
  await clock.advance(5_000)
  expect(afterCommand).toBe(1)
  expect(runs).toBeGreaterThanOrEqual(4)
})

test('each poll sends this session heartbeat to the collector: thinking, then the running tool', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/tester', CLAUDE_CODE_SESSION_ID: 'sess-cccccccc-3333' })
  const beats: Record<string, unknown>[] = []
  on('process.run', async (_$, e) => {
    if (e.argv.includes('-e')) {
      return { value: { exitCode: 0, stdout: 'C:/code/billing', stderr: '', isStdoutTruncated: false,
        isStderrTruncated: false } }
    }
    if (e.argv.includes('--beat') && typeof e.init?.stdin === 'string') beats.push(JSON.parse(e.init.stdin))
    return { value: { exitCode: 0, stdout: JSON.stringify(SAMPLE.snapshot), stderr: '', isStdoutTruncated: false,
      isStderrTruncated: false } }
  })
  on('session.usage', async () => ({ value: { startedAt: NOW, rateLimits: [], context: { window: 200000 } } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }) as never)
  let releaseTool: () => void = () => {}
  on('tool.call', async () => {
    await new Promise<void>(resolve => { releaseTool = resolve })
    return { result: { stdout: 'ok', stderr: '', interrupted: false } } as never
  })
  await $.command.run({ command: 'luna', args: '' } as never)
  await $.turn.start({ text: 'hi', turnId: 't1' } as never)
  await clock.advance(1100)
  const toolCall = $.tool.call({ tool: 'Bash', command: 'npm run build\nsecond line', tool_use_id: 'u1' } as never)
  await clock.advance(1100)
  await clock.advance(5000)
  releaseTool()
  await toolCall
  expect(beats.some(b => b.state === 'thinking' && b.name === 'billing')).toBe(true)
  expect(beats.some(b => b.state === 'tool' && (b.tool as { detail: string }).detail === 'npm run build')).toBe(true)
  expect(beats.every(b => b.sessionId === 'sess-cccccccc-3333')).toBe(true)
})
test('with the pane hidden the ticker polls every 20 s, not every 5 s', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/tester', CLAUDE_CODE_SESSION_ID: SAMPLE.sessionId })
  let runs = 0
  on('process.run', async (_$, e) => {
    if (e.argv.some(a => a.endsWith('luna-overview.mjs'))) runs += 1
    return { value: { exitCode: 0, stdout: JSON.stringify(SAMPLE.snapshot), stderr: '', isStdoutTruncated: false,
      isStderrTruncated: false } }
  })
  on('session.usage', async () => ({ value: { startedAt: NOW, rateLimits: [], context: { window: 200000 } } }) as never)
  on('ui.open', async () => ({ value: { isPlaced: false } }) as never)
  on('ui.panes', async () => ({ value: [] }) as never)
  await $.command.run({ command: 'luna', args: '' } as never)
  const first = runs
  for (let i = 0; i < 8; i++) await clock.advance(5_000)
  expect(runs - first).toBeGreaterThanOrEqual(1)
  expect(runs - first).toBeLessThanOrEqual(2)
})

test('a prompt opens the pane when it is not on screen, once', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/tester', CLAUDE_CODE_SESSION_ID: SAMPLE.sessionId })
  let opens = 0
  let placed = false
  on('process.run', async () => ({ value: { exitCode: 0, stdout: JSON.stringify(SAMPLE.snapshot), stderr: '',
    isStdoutTruncated: false, isStderrTruncated: false } }))
  on('session.usage', async () => ({ value: { startedAt: NOW, rateLimits: [], context: { window: 200000 } } }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  on('ui.open', async () => { opens += 1; placed = true; return { value: { isPlaced: true } } as never })
  on('ui.panes', async () => ({ value: placed ? [{ id: 'luna-panel', title: 'Luna', isShown: true, isFocused: false,
    isPlaced: true }] : [] }) as never)
  on('prompt.submit', async (_$, e) => ({ text: e.text }) as never)
  await $.prompt.submit({ text: 'hello' } as never)
  expect(opens).toBe(1)
  await $.prompt.submit({ text: 'again' } as never)
  expect(opens).toBe(1)
  await $.command.run({ command: 'luna', args: '' } as never)
  expect(opens).toBe(2)
})

test('without CLAUDE_CODE_SESSION_ID the heartbeat uses $.session.id()', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.env(on, { USERPROFILE: 'C:/Users/tester' })
  const beats: Record<string, unknown>[] = []
  on('process.run', async (_$, e) => {
    if (e.argv.includes('-e')) {
      return { value: { exitCode: 0, stdout: 'C:/code/billing', stderr: '', isStdoutTruncated: false,
        isStderrTruncated: false } }
    }
    if (e.argv.includes('--beat') && typeof e.init?.stdin === 'string') beats.push(JSON.parse(e.init.stdin))
    return { value: { exitCode: 0, stdout: JSON.stringify(SAMPLE.snapshot), stderr: '', isStdoutTruncated: false,
      isStderrTruncated: false } }
  })
  on('session.usage', async () => ({ value: { startedAt: NOW, rateLimits: [], context: { window: 200000 } } }) as never)
  on('session.id', async () => ({ value: 'sess-dddddddd-4444' }) as never)
  on('ui.open', async () => ({ value: { isPlaced: true } }) as never)
  on('ui.status', async () => ({ value: undefined }) as never)
  await $.command.run({ command: 'luna', args: '' } as never)
  expect(beats.length).toBeGreaterThanOrEqual(1)
  expect(beats.every(b => b.sessionId === 'sess-dddddddd-4444')).toBe(true)
})
