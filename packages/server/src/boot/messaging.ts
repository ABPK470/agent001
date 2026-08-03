import type { AgentOrchestrator } from "../runtime/orchestrator.js"
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
  readonly channelConfigs: Awaited<ReturnType<typeof listChannelConfigs>>
}

export async function initMessaging(orchestrator: AgentOrchestrator): Promise<MessagingRuntime> {
  const queueStore = new SqliteQueueStore()
  const conversationStore = new SqliteConversationStore()
  const messageQueue = new MessageQueue(queueStore)
  const messageRouter = new MessageRouter(messageQueue, conversationStore, {
    startRun: async (goal, session, threadId) =>
      await orchestrator.startRun(await goal, threadId ? { threadId } : undefined, session ?? null)
  })
  orchestrator.setMessageRouter(messageRouter)

  const channelConfigs = await listChannelConfigs()
  for (const cfg of channelConfigs) {
    if (cfg.type === "teams") {
      const channel = new TeamsChannel(cfg)
      messageQueue.registerChannel(channel)
      messageRouter.registerChannel(channel)
      console.log(`Channel loaded: teams (appId: ${cfg.platformId})`)
    }
  }
  await messageQueue.start()

  return { messageQueue, messageRouter, channelConfigs }
}
