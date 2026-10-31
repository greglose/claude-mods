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
