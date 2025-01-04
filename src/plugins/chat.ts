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
import { GroupTemp, Message, PresetTemplate } from '../types'
import {
    createEmbeddingsModel,
    formatCompletionMessages,
    formatMessage,
    formatSearchResult,
    getSearchKeyword,
    isEmoticonStatement,
    parseResponse,
    setLogger
} from '../utils'
import { Preset } from '../preset'
import { StickerService } from '../service/sticker'
import { StructuredTool } from '@langchain/core/tools'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'

let logger: Logger

interface ModelResponse {
    responseMessage: BaseMessage
    parsedResponse: ReturnType<typeof parseResponse>
}

async function initializeModel(
    ctx: Context,
    platform: string,
    modelName: string
): Promise<ChatLunaChatModel> {
    await ctx.chatluna.awaitLoadPlatform(platform)
    return (await ctx.chatluna.createChatModel(
        platform,
        modelName
    )) as ChatLunaChatModel
}

async function setupModelPool(
    ctx: Context,
    config: Config
): Promise<{
    globalModel: ChatLunaChatModel
    modelPool: Record<string, Promise<ChatLunaChatModel>>
}> {
    const [platform, modelName] = parseRawModelName(config.model)
    const globalModel = await initializeModel(ctx, platform, modelName)
    logger.info('global model loaded %c', config.model)

    const modelPool: Record<string, Promise<ChatLunaChatModel>> = {}

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
    globalModel: ChatLunaChatModel,
    modelPool: Record<string, Promise<ChatLunaChatModel>>
): Promise<ChatLunaChatModel> {
    return await (modelPool[guildId] ?? Promise.resolve(globalModel))
}

