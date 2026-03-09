import { h } from 'koishi'

import { Config } from '..'
import { processElements, processTextMatches } from './elements'
import { logger } from './logger'

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
        // 保留原始 `<message ...>...</message>`，便于后续解析元素属性（如 `quote="..."`）。
        rawMessage,
        messageType: tempJson.type,
        status,
        sticker: tempJson.sticker
    }
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
