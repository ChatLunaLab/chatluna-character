import { HumanMessage } from '@langchain/core/messages'
import { Middleware, createMiddleware } from '../middleware'
import { PipeContext } from '../context'
import { BeforeChatAgent } from '../../before-chat-agent'

export function createBeforeChatMiddleware(options: {
    name?: string
    after?: string[]
    before?: string[]
}): Middleware {
    return createMiddleware(
        {
            name: options.name || 'before-chat',
            after: options.after || [],
            before: options.before || ['chat']
        },
        async (context: PipeContext, next: () => Promise<void>) => {
            // Get necessary tools for this middleware
            const tools = await context.getOrSet('web-tools', async () => {
                return await Promise.all(
                    ['web-search', 'web-browser'].map((name) =>
                        context.ctx.chatluna.platform.getTool(name).createTool({
                            model: context.model,
                            embeddings: context.embeddings
                        })
                    )
                )
            })

            // Create the before-chat agent
            const beforeChatAgent = new BeforeChatAgent({
                tools,
                characterPrompt: context.preset,
                executeModel: context.model
            })

            const think = await context.ctx.chatluna_character_think.getThink(
                context.preset.name,
                'group',
                context.session.guildId
            )

            const topics =
                await context.ctx.chatluna_character_topic.getRecentTopics(
                    context.session.guildId
                )
            // Execute the before-chat agent
            let beforeChatResult = ''
            for await (const action of beforeChatAgent.stream({
                chat_history: [],
                history: JSON.stringify(context.history),
                input: new HumanMessage(context.message.content),
                think: JSON.stringify(think),
                related_topics: JSON.stringify(topics)
            })) {
                if (action.type === 'finish') {
                    beforeChatResult += action.action['output']
                }
            }

            // Store the result in context for next middleware
            context.state.beforeChatResult = beforeChatResult
            context.log('Before chat completed', { result: beforeChatResult })

            // Continue to next middleware
            await next()
        }
    )
}
