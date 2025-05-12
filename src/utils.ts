import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { Config } from '.'
import { Message, SearchAction } from './types'
import { BaseMessage } from '@langchain/core/messages'
import { Context, Element, h, Logger, Session } from 'koishi'
import { marked, Token } from 'marked'
import he from 'he'
import { PromptTemplate } from '@langchain/core/prompts'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { EmptyEmbeddings } from 'koishi-plugin-chatluna/llm-core/model/in_memory'
import { StructuredTool } from '@langchain/core/tools'

export function isEmoticonStatement(
    text: string,
    elements: Element[]
): 'emoji' | 'text' | 'span' {
    if (elements.length === 1 && elements[0].attrs['span']) {
        return 'span'
    }

    const regex =
        /^[\p{P}\p{S}\p{Z}\p{M}\p{N}\p{L}\s]*\p{So}[\p{P}\p{S}\p{Z}\p{M}\p{N}\p{L}\s]*$/u
    return regex.test(text) ? 'emoji' : 'text'
}

export function isOnlyPunctuation(text: string): boolean {
    // 匹配中英文标点符号
    const regex =
        /^[.,;!?…·—–—()【】「」『』《》<>《》{}【】〔〕"":'\[\]@#￥%\^&\*\-+=|\\~？。`]+$/
    return regex.test(text)
}

function parseMessageContent(response: string) {
    let rawMessage = response.match(
        /<message_part>\s*(.*?)\s*<\/message_part>/s
    )?.[1]
    const status = response.match(/<status>(.*?)<\/status>/s)?.[1]

    if (rawMessage == null) {
        const matches = response.match(/<message[\s\S]*?<\/message>/gm)
        rawMessage = matches ? matches[matches.length - 1] : undefined
    }

    if (rawMessage == null) {
        throw new Error('Failed to parse response: ' + response)
    }

    const tempJson = parseXmlToObject(rawMessage)
    return {
        rawMessage: tempJson.content,
        messageType: tempJson.type,
        status,
        sticker: tempJson.sticker
    }
}

export async function processElements(
    elements: Element[],
    voiceRender?: (element: h) => Promise<h[]>
) {
    const resultElements: Element[][] = []

    const forEachElement = async (elements: Element[]) => {
        for (let i = 0; i < elements.length; i++) {
            const element = elements[i]
            if (element.type === 'text') {
                if (element.attrs['code'] || element.attrs['span']) {
                    resultElements.push([element])
                    continue
                } else if (element.attrs['voice'] && voiceRender) {
                    resultElements.push(await voiceRender(element))
                }

                const matchArray = splitSentence(
                    he.decode(element.attrs.content as string)
                ).filter((x) => x.length > 0)

                for (const match of matchArray) {
                    resultElements.push([h.text(match)])
                }
            } else if (['em', 'strong', 'del', 'p'].includes(element.type)) {
                await forEachElement(element.children)
            } else {
                resultElements.push([element])
            }
        }
    }

    await forEachElement(elements)
    return resultElements
}

interface TextMatch {
    type: 'at' | 'pre' | 'emo' | 'voice' | 'sticker'
    content: string
    start: number
    end: number
    children?: TextMatch[]
}

export function processTextMatches(rawMessage: string, useAt: boolean = true) {
    const currentElements: Element[] = []
    let parsedMessage = ''

    // 使用自定义 lexer 解析文本
    const tokens: TextMatch[] = textMatchLexer(rawMessage)

    if (tokens.length === 0) {
        parsedMessage = rawMessage
        currentElements.push(...transform(rawMessage))
        return { currentElements, parsedMessage }
    }

    let lastIndex = 0
    for (const token of tokens) {
        const before = rawMessage.substring(lastIndex, token.start)

        if (before.trim().length > 0) {
            parsedMessage += before
            currentElements.push(...transform(before))
        }

        if (token.type === 'at') {
            if (useAt) {
                // Handle special case for leading @mentions
                currentElements.push(h.text(' '))
                currentElements.push(h.at(token.content))
            }
        } else if (token.type === 'emo') {
            currentElements.push(
                h('text', { span: true, content: token.content })
            )
        } else if (token.type === 'pre') {
            parsedMessage += token.content
            let children: Element[] = []

            // 处理 children
            if (!token.children) {
                children.push(h('text', { span: true, content: token.content }))
            } else {
                const { currentElements } = processTextMatches(
                    token.content,
                    useAt
                )
                children.push(...currentElements)
            }

            children = children.reduce(
                (acc, element) =>
                    acc.concat(
                        element.type === 'p'
                            ? element.children || element
                            : element
                    ),
                []
            )

            currentElements.push(h('message', { span: true, children }))
        } else if (token.type === 'voice') {
            currentElements.push(
                h('text', { voice: true, content: token.content })
            )
        } else if (token.type === 'sticker') {
            currentElements.push(h('message', [h.image(token.content)]))
        }

        lastIndex = token.end
    }

    const after = rawMessage.substring(lastIndex)
    if (after.trim().length > 0) {
        parsedMessage += after
        currentElements.push(...transform(after))
    }

    return { currentElements, parsedMessage }
}

// 自定义 lexer 函数
function textMatchLexer(input: string): TextMatch[] {
    const tokens: TextMatch[] = []
    const stack: { type: 'pre'; start: number; children: TextMatch[] }[] = []
    let index = 0
    let inPre = false

    while (index < input.length) {
        // 检测 <pre> 标签
        if (input.startsWith('<pre>', index)) {
            stack.push({ type: 'pre', start: index, children: [] })
            index += 5 // 跳过 <pre>
            inPre = true
            continue
        }

        // 检测 </pre> 标签
        if (input.startsWith('</pre>', index)) {
            const { start } = stack.pop() || {}
            if (start !== undefined) {
                const content = input.substring(start + 5, index) // 获取 <pre> 内的内容
                // 将内容分割为文本和 at 元素
                const innerTokens = textMatchLexer(content)
                tokens.push({
                    type: 'pre',
                    content,
                    start,
                    end: index + 6, // 结束位置
                    children: innerTokens // 添加子元素
                })
            }
            index += 6 // 跳过 </pre>
            inPre = false
            continue
        }

        // 检测 <at> 标签
        if (!inPre && input.startsWith('<at', index)) {
            const endTagIndex = input.indexOf('</at>', index)
            if (endTagIndex !== -1) {
                // <at name="xx">xxx</at>
                // get xxx
                const atTagPattern = /<at\b[^>]*>(.*?)<\/at>/
                const match = atTagPattern.exec(
                    input.substring(index, endTagIndex + 5)
                )

                if (!match) {
                    throw new Error(
                        `Invalid <at> tag at position ${index}: missing content`
                    )
                }

                const content = match[1] // 获取 <at> 和 </at> 之间的内容
                tokens.push({
                    type: 'at',
                    content,
                    start: index,
                    end: endTagIndex + 5 // 结束位置
                })

                index = endTagIndex + 5 // 跳过 </at>
                continue
            }
        }

        // 检查 <emo> 标签
        if (input.startsWith('<emo>', index)) {
            const endTagIndex = input.indexOf('</emo>', index)
            if (endTagIndex !== -1) {
                const content = input.substring(index + 5, endTagIndex) // 获取 <emo> 和 </emo> 之间的内容
                tokens.push({
                    type: 'emo',
                    content,
                    start: index,
                    end: endTagIndex + 6 // 结束位置
                })
                index = endTagIndex + 6 // 跳过 </emo>
                continue
            }
        }

        // 检查 <voice> 标签
        if (input.startsWith('<voice>', index)) {
            const endTagIndex = input.indexOf('</voice>', index)
            if (endTagIndex !== -1) {
                const content = input.substring(index + 7, endTagIndex) // 获取 <voice> 和 </voice> 之间的内容
                tokens.push({
                    type: 'voice',
                    content,
                    start: index,
                    end: endTagIndex + 8 // 结束位置
                })
                index = endTagIndex + 8 // 跳过 </voice>
                continue
            }
        }

        // 检查 <sticker> 标签
        if (input.startsWith('<sticker>', index)) {
            const endTagIndex = input.indexOf('</sticker>', index)
            if (endTagIndex !== -1) {
                const content = input.substring(index + 9, endTagIndex) // 获取 <sticker> 和 </sticker> 之间的内容
                tokens.push({
                    type: 'sticker',
                    content,
                    start: index,
                    end: endTagIndex + 10 // 结束位置
                })
                index = endTagIndex + 10 // 跳过 </sticker>
                continue
            }
        }

        // 普通文本处理
        index++
    }

    return tokens
}

export async function parseResponse(
    response: string,
    useAt: boolean = true,
    voiceRender?: (element: h) => Promise<h[]>
) {
    try {
        const { rawMessage, messageType, status, sticker } =
            parseMessageContent(response)

        const { currentElements, parsedMessage } = processTextMatches(
            rawMessage,
            useAt
        )
        const resultElements = await processElements(
            currentElements,
            voiceRender
        )

        return {
            elements: resultElements,
            rawMessage: parsedMessage,
            status,
            sticker,
            messageType
        }
    } catch (e) {
        logger?.error(e)
        throw new Error('Failed to parse response: ' + response)
    }
}

export function splitSentence(text: string): string[] {
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

export function matchAt(str: string) {
    // <at name='name'>id</at>
    // <at(.*?)>id</at>
    // get id, if the name is empty
    const atRegex = /<at[^>]*>(.*?)<\/at>/gs
    return [...str.matchAll(atRegex)].map((item) => {
        return {
            at: item[1],
            start: item.index,
            end: item.index + item[0].length
        }
    })
}

export function matchPre(str: string) {
    const preRegex = /<pre>(.*?)<\/pre>/gs
    // <pre>emo</pre>
    return [...str.matchAll(preRegex)].map((item) => {
        return {
            pre: item[1],
            start: item.index,
            end: item.index + item[0].length
        }
    })
}

export function formatTimestamp(timestamp: number | Date): string {
    const date = timestamp instanceof Date ? timestamp : new Date(timestamp)
    return date.toLocaleString('en-US', {
        month: 'numeric',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
        timeZoneName: 'short'
    })
}

function formatMessageString(message: Message) {
    let xmlMessage = `<message type='text' name='${message.name}' id='${message.id}'`

    if (message.timestamp) {
        const timestampString = formatTimestamp(message.timestamp)
        xmlMessage += ` timestamp='${timestampString}'`
    }

    if (message.quote) {
        xmlMessage += ` quote='${formatMessageString(message.quote)}'`
    }

    xmlMessage += `>${message.content}</message>`

    return xmlMessage
}

/**
 * 预处理内容，移除可能的 markdown 代码块标记
 */
export function preprocessContent(content: string): string {
    // 移除 markdown 代码块标记 (```json 和 ```)
    content = content.replace(
        /```(?:json|javascript|js)?\s*([\s\S]*?)```/g,
        '$1'
    )

    // 移除前后可能的空白字符
    content = content.trim()

    return content
}

/**
 * 尝试解析 JSON，失败时返回 null
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tryParseJSON(content: string): any {
    return JSON.parse(content)
}

/**
 * 尝试修复常见的 JSON 格式错误
 */
export function attemptToFixJSON(content: string): string {
    let fixedContent = content

    // 修复缺少引号的键名
    fixedContent = fixedContent.replace(
        /(\{|\,)\s*([a-zA-Z0-9_]+)\s*\:/g,
        '$1"$2":'
    )

    // 修复使用单引号而非双引号的情况
    fixedContent = fixedContent.replace(/(\{|\,)\s*'([^']+)'\s*\:/g, '$1"$2":')
    fixedContent = fixedContent.replace(/\:\s*'([^']+)'/g, ':"$1"')

    // 修复缺少逗号的情况
    fixedContent = fixedContent.replace(/"\s*\}\s*"/g, '","')
    fixedContent = fixedContent.replace(/"\s*\{\s*"/g, '",{"')

    // 修复多余的逗号
    fixedContent = fixedContent.replace(/,\s*\}/g, '}')
    fixedContent = fixedContent.replace(/,\s*\]/g, ']')

    // 修复不完整的数组
    if (fixedContent.includes('[') && !fixedContent.includes(']')) {
        fixedContent += ']'
    }

    // 修复不完整的对象
    if (fixedContent.includes('{') && !fixedContent.includes('}')) {
        fixedContent += '}'
    }

    // 如果内容不是以 [ 开头但包含 [ 字符，尝试提取数组部分
    if (!fixedContent.trim().startsWith('[') && fixedContent.includes('[')) {
        const arrayMatch = fixedContent.match(/\[([\s\S]*)\]/)
        if (arrayMatch && arrayMatch[0]) {
            fixedContent = arrayMatch[0]
        }
    }

    return fixedContent
}

