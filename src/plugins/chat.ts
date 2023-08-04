import { Context, Element, Schema, h, sleep } from 'koishi';
import CharacterPlugin from '..';
import { Factory } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/chat/factory"
import { createLogger } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/utils/logger"
import { service } from '..';
import { PromptTemplate } from 'langchain';
import { Message } from '../types';
import { ChatHubBaseChatModel } from '@dingyi222666/koishi-plugin-chathub/lib/llm-core/model/base';
import { HumanMessage, SystemMessage } from 'langchain/schema';
import { parse } from 'path';


const logger = createLogger("chathub-character/plugins/chat")

export async function apply(ctx: Context, config: CharacterPlugin.Config) {

    const modelNameSpitted = config.model.split("/")
    const model = await ctx.chathub.createChatModel(modelNameSpitted[0], modelNameSpitted[1])

    const completionPrompt = PromptTemplate.fromTemplate(config.defaultPrompt)

    service.collect(async (session, messages) => {

        const finalMessage = await formatMessage(messages, config, model)

        const formattedPrompt = await completionPrompt.format({
            time: new Date().toLocaleString(),
        })

        logger.debug("messages: " + JSON.stringify(messages))

        const responseMessage = await model.call([
            new SystemMessage(formattedPrompt),
            new HumanMessage("切记，你的回复不能超过15个字！\n" + finalMessage)
        ])


        logger.debug("model response: " + responseMessage.content)

        const response = parseResponse(responseMessage.content)

        if (response.length < 1) {
            service.mute(session, config.muteTime)
            return
        }
        for (const elements of response) {
            const text = elements.map(element => element.attrs.content ?? "").join("")
            await sleep(text.length * config.sleepTime)
            session.send(elements)
        }

        service.broadcastOnBot(session, response.flat())

    })
}


function parseResponse(response: string) {
    let message: string
    try {
        // parse [name:id:"content"] to content
        // like [旧梦旧念:2187778735:"嗯？怎么了？"] -> 嗯？怎么了？
        const regex = /\[.*:.*:(?:")?(.*?)"]/g;
        const match = regex.exec(response);


        message = match[1]

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
            if (id) {
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


    const calculatedMessages: string[] = []

    for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]

        const jsonMessage = `[${message.name}:${message.id}:"${message.content}"]`
        const jsonMessageToken = await model.getNumTokens(jsonMessage)

        if (currentTokens + jsonMessageToken > maxTokens - 4) {
            break
        } else {
            currentTokens += jsonMessageToken
            calculatedMessages.unshift(jsonMessage)
        }
    }

    logger.debug(`maxTokens: ${maxTokens}, currentTokens: ${currentTokens}`)

    return calculatedMessages.join("\n")
}