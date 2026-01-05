// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {} from '@initencounter/vits'
import {
    BaseMessage,
    HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import { Context, h, Logger, Random, Session, sleep } from 'koishi'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { Config } from '..'
import { ChatLunaChain, GroupTemp, Message, PresetTemplate } from '../types'
import {
    createChatLunaChain,
    formatCompletionMessages,
    formatMessage,
    formatTimestamp,
    isEmoticonStatement,
    parseResponse,
    setLogger,
    trimCompletionMessages
} from '../utils'
import { Preset } from '../preset'

import type {} from 'koishi-plugin-chatluna/services/chat'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import { ComputedRef } from 'koishi-plugin-chatluna'

let logger: Logger

interface ModelResponse {
    responseMessage: BaseMessage
    parsedResponse: Awaited<ReturnType<typeof parseResponse>>
}

async function initializeModel(
    ctx: Context,
    platform: string,
    modelName: string
) {
    return await ctx.chatluna.createChatModel(platform, modelName)
}

async function setupModelPool(
    ctx: Context,
    config: Config
): Promise<{
    globalModel: ComputedRef<ChatLunaChatModel>
    modelPool: Record<string, Promise<ComputedRef<ChatLunaChatModel>>>
}> {
    const [platform, modelName] = parseRawModelName(config.model)
    const globalModel = await initializeModel(ctx, platform, modelName)
    logger.info('global model loaded %c', config.model)

    const modelPool: Record<
        string,
        Promise<ComputedRef<ChatLunaChatModel>>
    > = {}

    if (config.modelOverride?.length > 0) {
        for (const override of config.modelOverride) {
            modelPool[override.groupId] = (async () => {
                const [platform, modelName] = parseRawModelName(override.model)
                const loadedModel = await initializeModel(
                    ctx,
                    platform,
                    modelName
                )

                logger.info(
                    'override model loaded %c for group %c',
                    override.model,
                    override.groupId
                )

                modelPool[override.groupId] = Promise.resolve(loadedModel)
                return loadedModel
            })()
        }
    }

    return { globalModel, modelPool }
}

async function getModelForGuild(
    guildId: string,
    globalModel: ComputedRef<ChatLunaChatModel>,
    modelPool: Record<string, Promise<ComputedRef<ChatLunaChatModel>>>
): Promise<ComputedRef<ChatLunaChatModel>> {
    return await (modelPool[guildId] ?? Promise.resolve(globalModel))
}

async function getConfigAndPresetForGuild(
    guildId: string,
    config: Config,
    globalPreset: PresetTemplate,
    presetPool: Record<string, PresetTemplate>,
    preset: Preset
): Promise<{ copyOfConfig: Config; currentPreset: PresetTemplate }> {
    const currentGuildConfig = config.configs[guildId]
    let copyOfConfig = { ...config }
    let currentPreset = globalPreset

    if (currentGuildConfig) {
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

        logger.debug(
            `override config: ${JSON.stringify(copyOfConfig)} for guild ${guildId}`
        )
    }

    return { copyOfConfig, currentPreset }
}

async function prepareMessages(
    messages: Message[],
    config: Config,
    session: Session,
    model: ChatLunaChatModel,
    currentPreset: PresetTemplate,
    temp: GroupTemp,
    chain?: ChatLunaChain,
    focusMessage?: Message
): Promise<BaseMessage[]> {
    const [recentMessage, lastMessage] = await formatMessage(
        messages,
        config,
        model,
        currentPreset.system.rawString,
        currentPreset.input.rawString,
        focusMessage
    )

    const formattedSystemPrompt = await currentPreset.system.format(
        {
            time: '',
            stickers: '',
            status: ''
        },
        session.app.chatluna.promptRenderer,
        {
            session
        }
    )

    if (!chain) {
        logger.debug('messages_new: ' + JSON.stringify(recentMessage))
        logger.debug('messages_last: ' + JSON.stringify(lastMessage))
    }

    const humanMessage = new HumanMessage(
        await currentPreset.input.format(
            {
                history_new: recentMessage
                    .join('\n\n')
                    .replaceAll('{', '{{')
                    .replaceAll('}', '}}'),
                history_last: lastMessage
                    .replaceAll('{', '{{')
                    .replaceAll('}', '}}'),
                time: formatTimestamp(new Date()),
                stickers: '', // JSON.stringify(stickerService.getAllStickTypes()),
                status: temp.status ?? currentPreset.status ?? '',
                prompt: session.content,
                built: {
                    preset: currentPreset.name,
                    conversationId: session.guildId
                }
            },
            session.app.chatluna.promptRenderer,
            {
                session
            }
        )
    )

    const tempMessages: BaseMessage[] = []

    if (config.image) {
        for (const message of messages) {
            if (message.images && message.images.length > 0) {
                /*    for (const image of message.images) {
                    const imageMessage = new HumanMessage(
                        `[image:${image.hash}]`
                    )
                    imageMessage.additional_kwargs = {
                        images: [image.url]
                    }

                } */

                const imageMessage = new HumanMessage({
                    content: message.images.flatMap((image) => [
                        { type: 'text', text: image.formatted },
                        { type: 'image_url', image_url: image.url }
                    ])
                })

                tempMessages.push(imageMessage)
            }
        }
    }

    return formatCompletionMessages(
        [new SystemMessage(formattedSystemPrompt)].concat(
            temp.completionMessages
        ),
        tempMessages,
        humanMessage,
        config,
        model
    )
}

async function getModelResponse(
    ctx: Context,
    session: Session,
    model: ChatLunaChatModel,
    completionMessages: BaseMessage[],
    config: Config,
    chain?: ChatLunaChain
): Promise<ModelResponse | null> {
    for (let retryCount = 0; retryCount < 2; retryCount++) {
        try {
            const lastMessage =
                completionMessages[completionMessages.length - 1]
            const historyMessages = completionMessages.slice(0, -1)

            const systemMessage =
                chain != null ? historyMessages.shift() : undefined

            const responseMessage = chain
                ? await chain.invoke(
                      {
                          instructions: getMessageContent(
                              systemMessage.content
                          ),
                          chat_history: historyMessages,
                          input: lastMessage
                      },
                      {
                          configurable: {
                              session,
                              model,
                              userId: session.userId,
                              conversationId: session.guildId
                          }
                      }
                  )
                : await model.invoke(completionMessages)

            logger.debug('model response: ' + responseMessage.content)

            const parsedResponse = await parseResponse(
                responseMessage.content as string,
                config.isAt,
                async (element) => {
                    logger.debug(
                        'voice render element: ' + JSON.stringify(element)
                    )
                    try {
                        const content = element.attrs['content']
                        const extra = element.attrs['extra']
                        if (extra) {
                            const { id } = extra
                            if (id) {
                                return [
                                    await ctx.vits.say(
                                        Object.assign(
                                            {
                                                speaker_id: parseInt(id),
                                                input: content
                                            },
                                            { session }
                                        )
                                    )
                                ]
                            }
                        }
                        return [
                            await ctx.vits.say(
                                Object.assign({ input: content }, { session })
                            )
                        ]
                    } catch (e) {
                        logger.error('voice render failed', e)
                        return [element]
                    }
                },
                config
            )
            return { responseMessage, parsedResponse }
        } catch (e) {
            logger.error('model requests failed', e)
            if (retryCount === 1) return null
            await sleep(3000)
        }
    }
    return null
}

function calculateMessageDelay(
    text: string,
    elements: h[],
    typingTime: number
): number {
    let maxTime = text.length * typingTime + 100
    if (elements.length === 1 && elements[0].attrs['code'] === true) {
        maxTime *= 0.1
    }
    return maxTime
}

async function handleVoiceMessage(
    session: Session,
    ctx: Context,
    text: string,
    elements: h[]
): Promise<boolean> {
    try {
        await session.send(
            await ctx.vits.say(Object.assign({ input: text }, { session }))
        )
        return true
    } catch (e) {
        logger.error(e)
        await session.send(elements)
        return false
    }
}

async function handleMessageSending(
    session: Session,
    elements: h[],
    text: string,
    parsedResponse: Awaited<ReturnType<typeof parseResponse>>,
    config: Config,
    ctx: Context,
    maxTime: number,
    emoticonStatement: string,
    breakSay: boolean
): Promise<boolean> {
    const isVoice = parsedResponse.messageType === 'voice'
    if (isVoice && emoticonStatement !== 'text') {
        return false
    }

    const random = new Random()

    if (config.splitVoice !== true && isVoice && !breakSay) {
        const fullMaxTime =
            parsedResponse.rawMessage.length * config.typingTime + 100
        await sleep(random.int(fullMaxTime / 4, fullMaxTime / 2))
        return handleVoiceMessage(
            session,
            ctx,
            parsedResponse.rawMessage,
            elements
        )
    }

    if (emoticonStatement !== 'span') {
        await sleep(random.int(maxTime / 2, maxTime))
    } else {
        await sleep(random.int(maxTime / 12, maxTime / 4))
    }

    try {
        switch (parsedResponse.messageType) {
            case 'text':
                await session.send(elements)
                break
            case 'voice':
                await session.send(
                    await ctx.vits.say(
                        Object.assign({ input: text }, { session })
                    )
                )
                break
            default:
                await session.send(elements)
                break
        }
    } catch (e) {
        logger.error(e)
        await session.send(elements)
    }

    return false
}

async function handleModelResponse(
    session: Session,
    config: Config,
    ctx: Context,
    parsedResponse: Awaited<ReturnType<typeof parseResponse>>
): Promise<void> {
    let breakSay = false

    for (const elements of parsedResponse.elements) {
        const text = elements
            .map((element) => element.attrs.content ?? '')
            .join('')

        const emoticonStatement = isEmoticonStatement(text, elements)

        if (elements.length < 1) continue

        const maxTime =
            text.length > config.largeTextSize
                ? config.largeTextTypingTime
                : calculateMessageDelay(text, elements, config.typingTime)

        breakSay = await handleMessageSending(
            session,
            elements,
            text,
            parsedResponse,
            config,
            ctx,
            maxTime,
            emoticonStatement,
            breakSay
        )

        if (breakSay) {
            break
        }
    }

    await ctx.chatluna_character.broadcastOnBot(
        session,
        parsedResponse.elements.flat()
    )
}

export async function apply(ctx: Context, config: Config) {
    const service = ctx.chatluna_character
    const preset = service.preset
    logger = service.logger

    setLogger(logger)

    const { globalModel, modelPool } = await setupModelPool(ctx, config)

    let globalPreset = preset.getPresetForCache(config.defaultPreset)
    let presetPool: Record<string, PresetTemplate> = {}

    const chainPool: Record<string, ComputedRef<ChatLunaChain>> = {}

    ctx.on('chatluna_character/preset_updated', () => {
        globalPreset = preset.getPresetForCache(config.defaultPreset)
        presetPool = {}
    })

    service.collect(async (session, messages) => {
        const guildId = session.event.guild?.id ?? session.guildId

        try {
            const model = await getModelForGuild(
                guildId,
                globalModel,
                modelPool
            )

            const { copyOfConfig, currentPreset } =
                await getConfigAndPresetForGuild(
                    guildId,
                    config,
                    globalPreset,
                    presetPool,
                    preset
                )

            if (model.value == null) {
                logger.warn(
                    `Model ${copyOfConfig.model} load not successful. Please check your logs output.`
                )
                return
            }

            if (copyOfConfig.toolCalling) {
                chainPool[guildId] =
                    chainPool[guildId] ??
                    (await createChatLunaChain(ctx, model, session))
            }

            const temp = await service.getTemp(session)
            const latestMessages = service.getMessages(guildId) ?? messages
            const focusMessage = latestMessages[latestMessages.length - 1]

            const completionMessages = await prepareMessages(
                latestMessages,
                copyOfConfig,
                session,
                model.value,
                currentPreset,
                temp,
                chainPool[guildId]?.value,
                focusMessage
            )

            if (!chainPool[guildId]) {
                logger.debug(
                    'completion message: ' +
                        JSON.stringify(
                            completionMessages.map((it) => it.content)
                        )
                )
            }

            const response = await getModelResponse(
                ctx,
                session,
                model.value,
                completionMessages,
                copyOfConfig,
                chainPool[guildId]?.value
            )

            if (!response) return

            const { responseMessage, parsedResponse } = response

            temp.status = parsedResponse.status
            if (parsedResponse.elements.length < 1) {
                service.mute(session, copyOfConfig.muteTime)
                return
            }

            temp.completionMessages.push(
                completionMessages[completionMessages.length - 1]
            )
            temp.completionMessages.push(responseMessage)

            trimCompletionMessages(
                temp.completionMessages,
                copyOfConfig.modelCompletionCount
            )

            await handleModelResponse(
                session,
                copyOfConfig,
                ctx,
                parsedResponse
            )

            service.muteAtLeast(session, copyOfConfig.coolDownTime * 1000)
        } catch (e) {
            logger.error(e)
        } finally {
            service.releaseResponseLock(session)
        }
    })
}
