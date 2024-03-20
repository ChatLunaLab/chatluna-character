// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {} from '@initencounter/vits'
import {
    BaseMessage,
    HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import { Context, Element, h, Logger, Random, sleep } from 'koishi'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/lib/llm-core/platform/model'
import { parseRawModelName } from 'koishi-plugin-chatluna/lib/llm-core/utils/count_tokens'
import { Config } from '..'
import { Message, PresetTemplate } from '../types'

export async function apply(ctx: Context, config: Config) {
    const service = ctx.chatluna_character
    const preset = service.preset
    const stickerService = service.stickerService
    logger = service.logger

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

    const globalPreset = await preset.getPreset(config.defaultPreset)
    const presetPool: Record<string, PresetTemplate> = {}

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
                (() => {
                    const template = preset.getPresetForCache(
                        currentGuildConfig.preset
                    )
                    presetPool[guildId] = template
                    return template
                })()
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
            time: new Date().toLocaleString()
        })

        logger.debug('messages_new: ' + JSON.stringify(recentMessage))

        logger.debug('messages_last: ' + JSON.stringify(lastMessage))

        const humanMessage = new HumanMessage(
            await currentPreset.input.format({
                history_new: recentMessage,
                history_last: lastMessage,
                time: new Date().toLocaleString()
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

        let isError = false

        for (let i = 0; i < 3; i++) {
            try {
                responseMessage = await model.invoke(completionMessages)

                logger.debug('model response: ' + responseMessage.content)

                parsedResponse = parseResponse(
                    responseMessage.content as string,
                    copyOfConfig.isAt
                )

                break
            } catch (e) {
                logger.error(e)
                await sleep(2000)
                if (i === 2) {
                    isError = true
                }
            }
        }

        if (isError) {
            return
        }

        if (parsedResponse.elements.length < 1) {
            service.mute(session, copyOfConfig.muteTime)
            return
        }

        temp.completionMessages.push(humanMessage, responseMessage)

        if (temp.completionMessages.length > 8) {
            while (temp.completionMessages.length <= 4) {
                temp.completionMessages.shift()
            }
        }

        const random = new Random()

        for (const elements of parsedResponse.elements) {
            const text = elements
                .map((element) => element.attrs.content ?? '')
                .join('')

            let maxTime = text.length * copyOfConfig.typingTime + 100

            if (
                parsedResponse.messageType === 'voice' &&
                isEmoticonStatement(text)
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
                await session.send(
                    await ctx.vits.say({ input: parsedResponse.rawMessage })
                )
                break
            }

            try {
                await sleep(random.int(maxTime / 2, maxTime))
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

        const sticker = await stickerService.randomStick()

        if (sticker) {
            await sleep(random.int(500, 2000))
            await session.send(sticker)
        }

        service.mute(session, copyOfConfig.coolDownTime * 1000)

        await service.broadcastOnBot(session, parsedResponse.elements.flat())
    })
}

function isEmoticonStatement(text: string): boolean {
    const regex =
        /^[\p{P}\p{S}\p{Z}\p{M}\p{N}\p{L}\s]*\p{So}[\p{P}\p{S}\p{Z}\p{M}\p{N}\p{L}\s]*$/u
    return regex.test(text)
}

function parseResponse(response: string, useAt: boolean = true) {
    let rawMessage: string
    let parsedMessage = ''
    let messageType = 'text'
    try {
        // match json object

        // best match <message>content</message>

        rawMessage = response.match(/<message>\s*(.*?)\s*<\/message>/)?.[1]

        if (rawMessage == null) {
            logger.debug('failed to parse response: ' + response)
            // try to find the first "{" and the last "}", sub it and as a json
            // good luck.
            rawMessage = response.substring(
                response.indexOf('{'),
                response.lastIndexOf('}') + 1
            )
        }

        const tempJson = JSON.parse(rawMessage) as {
            name: string
            type: string
            content: string
        }

        rawMessage = tempJson.content
        messageType = tempJson.type

        if (typeof rawMessage !== 'string') {
            throw new Error('Failed to parse response: ' + response)
        }
    } catch (e) {
        logger.error(e)
        throw new Error('Failed to parse response: ' + response)
    }

    const resultElements: Element[][] = []

    const currentElements: Element[] = []
    // match [at:name:id] -> id

    const atMatch = matchAt(rawMessage)

    if (atMatch.length > 0) {
        let lastAtIndex = 0
        for (const at of atMatch) {
            const before = rawMessage.substring(lastAtIndex, at.start)

            if (before.length > 0) {
                parsedMessage += before
                currentElements.push(h.text(before))
            }

            if (useAt) {
                currentElements.push(h.at(at.at))
            }

            lastAtIndex = at.end
        }

        const after = rawMessage.substring(lastAtIndex)

        if (after.length > 0) {
            parsedMessage += after
            currentElements.push(h.text(after))
        }
    } else {
        parsedMessage = rawMessage
        currentElements.push(h.text(rawMessage))
    }

    for (let currentElement of currentElements) {
        if (currentElement.type === 'text') {
            const text = currentElement.attrs.content as string

            const matchArray = splitSentence(text).filter((x) => x.length > 0)

            for (const match of matchArray) {
                currentElement = h.text(match)
                resultElements.push([currentElement])
            }
        } else {
            resultElements.push([currentElement])
        }
    }

    if (resultElements[0]?.[0]?.type === 'at' && resultElements.length > 1) {
        resultElements[1].unshift(h.text(' '))
        resultElements[1].unshift(resultElements[0][0])

        resultElements.shift()
    }

    return {
        elements: resultElements,
        rawMessage: parsedMessage,
        messageType
    }
}

function splitSentence(text: string): string[] {
    const result: string[] = []

    const lines = text
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .join(' ')

    const state = {
        bracket: 0,
        text: 0
    }

    let current = ''

    const punctuations = [
        '，',
        '。',
        '？',
        '！',
        '；',
        '：',
        ',',
        '?',
        '!',
        ';',
        ':',
        '、',
        '~',
        '—',
        '\r'
    ]

    const retainPunctuations = ['?', '!', '？', '！', '~']

    const mustPunctuations = ['。', '?', '！', '?', '！', ':', '：']

    const brackets = ['【', '】', '《', '》', '(', ')', '（', '）']

    for (let index = 0; index < lines.length; index++) {
        const char = lines[index]
        const nextChar = lines?.[index + 1]

        const indexOfBrackets = brackets.indexOf(char)

        if (indexOfBrackets > -1) {
            state.bracket += indexOfBrackets % 2 === 0 ? 1 : -1
        }

        if (indexOfBrackets > -1 && state.bracket === 0 && state.text > 0) {
            current += char
            result.push(current)
            state.text = 0
            current = ''
            continue
        } else if (indexOfBrackets % 2 === 0 && state.bracket === 1) {
            result.push(current)
            state.text = 0
            current = char
            continue
        } else if (state.bracket > 0) {
            current += char
            state.text++
            continue
        }

        if (!punctuations.includes(char)) {
            current += char
            continue
        }

        if (retainPunctuations.includes(char)) {
            current += char
        }

        if (
            retainPunctuations.indexOf(nextChar) % 2 === 0 &&
            retainPunctuations.indexOf(char) % 2 === 1
        ) {
            index += 1
        }

        if (current.length < 1) {
            continue
        }

        if (current.length > 2 || mustPunctuations.includes(char)) {
            result.push(current.trimStart().trimEnd())

            current = ''
        } else if (!retainPunctuations.includes(char)) {
            current += char
        }
    }

    if (current.length > 0) {
        result.push(current.trimStart().trimEnd())
    }

    return result.filter((item) => punctuations.indexOf(item) === -1)
}

function matchAt(str: string) {
    // (旧梦旧念:3510003509:<at>)
    // /\(.*\-(\d+)\-<at>\)/g
    const atRegex = /([(（]).*-(\d+)-<at>([)）])/g
    return [...str.matchAll(atRegex)].map((item) => {
        return {
            at: item[2],
            start: item.index,
            end: item.index + item[0].length
        }
    })
}

async function formatCompletionMessages(
    messages: BaseMessage[],
    humanMessage: BaseMessage,
    config: Config,
    model: ChatLunaChatModel
) {
    const maxTokens = config.maxTokens - 600
    const systemMessage = messages.shift()
    let currentTokens = 0

    currentTokens += await model.getNumTokens(systemMessage.content as string)
    currentTokens += await model.getNumTokens(humanMessage.content as string)

    const result: BaseMessage[] = []

    result.unshift(humanMessage)

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]

        const messageTokens = await model.getNumTokens(
            message.content as string
        )

        if (currentTokens + messageTokens > maxTokens) {
            break
        }

        currentTokens += messageTokens
        result.unshift(message)
    }

    logger.debug(`maxTokens: ${maxTokens}, currentTokens: ${currentTokens}`)

    result.unshift(systemMessage)

    return result
}

async function formatMessage(
    messages: Message[],
    config: Config,
    model: ChatLunaChatModel,
    systemPrompt: string,
    historyPrompt: string
) {
    const maxTokens = config.maxTokens - 300
    let currentTokens = 0

    currentTokens += await model.getNumTokens(systemPrompt)
    currentTokens += await model.getNumTokens(historyPrompt)

    const calculatedMessages: string[] = []

    const random = new Random()
    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]

        const voiceProbability = random.int(1, 10) > 5 ? 'voice' : 'text'
        const jsonMessage = `{"name":"${message.name}","id":"${message.id}","content":${JSON.stringify(
            message.content
        )}","type":"${voiceProbability}"}`
        const jsonMessageToken = await model.getNumTokens(jsonMessage)

        if (currentTokens + jsonMessageToken > maxTokens - 4) {
            break
        }

        currentTokens += jsonMessageToken
        calculatedMessages.unshift(jsonMessage)
    }

    const lastMessage = calculatedMessages.pop()

    if (lastMessage === undefined) {
        throw new Error(
            'lastMessage is undefined, please set the max token to be bigger'
        )
    }

    return [calculatedMessages, lastMessage]
}

let logger: Logger
