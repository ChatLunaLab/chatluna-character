import { ChatPipe } from './pipe'
import { DagManager } from './dag'
import { Middleware } from './middleware'
import { createDefaultMiddlewares } from './middleware/index'
import { Context } from 'koishi'

export { ChatPipe } from './pipe'
export { PipeContext } from './context'
export { Middleware, createMiddleware } from './middleware'
export { DagManager } from './dag'
export { createDefaultMiddlewares } from './middleware/index'

// Factory function to create a preconfigured chat pipe with default middlewares
export function createChatPipe(ctx: Context): ChatPipe {
    const { middlewares } = createDefaultMiddlewares()

    // Create and configure the chat pipe
    const chatPipe = new ChatPipe(ctx)

    // Add sorted middlewares to the pipe
    for (const middleware of middlewares) {
        chatPipe.use(middleware)
    }

    return chatPipe
}

// Factory function to create a chat pipe with custom middleware configuration
export function createCustomChatPipe(
    ctx: Context,
    middlewares: Middleware[]
): ChatPipe {
    // Create a new DAG manager to sort the middlewares
    const dagManager = new DagManager()

    // Add all middlewares to the DAG manager
    for (const middleware of middlewares) {
        dagManager.addMiddleware(middleware)
    }

    // Sort the middlewares using the DAG
    const sortedMiddlewares = dagManager.sort()

    // Create the chat pipe
    const chatPipe = new ChatPipe(ctx)

    // Add sorted middlewares to the pipe
    for (const middleware of sortedMiddlewares) {
        chatPipe.use(middleware)
    }

    return chatPipe
}
