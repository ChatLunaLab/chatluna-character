import { createBeforeChatMiddleware } from './before-chat'
import { createChatMiddleware } from './chat'
import { createAfterChatMiddleware } from './after-chat'
import { Middleware } from '../middleware'
import { DagManager } from '../dag'

export { createBeforeChatMiddleware } from './before-chat'
export { createChatMiddleware } from './chat'
export { createAfterChatMiddleware } from './after-chat'

// Factory function to create the default middleware set with DAG dependencies
export function createDefaultMiddlewares(): {
    middlewares: Middleware[]
    dagManager: DagManager
} {
    const beforeChat = createBeforeChatMiddleware({})
    const chat = createChatMiddleware({})
    const afterChat = createAfterChatMiddleware({})

    // Set up the DAG relationships using before/after
    const dag = new DagManager()

    // Add middlewares to DAG
    dag.addMiddleware(beforeChat)
    dag.addMiddleware(chat)
    dag.addMiddleware(afterChat)

    return {
        middlewares: dag.sort(),
        dagManager: dag
    }
}