async function getSearchTool(
    ctx: Context,
    config: Config,
    guildId: string,
    model: ChatLunaChatModel,
    toolsPool: Record<string, StructuredTool>
): Promise<StructuredTool | undefined> {
    let isSearchEnabled = config.search

    if (config.configs[guildId]) {
        isSearchEnabled = config.configs[guildId]['search'] || isSearchEnabled
    }

    if (!isSearchEnabled) {
        return undefined
    }

    if (toolsPool[guildId]) {
        return toolsPool[guildId]
    }

    const embeddings = await createEmbeddingsModel(ctx)

    const chatlunaTool = ctx.chatluna.platform.getTool('web-search')

    if (!chatlunaTool) return undefined

    const tool = await chatlunaTool.createTool({
        model,
        embeddings,
        summaryType: config.searchSummayType
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any)

    toolsPool[guildId] = tool

    return tool
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
        copyOfConfig = { ...copyOfConfig, ...currentGuildConfig }
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

    return { copyOfConfig, currentPreset }
}

async function prepareMessages(
    messages: Message[],
    config: Config,
    session: Session,
    model: ChatLunaChatModel,
    currentPreset: PresetTemplate,
    temp: GroupTemp,
    stickerService: StickerService,
    searchTool?: StructuredTool
): Promise<BaseMessage[]> {
    const [recentMessage, lastMessage] = await formatMessage(
        messages,
        config,
        model,
        currentPreset.system.template as string,
        currentPreset.system.template as string
    )

    const formattedSystemPrompt = await currentPreset.system.format({
        time: new Date().toString(),
        status: temp.status ?? currentPreset.status ?? '',
        stickers: JSON.stringify(stickerService.getAllStickTypes())
    })

    logger.debug('messages_new: ' + JSON.stringify(recentMessage))
    logger.debug('messages_last: ' + JSON.stringify(lastMessage))

    const humanMessage = new HumanMessage(
        await currentPreset.input.format({
            history_new: recentMessage,
            history_last: lastMessage,
            time: new Date().toString(),
            stickers: JSON.stringify(stickerService.getAllStickTypes()),
            status: temp.status ?? currentPreset.status ?? ''
        })
    )

    // replace {?search xxxx {search} xxx} to xxxx {search} xxx
    // {?search 如果你需要用到这些知识，请使用这些知识 {search} 记住！} -> 如果你需要用到这些知识，请使用这些知识 {xxxx} 记住！
    let baseHumanContent = getMessageContent(humanMessage.content)

    const searchPattern = /{\?search\s*(.+){search}\s*(.+)}/gms
    const searchMatch = searchPattern.exec(baseHumanContent)

    const imagePattern = /{\?image(.+)}/gms
    const imageMatch = imagePattern.exec(baseHumanContent)

    if (searchMatch && searchMatch.length > 0) {
        let searchResult = ''
        if (searchTool) {
            let keyword = await getSearchKeyword(
                config,
                session,
                messages,
                model
            )

            // 过滤空格，空行
            keyword = keyword.replace(/\s+/g, ' ').trim()

            if (keyword !== '[skip]') {
                const rawSearchResult = await searchTool
                    .invoke(keyword)
                    .then((it) => it as string)

                searchResult = formatSearchResult(rawSearchResult)

                // logger.debug('searchResult: ' + searchResult)
            }
        }

        const matchedContent = searchMatch[0] // 获取完整匹配
        const leftContent = searchMatch[1] // 获取第一个捕获组
        const rightContent = searchMatch[2] // 获取第二个捕获组

        if (searchResult.length > 0) {
            baseHumanContent = baseHumanContent.replace(
                matchedContent,
                `{${leftContent} ${searchResult} ${rightContent}}`
            )
        } else {
            baseHumanContent = baseHumanContent.replace(matchedContent, '')
        }

        humanMessage.content = baseHumanContent

        // logger.debug('humanMessage: ' + humanMessage.content)
    }

    if (config.image) {
        // search the image
        for (let index = messages.length - 1; index >= 0; index--) {
            const message = messages[index]
            if (message.images && message.images.length > 0) {
                humanMessage.additional_kwargs = {
                    images: message.images
                }
                break
            }
        }

        // remove the image in old compleation messages

        for (const message of temp.completionMessages) {
            if (message.additional_kwargs?.images) {
                delete message.additional_kwargs.images
            }
        }

        // replace {?image xxx} => xxx
        if (imageMatch && imageMatch.length > 0) {
            const matchedContent = imageMatch[0] // 获取完整匹配
            const content = imageMatch[1] // 获取第一个捕获组
            baseHumanContent = baseHumanContent.replace(matchedContent, content)
            humanMessage.content = baseHumanContent
        }
    } else {
        // replace {?image xxx} => ''
        if (imageMatch && imageMatch.length > 0) {
            const matchedContent = imageMatch[0] // 获取完整匹配
            baseHumanContent = baseHumanContent.replace(matchedContent, '')
            humanMessage.content = baseHumanContent
        }
    }

    return formatCompletionMessages(
        [new SystemMessage(formattedSystemPrompt)].concat(
            temp.completionMessages
        ),
        humanMessage,
        config,
        model
    )
}

async function getModelResponse(
    model: ChatLunaChatModel,
    completionMessages: BaseMessage[],
    isAt: boolean
): Promise<ModelResponse | null> {
    for (let retryCount = 0; retryCount < 3; retryCount++) {
        try {
            const responseMessage = await model.invoke(completionMessages)
            logger.debug('model response: ' + responseMessage.content)
            const parsedResponse = parseResponse(
                responseMessage.content as string,
                isAt
            )
            return { responseMessage, parsedResponse }
        } catch (e) {
            logger.error('model requests failed', e)
            if (retryCount === 2) return null
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
        await session.send(await ctx.vits.say({ input: text }))
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
    parsedResponse: ReturnType<typeof parseResponse>,
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
                await session.send(await ctx.vits.say({ input: text }))
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

async function handleStickerSending(
    session: Session,
    config: Config,
    parsedResponse: ReturnType<typeof parseResponse>,
    stickerService: StickerService
): Promise<void> {
    const random = new Random()
    if (Math.random() < config.sendStickerProbability) {
        const sticker = await stickerService.randomStickByType(
            parsedResponse.sticker
        )
        await sleep(random.int(500, 2000))
        await session.send(sticker)
    }
}

async function handleModelResponse(
    session: Session,
    config: Config,
    ctx: Context,
    stickerService: StickerService,
    parsedResponse: ReturnType<typeof parseResponse>
): Promise<void> {
    let breakSay = false

    for (const elements of parsedResponse.elements) {
        const text = elements
            .map((element) => element.attrs.content ?? '')
            .join('')

        const emoticonStatement = isEmoticonStatement(text, elements)

        if (elements.length < 1) continue

        const maxTime = calculateMessageDelay(text, elements, config.typingTime)

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

    await handleStickerSending(session, config, parsedResponse, stickerService)

    ctx.chatluna_character.mute(session, config.coolDownTime * 1000)
    await ctx.chatluna_character.broadcastOnBot(
        session,
        parsedResponse.elements.flat()
    )
}

export async function apply(ctx: Context, config: Config) {
    const service = ctx.chatluna_character
    const preset = service.preset
    const stickerService = service.stickerService
    logger = service.logger

    setLogger(logger)

    const { globalModel, modelPool } = await setupModelPool(ctx, config)

    let globalPreset = preset.getPresetForCache(config.defaultPreset)
    let presetPool: Record<string, PresetTemplate> = {}

    const toolsPool: Record<string, StructuredTool> = {}

    ctx.on('chatluna_character/preset_updated', () => {
        globalPreset = preset.getPresetForCache(config.defaultPreset)
        presetPool = {}
    })

    service.collect(async (session, messages) => {
        const guildId = session.event.guild?.id ?? session.guildId
        const model = await getModelForGuild(guildId, globalModel, modelPool)

        const searchTool = await getSearchTool(
            ctx,
            config,
            guildId,
            model,
            toolsPool
        )

        const { copyOfConfig, currentPreset } =
            await getConfigAndPresetForGuild(
                guildId,
                config,
                globalPreset,
                presetPool,
                preset
            )

        const temp = await service.getTemp(session)
        const completionMessages = await prepareMessages(
            messages,
            copyOfConfig,
            session,
            model,
            currentPreset,
            temp,
            stickerService,
            searchTool
        )

        logger.debug(
            'completion message: ' +
                JSON.stringify(completionMessages.map((it) => it.content))
        )

        const response = await getModelResponse(
            model,
            completionMessages,
            copyOfConfig.isAt
        )
        if (!response) {
            // clear the completion messages
            // temp.completionMessages.length = 0
            return
        }

        const { responseMessage, parsedResponse } = response

        temp.status = parsedResponse.status
        if (parsedResponse.elements.length < 1) {
            service.mute(session, copyOfConfig.muteTime)
            return
        }

        temp.completionMessages.push(responseMessage)
        if (temp.completionMessages.length > 4) {
            temp.completionMessages.length = 0
        }

        await handleModelResponse(
            session,
            copyOfConfig,
            ctx,
            stickerService,
            parsedResponse
        )
    })
}