export function parseSearchAction(action: string): SearchAction {
    action = preprocessContent(action)

    try {
        return tryParseJSON(action) as SearchAction
    } catch (e) {
        action = attemptToFixJSON(action)

        try {
            return tryParseJSON(action) as SearchAction
        } catch (e) {
            logger?.error(`parse search action failed: ${e}`)
        }
    }

    if (action.includes('[skip]')) {
        return {
            action: 'skip',
            thought: 'skip the search'
        }
    }

    return {
        action: 'skip',
        thought: 'skip the search'
    }
}

export async function getSearchKeyword(
    config: Config,
    session: Session,
    messages: Message[],
    model: ChatLunaChatModel
) {
    if (
        config.searchKeywordExtraModel != null &&
        config.searchKeywordExtraModel.length > 0
    ) {
        const [platform, modelName] = parseRawModelName(
            config.searchKeywordExtraModel
        )
        try {
            model = await session.app.chatluna.createChatModel(
                platform,
                modelName
            )
        } catch (e) {
            logger.error(e)
        }
    }

    const userNames: Record<string, string> = {
        [session.bot.selfId]: 'bot'
    }

    let currentUser = 0

    function getUserName(id: string): string {
        const name = userNames[id]

        if (name) {
            return name
        }

        userNames[id] = `user${currentUser++}`
        return userNames[id]
    }

    const formattedMessages = messages.map((message) => {
        let content = message.content

        // match <at name='xx'>xxx</at>
        const atMatch = /<at\s+name='([^']*)'>.*?<\/at>/g

        content = content.replace(atMatch, (match, id) => {
            const name = getUserName(id)
            return ` @${name} `
        })

        if (message.id === session.bot.userId) {
            return `bot: ${content}`
        }

        return `${getUserName(message.id)}: ${content}`
    })

    // logger.debug('formattedMessages: ', formattedMessages)

    const promptTemplate = PromptTemplate.fromTemplate(config.searchPrompt)

    const prompt = await promptTemplate.invoke({
        chat_history: formattedMessages.join('\n'),
        // xx: -> ""
        question: formattedMessages[formattedMessages.length - 1],
        time: formatTimestamp(new Date())
    })

    const modelResult = getMessageContent(
        await model
            .invoke(prompt, {
                temperature: 0
            })
            .then((message) => message.content)
    )

    const searchAction = parseSearchAction(modelResult)

    logger.debug('Search Action', modelResult)

    return searchAction
}

