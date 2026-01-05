import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { Config } from '.'
import { ChatLunaChain, Message } from './types'
import {
    AIMessageChunk,
    BaseMessage,
    HumanMessage
} from '@langchain/core/messages'
import { Context, Element, h, Logger, Session } from 'koishi'
import { marked, Token } from 'marked'
import he from 'he'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import type {} from 'koishi-plugin-chatluna/services/chat'
import { PresetTemplate } from 'koishi-plugin-chatluna/llm-core/prompt'
import { ChatLunaChatPrompt } from 'koishi-plugin-chatluna/llm-core/chain/prompt'
import {
    createAgentExecutor,
    createToolsRef
} from 'koishi-plugin-chatluna/llm-core/agent'
import { RunnableLambda } from '@langchain/core/runnables'
import { computed, ComputedRef } from 'koishi-plugin-chatluna'

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
        /<output>(.*?)<\/output>/gs,
        /<message_part>(.*?)<\/message_part>/gs,
        /<message[\s\S]*?<\/message>/gm
    ]

    let rawMessage: string | undefined
    for (const pattern of patterns) {
        const matches = Array.from(response.matchAll(pattern))
        if (matches.length > 0) {
            rawMessage =
                pattern === patterns[2]
                    ? matches[matches.length - 1][0]
                    : matches[matches.length - 1][1]
            break
        }
    }

    if (!rawMessage) {
        throw new Error('Failed to parse response: ' + response)
    }

    const tempJson = parseXmlToObject(rawMessage)
    return {
        // Keep the original `<message ...>...</message>` so we can read attributes
        // (e.g. `quote="..."`) during element parsing.
        rawMessage,
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
    const last = () => result.at(-1)
    const canAppendAt = () => last()?.at(-2)?.type === 'at'

    type PendingQuote = { id?: string; used: boolean }

    const ensureLast = () => {
        if (!last()) result.push([])
    }

    const appendToLast = (items: Element[], pendingQuote?: PendingQuote) => {
        if (items.length === 0) return
        ensureLast()
        const target = last()

        // Attach quote to the first fragment that actually receives content.
        if (pendingQuote?.id && !pendingQuote.used) {
            target.unshift(h('quote', { id: pendingQuote.id }))
            pendingQuote.used = true
        }

        target.push(...items)
    }

    const pushFragment = (items: Element[], pendingQuote?: PendingQuote) => {
        if (items.length === 0) {
            result.push([])
            return
        }

        if (pendingQuote?.id && !pendingQuote.used) {
            result.push([h('quote', { id: pendingQuote.id }), ...items])
            pendingQuote.used = true
            return
        }

        result.push(items)
    }

    const startNewFragmentIfNeeded = () => {
        if (last()?.length) result.push([])
    }

    const process = async (els: Element[], pendingQuote?: PendingQuote) => {
        for (const el of els) {
            if (el.type === 'text') {
                if (el.attrs.code || el.attrs.span) {
                    pushFragment([el], pendingQuote)
                } else if (el.attrs.voice && voiceRender) {
                    pushFragment(await voiceRender(el), pendingQuote)
                } else if (config?.splitSentence) {
                    for (const text of splitSentence(
                        he.decode(el.attrs.content)
                    ).filter(Boolean)) {
                        canAppendAt()
                            ? appendToLast([h.text(text)], pendingQuote)
                            : pushFragment([h.text(text)], pendingQuote)
                    }
                } else {
                    canAppendAt()
                        ? appendToLast([el], pendingQuote)
                        : pushFragment([el], pendingQuote)
                }
            } else if (['em', 'strong', 'del', 'p'].includes(el.type)) {
                el.children
                    ? await process(el.children, pendingQuote)
                    : pushFragment([el], pendingQuote)
            } else if (el.type === 'at') {
                last()
                    ? appendToLast([h.text(' '), el, h.text(' ')], pendingQuote)
                    : pushFragment([h.text(' '), el, h.text(' ')], pendingQuote)
            } else if (el.type === 'img' && !el.attrs.sticker) {
                last()
                    ? appendToLast([el], pendingQuote)
                    : pushFragment([el], pendingQuote)
            } else if (
                el.type === 'message' &&
                el.attrs.span &&
                el.attrs.block
            ) {
                // A top-level `<message ...>` block from the model output.
                // Use it as a boundary so each block can carry its own quote id.
                startNewFragmentIfNeeded()
                const blockQuote: PendingQuote | undefined = el.attrs.quote
                    ? { id: String(el.attrs.quote), used: false }
                    : undefined

                await process(el.children, blockQuote)
                startNewFragmentIfNeeded()
            } else if (el.type === 'message' && el.attrs.span) {
                await process(el.children, pendingQuote)
            } else if (el.type === 'face') {
                last()
                    ? appendToLast([el], pendingQuote)
                    : pushFragment([el], pendingQuote)
            } else {
                canAppendAt()
                    ? appendToLast([el], pendingQuote)
                    : pushFragment([el], pendingQuote)
            }
        }
    }

    await process(elements)

    // Align with ChatLuna sender: drop quote if the fragment contains incompatible types.
    for (const fragment of result) {
        if (fragment[0]?.type !== 'quote') continue
        const hasIncompatibleType = fragment.some(
            (element) => element.type === 'audio' || element.type === 'message'
        )
        if (hasIncompatibleType) fragment.shift()
    }

    return result.filter((fragment) => fragment.length > 0)
}

