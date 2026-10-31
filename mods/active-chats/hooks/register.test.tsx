import { expect, test } from 'claude-code/testing'

import { characterSvg, isAnimated } from './characters'
import { readDisk, readTranscript } from './details'
import { chatColor, chatMeta, chatPose, groupChats, projectName } from './register'

declare const setTimeout: (fn: () => void, ms: number) => void
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0))

const PANE = {
  plugin: 'active-chats',
  component: 'Pane',
  requestId: 'active-chats',
  props: {
    title: 'Active chats',
    isFocused: false,
    bodyColumns: 40,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 20 },
    view: {},
  },
} as const

const reply = (value: unknown) => ({
  value: {
    content: [
      {
        type: 'text',
        text: typeof value === 'string' ? value : JSON.stringify(value),
      },
    ],
    isError: false,
  },
})

const session = (over: object) => ({
  sessionId: 'a',
  title: 'Asks',
  isArchived: false,
  isRunning: false,
  lastActivityAt: '2026-10-31T16:00:00.000Z',
  ...over,
})

test('active chats show state, and the toggle asks for archived', async ($, on) => {
  const archivedFlags: unknown[] = []
  const opened: unknown[] = []
  on('process.run', (_, e) => {
    if (e.argv[0] === 'git') {
      const stdout = e.argv.includes('status')
        ? ' M a.ts\n?? b.ts\n'
        : e.argv.includes('rev-list')
          ? '4\n'
          : 'origin/main\n'

      return { value: { exitCode: 0, stdout, stderr: '' } } as never
    }
    if (e.argv[0] === 'python3') {
      return {
        value: {
          exitCode: 0,
          stdout: JSON.stringify({
            agents: [{ name: 'impl-1', description: 'Wire it', isFinished: false, ageMs: 1000 }],
            outputAges: [],
          }),
          stderr: '',
        },
      } as never
    }
    opened.push(e.argv)

    return { value: { exitCode: 0, stdout: '', stderr: '' } } as never
  })
  on('command.register', () => ({ value: { command: 'active-chats' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('clock.now', () => ({ value: Date.parse('2026-10-31T16:05:00.000Z') }))
  on('mcp.call', (_, e) => {
    if (e.tool === 'list_sessions') {
      const withArchived = e.args.include_archived
      archivedFlags.push(withArchived)

      return reply([
        session({}),
        session({ sessionId: 'z', title: 'Nightly run' }),
        session({ sessionId: 'b', title: 'Done', link: 'claude://b' }),
        session({ sessionId: 'c', title: 'Busy', isRunning: true, cwd: '/repo' }),
        ...(withArchived
          ? [session({ sessionId: 'd', title: 'Old', isArchived: true })]
          : []),
      ])
    }
    const id = e.args.session_id
    if (e.tool === 'get_usage') {
      return reply(
        id === 'c'
          ? { context: { status: 'ok', percentUsed: 23 } }
          : { context: { status: 'unavailable' } },
      )
    }
    if (e.tool === 'get_session') {
      return reply({ scheduledTaskId: id === 'z' ? 'nightly' : undefined })
    }
    if (id === 'a') return reply('Session "Asks" (idle)\n[assistant] Which one?')
    if (id === 'b') return reply('Session "Done" (idle)\n[assistant] Finished.')

    return reply('Session "Busy" (running)\n[user] go')
  })

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    expect(await ui.find({ type: 'Text', text: /3 listed/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Needs you \(1\)/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Working/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /23% context/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /2 uncommitted/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /4 unmerged/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /Nightly run/ })).toBeFalsy()
    expect(await ui.find({ type: 'Text', text: /^Idle/ })).toBeTruthy()
    expect(await ui.find({ type: 'Text', text: /^Archived$/ })).toBeFalsy()
    await ui.unmount()
  }

  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'b' })
  expect(opened.at(-1)).toEqual(['open', 'claude://b'])
  await ui.press({ key: 'expand-c' })
  expect(await ui.find({ type: 'Text', text: /impl-1: Wire it/ })).toBeTruthy()
  await ui.press({ key: 'expand-c' })
  expect(await ui.find({ type: 'Text', text: /impl-1/ })).toBeFalsy()
  await ui.press({ key: 'toggle-archived' })
  expect(archivedFlags.at(-1)).toBe(true)
  expect(await ui.find({ type: 'Text', text: /^Archived$/ })).toBeTruthy()
  await ui.unmount()
})

test('a plain-text refusal shows its own words', async ($, on) => {
  on('command.register', () => ({ value: { command: 'active-chats' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('clock.now', () => ({ value: 0 }))
  on('mcp.call', () => reply('Error: result exceeds maximum allowed tokens'))

  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(
    (await ui.find({ type: 'Text', text: /Could not load/ }))?.text,
  ).toContain('exceeds maximum')
  await ui.unmount()
})

test('colors follow state, then age', () => {
  const now = Date.parse('2026-10-31T12:00:00.000Z')
  const chat = (state: 'waiting' | 'working' | 'idle' | 'archived', hours: number) => ({
    id: 'a',
    title: 'A',
    state,
    lastActivityAt: new Date(now - hours * 3_600_000).toISOString(),
  })

  expect(chatColor(chat('waiting', 48), now)).toBe('#e5534b')
  expect(chatColor(chat('working', 48), now)).toBe('#3fb950')
  expect(chatColor(chat('idle', 13), now)).toBe('#b4b4b4')
  expect(chatColor(chat('archived', 13), now)).toBe('#b4b4b4')
  expect(chatColor(chat('idle', 11), now)).toBeUndefined()
})

test('a scheduled chat does not open the pane', async ($, on) => {
  let opens = 0
  on('command.register', () => ({ value: { command: 'active-chats' } }))
  on('ui.open', () => {
    opens += 1

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('mcp.call', () => reply({ scheduledTaskId: 'nightly' }))

  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await settle()
  expect(opens).toBe(0)
})

test('a person\'s chat opens the pane, whatever isInteractive says', async ($, on) => {
  let opens = 0
  on('command.register', () => ({ value: { command: 'active-chats' } }))
  on('ui.open', () => {
    opens += 1

    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('clock.every', () => ({ value: undefined }))
  on('mcp.call', (_, e) => reply(e.tool === 'get_session' ? {} : []))

  await $.session.start({ cwd: '/', surface: null, isInteractive: false })
  await settle()
  expect(opens).toBe(1)
})

const chatAt = (state: 'waiting' | 'working' | 'idle' | 'archived', hours: number, now: number) => ({
  id: 'a',
  title: 'A',
  state,
  lastActivityAt: new Date(now - hours * 3_600_000).toISOString(),
})

test('poses and groups follow status and age', () => {
  const now = Date.parse('2026-10-31T12:00:00.000Z')

  expect(chatPose(chatAt('idle', 13, now), now)).toBe('asleep')
  expect(chatPose(chatAt('idle', 1, now), now)).toBe('idle')
  expect(chatPose(chatAt('waiting', 13, now), now)).toBe('waiting')
  const groups = groupChats([chatAt('idle', 13, now), chatAt('idle', 1, now)], now)
  expect(groups.older.length).toBe(1)
  expect(groups.recent.length).toBe(1)
})

test('characters animate only when they should', () => {
  expect(characterSvg('a', 'waiting')).toContain('<animate')
  expect(characterSvg('a', 'working')).toContain('prefers-reduced-motion')
  expect(characterSvg('a', 'asleep')).not.toContain('<animate')
  expect(isAnimated('idle')).toBe(false)
  expect(characterSvg('same', 'idle')).toBe(characterSvg('same', 'idle'))
})

test('meta line names the project, PR and context', () => {
  const now = Date.parse('2026-10-31T12:00:00.000Z')

  expect(projectName('/home/me/projects/app/.claude/worktrees/x')).toBe('app')
  expect(projectName('/home/me/projects/app')).toBe('app')
  expect(
    chatMeta(
      { ...chatAt('idle', 1, now), project: 'P', prNumber: 7, prState: 'OPEN', contextPercent: 23 },
      now,
    ),
  ).toBe('1h ago · P · PR #7 open · 23% context')
})

test('agents split into running, stalled and done', () => {
  const disk = readDisk(
    JSON.stringify({
      agents: [
        { name: 'old', description: '', isFinished: false, ageMs: 3_600_000 },
        { name: 'live', description: 'x', isFinished: false, ageMs: 1000 },
        { name: 'over', description: '', isFinished: true, ageMs: 5 },
      ],
      outputAges: [1000, 3_600_000],
    }),
  )

  expect(disk.agents.map(agent => `${agent.name}:${agent.status}`)).toEqual([
    'live:running',
    'old:stalled',
    'over:done',
  ])
  expect(disk.activeOutputs).toBe(1)
})

test('transcript gives recent tools and the last words', () => {
  const read = readTranscript(
    'Session "S" (idle)\n[assistant] (called Bash)\n[assistant] First line.\nMore.\n[assistant] (called mcp__x__wrap_up)\n[result] done',
  )

  expect(read.recentTools).toEqual(['Bash', 'wrap_up'])
  expect(read.lastSaid).toBe('First line.')
})
