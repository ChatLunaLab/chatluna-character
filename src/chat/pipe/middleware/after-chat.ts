import { createMiddleware, Middleware } from '../middleware'
import { PipeContext } from '../context'
import { AfterChatAgent } from '../../after-chat-agent'

export function createAfterChatMiddleware(options: {
    name?: string
    after?: string[]
    before?: string[]
}): Middleware {
    return createMiddleware(
        {
            name: options.name || 'after-chat',
            after: options.after || ['chat'],
            before: options.before || []
        },
        async (context: PipeContext, next: () => Promise<void>) => {
            // Get post-processing tools if needed
            const tools = await context.getOrSet(
                'post-process-tools',
                async () => {
                    return await Promise.all(
                        ['memory-store', 'status-update']
                            .map((name) => {
                                const tool =
                                    context.ctx.chatluna.platform.getTool(name)
                                return tool
                                    ? tool.createTool({
                                          model: context.model,
                                          embeddings: context.embeddings
                                      })
                                    : null
                            })
                            .filter(Boolean)
                    )
                }
            )

            // Create the after-chat agent
            const afterChatAgent = new AfterChatAgent({
                tools,
                characterPrompt: context.preset,
                executeModel: context.model
            })

            // Execute the after-chat agent
            let afterChatResult = ''
            for await (const action of afterChatAgent.stream({
                chat_history: [],
                history: JSON.stringify(context.history),
                input: context.message.content,
                response: context.state.chatResult || '',
                think: JSON.stringify(
                    await context.ctx.chatluna_character_think.getThink(
                        context.preset.name,
                        'global'
                    )
                ),
                think_group: JSON.stringify(
                    await context.ctx.chatluna_character_think.getThink(
                        context.preset.name,
                        'group',
                        context.session.guildId
                    )
                )
            })) {
                if (action.type === 'finish') {
                    afterChatResult += action.action['output']
                }
            }

            // Set the final result to chat result (or after-chat result if needed)
            context.setResult(afterChatResult)
            context.state.afterChatResult = afterChatResult
            context.log('After chat completed', { result: afterChatResult })

            // Continue to next middleware if any
            await next()
        }
    )
}
