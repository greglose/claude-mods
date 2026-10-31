import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  McpToolResult,
  Register,
  RenderChildren,
} from 'claude-code'

import type { Chat, ChatDetail, ChatState } from '../types'
import { DISK_SCRIPT, LIST_SCRIPT, readDisk, readTranscript } from './details'
import { characterSvg, isAnimated } from './characters'
import type { Pose } from './characters'

const PANE = 'active-chats'
const SERVER = 'ccd_session_mgmt'
const POLL_MS = 30_000
const BATCH = 6
// The server refuses a result past its size cap, which 200 rows exceed.
const MAX_CHATS = 100

const chats = atom({ plugin: 'active-chats', key: 'chats' } as const, [])
const includeArchived = atom(
  { plugin: 'active-chats', key: 'includeArchived' } as const,
  false,
)
const error = atom({ plugin: 'active-chats', key: 'error' } as const, null)
const isCapped = atom({ plugin: 'active-chats', key: 'isCapped' } as const, false)
const searchQuery = atom(
  { plugin: 'active-chats', key: 'searchQuery' } as const,
  '',
)
const openProjects = atom(
  { plugin: 'active-chats', key: 'openProjects' } as const,
  {},
)
const expandedIds = atom(
  { plugin: 'active-chats', key: 'expandedIds' } as const,
  [],
)
const details = atom({ plugin: 'active-chats', key: 'details' } as const, {})
const isLoading = atom(
  { plugin: 'active-chats', key: 'isLoading' } as const,
  false,
)

type Listed = {
  sessionId: string
  title?: string
  isArchived: boolean
  isRunning: boolean
  lastActivityAt: string
  link?: string
  cwd?: string
  prNumber?: number
  prState?: string
  startedBy?: string
  liveAgents?: number
  activeOutputs?: number
}

// Only the end of a message asks; a question earlier on was usually answered.
const ASK_WINDOW = 300
const ASKS =
  /\?\s*$|\bneed[s]? (?:one |a |an )?(?:decision|answer|input|approval)\b|\bneed[s]? .{0,40}\bfrom you\b|\byour (?:calls?|decision|go-ahead|approval)\b|\bblocked on you\b/im

/** Reads a chat's state from its running flag and the tail of its transcript. */
export function classify(isRunning: boolean, transcript: string): ChatState {
  const header = transcript.match(/^Session ".*" \(([^)]+)\)/m)?.[1] ?? ''
  if (/wait|permission|input/i.test(header)) return 'waiting'

  const entries = transcript.split(/^(?=\[[a-z_]+\])/m).slice(1)
  const last = entries.filter(entry => !entry.startsWith('[result]')).at(-1)
  if (last?.includes('AskUserQuestion')) return 'waiting'
  if (isRunning) return 'working'

  return last?.startsWith('[assistant]') && ASKS.test(last.slice(-ASK_WINDOW)) ? 'waiting' : 'idle'
}

