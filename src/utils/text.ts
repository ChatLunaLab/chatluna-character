import { Element } from 'koishi'

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

export function truncate(text: string, maxLength = 2000): string {
    return text.length > maxLength ? text.slice(0, maxLength) + '...' : text
}
