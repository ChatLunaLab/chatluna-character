import he from 'he'
import { Element, h } from 'koishi'

import { Config } from '..'
import { splitSentence, transform } from './text'

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

const MULTIMODAL_FILE_LIMIT_ATTR = 'chatluna_multimodal_file_input_max_size_mb'

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

        // 仅在第一个真正承载内容的片段前附加引用。
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

    const appendOrPush = (items: Element[], pendingQuote?: PendingQuote) => {
        canAppendAt()
            ? appendToLast(items, pendingQuote)
            : pushFragment(items, pendingQuote)
    }

    const processTextElement = async (
        el: Element,
        pendingQuote?: PendingQuote
    ) => {
        if (el.attrs.code || el.attrs.span) {
            pushFragment([el], pendingQuote)
            return
        }

        if (el.attrs.voice && voiceRender) {
            pushFragment(await voiceRender(el), pendingQuote)
            return
        }

        if (config?.splitSentence) {
            for (const text of splitSentence(
                he.decode(el.attrs.content)
            ).filter(Boolean)) {
                appendOrPush([h.text(text)], pendingQuote)
            }
            return
        }

        appendOrPush([el], pendingQuote)
    }

    const processMessageElement = async (
        el: Element,
        process: (els: Element[], pendingQuote?: PendingQuote) => Promise<void>,
        pendingQuote?: PendingQuote
    ) => {
        if (!(el.attrs.span && el.attrs.block)) {
            await process(el.children, pendingQuote)
            return
        }

        // 模型输出的顶层 `<message ...>` 块作为分片边界，每个块可携带自己的 quote id。
        startNewFragmentIfNeeded()
        const blockQuote: PendingQuote | undefined = el.attrs.quote
            ? { id: String(el.attrs.quote), used: false }
            : undefined

        await process(el.children, blockQuote)
        startNewFragmentIfNeeded()
    }

    const process = async (els: Element[], pendingQuote?: PendingQuote) => {
        for (const el of els) {
            if (el.type === 'text') {
                await processTextElement(el, pendingQuote)
                continue
            }

            if (['em', 'strong', 'del', 'p'].includes(el.type)) {
                el.children
                    ? await process(el.children, pendingQuote)
                    : pushFragment([el], pendingQuote)
                continue
            }

            if (el.type === 'at') {
                const wrappedAt = [h.text(' '), el, h.text(' ')]
                last()
                    ? appendToLast(wrappedAt, pendingQuote)
                    : pushFragment(wrappedAt, pendingQuote)
                continue
            }

            if (el.type === 'img' && !el.attrs.sticker) {
                last()
                    ? appendToLast([el], pendingQuote)
                    : pushFragment([el], pendingQuote)
                continue
            }

            if (el.type === 'message' && el.attrs.span) {
                await processMessageElement(el, process, pendingQuote)
                continue
            }

            if (el.type === 'face') {
                last()
                    ? appendToLast([el], pendingQuote)
                    : pushFragment([el], pendingQuote)
                continue
            }

            appendOrPush([el], pendingQuote)
        }
    }

    await process(elements)

    // 与 ChatLuna 发送侧行为对齐：片段中若存在不兼容类型则移除 quote。
    for (const fragment of result) {
        if (fragment[0]?.type !== 'quote') continue
        const hasIncompatibleType = fragment.some(
            (element) => element.type === 'audio' || element.type === 'message'
        )
        if (hasIncompatibleType) fragment.shift()
    }

    return result.filter((fragment) => fragment.length > 0)
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

export function attachMultimodalFileLimit(elements: h[], maxSizeMb: number) {
    if (!Number.isFinite(maxSizeMb) || maxSizeMb <= 0) {
        return
    }

    const limit = Math.floor(maxSizeMb)
    for (const element of elements) {
        if (
            element.type === 'file' ||
            element.type === 'video' ||
            element.type === 'audio'
        ) {
            element.attrs[MULTIMODAL_FILE_LIMIT_ATTR] = limit
        }
    }
}