export function ago(iso: string, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / 60_000))
  if (minutes < 1) return 'just now'
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`

  return `${Math.floor(hours / 24)}d ago`
}

const RED = '#e5534b'
const AMBER = '#d29922'
const PURPLE = '#a371f7'
const GREEN = '#3fb950'
const GREY = '#b4b4b4'
// A plain Button insets its label; lines under it line up with this.
const TITLE_INSET = 1
const STALE_MS = 12 * 60 * 60 * 1000

/** Red needs the person, green is running, light grey is over 12 hours old. */
export function chatColor(chat: Chat, now: number): string | undefined {
  if (chat.state === 'waiting') return RED
  if (chat.state === 'working') return GREEN

  return now - Date.parse(chat.lastActivityAt) > STALE_MS ? GREY : undefined
}

/** The repo folder, whether the chat runs in it or in one of its worktrees. */
export function projectName(cwd: string | undefined): string | undefined {
  return cwd?.split('/.claude/worktrees/')[0]?.split('/').filter(Boolean).at(-1)
}

/** The records cover every chat; the tool's rows add the live running state. */
export function mergeChats(fromDisk: Listed[], fromTool: Listed[]): Listed[] {
  if (fromDisk.length === 0) return fromTool
  const live = new Map(fromTool.map(session => [session.sessionId, session]))

  return fromDisk
    .map(session => ({ ...session, ...live.get(session.sessionId) }))
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
}

/** A chat outside any repo is its own project; a removed worktree keeps its repo. */
export function fallbackProject(session: Listed): string | undefined {
  return session.cwd?.includes('/.claude/worktrees/')
    ? projectName(session.cwd)
    : (session.title ?? projectName(session.cwd))
}

function withoutUndefined<T extends object>(value: T | undefined): Partial<T> {
  return Object.fromEntries(
    Object.entries(value ?? {}).filter(([, field]) => field !== undefined),
  ) as Partial<T>
}

export type ProjectGroup = {
  name: string
  quiet: Chat[]
  needsYou: number
  running: number
  uncommitted: number
  unmerged: number
  lastActivityAt: string
}

export function groupProjects(list: readonly Chat[]): ProjectGroup[] {
  const byName = new Map<string, Chat[]>()
  for (const chat of list) {
    if (chat.state === 'archived') continue
    const name = chat.project ?? chat.title
    byName.set(name, [...(byName.get(name) ?? []), chat])
  }
  const sum = (chats: Chat[], field: 'uncommitted' | 'unmerged') =>
    chats.reduce((total, chat) => total + (chat[field] ?? 0), 0)

  return [...byName]
    .map(([name, chats]) => ({
      name,
      quiet: chats.filter(chat => chat.state === 'idle'),
      needsYou: chats.filter(chat => chat.state === 'waiting').length,
      running: chats.filter(chat => chat.state === 'working').length,
      uncommitted: sum(chats, 'uncommitted'),
      unmerged: sum(chats, 'unmerged'),
      lastActivityAt: chats
        .map(chat => chat.lastActivityAt)
        .reduce((a, b) => (Date.parse(a) > Date.parse(b) ? a : b)),
    }))
    .sort((a, b) => Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt))
}

/** Every word must appear somewhere in the chat's title or project. */
export function searchChats(list: readonly Chat[], query: string): Chat[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)

  return list.filter(chat => {
    const haystack = `${chat.title} ${chat.project ?? ''}`.toLowerCase()

    return words.every(word => haystack.includes(word))
  })
}

const DORMANT_MS = 3 * 24 * 60 * 60 * 1000

/** Nothing needs you, nothing is moving, and it has been quiet for days. */
export function isDormant(project: ProjectGroup, now: number): boolean {
  return (
    project.needsYou === 0 &&
    project.running === 0 &&
    now - Date.parse(project.lastActivityAt) > DORMANT_MS
  )
}

export function isOld(chat: Pick<Chat, 'lastActivityAt'>, now: number): boolean {
  return now - Date.parse(chat.lastActivityAt) > STALE_MS
}

export function chatPose(chat: Chat, now: number): Pose {
  if (chat.state === 'idle' && isOld(chat, now)) return 'asleep'

  return chat.state
}

export function chatMeta(chat: Chat, now: number, showProject = true): string {
  return [
    ago(chat.lastActivityAt, now),
    showProject ? chat.project : undefined,
    chat.prNumber === undefined
      ? undefined
      : `PR #${chat.prNumber}${chat.prState ? ` ${chat.prState.toLowerCase()}` : ''}`,
    chat.contextPercent === undefined ? undefined : `${chat.contextPercent}% context`,
  ]
    .filter(Boolean)
    .join(' · ')
}

export function groupChats(list: readonly Chat[], now: number) {
  const inState = (state: ChatState) => list.filter(chat => chat.state === state)
  const idle = inState('idle')

  return {
    needsYou: inState('waiting'),
    running: inState('working'),
    recent: idle.filter(chat => !isOld(chat, now)),
    older: idle.filter(chat => isOld(chat, now)),
    archived: inState('archived'),
  }
}

/** Spells out what the row's color says, so the color is never the only cue. */
export function rowStatus(chat: Chat): string {
  return chat.state === 'idle' ? '' : `${LABEL[chat.state]} · `
}

const LABEL: Record<ChatState, string> = {
  waiting: 'Needs you',
  working: 'Running',
  idle: 'Idle',
  archived: 'Archived',
}

// Idle transcripts only change when lastActivityAt does.
const stateCache = new Map<string, ChatState>()
let isRefreshing = false

function text(result: McpToolResult): string {
  return result.content
    .map(block => ('text' in block && typeof block.text === 'string' ? block.text : ''))
    .join('\n')
}

