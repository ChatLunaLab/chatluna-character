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
    const status = response.match(/<status>(.*?)<\/status>/s)?.[1]

    const patterns = [
        /<message_part>\s*(.*?)\s*<\/message_part>/s,
        /<output>\s*(.*?)\s*<\/output>/s,
        /<message[\s\S]*?<\/message>/gm
    ]

    let rawMessage: string | undefined
    for (const pattern of patterns) {
        const match = response.match(pattern)
        if (match) {
            rawMessage =
                Array.isArray(match) && pattern.global ? match.pop() : match[1]
            break
        }
    }

    if (!rawMessage) {
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
    voiceRender?: (element: h) => Promise<h[]>,
    config?: Config
) {
    const result: Element[][] = []
    const last = () => result[result.length - 1]
    const canAppendAt = () => last()?.length === 2 && last()[1].type === 'at'

    const process = async (els: Element[]) => {
        for (const el of els) {
            if (el.type === 'text') {
                if (el.attrs.code || el.attrs.span) {
                    result.push([el])
                } else if (el.attrs.voice && voiceRender) {
                    result.push(await voiceRender(el))
                } else if (config?.splitSentence) {
                    for (const text of splitSentence(
                        he.decode(el.attrs.content)
                    ).filter(Boolean)) {
                        canAppendAt()
                            ? last().push(h.text(text))
                            : result.push([h.text(text)])
                    }
                } else {
                    canAppendAt() ? last().push(el) : result.push([el])
                }
            } else if (['em', 'strong', 'del', 'p'].includes(el.type)) {
                await process(el.children)
            } else if (el.type === 'at') {
                last()
                    ? last().push(h.text(' '), el)
                    : result.push([h.text(' '), el])
            } else if (el.type === 'img' && !el.attrs.sticker) {
                last() ? last().push(el) : result.push([el])
            } else if (el.type === 'message' && el.attrs.span) {
                await process(el.children)
            } else {
                result.push([el])
            }
        }
    }

    await process(elements)
    return result
}

interface TextMatch {
    type: 'at' | 'pre' | 'emo' | 'voice' | 'sticker' | 'message' | 'img'
    content: string
    extra?: Record<string, string>
    start: number
    end: number
    children?: TextMatch[]
}

export function processTextMatches(rawMessage: string, useAt: boolean = true) {
    const currentElements: Element[] = []
    let parsedMessage = ''
    const tokens = textMatchLexer(rawMessage)

    if (tokens.length === 0) {
        return {
            currentElements: transform(rawMessage),
            parsedMessage: rawMessage
        }
    }

    let lastIndex = 0
    for (const token of tokens) {
        const before = rawMessage.substring(lastIndex, token.start)
        if (before.trim()) {
            parsedMessage += before
            currentElements.push(...transform(before))
        }

        switch (token.type) {
            case 'at':
                if (useAt) {
                    currentElements.push(h.at(token.content))
                }
                break
            case 'emo':
                currentElements.push(
                    h('text', { span: true, content: token.content })
                )
                break
            case 'pre':
            case 'message': {
                parsedMessage += token.content
                const children = token.children
                    ? processTextMatches(token.content, useAt).currentElements
                    : [h('text', { span: true, content: token.content })]

                currentElements.push(h('message', { span: true }, ...children))
                break
            }
            case 'voice':
                currentElements.push(
                    h('message', [
                        h('text', {
                            voice: true,
                            content: token.content,
                            extra: token.extra
                        })
                    ])
                )
                break
            case 'sticker':
                currentElements.push(h('message', [h.image(token.content)]))
                break
            case 'img':
                currentElements.push(
                    h.image(token.content, {
                        sticker: false
                    })
                )
                break
        }

        lastIndex = token.end
    }

    const after = rawMessage.substring(lastIndex)
    if (after.trim()) {
        parsedMessage += after
        currentElements.push(...transform(after))
    }

    return { currentElements, parsedMessage }
}

function textMatchLexer(input: string): TextMatch[] {
    const tokens: TextMatch[] = []

    let index = 0

    const tagMappings = [
        { open: '<pre>', close: '</pre>', type: 'pre' as const, nested: true },
        {
            open: '<message>',
            close: '</message>',
            type: 'message' as const,
            nested: true
        },
        { open: '<emo>', close: '</emo>', type: 'emo' as const, nested: false },
        {
            open: '<sticker>',
            close: '</sticker>',
            type: 'sticker' as const,
            nested: false
        },
        {
            open: '<img>',
            close: '</img>',
            type: 'img' as const,
            nested: false
        }
    ]

    const stack: { type: (typeof tagMappings)[0]['type']; start: number }[] = []

    while (index < input.length) {
        let matched = false

        for (const { open, close, type, nested } of tagMappings) {
            if (input.startsWith(open, index)) {
                if (nested) {
                    stack.push({ type, start: index })
                    index += open.length
                    matched = true
                    break
                } else if (stack.length === 0) {
                    const endIndex = input.indexOf(close, index)
                    if (endIndex !== -1) {
                        const content = input.substring(
                            index + open.length,
                            endIndex
                        )
                        tokens.push({
                            type,
                            content,
                            start: index,
                            end: endIndex + close.length
                        })
                        index = endIndex + close.length
                        matched = true
                        break
                    }
                }
            } else if (nested && input.startsWith(close, index)) {
                const stackItem = stack.pop()
                if (stackItem?.type === type) {
                    const content = input.substring(
                        stackItem.start + open.length,
                        index
                    )
                    const children = textMatchLexer(content)

                    tokens.push({
                        type,
                        content,
                        start: stackItem.start,
                        end: index + close.length,
                        children
                    })
                    index += close.length
                    matched = true
                    break
                }
            }
        }

        if (!matched && stack.length === 0 && input.startsWith('<at', index)) {
            const endIndex = input.indexOf('</at>', index)
            if (endIndex !== -1) {
                const match = /<at\b[^>]*>(.*?)<\/at>/.exec(
                    input.substring(index, endIndex + 5)
                )
                if (match) {
                    tokens.push({
                        type: 'at',
                        content: match[1],
                        start: index,
                        end: endIndex + 5
                    })
                    index = endIndex + 5
                    matched = true
                }
            }
        }

        if (
            !matched &&
            stack.length === 0 &&
            input.startsWith('<voice', index)
        ) {
            const openTagEnd = input.indexOf('>', index)
            const endIndex = input.indexOf('</voice>', index)
            if (openTagEnd !== -1 && endIndex !== -1) {
                const hasAttributes = input.charAt(index + 6) === ' '
                let extra: Record<string, string> | undefined

                if (hasAttributes) {
                    const attributesString = input.substring(
                        index + 6,
                        openTagEnd
                    )
                    const idMatch =
                        attributesString.match(/id=['"]([^'"]+)['"]/)
                    if (idMatch) {
                        extra = { id: idMatch[1] }
                    }
                }

                const content = input.substring(openTagEnd + 1, endIndex)
                tokens.push({
                    type: 'voice',
                    content,
                    extra,
                    start: index,
                    end: endIndex + 8
                })
                index = endIndex + 8
                matched = true
            }
        }

        if (!matched) {
            index++
        }
    }

    return tokens
}

