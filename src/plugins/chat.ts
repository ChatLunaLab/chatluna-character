// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {} from '@initencounter/vits'
import {
    BaseMessage,
    HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import { Context, Logger, Random, sleep } from 'koishi'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { Config } from '..'
import { PresetTemplate } from '../types'
import {
    formatCompletionMessages,
    formatMessage,
    isEmoticonStatement,
    parseResponse,
    setLogger
} from '../utils'

export async function apply(ctx: Context, config: Config) {
    const service = ctx.chatluna_character

    const preset = service.preset
    const stickerService = service.stickerService
    logger = service.logger

    setLogger(logger)

    const modelPool: Record<string, Promise<ChatLunaChatModel>> = {}

    const [platform, modelName] = parseRawModelName(config.model)

    await ctx.chatluna.awaitLoadPlatform(platform)

    const globalModel = (await ctx.chatluna.createChatModel(
        platform,
        modelName
    )) as ChatLunaChatModel

    logger.info('global model loaded %c', config.model)

    if (config.modelOverride?.length > 0) {
        for (const override of config.modelOverride) {
            modelPool[override.groupId] = (async () => {
                const [platform, modelName] = parseRawModelName(override.model)

                await ctx.chatluna.awaitLoadPlatform(platform)

                const loadedModel = (await ctx.chatluna.createChatModel(
                    platform,
                    modelName
                )) as ChatLunaChatModel

                logger.info(
                    'override model loaded %c for group %c',
                    override.model,
                    override.groupId
                )

                // set model pool to resolved model
                modelPool[override.groupId] = Promise.resolve(loadedModel)

                return loadedModel
            })()
        }
    }

    let globalPreset = preset.getPresetForCache(config.defaultPreset)

    let presetPool: Record<string, PresetTemplate> = {}

    ctx.on('chatluna_character/preset_updated', () => {
        // updated
        globalPreset = preset.getPresetForCache(config.defaultPreset)

        presetPool = {}
    })

    service.collect(async (session, messages) => {
        const guildId = session.event.guild?.id ?? session.guildId

        const model = await (modelPool[guildId] ?? Promise.resolve(globalModel))

        const currentGuildConfig = config.configs[guildId]
        let copyOfConfig = Object.assign({}, config)

        let currentPreset = globalPreset

        if (currentGuildConfig != null) {
            copyOfConfig = Object.assign({}, copyOfConfig, currentGuildConfig)
            currentPreset =
                presetPool[guildId] ??
                (await (async () => {
                    const template = preset.getPresetForCache(
                        currentGuildConfig.preset
                    )
                    presetPool[guildId] = template
                    return template
                })())
        }

        const [recentMessage, lastMessage] = await formatMessage(
            messages,
            copyOfConfig,
            model,
            currentPreset.system.template as string,
            currentPreset.system.template as string
        )

        const temp = await service.getTemp(session)

        const formattedSystemPrompt = await currentPreset.system.format({
            time: new Date().toLocaleString(),
            status: temp.status ?? currentPreset.status ?? '',
            stickers: JSON.stringify(stickerService.getAllStickTypes())
        })

        logger.debug('messages_new: ' + JSON.stringify(recentMessage))

        logger.debug('messages_last: ' + JSON.stringify(lastMessage))

        const humanMessage = new HumanMessage(
            await currentPreset.input.format({
                history_new: recentMessage,
                history_last: lastMessage,
                time: new Date().toLocaleString(),
                stickers: JSON.stringify(stickerService.getAllStickTypes()),
                status: temp.status ?? currentPreset.status ?? ''
            })
        )

        const completionMessages: BaseMessage[] =
            await formatCompletionMessages(
                [new SystemMessage(formattedSystemPrompt)].concat(
                    temp.completionMessages
                ),
                humanMessage,
                copyOfConfig,
                model
            )

        logger.debug(
            'completion message: ' +
                JSON.stringify(completionMessages.map((it) => it.content))
        )

        let responseMessage: BaseMessage

        let parsedResponse: ReturnType<typeof parseResponse>

        let retryCount = 0
        while (retryCount < 3) {
            retryCount++

            try {
                responseMessage = await model.invoke(completionMessages)
            } catch (e) {
                logger.error('model requests failed', e)
                retryCount = 3
                break
            }

            try {
                logger.debug('model response: ' + responseMessage.content)

                parsedResponse = parseResponse(
                    responseMessage.content as string,
                    copyOfConfig.isAt
                )

                break
            } catch (e) {
                await sleep(3000)
            }
        }

        if (retryCount >= 3) {
            return
        }

        temp.status = parsedResponse.status

        if (parsedResponse.elements.length < 1) {
            service.mute(session, copyOfConfig.muteTime)
            return
        }

        temp.completionMessages.push(humanMessage, responseMessage)

        if (temp.completionMessages.length > 5) {
            temp.completionMessages.length = 0
        }

        const random = new Random()

        for (const elements of parsedResponse.elements) {
            const text = elements
                .map((element) => element.attrs.content ?? '')
                .join('')

            const emoticonStatement = isEmoticonStatement(text, elements)

            if (elements.length < 1) {
                continue
            }

            let maxTime = text.length * copyOfConfig.typingTime + 100

            if (elements.length === 1 && elements[0].attrs['code'] === true) {
                // 代码块快速发送
                maxTime = 10
            }

            if (
                parsedResponse.messageType === 'voice' &&
                emoticonStatement !== 'text'
            ) {
                continue
            }

            if (
                config.splitVoice !== true &&
                parsedResponse.messageType === 'voice'
            ) {
                maxTime =
                    parsedResponse.rawMessage.length * copyOfConfig.typingTime +
                    100
                await sleep(random.int(maxTime / 4, maxTime / 2))
                try {
                    await session.send(
                        await ctx.vits.say({ input: parsedResponse.rawMessage })
                    )
                } catch (e) {
                    logger.error(e)
                    // fallback to text
                    await session.send(elements)
                }
                continue
            }

            try {
                if (emoticonStatement !== 'emo') {
                    await sleep(random.int(maxTime / 2, maxTime))
                } else {
                    await sleep(random.int(maxTime / 8, maxTime / 2))
                }

                switch (parsedResponse.messageType) {
                    case 'text':
                        await session.send(elements)
                        break
                    case 'voice':
                        await session.send(
                            await ctx.vits.say({
                                input: text
                            })
                        )
                        break
                    default:
                        await session.send(elements)
                        break
                }
            } catch (e) {
                logger.error(e)
                // fallback to text
                await session.send(elements)
            }
        }

        const randomNumber = Math.random()

        if (randomNumber < config.sendStickerProbability) {
            const sticker = await stickerService.randomStickByType(
                parsedResponse.sticker
            )
            await sleep(random.int(500, 2000))
            await session.send(sticker)
        }

        service.mute(session, copyOfConfig.coolDownTime * 1000)

        await service.broadcastOnBot(session, parsedResponse.elements.flat())
    })
}

let logger: Logger
