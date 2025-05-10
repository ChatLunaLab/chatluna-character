import { createMiddleware, Middleware } from '../middleware'
import { PipeContext } from '../context'

import { ChatAgent } from '../../chat-agent'

export function createChatMiddleware(options: {
    name?: string
    after?: string[]
    before?: string[]
}): Middleware {
    return createMiddleware(
        {
            name: options.name || 'chat',
            after: options.after || ['before-chat'],
            before: options.before || ['after-chat']
        },
        async (context: PipeContext, next: () => Promise<void>) => {
            // Create the chat agent
            const chatAgent = new ChatAgent({
                tools: [],
                characterPrompt: context.preset,
                executeModel: context.model
            })

            // Execute the chat agent
            let chatResult = ''
            for await (const action of chatAgent.stream({
                chat_history: [],
                history: JSON.stringify(context.history),
                input: '',
                think: JSON.stringify(
                    await context.ctx.chatluna_character_think.getThink(
                        context.preset.name,
                        'global'
                    )
                ),
                think_before: JSON.stringify(
                    context.state.beforeChatResult || ''
                ),
                think_group: JSON.stringify(
                    await context.ctx.chatluna_character_think.getThink(
                        context.preset.name,
                        'group',
                        context.session.guildId
                    )
                ),
                history_last: JSON.stringify(context.message.content),
                related_topics: JSON.stringify(
                    await context.ctx.chatluna_character_topic.getRecentTopics(
                        context.session.guildId
                    )
                )
            })) {
                if (action.type === 'finish') {
                    chatResult += action.action['output']
                }
            }

            // Store the result in context for next middleware
            context.state.chatResult = chatResult
            context.log('Chat completed', { result: chatResult })

            // Continue to next middleware
            await next()
        }
    )
}
