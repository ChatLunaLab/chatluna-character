import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { Config } from '.'
import { Message } from './types'
import { BaseMessage } from '@langchain/core/messages'
import { Element, h, Logger } from 'koishi'
import { marked, Token } from 'marked'
import he from 'he'

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
        /^[.,;!?…·—–—()【】「」『』《》<>《》{}【】〔〕“”‘’'"\[\]@#￥%\^&\*\-+=|\\~？。`]+$/
    return regex.test(text)
}

function parseMessageContent(response: string) {
    let rawMessage = response.match(
        /<message_part>\s*(.*?)\s*<\/message_part>/s
    )?.[1]
    const status = response.match(/<status>(.*?)<\/status>/s)?.[1]

    if (rawMessage == null) {
        rawMessage = response.match(/<message[\s\S]*?<\/message>/)?.[0]
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

function processElements(elements: Element[]) {
    const resultElements: Element[][] = []

    const forEachElement = (elements: Element[]) => {
        for (let i = 0; i < elements.length; i++) {
            const element = elements[i]
            if (element.type === 'text') {
                if (element.attrs['code'] || element.attrs['span']) {
                    resultElements.push([element])
                    continue
                }

                const matchArray = splitSentence(
                    he.decode(element.attrs.content as string)
                ).filter((x) => x.length > 0)

                for (const match of matchArray) {
                    resultElements.push([h.text(match)])
                }
            } else if (['em', 'strong', 'del', 'p'].includes(element.type)) {
                forEachElement(element.children)
            } else {
                resultElements.push([element])
            }
        }
    }

    forEachElement(elements)
    return resultElements
}

interface TextMatch {
    type: 'at' | 'pre'
    content: string
    start: number
    end: number
}

export function processTextMatches(rawMessage: string, useAt: boolean = true) {
    const currentElements: Element[] = []
    let parsedMessage = ''

    // 获取所有匹配并排序
    const matches: TextMatch[] = [
        ...matchAt(rawMessage).map((m) => ({
            type: 'at' as const,
            content: m.at,
            start: m.start,
            end: m.end
        })),
        ...matchPre(rawMessage).map((m) => ({
            type: 'pre' as const,
            content: m.pre,
            start: m.start,
            end: m.end
        }))
    ].sort((a, b) => a.start - b.start)

    if (matches.length === 0) {
        parsedMessage = rawMessage
        currentElements.push(...transform(rawMessage))
        return { currentElements, parsedMessage }
    }

    let lastIndex = 0
    for (const match of matches) {
        const before = rawMessage.substring(lastIndex, match.start)

        if (before.length > 0) {
            parsedMessage += before
            currentElements.push(...transform(before))
        }

        if (match.type === 'at') {
            if (useAt) {
                currentElements.push(h.at(match.content))
            }
        } else {
            // pre
            parsedMessage += match.content
            currentElements.push(
                h('text', { span: true, content: match.content })
            )
        }

        lastIndex = match.end
    }

    const after = rawMessage.substring(lastIndex)
    if (after.length > 0) {
        parsedMessage += after
        currentElements.push(...transform(after))
    }

    return { currentElements, parsedMessage }
}

export function parseResponse(response: string, useAt: boolean = true) {
    try {
        const { rawMessage, messageType, status, sticker } =
            parseMessageContent(response)

        const { currentElements, parsedMessage } = processTextMatches(
            rawMessage,
            useAt
        )
        const resultElements = processElements(currentElements)

        // Handle special case for leading @mentions
        if (
            resultElements[0]?.[0]?.type === 'at' &&
            resultElements.length > 1
        ) {
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
    } catch (e) {
        logger.error(e)
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
        const message = messages[i]

        const xmlMessage = `<message type='text' name='${message.name}' id='${message.id}'>${message.content}</message>`

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
