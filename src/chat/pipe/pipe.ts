import { Context, Session } from 'koishi'
import { PipeContext, createContext } from './context'
import { Middleware } from './middleware'
import { Message, PresetTemplate } from '../../types'
import { Embeddings } from '@langchain/core/embeddings'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'

export class ChatPipe {
    private middlewares: Middleware[] = []
    private ctx: Context

    constructor(ctx: Context) {
        this.ctx = ctx
    }

    // Add middleware to the pipeline
    use(middleware: Middleware): this {
        this.middlewares.push(middleware)
        return this
    }

    // Execute the middleware pipeline
    async execute(
        session: Session,
        message: Message,
        history: Message[],
        preset: PresetTemplate,
        model: ChatLunaChatModel,
        embeddings: Embeddings
    ): Promise<string> {
        // Create the context for middleware to use
        const context = createContext(
            this.ctx,
            session,
            message,
            history,
            preset,
            model,
            embeddings
        )

        // Execute middleware pipeline - middlewares are already sorted by DAG
        await this.executeMiddleware(context, this.middlewares, 0)

        return context.state.result
    }

    // Internal method to execute middleware chain
    private async executeMiddleware(
        context: PipeContext,
        middlewares: Middleware[],
        index: number
    ): Promise<void> {
        // If we've reached the end of middleware chain, return
        if (index >= middlewares.length) {
            return
        }

        const middleware = middlewares[index]
        context.log(`Executing middleware: ${middleware.name}`)

        // Execute current middleware, passing next function to continue the chain
        await middleware.execute(context, async () => {
            await this.executeMiddleware(context, middlewares, index + 1)
        })
    }
}