// A chat never joins or leaves a schedule, so an answer holds for the session.
const scheduledCache = new Map<string, boolean>()

async function isScheduled($: EngineInterface, id: string): Promise<boolean> {
  const cached = scheduledCache.get(id)
  if (cached !== undefined) return cached

  const result = await $.mcp.call(SERVER, 'get_session', { session_id: id })
  const body = text(result)
  // Unknown stays listed, and is asked again next refresh.
  if (result.isError || !body.trimStart().startsWith('{')) return false

  const scheduled = Boolean(JSON.parse(body).scheduledTaskId)
  scheduledCache.set(id, scheduled)

  return scheduled
}

// Context only moves with activity, so one answer holds until the chat does more.
const contextCache = new Map<string, number | null>()

async function contextPercent(
  $: EngineInterface,
  session: Listed,
): Promise<number | undefined> {
  const cacheKey = `${session.sessionId}@${session.lastActivityAt}`
  const cached = session.isRunning ? undefined : contextCache.get(cacheKey)
  if (cached !== undefined) return cached ?? undefined

  const result = await $.mcp.call(SERVER, 'get_usage', {
    session_id: session.sessionId,
  })
  const body = text(result)
  if (result.isError || !body.trimStart().startsWith('{')) return undefined

  // A chat with no live process reports its context unavailable.
  const percent = JSON.parse(body).context?.percentUsed
  const known = typeof percent === 'number' ? percent : null
  contextCache.set(cacheKey, known)

  return known ?? undefined
}

const GIT_TTL_MS = 2 * 60 * 1000
type GitState = { uncommitted: number; unmerged: number; project?: string }
const gitCache = new Map<string, { at: number; state: GitState | undefined }>()

// A squash merge leaves commits ahead of the base, so a merged PR counts as none.
async function gitState(
  $: EngineInterface,
  session: Listed,
): Promise<GitState | undefined> {
  const { cwd } = session
  if (!cwd || session.isArchived) return undefined
  const now = await $.clock.now()
  const cacheKey = `${cwd}@${session.prState ?? ''}`
  const cached = gitCache.get(cacheKey)
  if (cached && now - cached.at < GIT_TTL_MS) return cached.state

  const git = (...args: string[]) =>
    $.process.run(['git', '-C', cwd, ...args], {
      env: { GIT_OPTIONAL_LOCKS: '0' },
    })
  let state: GitState | undefined
  try {
    const status = await git('status', '--porcelain')
    if (status.exitCode === 0) {
      const head = await git('symbolic-ref', '-q', '--short', 'refs/remotes/origin/HEAD')
      const base = head.exitCode === 0 ? head.stdout.trim() : 'origin/main'
      const ahead = await git('rev-list', '--count', `${base}..HEAD`)
      const top = await git('rev-parse', '--show-toplevel')
      state = {
        project: top.exitCode === 0 ? projectName(top.stdout.trim()) : undefined,
        uncommitted: status.stdout.split('\n').filter(Boolean).length,
        unmerged:
          ahead.exitCode === 0 && session.prState !== 'MERGED'
            ? Number(ahead.stdout.trim()) || 0
            : 0,
      }
    }
  } catch {
    state = undefined
  }
  gitCache.set(cacheKey, { at: now, state })

  return state
}

async function loadDetail($: EngineInterface, id: string): Promise<void> {
  let detail: ChatDetail
  try {
    const events = await $.mcp.call(SERVER, 'list_events', {
      session_id: id,
      limit: 30,
    })
    const disk = await $.process.run(['python3', '-c', DISK_SCRIPT, id])
    if (disk.exitCode !== 0) throw new Error(disk.stderr)
    detail = {
      ...readDisk(disk.stdout),
      ...readTranscript(events.isError ? '' : text(events)),
    }
  } catch (failure) {
    detail = {
      agents: [],
      activeOutputs: 0,
      recentTools: [],
      error: failure instanceof Error ? failure.message : String(failure),
    }
  }
  await update($, details, all => ({ ...all, [id]: detail }))
}

let selfId: string | undefined

async function readSelfId($: EngineInterface): Promise<string | undefined> {
  const self = await $.mcp.call(SERVER, 'get_session', { session_id: 'self' })
  const body = text(self)
  if (self.isError || !body.trimStart().startsWith('{')) return undefined

  return JSON.parse(body).sessionId
}

