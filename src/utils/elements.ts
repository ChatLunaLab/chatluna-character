import { Element, h } from 'koishi'

import type { ResponseElementMatch, ResponseElementRenders } from './render'

interface TextMatch extends ResponseElementMatch {
    children?: TextMatch[]
}

const MULTIMODAL_FILE_LIMIT_ATTR = 'chatluna_multimodal_file_input_max_size_mb'

type PendingQuote = { id?: string; used: boolean }

type ElementFragment = Element[]
type ElementFragments = ElementFragment[]

class ElementFragmentCollector {
    private _fragments: ElementFragments = []

    constructor(private readonly _renders: ResponseElementRenders = {}) {}

    async collect(elements: Element[]) {
        await this.visitElements(elements)
        this.removeInvalidQuotes()
        return this._fragments.filter((frag) => frag.length > 0)
    }

    private getLastFragment() {
        return this._fragments.at(-1)
    }

    private shouldAppendAfterAt() {
        return this.getLastFragment()?.at(-2)?.type === 'at'
    }

    private shouldAppendAfterFace() {
        return this.getLastFragment()?.at(-1)?.type === 'face'
    }

    private shouldAppendText() {
        return this.shouldAppendAfterAt() || this.shouldAppendAfterFace()
    }

    // Attach the quote only once, right before the first fragment that carries content.
    private attachPendingQuote(target: ElementFragment, quote?: PendingQuote) {
        if (!quote?.id || quote.used) return
        target.unshift(h('quote', { id: quote.id }))
        quote.used = true
    }

    private pushFragment(items: Element[], quote?: PendingQuote) {
        if (items.length === 0) return
        const frag = [...items]
        this.attachPendingQuote(frag, quote)
        this._fragments.push(frag)
    }

    private appendFragment(items: Element[], quote?: PendingQuote) {
        if (items.length === 0) return
        const frag = this.getLastFragment()

        if (!frag) {
            this.pushFragment(items, quote)
            return
        }

        this.attachPendingQuote(frag, quote)
        frag.push(...items)
    }

    private writeFragment(
        items: Element[],
        quote?: PendingQuote,
        append: boolean = false
    ) {
        if (append) {
            this.appendFragment(items, quote)
            return
        }

        this.pushFragment(items, quote)
    }

    private startNewFragment() {
        if (this.getLastFragment()?.length) this._fragments.push([])
    }

    // Match sender-side behavior: quotes cannot stay on fragments with nested messages or audio.
    private removeInvalidQuotes() {
        for (const frag of this._fragments) {
            if (frag[0]?.type !== 'quote') continue
            if (
                frag.some((el) => el.type === 'audio' || el.type === 'message')
            ) {
                frag.shift()
            }
        }
    }

    private async handleTextElement(el: Element, quote?: PendingQuote) {
        if (el.attrs.code || el.attrs.span) {
            this.pushFragment([el], quote)
            return
        }

        this.writeFragment([el], quote, this.shouldAppendText())
    }

    private async handleMessageElement(el: Element, quote?: PendingQuote) {
        if (!(el.attrs.span && el.attrs.block)) {
            await this.visitElements(el.children, quote)
            return
        }

        // A top-level model `<message>` block defines its own fragment boundary.
        this.startNewFragment()
        const next = el.attrs.quote
            ? { id: String(el.attrs.quote), used: false }
            : undefined

        await this.visitElements(el.children, next)
        this.startNewFragment()
    }

    private async visitElements(elements: Element[], quote?: PendingQuote) {
        for (const el of elements) {
            const render = this._renders[el.type]
            if (render?.process) {
                this.writeFragment(
                    await render.process(el),
                    quote,
                    this.shouldAppendAfterAt()
                )
                continue
            }

            switch (el.type) {
                case 'text':
                    await this.handleTextElement(el, quote)
                    break
                case 'em':
                case 'strong':
                case 'del':
                case 'p':
                    if (el.children?.length) {
                        await this.visitElements(el.children, quote)
                    } else {
                        this.pushFragment([el], quote)
                    }
                    break
                case 'at':
                    this.writeFragment(
                        [h.text(' '), el, h.text(' ')],
                        quote,
                        Boolean(this.getLastFragment())
                    )
                    break
                case 'img':
                    if (el.attrs.sticker) {
                        this.writeFragment(
                            [el],
                            quote,
                            this.shouldAppendAfterAt()
                        )
                    } else {
                        this.writeFragment(
                            [el],
                            quote,
                            Boolean(this.getLastFragment())
                        )
                    }
                    break
                case 'message':
                    if (el.attrs.span) {
                        await this.handleMessageElement(el, quote)
                    } else {
                        this.writeFragment(
                            [el],
                            quote,
                            this.shouldAppendAfterAt()
                        )
                    }
                    break
                case 'face':
                    this.writeFragment(
                        [el],
                        quote,
                        Boolean(this.getLastFragment())
                    )
                    break
                default:
                    this.writeFragment([el], quote, this.shouldAppendAfterAt())
                    break
            }
        }
    }
}

