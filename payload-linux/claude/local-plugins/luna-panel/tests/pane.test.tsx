import { expect, mock, test } from 'claude-code/testing'

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

// The engine beneath the plugin: processes answered from a fixture, every exec.mjs/cli-update.mjs call recorded.
function engine(on: Parameters<Parameters<typeof test>[1]>[1], calls: Calls, cli: unknown = null, snap: unknown = snapshot) {
  mock.clock(on)
  on('env.get', (_, e) => ({ value: (e as { name?: string }).name === 'HOME' ? '/home/t' : undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('session.usage', () => ({
    value: { rateLimits: [{ kind: 'seven_day', percentUsed: 69, resetsAt: '2026-11-19T22:00:00.000Z' }] },
  }))
  on('command.register', () => ({ value: { command: 'luna' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.panes', () => ({ value: [{ id: PLUGIN, title: 'Luna', isShown: true, isPlaced: true, isFocused: false }] }))
  on('process.run', (_, e) => {
    const argv = (e as { argv: readonly string[] }).argv
    if (argv.some(a => a.endsWith('luna-overview.mjs'))) {
      return { value: { exitCode: 0, stdout: JSON.stringify(snap), stderr: '' } }
    }
    if (argv.some(a => a.endsWith('exec.mjs')) || argv.some(a => a.endsWith('cli-update.mjs'))) {
      calls.push([...argv])
      const isStatus = argv.includes('status')
      const isRefresh = argv.includes('refresh')
      const out = isStatus && cli ? JSON.stringify(cli)
        : JSON.stringify({ ok: true, changed: true, note: isRefresh ? 'added codex/gpt-7-sol, claude/fable' : 'ok' })
      return { value: { exitCode: 0, stdout: out, stderr: '' } }
    }
    return { value: { exitCode: 0, stdout: '/home/t', stderr: '' } }
  })
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
    expect(await ui.find({ type: 'Text', text: /^Gemini$/ })).toBeTruthy()
    // The active executor of the complex tier is named in full, version included.
    expect(await ui.find({ type: 'Text', text: /^Sol 6\.1$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Сложное\s*$/ })).toBeTruthy()
    // Claude's five-hour window is shown from the session heartbeats, next to the week.
    expect(await ui.find({ type: 'Text', text: /^5 ч/ })).toBeTruthy()
    // Groups inside a section card are separated by a drawn rule (text, so every surface shows it).
    expect(await ui.find({ type: 'Text', text: /^┈{20,}$/ })).toBeTruthy()
    // Panels run all their seats at once; they are listed in the overview so they are never mistaken for chains.
    expect(await ui.find({ type: 'Text', text: /все места работают одновременно/ })).toBeTruthy()
    await ui.unmount()
  }
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

test('catalog: opening the pane looks for new Codex and Claude models and names what joined', async ($, on) => {
  const calls: Calls = []
  engine(on, calls)
  const ui = await opened($, 'desktop')
  const refresh = calls.find(c => c.includes('catalog') && c.includes('refresh'))
  expect(refresh?.join(' ')).toContain('catalog refresh --provider all --actor panel')
  expect(await ui.find({ type: 'Text', text: /В каталог добавлены: Sol 7, Fable/ })).toBeTruthy()
  await ui.unmount()
})

test('updates: an update needs a second press, and the second press runs it with --confirm', async ($, on) => {
  const calls: Calls = []
  engine(on, calls, {
    codex: { installed: '0.164.0', latest: '0.169.0', expectedByHarness: '0.164.0', updateAvailable: true, busy: { jobs: 0, reason: null } },
    agy: { installed: '1.5.9', latest: '1.5.9', checksumOk: true, updateAvailable: false, busy: { jobs: 0, reason: null } },
    checkedAt: '2026-11-16T14:45:17.526Z',
  })
  const ui = await opened($, 'desktop')
  await ui.press({ key: 'tab-updates' })
  expect(calls.some(c => c.includes('status'))).toBe(true)
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
  engine(on, calls, null, {
    ...snapshot,
    usage: {
      at: '2026-11-16T15:17:00.000Z',
      today: { claude: tok(4_200_000), codex: tok(1_900_000), gemini: tok(6_900_000) },
      week: { claude: tok(31_000_000), codex: tok(12_000_000), gemini: tok(20_000_000) },
      days: Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-${10 + i}`, claude: 1_000_000 * i, codex: 500_000, gemini: 2_000_000 })),
      byModel7d: [{ provider: 'codex', model: 'gpt-6.1-sol', total: 9_000_000 }],
      byProject7d: [{ project: 'rpg', total: 22_000_000 }],
      topJobs: [{ provider: 'gemini', model: 'gemini-3.8-flash', name: 'h2fix', project: 'gpt-harness', total: 3_400_000 }],
    },
  })
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await opened($, surface)
    await ui.press({ key: 'tab-usage' })
    expect(await ui.find({ type: 'Text', text: /^СЕГОДНЯ$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^7 ДНЕЙ$/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /h2fix/ })).toBeTruthy()
    await ui.unmount()
  }
})