async function readAllChats(
  $: EngineInterface,
  showArchived: boolean,
): Promise<Listed[]> {
  try {
    const run = await $.process.run([
      'python3',
      '-c',
      LIST_SCRIPT,
      showArchived ? '1' : '0',
    ])
    const rows = run.exitCode === 0 ? JSON.parse(run.stdout) : []

    return Array.isArray(rows) ? rows : []
  } catch {
    return []
  }
}

// $.state lasts one session; the store carries these across chats and restarts.
const OPEN_STATE_KEY = 'openState'
const EXPANDED_KEY = 'expandedIds'

async function loadSavedView($: EngineInterface): Promise<void> {
  try {
    const open = await $.store.get(OPEN_STATE_KEY)
    if (open && typeof open === 'object') {
      await update($, openProjects, () => open as Record<string, boolean>)
    }
    const ids = await $.store.get(EXPANDED_KEY)
    if (Array.isArray(ids)) await update($, expandedIds, () => ids as string[])
  } catch {
    // The pane works without saved state; it just starts from the defaults.
  }
}

async function saveView($: EngineInterface, key: string, value: unknown): Promise<void> {
  try {
    await $.store.set(key, value)
  } catch {
    // The choice still holds for this chat.
  }
}

async function setOpen($: EngineInterface, key: string, value: boolean): Promise<void> {
  await update($, openProjects, all => ({ ...all, [key]: value }))
  await saveView($, OPEN_STATE_KEY, await read($, openProjects))
}

async function refresh($: EngineInterface): Promise<void> {
  if (isRefreshing) return
  isRefreshing = true
  await update($, isLoading, () => true)
  await loadSavedView($)
  try {
    const showArchived = await read($, includeArchived)
    const listed = await $.mcp.call(SERVER, 'list_sessions', {
      include_archived: showArchived,
      limit: MAX_CHATS,
    })
    const body = text(listed)
    // A refusal can arrive as plain text without isError set.
    const isListed = !listed.isError && body.trimStart().startsWith('[')
    const fromTool = isListed ? (JSON.parse(body) as Listed[]) : []
    const fromDisk = await readAllChats($, showArchived)
    if (!isListed && fromDisk.length === 0) throw new Error(body)
    selfId ??= await readSelfId($)
    const sessions = mergeChats(fromDisk, fromTool).filter(
      session => session.sessionId !== selfId,
    )
    const isComplete = fromDisk.length > 0

    const next: Chat[] = []
    for (let at = 0; at < sessions.length; at += BATCH) {
      const batch = sessions.slice(at, at + BATCH).map(async session => {
        if (!isComplete && (await isScheduled($, session.sessionId))) return null
        const isActive =
          session.isRunning ||
          Boolean(session.liveAgents) ||
          Boolean(session.activeOutputs)

        const chat = {
          id: session.sessionId,
          title: session.title ?? 'Untitled',
          link: session.link,
          lastActivityAt: session.lastActivityAt,
          project: fallbackProject(session),
          ...withoutUndefined(await gitState($, session)),
          startedBy: session.startedBy,
          prNumber: session.prNumber ?? undefined,
          prState: session.prState ?? undefined,
          contextPercent: session.isArchived
            ? undefined
            : await contextPercent($, session),
        }
        if (session.isArchived) return { ...chat, state: 'archived' as const }

        const cacheKey = `${session.sessionId}@${session.lastActivityAt}`
        const cached = isActive ? undefined : stateCache.get(cacheKey)
        if (cached) return { ...chat, state: cached }

        const events = await $.mcp.call(SERVER, 'list_events', {
          session_id: session.sessionId,
          limit: 6,
        })
        const transcript = text(events)
        // A refusal can arrive as plain text without isError set.
        const isReadable = !events.isError && transcript.startsWith('Session "')
        const state = isReadable
          ? classify(isActive, transcript)
          : isActive
            ? 'working'
            : 'idle'
        if (isReadable && !isActive) stateCache.set(cacheKey, state)

        return { ...chat, state }
      })
      for (const chat of await Promise.all(batch)) {
          if (chat) next.push(chat)
        }
    }
    await update($, chats, () => next)
    await Promise.all([
        ...new Set([
          ...(await read($, expandedIds)),
          ...next.filter(chat => chat.state === 'working').map(chat => chat.id),
        ]),
      ].map(id => loadDetail($, id)))
    await update($, isCapped, () => !isComplete && sessions.length === MAX_CHATS)
    await update($, error, () => null)
  } catch (failure) {
    const message = failure instanceof Error ? failure.message : String(failure)
    await update($, error, () => message)
  } finally {
    isRefreshing = false
    await update($, isLoading, () => false)
  }
}