export async function executeSearchAction(
    action: SearchAction,
    searchTool: StructuredTool,
    webBrowserTool: StructuredTool
) {
    const searchResults: {
        title: string
        description: string
        url: string
    }[] = []

    if (!Array.isArray(action.content)) {
        logger?.error(
            `search action content is not an array: ${JSON.stringify(action)}`
        )
        return
    }

    const searchByQuestion = async (question: string) => {
        // Use the rephrased question for search
        const rawSearchResults = await searchTool.invoke(question)

        const parsedSearchResults =
            (JSON.parse(rawSearchResults as string) as unknown as {
                title: string
                description: string
                url: string
            }[]) ?? []

        searchResults.push(...parsedSearchResults)
    }

    const searchByUrl = async (url: string) => {
        const text = (await webBrowserTool.invoke({
            action: 'text',
            url
        })) as string

        searchResults.push({
            title: url,
            description: text,
            url
        })
    }

    if (action.action === 'url') {
        await Promise.all(action.content.map((url) => searchByUrl(url)))
    } else if (action.action === 'search') {
        await Promise.all(
            action.content.map((question) => searchByQuestion(question))
        )
    }

    // format questions

    const formattedSearchResults = searchResults.map((result) => {
        // sort like json style
        // title: xx, xx: xx like
        let resultString = ''

        for (const key in result) {
            resultString += `${key}: ${result[key]}, `
        }

        resultString = resultString.slice(0, -2)

        return resultString
    })

    return formattedSearchResults.join('\n\n')
}

