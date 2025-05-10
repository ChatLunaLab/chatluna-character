import { Context, Session } from 'koishi'
import { PresetTemplate } from '../../types'
import { AgentAction } from '../../agent/type'

import { Embeddings } from '@langchain/core/embeddings'
import { Message } from '../../message-counter/types'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'

export interface PipeContext {
    ctx: Context
    session: Session
    message: Message
    history: Message[]
    preset: PresetTemplate
    model: ChatLunaChatModel
    embeddings: Embeddings
    cache: Map<string, unknown>
    state: {
        result: string
        [key: string]: unknown
    }

    // Method to set a result in the context
    setResult(result: string): void

    // Method to get a cached value or compute it if not present
    getOrSet<T>(key: string, valueFactory: () => Promise<T>): Promise<T>

    // Method to add logs for debugging
    log(message: string, ...args: unknown[]): void

    // Stream through middleware pipeline and collect results
    streamThrough(action: AsyncGenerator<AgentAction>): Promise<string>
}

export function createContext(
    ctx: Context,
    session: Session,
    message: Message,
    history: Message[],
    preset: PresetTemplate,
    model: ChatLunaChatModel,
    embeddings: Embeddings
): PipeContext {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cache = new Map<string, any>()
    const state = {
        result: ''
    }

    return {
        ctx,
        session,
        message,
        history,
        preset,
        model,
        embeddings,
        cache,
        state,

        setResult(result: string) {
            this.state.result = result
        },

        async getOrSet<T>(
            key: string,
            valueFactory: () => Promise<T>
        ): Promise<T> {
            if (!this.cache.has(key)) {
                const value = await valueFactory()
                this.cache.set(key, value)
            }
            return this.cache.get(key) as T
        },

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        log(message: string, ...args: any[]) {
            ctx.logger.info(`[ChatPipe] ${message}`, ...args)
        },

        async streamThrough(
            action: AsyncGenerator<AgentAction>
        ): Promise<string> {
            let result = ''
            for await (const step of action) {
                if (step.type === 'finish') {
                    result += step.action['output'] || ''
                }
            }
            return result
        }
    }
}