export async function processElements(
    elements: Element[],
    renders: ResponseElementRenders = {}
) {
    return await new ElementFragmentCollector(renders).collect(elements)
}

class TextMatchParser {
    constructor(
        private readonly _useAt: boolean,
        private readonly _renders: ResponseElementRenders = {}
    ) {}

    parse(rawMessage: string) {
        const matches = this.read(rawMessage)

        if (matches.length === 0) {
            return {
                currentElements: [h('text', { content: rawMessage })],
                parsedMessage: rawMessage
            }
        }

        return this.render(matches)
    }

    private render(matches: TextMatch[]) {
        const currentElements: Element[] = []

        for (const match of matches) {
            const render = this._renders[match.type]
            if (render) {
                currentElements.push(...render.render(match))
                continue
            }

            switch (match.type) {
                case 'at':
                    if (this._useAt) currentElements.push(h.at(match.content))
                    break
                case 'message': {
                    const nested = this.render(match.children ?? [])
                    const block = match.extra?.topLevel === 'true'
                    const quote = block ? match.extra?.quote : undefined

                    currentElements.push(
                        h(
                            'message',
                            {
                                span: true,
                                ...(block ? { block: true } : {}),
                                ...(quote ? { quote } : {})
                            },
                            ...nested.currentElements
                        )
                    )
                    break
                }
                case 'markdown':
                    currentElements.push(
                        h('markdown', { content: match.content })
                    )
                    break
                case 'face':
                    currentElements.push(h('face', { id: match.content }))
                    break
                case 'sticker':
                    currentElements.push(h('message', [h.image(match.content)]))
                    break
                case 'img':
                    currentElements.push(
                        h.image(match.content, { sticker: false })
                    )
                    break
                case 'text':
                    currentElements.push(h('text', { content: match.content }))
                    break
            }
        }

        return {
            currentElements,
            parsedMessage: stringifyElements(currentElements)
        }
    }

    // Preserve nested `<message>` blocks while flattening other nodes into match tokens.
    private collect(elements: Element[], depth: number): TextMatch[] {
        const result: TextMatch[] = []
        const makeMatch = (
            type: string,
            content: string,
            extra?: Element['attrs'],
            children?: TextMatch[]
        ) => {
            return {
                type,
                content,
                ...(extra ? { extra } : {}),
                ...(children ? { children } : {})
            }
        }

        for (const el of elements) {
            const render = this._renders[el.type]
            if (render) {
                result.push(render.parse(el))
                continue
            }

            switch (el.type) {
                case 'message':
                    result.push(
                        makeMatch(
                            'message',
                            '',
                            {
                                ...(el.attrs.quote
                                    ? { quote: el.attrs.quote }
                                    : {}),
                                topLevel: depth === 0 ? 'true' : 'false'
                            },
                            this.collect(el.children, depth + 1)
                        )
                    )
                    break
                case 'at':
                    result.push(
                        makeMatch(
                            'at',
                            el.children?.[0]?.attrs?.content ??
                                el.attrs?.content,
                            el.attrs.extra
                        )
                    )
                    break
                case 'text':
                    result.push(makeMatch('text', el.attrs.content))
                    break
                case 'sticker':
                    result.push(
                        makeMatch(
                            'sticker',
                            el.children?.[0]?.attrs?.content ??
                                el.attrs?.content,
                            el.attrs
                        )
                    )
                    break
                case 'img':
                    result.push(
                        makeMatch(
                            'img',
                            el.children?.[0]?.attrs?.content ??
                                el.attrs?.content
                        )
                    )
                    break
                case 'face':
                    result.push(
                        makeMatch(
                            'face',
                            el.children[0].attrs.content,
                            el.attrs
                        )
                    )
                    break
                case 'markdown':
                    result.push(
                        makeMatch(
                            'markdown',
                            el.children?.[0]?.attrs?.content ??
                                el.attrs?.content
                        )
                    )
                    break
                default:
                    result.push(...this.collect(el.children, depth))
                    break
            }
        }

        return result
    }

    private read(input: string) {
        const parsed = h.parse(input)
        const result = this.collect(parsed, 0)
        return result
    }
}

export function parseMessageElements(
    rawMessage: string,
    useAt: boolean = true,
    renders: ResponseElementRenders = {}
) {
    return new TextMatchParser(useAt, renders).parse(rawMessage)
}

function stringifyElements(elements: Element[]) {
    return elements
        .map((el) => {
            if (el.type === 'message' && el.attrs.span) {
                return stringifyElements(el.children)
            }

            return el.toString()
        })
        .join('')
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