export function formatSearchResult(searchResult: string) {
    const parsedSearchResult = JSON.parse(searchResult) as {
        title: string
        description: string
        url: string
    }[]

    const formattedSearchResults = parsedSearchResult.map((result) => {
        // sort like json style
        // title: xx, xx: xx like
        let resultString = ''

        for (const key in result) {
            if (key === 'title' || key === 'description') {
                resultString += `${key}: ${result[key]}, `
            }
        }

        resultString = resultString.slice(0, -2)

        return resultString
    })

    return formattedSearchResults.join('\n')
}

export function createEmbeddingsModel(ctx: Context) {
    try {
        const modelName = ctx.chatluna.config.defaultEmbeddings

        const [platform, model] = parseRawModelName(modelName)

        return ctx.chatluna.createEmbeddings(platform, model)
    } catch (e) {
        logger.error(e)
        return new EmptyEmbeddings()
    }
}

export async function formatMessage(
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
        const xmlMessage = formatMessageString(messages[i])

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

export async function formatCompletionMessages(
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

export function parseXmlToObject(xml: string) {
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
            logger.debug(`Failed to parse ${name} attribute: ${xml}`)
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

const tagRegExp = /<(\/?)([^!\s>/]+)([^>]*?)\s*(\/?)>/

function renderToken(token: Token): h {
    if (token.type === 'code') {
        return h('text', { code: true, content: token.text + '\n' })
    } else if (token.type === 'paragraph') {
        return h('p', render(token.tokens))
    } else if (token.type === 'image') {
        return h.image(token.href)
    } else if (token.type === 'blockquote') {
        return h('text', { content: token.text + '\n' })
    } else if (token.type === 'text') {
        return h('text', { content: token.text })
    } else if (token.type === 'em') {
        return h('em', render(token.tokens))
    } else if (token.type === 'strong') {
        return h('strong', render(token.tokens))
    } else if (token.type === 'del') {
        return h('del', render(token.tokens))
    } else if (token.type === 'link') {
        return h('a', { href: token.href }, render(token.tokens))
    } else if (token.type === 'html') {
        const cap = tagRegExp.exec(token.text)
        if (!cap) {
            return h('text', { content: token.text })
        }
        if (cap[2] === 'img') {
            if (cap[1]) return
            const src = cap[3].match(/src="([^"]+)"/)
            if (src) return h.image(src[1])
        }
    }

    return h('text', { content: token.raw })
}

function render(tokens: Token[]): h[] {
    return tokens.map(renderToken).filter(Boolean)
}

export function transform(source: string): h[]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function transform(source: TemplateStringsArray, ...args: any[]): h[]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function transform(source: any, ...args: any[]) {
    if (!source) return []
    if (Array.isArray(source)) {
        source =
            args.map((arg, index) => source[index] + arg).join('') +
            source[args.length]
    }
    return render(marked.lexer(source))
}

let logger: Logger

export function setLogger(setLogger: Logger) {
    logger = setLogger
}