interface TextMatch {
    type:
        | 'at'
        | 'pre'
        | 'emo'
        | 'voice'
        | 'sticker'
        | 'message'
        | 'img'
        | 'face'
    content: string
    extra?: Record<string, string>
    start: number
    end: number
    children?: TextMatch[]
}

export function processTextMatches(
    rawMessage: string,
    useAt: boolean = true,
    markdownRender: boolean = true
) {
    const currentElements: Element[] = []
    let parsedMessage = ''
    const tokens = textMatchLexer(rawMessage)

    if (tokens.length === 0) {
        return {
            currentElements: markdownRender
                ? transform(rawMessage)
                : [h('text', { content: rawMessage })],
            parsedMessage: rawMessage
        }
    }

    let lastIndex = 0
    for (const token of tokens) {
        const before = rawMessage.substring(lastIndex, token.start)
        if (before.trim()) {
            parsedMessage += before
            if (markdownRender) {
                currentElements.push(...transform(before))
            } else {
                currentElements.push(h('text', { content: before }))
            }
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
                    ? processTextMatches(token.content, useAt, markdownRender)
                          .currentElements
                    : [h('text', { span: true, content: token.content })]

                const isTopLevelMessage = token.extra?.topLevel === 'true'
                const quoteId = isTopLevelMessage
                    ? token.extra?.quote
                    : undefined

                currentElements.push(
                    h(
                        'message',
                        {
                            span: true,
                            ...(isTopLevelMessage ? { block: true } : {}),
                            ...(quoteId ? { quote: quoteId } : {})
                        },
                        ...children
                    )
                )
                break
            }
            case 'face': {
                currentElements.push(
                    h('face', {
                        id: token.content
                    })
                )
                break
            }
            case 'voice':
                currentElements.push(
                    h('message', { span: true }, [
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
        if (markdownRender) {
            currentElements.push(...transform(after))
        } else {
            currentElements.push(h('text', { content: after }))
        }
    }

    return { currentElements, parsedMessage }
}

function textMatchLexer(input: string): TextMatch[] {
    const tokens: TextMatch[] = []

    let index = 0

    const tagMappings = [
        { open: '<pre>', close: '</pre>', type: 'pre' as const, nested: true },
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

    const stack: {
        type: TextMatch['type']
        start: number
        contentStart?: number
        extra?: Record<string, string>
    }[] = []

    while (index < input.length) {
        let matched = false

        // `<message ...>...</message>` supports attributes, so handle it explicitly.
        if (!matched && input.startsWith('<message', index)) {
            const openEnd = input.indexOf('>', index)
            if (openEnd !== -1) {
                const boundary = input.charAt(index + '<message'.length)
                if (boundary === '>' || boundary === ' ' || boundary === '\t') {
                    const attrs = input.substring(
                        index + '<message'.length,
                        openEnd
                    )
                    const quote = attrs.match(
                        /\bquote\s*=\s*['"]([^'"]+)['"]/
                    )?.[1]

                    stack.push({
                        type: 'message',
                        start: index,
                        contentStart: openEnd + 1,
                        extra: {
                            ...(quote ? { quote } : {}),
                            topLevel: stack.length === 0 ? 'true' : 'false'
                        }
                    })
                    index = openEnd + 1
                    matched = true
                }
            }
        }

        if (
            !matched &&
            stack.length > 0 &&
            stack[stack.length - 1].type === 'message' &&
            input.startsWith('</message>', index)
        ) {
            const stackItem = stack.pop()
            if (stackItem) {
                const content = input.substring(stackItem.contentStart!, index)
                const children = textMatchLexer(content)

                tokens.push({
                    type: 'message',
                    content,
                    extra: stackItem.extra,
                    start: stackItem.start,
                    end: index + '</message>'.length,
                    children
                })
                index += '</message>'.length
                matched = true
            }
        }

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
                const stackItem = stack.at(-1)
                if (stackItem?.type === type) {
                    stack.pop()
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
            input.startsWith('<face', index)
        ) {
            const endIndex = input.indexOf('</face>', index)
            if (endIndex !== -1) {
                const match = /<face\b[^>]*>(.*?)<\/face>/.exec(
                    input.substring(index, endIndex + 7)
                )
                if (match) {
                    const openTagMatch = /<face\b([^>]*)>/.exec(
                        input.substring(index, endIndex + 7)
                    )
                    let extra: Record<string, string> | undefined

                    if (openTagMatch && openTagMatch[1]) {
                        const nameMatch = openTagMatch[1].match(
                            /name=['"]([^'"]+)['"]/
                        )
                        if (nameMatch) {
                            extra = { name: nameMatch[1] }
                        }
                    }

                    tokens.push({
                        type: 'face',
                        content: match[1],
                        extra,
                        start: index,
                        end: endIndex + 7
                    })
                    index = endIndex + 7
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
            useAt,
            config?.markdownRender ?? true
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

function formatMessageString(message: Message, enableMessageId: boolean) {
    let xmlMessage = `<message name='${message.name}'`

    const id = message.id
    if (id) xmlMessage += ` id='${id}'`

    // `id` is optional and disabled by default to avoid leaking platform message ids.
    if (enableMessageId) {
        const id = message.messageId
        if (id) xmlMessage += ` messageId='${id}'`
    }

    if (message.timestamp) {
        const timestampString = formatTimestamp(message.timestamp)
        xmlMessage += ` timestamp='${timestampString}'`
    }

    if (message.quote) {
        xmlMessage += ` quote='${formatMessageString(message.quote, enableMessageId)}'`
    }

    xmlMessage += `>${message.content}</message>`

    return xmlMessage
}

export async function createChatLunaChain(
    ctx: Context,
    llmRef: ComputedRef<ChatLunaChatModel>,
    session: Session
): Promise<ComputedRef<ChatLunaChain>> {
    const currentPreset = computed(
        () =>
            ({
                triggerKeyword: [''],
                rawText: '',
                messages: [],
                config: {}
            }) satisfies PresetTemplate
    )

    const chatPrompt = computed(() => {
        const llm = llmRef.value
        return new ChatLunaChatPrompt({
            preset: currentPreset,
            tokenCounter: (text) => llm.getNumTokens(text),
            sendTokenLimit:
                llm.invocationParams().maxTokenLimit ??
                llm.getModelMaxContextSize(),
            promptRenderService: ctx.chatluna.promptRenderer
        })
    })

    const embeddingsRef = await createEmbeddingsModel(ctx)
    const toolListRef = ctx.chatluna.platform.getTools()
    const toolsListRef = computed(() =>
        toolListRef.value.map((tool) => ctx.chatluna.platform.getTool(tool))
    )

    const toolsRef = createToolsRef({
        tools: toolsListRef,
        embeddings: embeddingsRef.value
    })

    const executorRef = createAgentExecutor({
        llm: llmRef,
        tools: toolsRef.tools,
        prompt: chatPrompt.value,
        agentMode: 'tool-calling',
        returnIntermediateSteps: true,
        handleParsingErrors: true,
        instructions: computed(() => undefined)
    })

    return computed(() => {
        return RunnableLambda.from((input, options) => {
            // Update tools before execution
            if (options?.configurable?.session) {
                const copyOfMessages =
                    typeof input['chat_history'] === 'string'
                        ? [new HumanMessage(input['chat_history'])]
                        : [...input['chat_history']]

                if (copyOfMessages.length === 0) {
                    copyOfMessages.push(input.input)
                }

                toolsRef.update(options.configurable.session, copyOfMessages)
            }

            return executorRef.value
                .invoke(input, {
                    callbacks: [
                        {
                            handleAgentAction(action) {
                                logger.debug('Agent Action:', action)
                            },
                            handleToolEnd(output, runId, parentRunId, tags) {
                                logger.debug(`Tool End: `, output)
                            }
                        }
                    ],
                    ...(options ?? {})
                })
                .then(
                    (output) =>
                        new AIMessageChunk({
                            content: output.output
                        })
                )
        })
    })
}

export function createEmbeddingsModel(ctx: Context) {
    const modelName = ctx.chatluna.config.defaultEmbeddings

    const [platform, model] = parseRawModelName(modelName)

    return ctx.chatluna.createEmbeddings(platform, model)
}

export async function formatMessage(
    messages: Message[],
    config: Config,
    model: ChatLunaChatModel,
    systemPrompt: string,
    historyPrompt: string,
    focusMessage?: Message
) {
    const maxTokens = config.maxTokens - 300
    let currentTokens = 0

    currentTokens += await model.getNumTokens(systemPrompt)
    currentTokens += await model.getNumTokens(historyPrompt)

    const calculatedMessages: string[] = []
    let lastMessage: string | undefined

    if (focusMessage && messages.includes(focusMessage)) {
        const xmlFocusMessage = formatMessageString(
            focusMessage,
            config.enableMessageId
        )
        const xmlFocusMessageToken = await model.getNumTokens(xmlFocusMessage)

        if (currentTokens + xmlFocusMessageToken <= maxTokens - 4) {
            currentTokens += xmlFocusMessageToken
            lastMessage = xmlFocusMessage
        }
    }

    for (let i = messages.length - 1; i >= 0; i--) {
        if (lastMessage && messages[i] === focusMessage) continue

        const xmlMessage = formatMessageString(
            messages[i],
            config.enableMessageId
        )

        const xmlMessageToken = await model.getNumTokens(xmlMessage)

        if (currentTokens + xmlMessageToken > maxTokens - 4) {
            break
        }

        currentTokens += xmlMessageToken
        calculatedMessages.unshift(xmlMessage)
    }

    if (lastMessage === undefined) {
        lastMessage = calculatedMessages.pop()
    }

    if (lastMessage === undefined) {
        throw new Error(
            'lastMessage is undefined, please set the max token to be bigger'
        )
    }

    return [calculatedMessages, lastMessage] as const
}

export async function formatCompletionMessages(
    messages: BaseMessage[],
    tempMessages: BaseMessage[],
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

    for (const imageMessage of tempMessages) {
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

    const singleMatch = xml.match(/<message(?:\s+(.*?))?>(.*?)<\/message>/s)
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

export function trimCompletionMessages(
    completionMessages: BaseMessage[],
    modelCompletionCount: number
) {
    const limit = Math.max(0, Math.floor(modelCompletionCount)) * 2
    if (limit === 0) {
        completionMessages.length = 0
        return
    }

    const overflow = completionMessages.length - limit
    if (overflow > 0) {
        completionMessages.splice(0, overflow)
    }
}

const tagRegExp = /<(\/?)([^!\s>/]+)([^>]*?)\s*(\/?)>/

function renderToken(token: Token): h {
    // remove \n \t
    if (token.raw.trim().length < 1) {
        return undefined
    }

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
