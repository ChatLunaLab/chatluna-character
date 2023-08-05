import { Context, Element, h, sleep } from 'koishi';
import CharacterPlugin from '..';
import { createLogger } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/utils/logger"
import { service, stickerService } from '..';
import { PromptTemplate } from 'langchain/prompts'
import { Message } from '../types';
import { ChatHubBaseChatModel } from '@dingyi222666/koishi-plugin-chathub/lib/llm-core/model/base';
import { BaseMessage, HumanMessage, SystemMessage } from 'langchain/schema';


const logger = createLogger("chathub-character/plugins/chat")

export async function apply(ctx: Context, config: CharacterPlugin.Config) {
    const modelNameSpitted = config.model.split("/")
    const model = await ctx.chathub.createChatModel(modelNameSpitted[0], modelNameSpitted[1])

    const systemPrompt = PromptTemplate.fromTemplate(config.defaultPrompt)

    const completionPrompt = PromptTemplate.fromTemplate(config.historyPrompt)

    service.collect(async (session, messages) => {

        const [historyMessage, recentMessage, lastMessage] = await formatMessage(messages, config, model)

        const formattedSystemPrompt = await systemPrompt.format({
            time: new Date().toLocaleString(),
        })

        logger.debug("messages_old: " + JSON.stringify(historyMessage))
        logger.debug("messages_new: " + JSON.stringify(recentMessage))

        const completionMessage = [
            new SystemMessage(formattedSystemPrompt),
            new HumanMessage(await completionPrompt.format({
                history_old: historyMessage.length < 1 ? "empty" : historyMessage,
                history_new: recentMessage,
                history_last: lastMessage
            }))
        ]

        logger.debug("completion message: " + JSON.stringify(completionMessage.map(it => it.content)))

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


        logger.debug("model response: " + responseMessage.content)

        const response = parseResponse(responseMessage.content)

        if (response.length < 1) {
            service.mute(session, config.muteTime)
            return
        }

        for (const elements of response) {
            const text = elements.map(element => element.attrs.content ?? "").join("")
            await sleep(text.length * 200 + config.typingTime)
            session.send(elements)
        }

        const sticker = stickerService.randomStick()

        if (sticker) {
            logger.debug(`send sticker: ${JSON.stringify(sticker)}`)
            session.send(sticker)
        }

        service.mute(session, config.coolDownTime * 1000)

        service.broadcastOnBot(session, response.flat())

    })
}


function parseResponse(response: string) {
    let message: string
    try {
        // parse name:id:"content" to content
        // like 旧梦旧念:2187778735:"嗯？怎么了？" -> 嗯？怎么了？
        const regex = /\.*:.*:(?:")?(.*?)"/g;
        const match = regex.exec(response);

        message = match?.[1]

        if (typeof message !== "string") {
            logger.error("Failed to parse response: " + response)
            return []
        }
    } catch (e) {
        logger.error(e)
        logger.error("Failed to parse response: " + response)
        return []
    }

    let resultElements: Element[][] = []


    let currentElements: Element[] = []
    // match ([at:id(??)])
    logger.debug("message: " + message)
    const atMatch = message.match(/\(at\-(\d+)(.*)?\)/g)
    logger.debug("atMatch: " + JSON.stringify(atMatch))
    if (atMatch) {
        for (const at of atMatch) {
            const id = at.match(/\d+/)

            logger.debug("id: " + id)
            if (id && id[0] !== "0") {
                currentElements.push(h.at(id[0]))
            } else {
                logger.error("Failed to parse at: " + at)
            }
        }
        const text = message.replace(/\(at\-(\d+)(.*)?\)/g, "")
        logger.debug("text: " + text)
        currentElements.push(h.text(text))
    } else {

        currentElements.push(h.text(message))
    }


    for (let currentElement of currentElements) {
        if (currentElement.type === "text") {
            // 手动切分句子
            let text = currentElement.attrs.content as string
            // 包括市面上常见的标点符号，直接切割成数组，但是需要保留标点符号

            // 如 "你好，我是一个机器人" -> ["你好，", "我是一个机器人。"]
            // 要求任何语言都能匹配到

            // , . ， 。 、 ? ？ ! ！
            const matchArray = splitSentence(text)


            for (const match of matchArray) {

                // 检查最后一个字符，如果为，。、,. 就去掉
                let lastChar = match[match.length - 1]
                //logger.debug("lastChar: " + lastChar)

                // array.some
                if (["，", "。", "、", ","].some(char => char === lastChar)) {
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

    if (resultElements[0]?.[0]?.type == "at") {
        resultElements[1].unshift(h.text(" "))
        resultElements[1].unshift(resultElements[0][0])

        resultElements.shift()
    }


    return resultElements
}


// 定义一个函数，用于分割句子
function splitSentence(sentence: string): string[] {
    // 定义一个正则表达式，用于匹配中英文的标点符号
    const regex = /([，。？！；：,?!;:])/g;
    // 定义一个数组，存放所有可能出现的标点符号
    const punctuations = ["，", "。", "？", "！", "；", "：", ",", "?", "!", ";", ":"];
    // 使用split方法和正则表达式来分割句子，并过滤掉空字符串
    const result = sentence.split(regex).filter((s) => s !== "");

    // 定义一个新的数组，用于存放最终的结果
    const final: string[] = [];
    // 遍历分割后的数组
    for (let i = 0; i < result.length; i++) {
        // 如果当前元素是一个标点符号
        if (punctuations.includes(result[i])) {
            final[final.length - 1] = final[final.length - 1].trim() + result[i]
        }
        // 否则，如果当前元素不是空格
        else if (result[i] !== " ") {
            // 把当前元素加入到最终的数组中
            final.push(result[i]);
        }
    }
    // 返回最终的数组
    return final;
}


async function formatMessage(messages: Message[], config: CharacterPlugin.Config, model: ChatHubBaseChatModel) {
    let maxTokens = config.maxTokens
    let currentTokens = 0

    currentTokens += await model.getNumTokens(config.defaultPrompt)
    currentTokens += await model.getNumTokens(config.historyPrompt)

    const calculatedMessages: string[] = []

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]

        const jsonMessage = `${message.name}:${message.id}:"${message.content}"`
        const jsonMessageToken = await model.getNumTokens(jsonMessage)

        if (currentTokens + jsonMessageToken > maxTokens - 4) {
            break
        } else {
            currentTokens += jsonMessageToken
            calculatedMessages.unshift(jsonMessage)
        }
    }

    logger.debug(`maxTokens: ${maxTokens}, currentTokens: ${currentTokens}`)

    const [splittedLeftMessages, splittedRightMessages] = spiltArray(calculatedMessages, calculatedMessages.length > 5 ? calculatedMessages.length - 5 : 0)


    const lastMessage = splittedRightMessages.pop()

    return [splittedLeftMessages.length < 1 ? "" : splittedLeftMessages.join(), splittedRightMessages.join(), lastMessage]
}

function spiltArray<T>(array: Array<T>, left: number): [Array<T>, Array<T>] {
    const leftArray: Array<T> = []
    const rightArray: Array<T> = []

    for (let i = 0; i < array.length; i++) {
        if (i < left) {
            leftArray.push(array[i])
        } else {
            rightArray.push(array[i])
        }
    }

    return [leftArray, rightArray]
}