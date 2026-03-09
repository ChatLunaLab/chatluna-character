import { Element, h } from 'koishi'
import { marked, Token } from 'marked'

const tagRegExp = /<(\/?)([^!\s>/]+)([^>]*?)\s*(\/?)>/

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
