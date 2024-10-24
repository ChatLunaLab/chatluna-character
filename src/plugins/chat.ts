// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {} from '@initencounter/vits'
import {
    BaseMessage,
    HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import { Context, Element, h, Logger, Random, sleep } from 'koishi'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { Config } from '..'
import { Message, PresetTemplate } from '../types'
import { transform } from 'koishi-plugin-markdown'

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

function isEmoticonStatement(
    text: string,
    elements: Element[]
): 'emoji' | 'text' | 'emo' {
    if (elements.length === 1 && elements[0].attrs['emo']) {
        return 'emo'
    }

    const regex =
        /^[\p{P}\p{S}\p{Z}\p{M}\p{N}\p{L}\s]*\p{So}[\p{P}\p{S}\p{Z}\p{M}\p{N}\p{L}\s]*$/u
    return regex.test(text) ? 'emoji' : 'text'
}

function isOnlyPunctuation(text: string): boolean {
    // 匹配中英文标点符号
    const regex =
        /^[.,;!?…·—–—()【】「」『』《》<>《》{}【】〔〕“”‘’'"\[\]@#￥%\^&\*\-+=|\\~？。`]+$/
    return regex.test(text)
}

function parseResponse(response: string, useAt: boolean = true) {
    let rawMessage: string
    let parsedMessage = ''
    let messageType = 'text'
    let status = ''
    let sticker: string | null = null
    try {
        // match xml object

        // best match <message_part>content</message_part>

        rawMessage = response.match(
            /<message_part>\s*(.*?)\s*<\/message_part>/s
        )?.[1]

        status = response.match(/<status>(.*?)<\/status>/s)?.[1]

        // match the full <message(.*)>(.*?)</message>

        if (rawMessage == null) {
            rawMessage = response.match(/<message[\s\S]*?<\/message>/)?.[0]
        }

        if (rawMessage == null) {
            throw new Error('Failed to parse response: ' + response)
        }

        const tempJson = parseXmlToObject(rawMessage) as {
            name: string
            type: string
            sticker: string
            content: string
        }

        rawMessage = tempJson.content
        messageType = tempJson.type
        sticker = tempJson.sticker

        if (typeof rawMessage !== 'string') {
            throw new Error('Failed to parse response: ' + response)
        }
    } catch (e) {
        logger.error(e)
        throw new Error('Failed to parse response: ' + response)
    }

    const resultElements: Element[][] = []

    const currentElements: Element[] = []
    // match <at name='name'>id</at>

    const atMatch = matchAt(rawMessage)

    if (atMatch.length > 0) {
        let lastAtIndex = 0
        for (const at of atMatch) {
            const before = rawMessage.substring(lastAtIndex, at.start)

            if (before.length > 0) {
                parsedMessage += before
                currentElements.push(...transform(before))
            }

            if (useAt) {
                currentElements.push(h.at(at.at))
            }

            lastAtIndex = at.end
        }

        const after = rawMessage.substring(lastAtIndex)

        if (after.length > 0) {
            parsedMessage += after
            currentElements.push(...transform(after))
        }
    } else {
        parsedMessage = rawMessage
        currentElements.push(...transform(rawMessage))
    }

    const forEachElement = (elements: Element[]) => {
        for (let i = 0; i < elements.length; i++) {
            const element = elements[i]
            if (element.type === 'text') {
                const text = element.attrs.content as string

                if (text.endsWith('<emo>')) {
                    const nextElement = elements[i + 1]
                    const endElement = elements[i + 2]
                    const endElementText = endElement.attrs.content as string

                    if (endElementText.endsWith('</emo>')) {
                        nextElement.attrs['emo'] = true
                        resultElements.push([nextElement])
                        i += 2
                        continue
                    }
                }

                const matchArray = splitSentence(text).filter(
                    (x) => x.length > 0
                )

                for (const match of matchArray) {
                    const newElement = h.text(match)
                    resultElements.push([newElement])
                }
            } else if (
                element.type === 'em' ||
                element.type === 'strong' ||
                element.type === 'del' ||
                element.type === 'p'
            ) {
                forEachElement(element.children)
            } else {
                resultElements.push([element])
            }
        }
    }

    forEachElement(currentElements)

    if (resultElements[0]?.[0]?.type === 'at' && resultElements.length > 1) {
        resultElements[1].unshift(h.text(' '))
        resultElements[1].unshift(resultElements[0][0])

        resultElements.shift()
    }

    return {
        elements: resultElements,
        rawMessage: parsedMessage,
        status,
        sticker,
        messageType
    }
}

function parseXmlToObject(xml: string) {
    /* <message name='煕' id='0' type='text' sticker='喜欢'><emo>(づ｡◕‿‿◕｡)づ</emo> <emo>(ಡωಡ)hiahiahia</emo></message> */
    /* <message name='煕' id='0' type='text' sticker='喜欢'></message> */

    const messageRegex = /<message\s+(.*?)>(.*?)<\/message>/s
    const match = xml.match(messageRegex)

    if (!match) {
        throw new Error('Failed to parse response: ' + xml)
    }

    const [, attributes, content] = match

    const getAttr = (name: string): string => {
        const attrRegex = new RegExp(`${name}=['"]?([^'"]+)['"]?`)
        const attrMatch = attributes.match(attrRegex)
        if (!attrMatch) {
            logger.warn(`Failed to parse ${name} attribute: ${xml}`)
            return ''
        }
        return attrMatch[1]
    }

    const name = getAttr('name')
    const id = getAttr('id')
    const type = getAttr('type') || 'text'
    const sticker = getAttr('sticker')

    if (content === undefined) {
        throw new Error('Failed to parse content: ' + xml)
    }

    return { name, id, type, sticker, content }
}

function splitSentence(text: string): string[] {
    if (isOnlyPunctuation(text)) {
        return [text]
    }

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
            result.push(current)

            current = ''
        } else if (!retainPunctuations.includes(char)) {
            current += char
        }
    }

    if (current.length > 0) {
        result.push(current)
    }

    return result.filter((item) => punctuations.indexOf(item) === -1)
}

function matchAt(str: string) {
    // <at name='name'>id</at>
    // <at(.*?)>id</at>
    // get id, if the name is empty
    const atRegex = /<at[^>]*>(.*?)<\/at>/g
    return [...str.matchAll(atRegex)].map((item) => {
        return {
            at: item[1],
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

        const voiceProbability = random.int(1, 10) > 8 ? 'voice' : 'text'

        const xmlMessage = `<message type='${voiceProbability}' name='${message.name}' id='${message.id}'>${message.content}</message>`

        const xmlMessageToken = await model.getNumTokens(xmlMessage)

        if (currentTokens + xmlMessageToken > maxTokens - 4) {
            break
        }

        currentTokens += xmlMessageToken
        calculatedMessages.unshift(xmlMessage)
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
