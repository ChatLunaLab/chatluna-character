// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {} from '@initencounter/vits'
import { Context } from 'koishi'

import { Config } from '..'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { createChatPipe } from '../chat/pipe'

export async function apply(ctx: Context, config: Config) {
    ctx.plugin({
        apply: (ctx) => {
            ctx.on('ready', async () => {
                ctx.logger.error('cok')
                const embeddings = await getEmbeddings(ctx)
                const model = await getModel(ctx, config)

                // Create the chat pipe with default middleware
                const chatPipe = createChatPipe(ctx)

                await ctx.chatluna_character_message.addHandler(
                    async (session, message, history) => {
                        // Get the character preset
                        const preset =
                            await ctx.chatluna_character_preset.getDefaultPreset()

                        // Execute the chat pipe with context
                        const result = await chatPipe.execute(
                            session,
                            message,
                            history,
                            preset,
                            model,
                            embeddings
                        )

                        ctx.logger.info('Chat pipe completed', { result })
                    },
                    async (session, message, history) => {
                        const result =
                            history.length % 5 === 0 &&
                            session.isDirect === false &&
                            session.guildId === '391122026'

                        if (result) {
                            ctx.logger.error(1, history)
                            return true
                        }
                    }
                )
            })
        },
        inject: ['chatluna_character_message', 'chatluna_character_preset']
    })
}

function getEmbeddings(ctx: Context) {
    const defaultEmbeddings = ctx.chatluna.config.defaultEmbeddings

    const embeddings = ctx.chatluna.createEmbeddings(
        ...parseRawModelName(defaultEmbeddings)
    )
    return embeddings
}

async function getModel(ctx: Context, config: Config) {
    const [platform, model] = parseRawModelName(config.model || 'gpt-3.5-turbo')
    await ctx.chatluna.awaitLoadPlatform(platform)
    return await ctx.chatluna.createChatModel(platform, model)
}