export async function parseResponse(
    response: string,
    useAt: boolean = true,
    voiceRender?: (element: h) => Promise<h[]>,
    config?: Config
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
            voiceRender,
            config
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
    if (isOnlyPunctuation(text)) return [text]

    const scorePattern = /\d+[:：]\d+/g
    const scoreMatches = [...text.matchAll(scorePattern)]
    const protectedRanges = scoreMatches.map((m) => [
        m.index,
        m.index + m[0].length
    ])

    const isProtected = (index: number) =>
        protectedRanges.some(([start, end]) => index >= start && index < end)

    const lines = text
        .split('\n')
        .filter((l) => l.trim())
        .join(' ')
    const punct = [
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
    const retain = new Set(['?', '!', '？', '！', '~'])
    const mustSplit = new Set(['。', '?', '！', '!', ':', '：'])
    const brackets = [
        '【',
        '】',
        '《',
        '》',
        '(',
        ')',
        '（',
        '）',
        '“',
        '”',
        '‘',
        '’',
        "'",
        "'",
        '"',
        '"'
    ]

    const result = []
    let current = ''
    let bracketLevel = 0

    for (let i = 0; i < lines.length; i++) {
        const char = lines[i]
        const next = lines[i + 1]

        if (isProtected(i)) {
            current += char
            continue
        }

        const bracketIdx = brackets.indexOf(char)
        if (bracketIdx > -1) {
            bracketLevel += bracketIdx % 2 === 0 ? 1 : -1
            current += char

            if (bracketLevel === 0 && current.length > 1) {
                result.push(current)
                current = ''
            } else if (bracketLevel === 1 && bracketIdx % 2 === 0) {
                if (current.length > 1) result.push(current)
                current = char
            }
            continue
        }

        if (bracketLevel > 0) {
            current += char
            continue
        }

        if (!punct.includes(char)) {
            current += char
            continue
        }

        if (retain.has(char)) current += char
        if (retain.has(next) && retain.has(char) && next !== char) i++

        if (current.length > 0 && (current.length > 2 || mustSplit.has(char))) {
            result.push(current)
            current = ''
        } else if (!retain.has(char) && current.length > 0) {
            current += char
        }
    }

    if (current) result.push(current)
    return result.filter((item) => !punct.includes(item))
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
    let xmlMessage = `<message name='${message.name}' id='${message.id}'`

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
    imageMessages: BaseMessage[],
    humanMessage: BaseMessage,
    config: Config,
    model: ChatLunaChatModel
) {
    const maxTokens = config.maxTokens - 600
    const systemMessage = messages.shift()
    let currentTokens = 0

    currentTokens += await model.getNumTokens(
        getMessageContent(systemMessage.content)
    )
    currentTokens += await model.getNumTokens(
        getMessageContent(humanMessage.content)
    )

    const result: BaseMessage[] = []

    result.unshift(humanMessage)

    for (const imageMessage of imageMessages) {
        // Only calculate the text content
        const imageTokens = await model.getNumTokens(
            getMessageContent(imageMessage.content)
        )
        result.unshift(imageMessage)
        if (currentTokens + imageTokens > maxTokens) {
            break
        }
        currentTokens += imageTokens
    }

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
    const messageMatches = xml.match(/<message(?:\s+.*?)?>(.*?)<\/message>/gs)

    if (!messageMatches) {
        throw new Error('Failed to parse response: ' + xml)
    }

    if (messageMatches.length > 1) {
        return {
            name: '',
            id: '',
            type: 'text',
            sticker: '',
            content: xml
        }
    }

    const singleMatch = xml.match(/<message(?:\s+(.*?))?>(.+?)<\/message>/s)
    if (!singleMatch) {
        throw new Error('Failed to parse response: ' + xml)
    }

    const [, attributes = '', content = ''] = singleMatch

    const getAttr = (name: string): string => {
        if (!attributes) return ''
        const attrMatch = attributes.match(
            new RegExp(`${name}=['"]?([^'"]+)['"]?`)
        )
        return attrMatch?.[1] || ''
    }

    return {
        name: getAttr('name'),
        id: getAttr('id'),
        type: getAttr('type') || 'text',
        sticker: getAttr('sticker'),
        content
    }
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
