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
    getElementText,
    isEmoticonStatement,
    parseResponse,
    sendElements,
    setLogger,
    trimCompletionMessages,
    voiceRender
} from '../utils/index'
import { Preset } from '../preset'

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
            ctx,
            session,
            stripInternalTriggerTags(responseContent),
            session.isDirect ? false : (config.isAt ?? false),
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
    const conversationId = `${session.platform}:${
        session.isDirect ? 'private' : 'guild'
    }:${session.isDirect ? session.userId : (session.guildId ?? session.channelId)}`

    return {
        configurable: {
            session,
            model,
            userId: session.userId,
            conversationId,
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
    const conversationId = `${session.platform}:${
        session.isDirect ? 'private' : 'guild'
    }:${session.isDirect ? session.userId : (session.guildId ?? session.channelId)}`

    const responseStream = chain.stream(
        {
            instructions: getMessageContent(systemMessage?.content ?? ''),
            chat_history: historyMessages,
            input: lastMessage,
            configurable: {
                session,
                conversationId,
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
            logger.debug(`agent intermediate response:\n${responseContent}`)
        } else {
            logger.debug(`model response:\n${responseContent}`)
        }

        yield {
            responseMessage,
            responseContent,
            isIntermediate
        }
    }
}

async function registerResponseTriggers(
    ctx: Context,
    session: Session,
    key: string,
    config: Config,
    nextReplyReasons: string[],
    wakeUpReplies: ReturnType<typeof extractWakeUpReplies>
) {
    const store = ctx.chatluna_character_trigger

    if (nextReplyReasons.length > 0) {
        store.clearNextReplies(key)
        for (const reason of nextReplyReasons) {
            const accepted = store.registerNextReply(key, reason, config)

            if (!accepted) {
                logger.warn(
                    `Ignore invalid <next_reply reason="${reason}" /> for session ${key}`
                )
            }
        }
    }

    for (const wakeUp of wakeUpReplies) {
        const accepted = await store.registerWakeUpReply(
            session,
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

    if (wakeUpReplies.length > 0) {
        await store.setWakeUpReplies(session, store.getWakeUpReplies(key))
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
    globalPrivateModel: ComputedRef<ChatLunaChatModel>
    globalGroupModel: ComputedRef<ChatLunaChatModel>
    modelPool: Record<string, Promise<ComputedRef<ChatLunaChatModel>>>
}> {
    const [privatePlatform, privateModelName] = parseRawModelName(
        config.globalPrivateConfig.model
    )
    const globalPrivateModel = await initializeModel(
        ctx,
        privatePlatform,
        privateModelName
    )
    logger.info(
        'global private model loaded %c',
        config.globalPrivateConfig.model
    )

    const [groupPlatform, groupModelName] = parseRawModelName(
        config.globalGroupConfig.model
    )
    const globalGroupModel = await initializeModel(
        ctx,
        groupPlatform,
        groupModelName
    )
    logger.info('global group model loaded %c', config.globalGroupConfig.model)

    const modelPool: Record<
        string,
        Promise<ComputedRef<ChatLunaChatModel>>
    > = {}

    for (const groupId of Object.keys(config.configs)) {
        const guildConfig = config.configs[groupId]
        if (!guildConfig.model) {
            continue
        }

        if (guildConfig.model === config.globalGroupConfig.model) {
            continue
        }

        const key = `group:${groupId}`
        modelPool[key] = (async () => {
            const [platform, modelName] = parseRawModelName(guildConfig.model)
            const loadedModel = await initializeModel(ctx, platform, modelName)

            logger.info(
                'override model loaded %c for group %c',
                guildConfig.model,
                groupId
            )

            modelPool[key] = Promise.resolve(loadedModel)
            return loadedModel
        })()
    }

    for (const userId of Object.keys(config.privateConfigs)) {
        const privateConfig = config.privateConfigs[userId]
        if (!privateConfig.model) {
            continue
        }

        if (privateConfig.model === config.globalPrivateConfig.model) {
            continue
        }

        const key = `private:${userId}`
        modelPool[key] = (async () => {
            const [platform, modelName] = parseRawModelName(privateConfig.model)
            const loadedModel = await initializeModel(ctx, platform, modelName)

            logger.info(
                'override model loaded %c for private %c',
                privateConfig.model,
                userId
            )

            modelPool[key] = Promise.resolve(loadedModel)
            return loadedModel
        })()
    }

    return { globalPrivateModel, globalGroupModel, modelPool }
}

async function getConfigAndPresetForGuild(
    guildId: string,
    isDirect: boolean,
    config: Config,
    globalPrivatePreset: PresetTemplate,
    globalGroupPreset: PresetTemplate,
    presetPool: Record<string, PresetTemplate>,
    key: string,
    preset: Preset
): Promise<{ copyOfConfig: Config; currentPreset: PresetTemplate }> {
    const globalConfig = isDirect
        ? config.globalPrivateConfig
        : config.globalGroupConfig
    const currentGuildConfig = isDirect
        ? config.privateConfigs[guildId]
        : config.configs[guildId]
    let copyOfConfig = Object.assign({}, config, globalConfig)
    let currentPreset = isDirect ? globalPrivatePreset : globalGroupPreset

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
): Promise<{
    completionMessages: BaseMessage[]
    persistedHumanMessage: BaseMessage
}> {
    const { recentMessages, lastMessage, contextMessages } =
        await formatMessage(
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
        logger.debug('messages_new: ' + JSON.stringify(recentMessages))
        logger.debug('messages_last: ' + JSON.stringify(lastMessage))
    }

    if (focusMessage?.quote) {
        logger.debug('formatted_last_message: ' + lastMessage)
    }

    const historyLast = lastMessage.replaceAll('{', '{{').replaceAll('}', '}}')
    const triggerReasonText = (triggerReason ?? 'Normal message trigger')
        .replaceAll('{', '{{')
        .replaceAll('}', '}}')
    const built = {
        preset: currentPreset.name,
        conversationId: session.isDirect ? session.userId : session.guildId
    }

    let historyNewMessages = recentMessages
    if (
        config.modelCompletionCount > 0 &&
        temp.lastHistoryNew &&
        temp.lastHistoryNew.length > 0
    ) {
        let overlap = Math.min(
            temp.lastHistoryNew.length,
            recentMessages.length
        )

        while (overlap > 0) {
            const previous = temp.lastHistoryNew.slice(-overlap)
            const current = recentMessages.slice(0, overlap)

            if (previous.every((msg, index) => msg === current[index])) {
                break
            }

            overlap--
        }

        if (overlap > 0) {
            historyNewMessages = ['...'].concat(recentMessages.slice(overlap))
        }
    }

    temp.lastHistoryNew = recentMessages.slice()
    const humanMessage = new HumanMessage(
        await currentPreset.input.format(
            {
                history_new: historyNewMessages
                    .join('\n\n')
                    .replaceAll('{', '{{')
                    .replaceAll('}', '}}'),
                history_last: historyLast,
                time: formatTimestamp(new Date()),
                stickers: '',
                status: temp.status ?? currentPreset.status ?? '',
                trigger_reason: triggerReasonText,
                prompt: session.content,
                built
            },
            session.app.chatluna.promptRenderer,
            {
                session
            }
        )
    )
    const persistedHumanMessage = new HumanMessage(
        await currentPreset.input.format(
            {
                history_new: recentMessages
                    .join('\n\n')
                    .replaceAll('{', '{{')
                    .replaceAll('}', '}}'),
                history_last: historyLast,
                time: formatTimestamp(new Date()),
                stickers: '',
                status: temp.status ?? currentPreset.status ?? '',
                trigger_reason: triggerReasonText,
                prompt: session.content,
                built
            },
            session.app.chatluna.promptRenderer,
            {
                session
            }
        )
    )
    const tempMessages: BaseMessage[] = []

    if (config.image) {
        for (const message of contextMessages) {
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

    const completionMessages = await formatCompletionMessages(
        [new SystemMessage(formattedSystemPrompt)].concat(
            temp.completionMessages
        ),
        tempMessages,
        humanMessage,
        config,
        model
    )

    if (config.modelCompletionCount > 0) {
        let previous: string[] | undefined
        for (const message of completionMessages) {
            if (message.getType() !== 'human') {
                continue
            }

            if (typeof message.content !== 'string') {
                continue
            }

            const content = message.content
            const start = content.indexOf('# 最近消息')
            const end = content.indexOf('\n# 最后消息')
            if (start < 0 || end < 0 || end <= start) {
                continue
            }

            const block = content.slice(start + '# 最近消息'.length, end).trim()

            const current =
                block.length > 0
                    ? block
                          .split('\n\n')
                          .filter((it) => it.length > 0 && it !== '...')
                    : []

            if (!previous) {
                previous = current
                continue
            }

            let overlap = Math.min(previous.length, current.length)
            while (overlap > 0) {
                const prevTail = previous.slice(-overlap)
                const currHead = current.slice(0, overlap)
                if (prevTail.every((it, index) => it === currHead[index])) {
                    break
                }
                overlap--
            }

            if (overlap > 0) {
                const changed = ['...']
                    .concat(current.slice(overlap))
                    .join('\n\n')
                message.content =
                    content.slice(0, start + '# 最近消息'.length) +
                    '\n' +
                    changed +
                    '\n' +
                    content.slice(end)
            }

            previous = current
        }
    }

    return {
        completionMessages,
        persistedHumanMessage
    }
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

            logger.debug(`model response:\n${responseContent}`)
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
): Promise<{
    breakSay: boolean
    sent: boolean
    messageId?: string
    elements?: h[]
}> {
    try {
        const rendered = await voiceRender(
            ctx,
            session,
            text,
            undefined,
            elements
        )
        const ids = await sendElements(session, rendered)
        return {
            breakSay: true,
            sent: true,
            messageId: ids[0],
            elements: rendered
        }
    } catch (e) {
        logger.error(e)
        try {
            const ids = await sendElements(session, elements)
            return {
                breakSay: false,
                sent: true,
                messageId: ids[0],
                elements
            }
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
): Promise<{
    breakSay: boolean
    sent: boolean
    messageId?: string
    elements?: h[]
}> {
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
    let messageId: string | undefined
    let sentElements: h[] | undefined
    try {
        switch (parsedResponse.messageType) {
            case 'text':
                messageId = (await sendElements(session, elements))[0]
                sentElements = elements
                sent = true
                break
            case 'voice':
                sentElements = await voiceRender(
                    ctx,
                    session,
                    text,
                    undefined,
                    elements
                )
                messageId = (await sendElements(session, sentElements))[0]
                sent = true
                break
            default:
                messageId = (await sendElements(session, elements))[0]
                sentElements = elements
                sent = true
                break
        }
    } catch (e) {
        logger.error(e)
        try {
            messageId = (await sendElements(session, elements))[0]
            sentElements = elements
            sent = true
        } catch (fallbackError) {
            logger.error(fallbackError)
        }
    }

    return { breakSay: false, sent, messageId, elements: sentElements }
}

async function handleParsedResponseChunk(
    session: Session,
    config: Config,
    ctx: Context,
    parsedResponse: ParsedResponse
): Promise<{
    breakSay: boolean
    sentAny: boolean
    sentMessages: { elements: h[]; messageId?: string }[]
}> {
    let breakSay = false
    let sentAny = false
    const sentMessages: { elements: h[]; messageId?: string }[] = []

    for (const elements of parsedResponse.elements) {
        const text =
            parsedResponse.messageType === 'voice'
                ? parsedResponse.rawMessage
                : getElementText(elements)
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
        if (result.sent && result.elements) {
            sentMessages.push({
                elements: result.elements,
                messageId: result.messageId
            })
        }

        if (breakSay) {
            break
        }
    }

    return { breakSay, sentAny, sentMessages }
}

export async function apply(ctx: Context, config: Config) {
    const service = ctx.chatluna_character
    const preset = service.preset
    logger = service.logger

    setLogger(logger)

    const { globalPrivateModel, globalGroupModel, modelPool } =
        await setupModelPool(ctx, config)

    let globalPrivatePreset = preset.getPresetForCache(
        config.globalPrivateConfig.preset
    )
    let globalGroupPreset = preset.getPresetForCache(
        config.globalGroupConfig.preset
    )
    let presetPool: Record<string, PresetTemplate> = {}

    const chainPool: Record<string, ComputedRef<ChatLunaChain>> = {}

    ctx.on('chatluna_character/preset_updated', () => {
        globalPrivatePreset = preset.getPresetForCache(
            config.globalPrivateConfig.preset
        )
        globalGroupPreset = preset.getPresetForCache(
            config.globalGroupConfig.preset
        )
        presetPool = {}
    })

    service.collect(async (session, messages, triggerReason, signal) => {
        const guildId = session.isDirect ? session.userId : session.guildId
        const key = `${session.isDirect ? 'private' : 'group'}:${guildId}`

        try {
            const model = await (modelPool[key] ??
                Promise.resolve(
                    session.isDirect ? globalPrivateModel : globalGroupModel
                ))

            const { copyOfConfig, currentPreset } =
                await getConfigAndPresetForGuild(
                    guildId,
                    session.isDirect,
                    config,
                    globalPrivatePreset,
                    globalGroupPreset,
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
                    chainPool[key] ?? (await createChatLunaChain(ctx, model))
            }

            const latestMessages = service.getMessages(key) ?? messages
            const count = latestMessages.length
            const temp = await service.getTemp(session, latestMessages)
            const focusMessage = latestMessages[latestMessages.length - 1]

            const { completionMessages, persistedHumanMessage } =
                await prepareMessages(
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
            let onlyEmptyReply = false
            let hasNonEmptyReply = false

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

                const isEmptyReply =
                    chunk.parsedResponse.elements.length < 1 &&
                    chunk.parsedResponse.rawMessage.trim().length < 1
                if (isEmptyReply) {
                    onlyEmptyReply = true
                } else {
                    hasNonEmptyReply = true
                }

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
                    sendResult.sentMessages
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
                if (onlyEmptyReply && !hasNonEmptyReply) {
                    return
                }
                service.mute(session, copyOfConfig.muteTime * 1000)
                return
            }

            const persistedMessages = service.getMessages(key) ?? latestMessages
            if (persistedMessages.length > count) {
                temp.status = latestStatus
                await service.persistStatus(
                    session,
                    latestStatus,
                    persistedMessages[persistedMessages.length - 1]
                )
            }

            temp.completionMessages.push(persistedHumanMessage)
            if (lastResponseMessage) {
                temp.completionMessages.push(lastResponseMessage)
            }

            trimCompletionMessages(
                temp.completionMessages,
                copyOfConfig.modelCompletionCount
            )

            await registerResponseTriggers(
                ctx,
                session,
                key,
                copyOfConfig,
                nextReplyReasons,
                wakeUpReplies
            )

            service.muteAtLeast(session, copyOfConfig.coolDownTime * 1000)
        } catch (e) {
            logger.error(e)
        } finally {
            await service.releaseResponseLock(session)
        }
    })
}