// Scheduled runs and hosts without the session server never open the pane by
// themselves; /active-chats still does.
// The session tools can connect after session.start, so the lookup waits for them.
const START_RETRY_MS = 2_000
const START_ATTEMPTS = 30

async function isScheduledChat($: EngineInterface): Promise<boolean | undefined> {
  try {
    const self = await $.mcp.call(SERVER, 'get_session', { session_id: 'self' })
    const body = text(self)
    if (self.isError || !body.trimStart().startsWith('{')) return undefined

    return Boolean(JSON.parse(body).scheduledTaskId)
  } catch {
    return undefined
  }
}

async function startPane($: EngineInterface, attempt = 1): Promise<void> {
  const isScheduled = await isScheduledChat($)
  if (isScheduled === undefined) {
    if (attempt < START_ATTEMPTS) {
      $.clock.after(START_RETRY_MS, () => void startPane($, attempt + 1))
    }

    return
  }
  if (isScheduled) return
  const opened = await $.ui.open({ id: PANE, title: 'Active chats' })
  if (!opened.isPlaced && !opened.reason.startsWith('no-surface')) {
    $.ui.log(`Active chats pane not shown: ${opened.reason}`)
  }
  void refresh($)
  startPolling($)
}

let isPolling = false

function startPolling($: EngineInterface): void {
  if (isPolling) return
  isPolling = true
  $.clock.every(POLL_MS, async () => {
    const panes = await $.ui.panes()
    if (panes.some(pane => pane.id === PANE && pane.isPlaced)) await refresh($)
  })
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'active-chats',
      description: 'Show your chats, last activity and which are waiting for you',
    })
    await loadSavedView($)
    void startPane($)

    return next(e)
  })

  on('command.run', { command: 'active-chats' }, async $ => {
    await $.ui.open({ id: PANE, title: 'Active chats' })
    void refresh($)
    startPolling($)

    return { text: 'Active chats pane opened.' }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    const Input = 'Input' in table ? table.Input : undefined
    // The terminal has no vector element; its cards go without characters.
    const Svg = 'Svg' in table ? table.Svg : undefined
    const query = await read($, searchQuery)
    const list = searchChats(await read($, chats), query)
    const isSearching = query.trim().length > 0
    const showArchived = await read($, includeArchived)
    const projectOverrides = await read($, openProjects)
    const problem = await read($, error)
    const loading = await read($, isLoading)
    const capped = await read($, isCapped)
    const now = await $.clock.now()
    const groups = groupChats(list, now)
    const expanded = await read($, expandedIds)
    const detailById = await read($, details)

    const character = (id: string, pose: Pose, size: number) =>
      Svg && (
        <Svg
          source={characterSvg(id, pose)}
          alt={pose === 'allClear' ? 'A relaxed character' : `Character: ${pose}`}
          width={size}
          height={size}
          {...(isAnimated(pose) ? { isInteractive: true as const } : {})}
        />
      )

    const detailView = (chat: Chat) => {
      const detail = detailById[chat.id]
      if (!detail) return <Text size="caption" dimColor>Loading…</Text>
      if (detail.error) {
        return <Text size="caption" color="red">Could not read: {detail.error}</Text>
      }
      const started = list.filter(other => other.startedBy === chat.id)
      const live = detail.agents.filter(agent => agent.status !== 'done')
      const done = detail.agents.filter(agent => agent.status === 'done')

      return (
        <Box flexDirection="column" marginTop={1}>
          <Text size="caption" weight="semibold">
            Agents running ({live.filter(agent => agent.status === 'running').length})
          </Text>
          {live.length === 0 && <Text size="caption" dimColor>None</Text>}
          {live.map(agent => (
            <Text size="caption" color={agent.status === 'running' ? GREEN : GREY}>
              {agent.status === 'running' ? '● ' : '○ stalled? '}
              {agent.name}
              {agent.description ? `: ${agent.description}` : ''}
            </Text>
          ))}
          {detail.activeOutputs > 0 && (
            <Text size="caption" color={GREEN}>
              ● {detail.activeOutputs} background task(s) writing output
            </Text>
          )}
          {started.length > 0 && (
            <Text size="caption" weight="semibold">Chats it started</Text>
          )}
          {started.map(other => (
            <Text size="caption" color={chatColor(other, now)}>
              {other.title}: {LABEL[other.state]}
            </Text>
          ))}
          {detail.recentTools.length > 0 && (
            <Text size="caption" dimColor>
              Recent tools: {detail.recentTools.join(', ')}
            </Text>
          )}
          {done.length > 0 && (
            <Text size="caption" dimColor>
              Recently finished: {done.map(agent => agent.name).join(', ')}
            </Text>
          )}
          {detail.lastSaid && (
            <Text size="caption" dimColor>
              Last said: {detail.lastSaid}
            </Text>
          )}
        </Box>
      )
    }

    const projects = groupProjects(list)
    const liveProjects = projects.filter(project => !isDormant(project, now))
    const dormantProjects = projects.filter(project => isDormant(project, now))
    const isOpen = (key: string, fallback: boolean) =>
      isSearching || (projectOverrides[key] ?? fallback)
    const toggle = (key: string, value: boolean) => () => setOpen($, key, value)
    const section = (
      key: string,
      title: string,
      count: number,
      fallback: boolean,
      body: () => RenderChildren,
      color?: string,
    ) => {
      const open = isOpen(`section:${key}`, fallback)

      return (
        <Box key={`section-${key}`} flexDirection="column" gap={1} marginTop={1}>
          <Button
            key={`section-${key}`}
            plain
            onPress={toggle(`section:${key}`, !open)}
          >
            <Text weight="semibold" color={color}>
              {open ? '▾' : '▸'} {title} ({count})
            </Text>
          </Button>
          {open && body()}
        </Box>
      )
    }

    const row = (chat: Chat, showProject = true) => {
      const color = chatColor(chat, now)
      const isOpen = expanded.includes(chat.id)
      const runningAgents = (detailById[chat.id]?.agents ?? []).filter(
        agent => agent.status === 'running',
      ).length

      return (
        <Box key={`row-${chat.id}`} flexDirection="column">
          <Box flexDirection="row" gap={1} alignItems="center">
            {character(chat.id, chatPose(chat, now), 28)}
            <Box flexDirection="column" flexGrow={1} flexShrink={1}>
              <Button
                key={chat.id}
                plain
                onPress={async () => {
                  const opened = await $.process.run(['open', chat.link ?? ''])
                  if (opened.exitCode !== 0) {
                    await $.ui.toast(`Could not open ${chat.title}`)
                  }
                }}
              >
                <Text bold color={color}>
                  {chat.title}
                </Text>
              </Button>
              <Box flexDirection="column" paddingLeft={TITLE_INSET}>
              <Text size="caption" color={color} dimColor={!color}>
                {rowStatus(chat)}
                {chatMeta(chat, now, showProject)}
                {runningAgents > 0
                  ? ` · ${runningAgents} agent${runningAgents === 1 ? '' : 's'}`
                  : ''}
              </Text>
              {chat.uncommitted || chat.unmerged ? (
                <Text size="caption">
                  {chat.uncommitted ? (
                    <Text color={AMBER}>{chat.uncommitted} uncommitted </Text>
                  ) : null}
                  {chat.unmerged ? (
                    <Text color={PURPLE}>{chat.unmerged} unmerged</Text>
                  ) : null}
                </Text>
              ) : null}
              </Box>
            </Box>
            <Button
              key={`expand-${chat.id}`}
              plain
              dimColor
              onPress={async () => {
                await update($, expandedIds, ids =>
                  isOpen ? ids.filter(id => id !== chat.id) : [...ids, chat.id],
                )
                await saveView($, EXPANDED_KEY, await read($, expandedIds))
                if (!isOpen) await loadDetail($, chat.id)
              }}
            >
              <Text>{isOpen ? '▾' : '▸'}</Text>
            </Button>
          </Box>
          {isOpen && detailView(chat)}
        </Box>
      )
    }

    const projectView = (project: ProjectGroup) => {
      const open = isOpen(project.name, !isOld(project, now))
      const showOlder = isOpen(`older:${project.name}`, false)
      const recent = project.quiet.filter(chat => !isOld(chat, now))
      const older = project.quiet.filter(chat => isOld(chat, now))

      return (
        <Box key={`project-${project.name}`} flexDirection="column" gap={1}>
          <Box flexDirection="column">
            <Button
              key={`toggle-project-${project.name}`}
              plain
              onPress={toggle(project.name, !open)}
            >
              <Text bold>
                {open ? '▾' : '▸'} {project.name}
              </Text>
            </Button>
            <Box paddingLeft={TITLE_INSET}>
              <Text size="caption">
                {project.needsYou > 0 && <Text color={RED}>{project.needsYou} need you · </Text>}
                {project.running > 0 && <Text color={GREEN}>{project.running} active · </Text>}
                {project.uncommitted > 0 && <Text color={AMBER}>{project.uncommitted} uncommitted · </Text>}
                {project.unmerged > 0 && <Text color={PURPLE}>{project.unmerged} unmerged · </Text>}
                <Text dimColor>{ago(project.lastActivityAt, now)}</Text>
              </Text>
            </Box>
          </Box>
          {open && (recent.length > 0 || older.length > 0) && (
            <Box flexDirection="column" gap={1} paddingLeft={2}>
              {recent.map(chat => row(chat, false))}
              {older.length > 0 && (
                <Button
                  key={`older-${project.name}`}
                  plain
                  dimColor
                  onPress={toggle(`older:${project.name}`, !showOlder)}
                >
                  {showOlder ? 'Hide older' : `Show ${older.length} older`}
                </Button>
              )}
              {showOlder && older.map(chat => row(chat, false))}
            </Box>
          )}
        </Box>
      )
    }

    return (
      <Box flexDirection="column" gap={1}>
        <Box flexDirection="row" gap={1}>
          <Button
            key="toggle-archived"
            onPress={async () => {
              await update($, includeArchived, value => !value)
              await refresh($)
            }}
          >
            {showArchived ? 'Archived: shown' : 'Archived: hidden'}
          </Button>
          <Button key="refresh" onPress={() => refresh($)}>
            Refresh
          </Button>
        </Box>
        {Input && (
          <Input
            key="search"
            label="Search chats"
            placeholder="Search chats and projects"
            value={query}
            onInput={(value: string) => update($, searchQuery, () => value)}
            onSubmit={(value: string) => update($, searchQuery, () => value)}
          />
        )}
        <Text size="caption">
          <Text color={RED}>{groups.needsYou.length} need you</Text>
          {' · '}
          <Text color={GREEN}>{groups.running.length} running</Text>
          {` · ${groups.recent.length + groups.older.length} quiet · ${projects.length} projects`}
          {capped ? ` · newest ${MAX_CHATS}` : ''}
          {loading ? ' · updating' : ''}
        </Text>
        {problem && <Text color="red">Could not load chats: {problem}</Text>}
        {!problem && !loading && list.length === 0 && (
          <Text dimColor>{isSearching ? `No chats match "${query}".` : 'No chats.'}</Text>
        )}
        {!problem && !isSearching && list.length > 0 && groups.needsYou.length === 0 && (
          <Box flexDirection="row" gap={1} alignItems="center">
            {character('all-clear', 'allClear', 28)}
            <Text size="caption">All clear. Nothing needs you.</Text>
          </Box>
        )}
        {section('needs', 'Needs you', groups.needsYou.length, true, () =>
          groups.needsYou.map(chat => row(chat)), RED)}
        {section('active', 'Active now', groups.running.length, true, () =>
          groups.running.map(chat => row(chat)), GREEN)}
        {section('projects', 'Projects', liveProjects.length, true, () =>
          liveProjects.map(projectView))}
        {dormantProjects.length > 0 &&
          section('dormant', 'Dormant projects', dormantProjects.length, false, () =>
            dormantProjects.map(projectView))}
        {groups.archived.length > 0 &&
          section('archived', 'Archived', groups.archived.length, true, () =>
            groups.archived.map(chat => row(chat)), GREY)}
      </Box>
    )
  })
}
