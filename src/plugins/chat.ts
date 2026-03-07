/* eslint-disable generator-star-spacing */
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
import {
    ChatLunaChain,
    GroupTemp,
    Message,
    PresetTemplate,
    StreamedModelResponseChunk
} from '../types'
import {
    createChatLunaChain,
    extractNextReplyReasons,
    extractWakeUpReplies,
    formatCompletionMessages,
    formatMessage,
    formatTimestamp,
    isEmoticonStatement,
    parseResponse,
    setLogger,
    trimCompletionMessages
} from '../utils'
import { Preset } from '../preset'
import {
    clearNextReplyTriggers,
    groupInfos,
    registerNextReplyTrigger,
    registerWakeUpReplyTrigger
} from './filter'

import type {} from 'koishi-plugin-chatluna/services/chat'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import { ComputedRef } from 'koishi-plugin-chatluna'

let logger: Logger

type ParsedResponse = Awaited<ReturnType<typeof parseResponse>>
type StreamedParsedResponseChunk = StreamedModelResponseChunk<ParsedResponse>

interface StreamedResponseContentChunk {
    responseMessage: BaseMessage
    responseContent: string
    isIntermediate: boolean
}

function stripInternalTriggerTags(content: string) {
    return content
        .replace(/<next_reply\b[^>]*\/>/gi, '')
        .replace(/<wake_up_reply\b[^>]*\/>/gi, '')
}

async function parseResponseContent(
    ctx: Context,
    session: Session,
    config: Config,
    chunk: StreamedResponseContentChunk
): Promise<StreamedParsedResponseChunk> {
    let parsedResponse: ParsedResponse
    const { responseMessage, responseContent, isIntermediate } = chunk

    if (
        isIntermediate &&
        (/^Invoking\s+"[^"]+"\s+with\s+/i.test(responseContent.trim()) ||
            responseContent.trim().startsWith('Tool '))
    ) {
        logger.debug(
            'Failed to parse intermediate agent content, fallback to raw send: %s',
            responseContent
        )

        return {
            responseMessage,
            responseContent,
            parsedResponse: {
                elements: [],
                rawMessage: responseContent,
                status: undefined,
                sticker: undefined,
                messageType: 'text'
            }
        }
    }

    try {
        parsedResponse = await parseResponse(
            stripInternalTriggerTags(responseContent),
            config.isAt,
            async (element) => {
                logger.debug('voice render element: ' + JSON.stringify(element))
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
                                            speaker_id: Number.parseInt(id, 10),
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
    } catch (error) {
        if (!isIntermediate || responseMessage.content == null) {
            throw error
        }

        logger.debug(
            'Failed to parse intermediate agent content, fallback to raw send: %s',
            responseContent
        )

        parsedResponse = {
            elements: [],
            rawMessage: responseContent,
            status: undefined,
            sticker: undefined,
            messageType: 'text'
        }
    }

    return {
        responseMessage,
        responseContent,
        parsedResponse
    }
}

function createStreamConfig(
    session: Session,
    model: ChatLunaChatModel,
    presetName: string,
    signal?: AbortSignal
) {
    return {
        configurable: {
            session,
            model,
            userId: session.userId,
            conversationId: session.isDirect ? session.userId : session.guildId,
            preset: presetName
        },
        signal
    }
}

// eslint-disable-next-line prettier/prettier
async function* streamAgentResponseContents(
    chain: ChatLunaChain,
    session: Session,
    model: ChatLunaChatModel,
    presetName: string,
    systemMessage: BaseMessage | undefined,
    historyMessages: BaseMessage[],
    lastMessage: BaseMessage,
    signal?: AbortSignal
): AsyncGenerator<StreamedResponseContentChunk> {
    const responseStream = chain.stream(
        {
            instructions: getMessageContent(systemMessage?.content ?? ''),
            chat_history: historyMessages,
            input: lastMessage,
            configurable: {
                session,
                conversationId: session.isDirect
                    ? session.userId
                    : session.guildId,
                preset: presetName
            }
        },
        createStreamConfig(session, model, presetName, signal)
    )

    for await (const responseChunk of responseStream) {
        const responseMessage = responseChunk.message
        const responseContent = getMessageContent(responseMessage.content)
        if (responseContent.trim().length < 1) {
            continue
        }

        const isIntermediate = responseChunk.phase === 'intermediate'

        if (isIntermediate) {
            logger.debug(`agent intermediate response: ${responseContent}`)
        } else {
            logger.debug(`model response: ${responseContent}`)
        }

        yield {
            responseMessage,
            responseContent,
            isIntermediate
        }
    }
}

function registerResponseTriggers(
    key: string,
    config: Config,
    nextReplyReasons: string[],
    wakeUpReplies: ReturnType<typeof extractWakeUpReplies>
) {
    if (nextReplyReasons.length > 0) {
        clearNextReplyTriggers(key)
        for (const reason of nextReplyReasons) {
            const accepted = registerNextReplyTrigger(key, reason, config)

            if (!accepted) {
                logger.warn(
                    `Ignore invalid <next_reply reason="${reason}" /> for session ${key}`
                )
            }
        }
    }

    for (const wakeUp of wakeUpReplies) {
        const accepted = registerWakeUpReplyTrigger(
            key,
            wakeUp.time,
            wakeUp.reason,
            config
        )

        if (!accepted) {
            logger.warn(
                `Ignore invalid <wake_up_reply time="${wakeUp.time}" ` +
                    `reason="${wakeUp.reason}" /> for session ${key}`
            )
        }
    }
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
            const key = `group:${override.groupId}`
            modelPool[key] = (async () => {
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

                modelPool[key] = Promise.resolve(loadedModel)
                return loadedModel
            })()
        }
    }

    if (config.privateModelOverride?.length > 0) {
        for (const override of config.privateModelOverride) {
            const key = `private:${override.userId}`
            modelPool[key] = (async () => {
                const [platform, modelName] = parseRawModelName(override.model)
                const loadedModel = await initializeModel(
                    ctx,
                    platform,
                    modelName
                )

                logger.info(
                    'override model loaded %c for private %c',
                    override.model,
                    override.userId
                )

                modelPool[key] = Promise.resolve(loadedModel)
                return loadedModel
            })()
        }
    }

    return { globalModel, modelPool }
}

