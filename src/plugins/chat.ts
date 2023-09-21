import { Context, Element, h, sleep } from 'koishi'
import { createLogger } from '@dingyi222666/koishi-plugin-chathub/lib/utils/logger'
import { Config, service, stickerService } from '..'
import { PromptTemplate } from 'langchain/prompts'
import { Message } from '../types'
import { parseRawModelName } from '@dingyi222666/koishi-plugin-chathub/lib/llm-core/utils/count_tokens'
import { BaseMessage, HumanMessage, SystemMessage } from 'langchain/schema'
import { ChatHubChatModel } from '@dingyi222666/koishi-plugin-chathub/lib/llm-core/platform/model'

const logger = createLogger('chathub-character')

export async function apply(ctx: Context, config: Config) {
    const [platform, modelName] = parseRawModelName(config.model)
    const model = (await ctx.chathub.createChatModel(platform, modelName)) as ChatHubChatModel

    const systemPrompt = PromptTemplate.fromTemplate(config.defaultPrompt)

    const completionPrompt = PromptTemplate.fromTemplate(config.historyPrompt)

    service.collect(async (session, messages) => {
        const [recentMessage, lastMessage] = await formatMessage(messages, config, model)

        const formattedSystemPrompt = await systemPrompt.format({
            time: new Date().toLocaleString()
        })

        logger.debug('messages_new: ' + JSON.stringify(recentMessage))

        logger.debug('messages_last: ' + JSON.stringify(lastMessage))

        const completionMessage: BaseMessage[] = [
            new SystemMessage(formattedSystemPrompt),
            new HumanMessage(
                await completionPrompt.format({
                    history_new: recentMessage,
                    history_last: lastMessage
                })
            )
        ]

        logger.debug(
            'completion message: ' + JSON.stringify(completionMessage.map((it) => it.content))
        )

        let responseMessage: BaseMessage

        for (let i = 0; i < 3; i++) {
            try {
                responseMessage = await model.call(completionMessage)
                break
            } catch (e) {
                logger.error(e)
                await sleep(2000)
                continue
            }
        }

        logger.debug('model response: ' + responseMessage.content)

        const response = parseResponse(responseMessage.content)

        if (response.length < 1) {
            service.mute(session, config.muteTime)
            return
        }

        for (const elements of response) {
            const text = elements.map((element) => element.attrs.content ?? '').join('')
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
        // parse [name:id:"content"] [name:id:"content2"] to content2
        // like [旧梦旧念:2187778735:"嗯？怎么了？？"] [旧梦旧念:2187778735:"嗯？怎么了？"] -> 嗯？怎么了？
        // use matchAll
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
    // match ([at:id(??)])
    const atMatch = message.match(/\(at\-(\d+)(.*)?\)/g)
    logger.debug('atMatch: ' + JSON.stringify(atMatch))
    if (atMatch) {
        for (const at of atMatch) {
            const id = at.match(/\d+/)

            logger.debug('id: ' + id)
            if (id && id[0] !== '0') {
                currentElements.push(h.at(id[0]))
            } else {
                logger.error('Failed to parse at: ' + at)
            }
        }
        const text = message.replace(/\(at\-(\d+)(.*)?\)/g, '')
        logger.debug('text: ' + text)
        currentElements.push(h.text(text))
    } else {
        currentElements.push(h.text(message))
    }

    for (let currentElement of currentElements) {
        if (currentElement.type === 'text') {
            // 手动切分句子
            const text = currentElement.attrs.content as string
            // 包括市面上常见的标点符号，直接切割成数组，但是需要保留标点符号

            // 如 "你好，我是一个机器人" -> ["你好，", "我是一个机器人。"]
            // 要求任何语言都能匹配到

            // , . ， 。 、 ? ？ ! ！
            const matchArray = splitSentence(text)

            for (const match of matchArray) {
                // 检查最后一个字符，如果为，。、,. 就去掉
                const lastChar = match[match.length - 1]
                // logger.debug("lastChar: " + lastChar)

                // array.some
                if (['，', '。', '、', ',', '"', "'", ':'].some((char) => char === lastChar)) {
                    //  logger.debug("match: " + match)
                    currentElement = h.text(match.slice(0, match.length - 1))
                    //   logger.debug("currentElement: " + currentElement.attrs.content)
                    resultElements.push([currentElement])
                } else {
                    //    logger.debug("fuck match: " + match)
                    currentElement = h.text(match)
                    resultElements.push([currentElement])
                }
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

// 定义一个函数，用于分割句子
function splitSentence(sentence: string): string[] {
    // 定义一个正则表达式，用于匹配中英文的标点符号
    const regex = /([，。？！；：,?!;:])/g
    // 定义一个数组，存放所有可能出现的标点符号
    const punctuations = ['，', '。', '？', '！', '；', '：', ',', '?', '!', ';', ':']
    // 使用split方法和正则表达式来分割句子，并过滤掉空字符串
    const result = sentence.split(regex).filter((s) => s !== '')

    // 定义一个新的数组，用于存放最终的结果
    const final: string[] = []
    // 遍历分割后的数组
    for (let i = 0; i < result.length; i++) {
        // 如果当前元素是一个标点符号
        if (punctuations.includes(result[i])) {
            final[final.length - 1] = final[final.length - 1].trim() + result[i]
        }
        // 否则，如果当前元素不是空格
        else if (result[i] !== ' ') {
            // 把当前元素加入到最终的数组中
            final.push(result[i])
        }
    }
    // 返回最终的数组
    return final.filter((it) => !punctuations.some((char) => char === it))
}

async function formatMessage(messages: Message[], config: Config, model: ChatHubChatModel) {
    const maxTokens = config.maxTokens
    let currentTokens = 0

    currentTokens += await model.getNumTokens(config.defaultPrompt)
    currentTokens += await model.getNumTokens(config.historyPrompt)

    const calculatedMessages: string[] = []

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]

        const jsonMessage = `[${message.name}:${message.id}:"${message.content}]"`
        const jsonMessageToken = await model.getNumTokens(jsonMessage)

        if (currentTokens + jsonMessageToken > maxTokens - 4) {
            break
        } else {
            currentTokens += jsonMessageToken
            calculatedMessages.unshift(jsonMessage)
        }
    }

    logger.debug(`maxTokens: ${maxTokens}, currentTokens: ${currentTokens}`)

    const lastMessage = calculatedMessages.pop()

    return [calculatedMessages, lastMessage]
}
