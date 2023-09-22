import { Context, Element, h, sleep } from 'koishi'
import { createLogger } from '@dingyi222666/koishi-plugin-chathub/lib/utils/logger'
import { Config, preset, service, stickerService } from '..'
import { Message } from '../types'
import { parseRawModelName } from '@dingyi222666/koishi-plugin-chathub/lib/llm-core/utils/count_tokens'
import { BaseMessage, HumanMessage, SystemMessage } from 'langchain/schema'
import { ChatHubChatModel } from '@dingyi222666/koishi-plugin-chathub/lib/llm-core/platform/model'

const logger = createLogger('chathub-character')

export async function apply(ctx: Context, config: Config) {
    const [platform, modelName] = parseRawModelName(config.model)
    const model = (await ctx.chathub.createChatModel(
        platform,
        modelName
    )) as ChatHubChatModel

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

        const temp = await service.getTemp(session)

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
                [new SystemMessage(formattedSystemPrompt)].concat(
                    temp.completionMessages
                ),
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
                responseMessage = await model.call(completionMessages)
                break
            } catch (e) {
                logger.error(e)
                await sleep(2000)
                continue
            }
        }

        logger.debug('model response: ' + responseMessage.content)

        const response = parseResponse(responseMessage.content)

        temp.completionMessages.push(humanMessage, responseMessage)

        if (response.length < 1) {
            service.mute(session, config.muteTime)
            return
        }

        for (const elements of response) {
            const text = elements
                .map((element) => element.attrs.content ?? '')
                .join('')
            await sleep(text.length * config.typingTime + 100)
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
        message = message.match(/"(.*)"/)?.[1] ?? message
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

            lastAtIndex = at.end + 1
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
        '—',
        '\r'
    ]

    const retainPunctuations = ['?', '!', '？', '！']

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
            result.push(current)
            state.text = 0
            current = ''
            continue
        } else if (indexOfBrackets % 2 === 0 && state.bracket === 1) {
            result.push(current)
            state.text = 0
            current = ''
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

        if (current.length > 3 || mustPunctuations.includes(char)) {
            result.push(current.trimStart().trimEnd())

            current = ''
        } else if (!retainPunctuations.includes(char)) {
            current += char
        }
    }

    if (current.length > 0) {
        result.push(current.trimStart().trimEnd())
    }

    return result
}

function matchAt(str: string) {
    // (旧梦旧念:3510003509:<at>)
    const atRegex = /\(.*(:|：)(\d+)(:|：)<at>\)/g
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
    model: ChatHubChatModel
) {
    const maxTokens = config.maxTokens - 600
    const systemMessage = messages.shift()
    let currentTokens = 0

    currentTokens += await model.getNumTokens(systemMessage.content)
    currentTokens += await model.getNumTokens(humanMessage.content)

    const result: BaseMessage[] = []

    result.unshift(humanMessage)

    for (let index = messages.length - 1; index >= 0; index--) {
        const message = messages[index]

        const messageTokens = await model.getNumTokens(message.content)

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
    model: ChatHubChatModel,
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
