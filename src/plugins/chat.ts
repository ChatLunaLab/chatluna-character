// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {} from '@initencounter/vits'
import { Context } from 'koishi'

import { Config } from '..'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { BeforeChatAgent } from '../chat/before-chat-agent'
import { GENERATE_AGENT_PLAN_PROMPT } from '../agent/prompt'
import { HumanMessage } from '@langchain/core/messages'

export async function apply(ctx: Context, config: Config) {
    ctx.plugin({
        apply: (ctx) => {
            ctx.on('ready', async () => {
                ctx.logger.error('cok')
                const embeddings = await getEmbeddings(ctx)
                const model = await getModel(ctx, config)
                await ctx.chatluna_character_message.addHandler(
                    async (session, message, history) => {
                        const webTools = await Promise.all(
                            ['web-search', 'web-browser'].map((name) =>
                                ctx.chatluna.platform.getTool(name).createTool({
                                    model,
                                    embeddings
                                })
                            )
                        )
                        const beforeAgent = new BeforeChatAgent({
                            tools: webTools,
                            characterPrompt:
                                await ctx.chatluna_character_preset.getDefaultPreset(),
                            executeModel: model,
                            planModel: model,
                            planPrompt: GENERATE_AGENT_PLAN_PROMPT
                        })

                        // ctx.logger.error(2, history)

                        let beforeAgentResult = ''

                        for await (const action of beforeAgent.stream({
                            chat_history: [],
                            history: JSON.stringify(history),
                            input: new HumanMessage(message.content),
                            think: JSON.stringify(
                                ctx.chatluna_character_think.getThink(
                                    config.defaultPreset,
                                    'group',
                                    session.guildId
                                )
                            ),
                            related_topics: JSON.stringify(
                                ctx.chatluna_character_topic.getRecentTopics(
                                    session.guildId
                                )
                            )
                        })) {
                            if (action.type === 'finish') {
                                ctx.logger.error(1, 'result', action)
                                beforeAgentResult += action.action['output']
                            }
                        }

                        console.log('beforeAgentResult', beforeAgentResult)

                        ctx.logger.error('beforeAgentResult', beforeAgentResult)
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
