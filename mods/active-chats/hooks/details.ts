import type { AgentRun, ChatDetail } from '../types'

const RUNNING_AGENT_MS = 30 * 60 * 1000
const ACTIVE_OUTPUT_MS = 5 * 60 * 1000

// Read-only. The app keeps no API for another chat's agents, so this reads its
// session records: agent meta files and the age of their logs and task outputs.
export const DISK_SCRIPT = `
import glob, json, os, sys, time
sid = sys.argv[1]
home = os.path.expanduser('~')
found = glob.glob(home + '/Library/Application Support/Claude/claude-code-sessions/*/*/' + sid + '.json')
if not found:
    print(json.dumps({'agents': [], 'activeOutputs': 0}))
    sys.exit(0)
cli = json.load(open(found[0])).get('cliSessionId') or 'none'
agents = []
for path in glob.glob(home + '/.claude/projects/*/' + cli + '/subagents/**/*.meta.json', recursive=True):
    try:
        meta = json.load(open(path))
        log = path[:-len('.meta.json')] + '.jsonl'
        changed = os.path.getmtime(log if os.path.exists(log) else path)
    except (OSError, ValueError):
        continue
    agents.append({
        'name': meta.get('name') or meta.get('agentType') or 'agent',
        'description': meta.get('description') or '',
        'isFinished': bool(meta.get('finished')),
        'ageMs': int((time.time() - changed) * 1000),
    })
outputs = glob.glob('/private/tmp/claude-*/*/' + cli + '/tasks/*.output')
ages = []
for path in outputs:
    try:
        ages.append(int((time.time() - os.path.getmtime(path)) * 1000))
    except OSError:
        pass
print(json.dumps({'agents': agents, 'outputAges': ages}))
`

type DiskAgent = {
  name: string
  description: string
  isFinished: boolean
  ageMs: number
}

export function readDisk(stdout: string): Pick<ChatDetail, 'agents' | 'activeOutputs'> {
  const disk = JSON.parse(stdout) as { agents?: DiskAgent[]; outputAges?: number[] }
  const toRun = (agent: DiskAgent): AgentRun => ({
    name: agent.name,
    description: agent.description,
    status: agent.isFinished
      ? 'done'
      : agent.ageMs < RUNNING_AGENT_MS
        ? 'running'
        : 'stalled',
  })
  const sorted = [...(disk.agents ?? [])].sort((a, b) => a.ageMs - b.ageMs)
  const unfinished = sorted.filter(agent => !agent.isFinished).map(toRun)
  const done = sorted.filter(agent => agent.isFinished).slice(0, 5).map(toRun)

  return {
    agents: [...unfinished, ...done],
    activeOutputs: (disk.outputAges ?? []).filter(age => age < ACTIVE_OUTPUT_MS).length,
  }
}

export function readTranscript(
  transcript: string,
): Pick<ChatDetail, 'recentTools' | 'lastSaid'> {
  const entries = transcript.split(/^(?=\[[a-z_]+\])/m).slice(1)
  const assistant = entries
    .filter(entry => entry.startsWith('[assistant]'))
    .map(entry => entry.slice('[assistant]'.length).trim())
  const tool = (entry: string) => entry.match(/^\(called ([^)]+)\)/)?.[1]
  const recentTools = assistant
    .map(tool)
    .filter((name): name is string => Boolean(name))
    .slice(-6)
    .map(name => name.split('__').at(-1) ?? name)
  const said = assistant.filter(entry => !tool(entry)).at(-1)
  const firstLine = said?.split('\n').find(line => line.trim())?.trim()

  return {
    recentTools,
    lastSaid: firstLine && firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine,
  }
}

// Every non-scheduled chat from the app's session records, so the list is not
// limited by the 100 rows the session tools can return in one answer.
export const LIST_SCRIPT = `
import glob, json, os, sys, time
include_archived = sys.argv[1] == '1'
home = os.path.expanduser('~')
now = time.time()
rows = []
for path in glob.glob(home + '/Library/Application Support/Claude/claude-code-sessions/*/*/local_*.json'):
    try:
        d = json.load(open(path))
    except (OSError, ValueError):
        continue
    archived = bool(d.get('isArchived'))
    if d.get('scheduledTaskId') or (archived and not include_archived):
        continue
    at = d.get('lastActivityAt') or d.get('createdAt') or 0
    prs = d.get('prs') or [{}]
    cli = d.get('cliSessionId') or 'none'
    live = 0
    outputs = 0
    if not archived and now - at / 1000 < 86400:
        for meta_path in glob.glob(home + '/.claude/projects/*/' + cli + '/subagents/**/*.meta.json', recursive=True):
            try:
                log = meta_path[:-len('.meta.json')] + '.jsonl'
                if not json.load(open(meta_path)).get('finished') and now - os.path.getmtime(log) < 600:
                    live += 1
            except (OSError, ValueError):
                pass
        for task in glob.glob('/private/tmp/claude-*/*/' + cli + '/tasks/*.output'):
            try:
                if now - os.path.getmtime(task) < 300:
                    outputs += 1
            except OSError:
                pass
    rows.append({
        'sessionId': d.get('sessionId'),
        'title': d.get('title'),
        'cwd': d.get('cwd'),
        'isArchived': archived,
        'isRunning': False,
        'lastActivityAt': time.strftime('%Y-%m-%dT%H:%M:%S.000Z', time.gmtime(at / 1000)),
        'link': 'claude://claude.ai/epitaxy/' + str(d.get('sessionId')),
        'prNumber': prs[-1].get('prNumber'),
        'prState': prs[-1].get('prState') or prs[-1].get('state'),
        'liveAgents': live,
        'activeOutputs': outputs,
    })
print(json.dumps(rows))
`
