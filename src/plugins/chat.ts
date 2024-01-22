import { Context, Element, h, Logger, Random, sleep } from 'koishi'
import { Config } from '..'
import { Message } from '../types'
import { parseRawModelName } from 'koishi-plugin-chatluna/lib/llm-core/utils/count_tokens'
import {
    BaseMessage,
    HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/lib/llm-core/platform/model'

let logger: Logger

export async function apply(ctx: Context, config: Config) {
    const service = ctx.chatluna_character
    const preset = service.preset
    const stickerService = service.stickerService
    logger = service.logger

    const [platform, modelName] = parseRawModelName(config.model)

    await ctx.chatluna.awaitLoadPlatform(platform)

    const model = (await ctx.chatluna.createChatModel(
        platform,
        modelName
    )) as ChatLunaChatModel

    logger.info('chatluna model loaded %c', config.model)

    const selectedPreset = await preset.getPreset(config.defaultPreset)

    const systemPrompt = selectedPreset.system

    const completionPrompt = selectedPreset.input

    service.collect(async (session, messages) => {
        const [recentMessage, lastMessage] = await formatMessage(
            messages,
            config,
            model,
            systemPrompt.template,
            completionPrompt.template
        )

        /*  const temp = await service.getTemp(session) */

        const formattedSystemPrompt = await systemPrompt.format({
            time: new Date().toLocaleString()
        })

        logger.debug('messages_new: ' + JSON.stringify(recentMessage))

        logger.debug('messages_last: ' + JSON.stringify(lastMessage))

        const humanMessage = new HumanMessage(
            await completionPrompt.format({
                history_new: recentMessage,
                history_last: lastMessage,
                time: new Date().toLocaleString()
            })
        )

        const completionMessages: BaseMessage[] =
            await formatCompletionMessages(
                [new SystemMessage(formattedSystemPrompt)] /* .concat(
                    temp.completionMessages
                ) */,
                humanMessage,
                config,
                model
            )

        logger.debug(
            'completion message: ' +
                JSON.stringify(completionMessages.map((it) => it.content))
        )

        let responseMessage: BaseMessage

        for (let i = 0; i < 3; i++) {
            try {
                responseMessage = await model.invoke(completionMessages)
                break
            } catch (e) {
                logger.error(e)
                await sleep(2000)
                continue
            }
        }

        logger.debug('model response: ' + responseMessage.content)

        const response = parseResponse(responseMessage.content as string)

        /* temp.completionMessages.push(humanMessage, responseMessage)

        if (temp.completionMessages.length > 30) {
            while (temp.completionMessages.length <= 30) {
                temp.completionMessages.shift()
            }
        } */

        if (response.length < 1) {
            service.mute(session, config.muteTime)
            return
        }

        const random = new Random()

        for (const elements of response) {
            const text = elements
                .map((element) => element.attrs.content ?? '')
                .join('')
            const maxTime = text.length * config.typingTime + 100
            await sleep(random.int(maxTime / 2, maxTime))
            session.send(elements)
        }

        const sticker = await stickerService.randomStick()

        if (sticker) {
            session.send(sticker)
        }

        service.mute(session, config.coolDownTime * 1000)

        service.broadcastOnBot(session, response.flat())
    })
}

function parseResponse(response: string) {
    let message: string
    try {
        const match = response.matchAll(/\[.*?\]/g)

        message = [...match].pop()?.[0] ?? ''

        logger.debug('message: ' + message)
        message = message.match(/\[.*(:|：).*(:|：)(.*)\]/)?.[3] ?? ''
        message =
            message.match(/["\u201c\u201d“”](.*)["\u201c\u201d“”]/)?.[1] ??
            message

        logger.debug('message: ' + message)
        if (typeof message !== 'string') {
            logger.error('Failed to parse response: ' + response)
            return []
        }
    } catch (e) {
        logger.error(e)
        logger.error('Failed to parse response: ' + response)
        return []
    }

    const resultElements: Element[][] = []

    const currentElements: Element[] = []
    // match [at:name:id] -> id

    const atMatch = matchAt(message)

    logger.debug('atMatch: ' + JSON.stringify(atMatch))
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

    if (resultElements[0]?.[0]?.type === 'at') {
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

        const jsonMessage = `[${message.name}:${message.id}:${JSON.stringify(
            message.content
        )}]"`
        const jsonMessageToken = await model.getNumTokens(jsonMessage)

        if (currentTokens + jsonMessageToken > maxTokens - 4) {
            break
        }

        currentTokens += jsonMessageToken
        calculatedMessages.unshift(jsonMessage)
    }

    const lastMessage = calculatedMessages.pop()

    return [calculatedMessages, lastMessage]
}