async function getConfigAndPresetForGuild(
    guildId: string,
    isDirect: boolean,
    config: Config,
    globalPreset: PresetTemplate,
    presetPool: Record<string, PresetTemplate>,
    key: string,
    preset: Preset
): Promise<{ copyOfConfig: Config; currentPreset: PresetTemplate }> {
    const currentGuildConfig = isDirect
        ? config.privateConfigs[guildId]
        : config.configs[guildId]
    let copyOfConfig = { ...config }
    let currentPreset = globalPreset

    if (currentGuildConfig) {
        copyOfConfig = Object.assign({}, copyOfConfig, currentGuildConfig)
        currentPreset =
            presetPool[key] ??
            (await (async () => {
                const template = preset.getPresetForCache(
                    currentGuildConfig.preset
                )
                presetPool[key] = template
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
    focusMessage?: Message,
    triggerReason?: string
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

    if (focusMessage?.quote) {
        logger.debug('formatted_last_message: ' + lastMessage)
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
                trigger_reason: (triggerReason ?? 'Normal message trigger')
                    .replaceAll('{', '{{')
                    .replaceAll('}', '}}'),
                prompt: session.content,
                built: {
                    preset: currentPreset.name,
                    conversationId: session.isDirect
                        ? session.userId
                        : session.guildId
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

// eslint-disable-next-line prettier/prettier
async function* streamModelResponse(
    ctx: Context,
    session: Session,
    model: ChatLunaChatModel,
    completionMessages: BaseMessage[],
    config: Config,
    presetName: string,
    chain?: ChatLunaChain,
    signal?: AbortSignal
): AsyncGenerator<StreamedParsedResponseChunk> {
    for (let retryCount = 0; retryCount < 2; retryCount++) {
        if (signal?.aborted) return
        let emittedAny = false

        try {
            const lastMessage =
                completionMessages[completionMessages.length - 1]
            const historyMessages = completionMessages.slice(0, -1)

            const systemMessage =
                chain != null ? historyMessages.shift() : undefined

            if (chain) {
                for await (const responseChunk of streamAgentResponseContents(
                    chain,
                    session,
                    model,
                    presetName,
                    systemMessage,
                    historyMessages,
                    lastMessage,
                    signal
                )) {
                    emittedAny = true

                    yield await parseResponseContent(
                        ctx,
                        session,
                        config,
                        responseChunk
                    )
                }

                return
            }

            const responseMessage = await model.invoke(
                completionMessages,
                createStreamConfig(session, model, presetName, signal)
            )
            const responseContent = getMessageContent(responseMessage.content)
            if (responseContent.trim().length < 1) {
                return
            }

            logger.debug(`model response: ${responseContent}`)
            emittedAny = true

            yield await parseResponseContent(ctx, session, config, {
                responseMessage,
                responseContent,
                isIntermediate: false
            })
            return
        } catch (e) {
            if (signal?.aborted) return
            logger.error('model requests failed', e)
            if (emittedAny || retryCount === 1) return
            await sleep(3000)
        }
    }
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
): Promise<{ breakSay: boolean; sent: boolean }> {
    try {
        await session.send(
            await ctx.vits.say(Object.assign({ input: text }, { session }))
        )
        return { breakSay: true, sent: true }
    } catch (e) {
        logger.error(e)
        try {
            await session.send(elements)
            return { breakSay: false, sent: true }
        } catch (fallbackError) {
            logger.error(fallbackError)
            return { breakSay: false, sent: false }
        }
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
): Promise<{ breakSay: boolean; sent: boolean }> {
    const isVoice = parsedResponse.messageType === 'voice'
    if (isVoice && emoticonStatement !== 'text') {
        return { breakSay: false, sent: false }
    }

    const random = new Random()

    if (config.splitVoice !== true && isVoice && !breakSay) {
        const fullMaxTime =
            parsedResponse.rawMessage.length * config.typingTime + 100
        await sleep(random.int(fullMaxTime / 4, fullMaxTime / 2))
        return await handleVoiceMessage(
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

    let sent = false
    try {
        switch (parsedResponse.messageType) {
            case 'text':
                await session.send(elements)
                sent = true
                break
            case 'voice':
                await session.send(
                    await ctx.vits.say(
                        Object.assign({ input: text }, { session })
                    )
                )
                sent = true
                break
            default:
                await session.send(elements)
                sent = true
                break
        }
    } catch (e) {
        logger.error(e)
        try {
            await session.send(elements)
            sent = true
        } catch (fallbackError) {
            logger.error(fallbackError)
        }
    }

    return { breakSay: false, sent }
}

async function handleParsedResponseChunk(
    session: Session,
    config: Config,
    ctx: Context,
    parsedResponse: ParsedResponse
): Promise<{ breakSay: boolean; sentAny: boolean }> {
    let breakSay = false
    let sentAny = false

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

        const result = await handleMessageSending(
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
        breakSay = result.breakSay
        sentAny = sentAny || result.sent

        if (breakSay) {
            break
        }
    }

    return { breakSay, sentAny }
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

    service.collect(async (session, messages, triggerReason, signal) => {
        const guildId = session.isDirect ? session.userId : session.guildId
        const key = `${session.isDirect ? 'private' : 'group'}:${guildId}`

        try {
            const model = await (modelPool[key] ?? Promise.resolve(globalModel))

            const { copyOfConfig, currentPreset } =
                await getConfigAndPresetForGuild(
                    guildId,
                    session.isDirect,
                    config,
                    globalPreset,
                    presetPool,
                    key,
                    preset
                )

            if (model.value == null) {
                logger.warn(
                    `Model ${copyOfConfig.model} load not successful. ` +
                        'Please check your logs output.'
                )
                return
            }

            if (copyOfConfig.toolCalling) {
                chainPool[key] =
                    chainPool[key] ??
                    (await createChatLunaChain(ctx, model, session))
            }

            const latestMessages = service.getMessages(key) ?? messages
            const count = latestMessages.length
            const temp = await service.getTemp(session, latestMessages)
            const focusMessage = latestMessages[latestMessages.length - 1]

            const completionMessages = await prepareMessages(
                latestMessages,
                copyOfConfig,
                session,
                model.value,
                currentPreset,
                temp,
                chainPool[key]?.value,
                focusMessage,
                triggerReason
            )

            if (!chainPool[key]) {
                logger.debug(
                    'completion message: ' +
                        JSON.stringify(
                            completionMessages.map((it) => it.content)
                        )
                )
            }

            let lastResponseMessage: BaseMessage | undefined
            const nextReplyReasons: string[] = []
            const wakeUpReplies: ReturnType<typeof extractWakeUpReplies> = []
            let latestStatus = temp.status
            let sentAny = false

            for await (const chunk of streamModelResponse(
                ctx,
                session,
                model.value,
                completionMessages,
                copyOfConfig,
                currentPreset.name,
                chainPool[key]?.value,
                signal
            )) {
                latestStatus = chunk.parsedResponse.status ?? latestStatus

                const sendResult = await handleParsedResponseChunk(
                    session,
                    copyOfConfig,
                    ctx,
                    chunk.parsedResponse
                )

                if (!sendResult.sentAny) {
                    continue
                }

                sentAny = true
                lastResponseMessage = chunk.responseMessage
                await ctx.chatluna_character.broadcastOnBot(
                    session,
                    chunk.parsedResponse.elements.flat()
                )
                nextReplyReasons.push(
                    ...extractNextReplyReasons(chunk.responseContent)
                )
                wakeUpReplies.push(
                    ...extractWakeUpReplies(chunk.responseContent)
                )

                if (sendResult.breakSay) {
                    break
                }
            }

            if (!sentAny) {
                service.mute(session, copyOfConfig.muteTime)
                return
            }

            const persistedMessages =
                service.getMessages(key) ?? latestMessages
            if (persistedMessages.length > count) {
                temp.status = latestStatus
                await service.persistStatus(
                    session,
                    latestStatus,
                    persistedMessages[persistedMessages.length - 1]
                )
            }

            temp.completionMessages.push(
                completionMessages[completionMessages.length - 1]
            )
            if (lastResponseMessage) {
                temp.completionMessages.push(lastResponseMessage)
            }

            trimCompletionMessages(
                temp.completionMessages,
                copyOfConfig.modelCompletionCount
            )

            registerResponseTriggers(
                key,
                copyOfConfig,
                nextReplyReasons,
                wakeUpReplies
            )
            await service.persistWakeUpReplies(
                session,
                groupInfos[key]?.pendingWakeUpReplies ?? []
            )

            service.muteAtLeast(session, copyOfConfig.coolDownTime * 1000)
        } catch (e) {
            logger.error(e)
        } finally {
            await service.releaseResponseLock(session)
        }
    })
}
