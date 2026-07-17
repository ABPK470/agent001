import type { AgentOrchestrator } from "../api/runs/orchestrator.js"
import {
  MessageQueue,
  MessageRouter,
  SqliteConversationStore,
  SqliteQueueStore,
  TeamsChannel,
  listChannelConfigs
} from "../infra/queue/channels/index.js"

export interface MessagingRuntime {
  readonly messageQueue: MessageQueue
  readonly messageRouter: MessageRouter
  readonly channelConfigs: ReturnType<typeof listChannelConfigs>
}

export function initMessaging(orchestrator: AgentOrchestrator): MessagingRuntime {
  const queueStore = new SqliteQueueStore()
  const conversationStore = new SqliteConversationStore()
  const messageQueue = new MessageQueue(queueStore)
  const messageRouter = new MessageRouter(messageQueue, conversationStore, {
    startRun: (goal, session, threadId) =>
      orchestrator.startRun(goal, threadId ? { threadId } : undefined, session ?? null)
  })
  orchestrator.setMessageRouter(messageRouter)

  const channelConfigs = listChannelConfigs()
  for (const cfg of channelConfigs) {
    if (cfg.type === "teams") {
      const channel = new TeamsChannel(cfg)
      messageQueue.registerChannel(channel)
      messageRouter.registerChannel(channel)
      console.log(`Channel loaded: teams (appId: ${cfg.platformId})`)
    }
  }
  messageQueue.start()

  return { messageQueue, messageRouter, channelConfigs }
}
