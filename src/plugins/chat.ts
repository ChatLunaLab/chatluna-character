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

let logger: Logger

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
        console.log(copyOfConfig)
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
        let response: Element[][]

        let isError = false

        for (let i = 0; i < 2; i++) {
            try {
                responseMessage = await model.invoke(completionMessages)

                logger.debug('model response: ' + responseMessage.content)

                response = parseResponse(responseMessage.content as string)

                break
            } catch (e) {
                logger.error(e)
                await sleep(5000)
                if (i === 1) {
                    isError = true
                }
                continue
            }
        }

        if (isError) {
            return
        }

        if (response.length < 1) {
            service.mute(session, copyOfConfig.muteTime)
            return
        }

        temp.completionMessages.push(humanMessage, responseMessage)

        if (temp.completionMessages.length > 10) {
            while (temp.completionMessages.length <= 10) {
                temp.completionMessages.shift()
            }
        }

        const random = new Random()

        for (const elements of response) {
            const text = elements
                .map((element) => element.attrs.content ?? '')
                .join('')
            const maxTime = text.length * copyOfConfig.typingTime + 100
            await sleep(random.int(maxTime / 2, maxTime))
            session.send(elements)
        }

        const sticker = await stickerService.randomStick()

        if (sticker) {
            await sleep(random.int(500, 2000))
            session.send(sticker)
        }

        service.mute(session, copyOfConfig.coolDownTime * 1000)

        service.broadcastOnBot(session, response.flat())
    })
}

function parseResponse(response: string) {
    let message: string
    try {
        // match json object

        // best match <message>content</message>

        message = response.match(/<message>\s*(.*?)\s*<\/message>/)?.[1]

        if (message == null) {
            logger.debug('failed to parse response: ' + response)
            // try find the first "{" and the last "}", sub it and as a json
            // good luck.
            message = response.substring(
                response.indexOf('{'),
                response.lastIndexOf('}') + 1
            )
        }

        message = (
            JSON.parse(message) as {
                name: string
                content: string
            }
        ).content

        if (typeof message !== 'string') {
            throw new Error('Failed to parse response: ' + response)
        }
    } catch (e) {
        logger.error(e)
        throw new Error('Failed to parse response: ' + response)
    }

    const resultElements: Element[][] = []

    const currentElements: Element[] = []
    // match [at:name:id] -> id

    const atMatch = matchAt(message)

    if (atMatch.length > 0) {
        let lastAtIndex = 0
        for (const at of atMatch) {
            const before = message.substring(lastAtIndex, at.start)

            if (before.length > 0) {
                currentElements.push(h.text(before))
            }

            currentElements.push(h.at(at.at))

            lastAtIndex = at.end
        }

        const after = message.substring(lastAtIndex)

        if (after.length > 0) {
            currentElements.push(h.text(after))
        }
    } else {
        currentElements.push(h.text(message))
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

    return resultElements
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

    const mustPunctuations = ['。', '?', '！', '?', '！', ':', '：', '~']

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
    const atRegex = /(\(|（).*\-(\d+)\-<at>(\)|）)/g
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

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]

        const jsonMessage = `{"name":"${message.name}","id":"${message.id}","content":${JSON.stringify(
            message.content
        )}"}`
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
