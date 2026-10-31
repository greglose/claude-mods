export type ChatState = 'waiting' | 'working' | 'idle' | 'archived'

export type Chat = {
  id: string
  title: string
  link?: string
  lastActivityAt: string
  contextPercent?: number
  project?: string
  uncommitted?: number
  unmerged?: number
  startedBy?: string
  prNumber?: number
  prState?: string
  state: ChatState
}

export type AgentRun = {
  name: string
  description: string
  status: 'running' | 'stalled' | 'done'
}

export type ChatDetail = {
  agents: AgentRun[]
  activeOutputs: number
  recentTools: string[]
  lastSaid?: string
  error?: string
}

declare module 'claude-code' {
  interface PluginState {
    'active-chats': {
      chats: Chat[]
      includeArchived: boolean
      error: string | null
      isCapped: boolean
      expandedIds: string[]
      details: Record<string, ChatDetail>
      isOlderOpen: boolean
      isLoading: boolean
    }
  }
}
