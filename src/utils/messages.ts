import { BaseMessage } from '@langchain/core/messages'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { Context, h, Session } from 'koishi'
import { isForwardMessageElement } from 'koishi-plugin-chatluna/utils/koishi'
import {
    getMessageContent,
    hashString,
    isMessageContentImageUrl
} from 'koishi-plugin-chatluna/utils/string'

import { Config } from '..'
import { Message, MessageImage } from '../types'
import { logger } from './logger'

function escapeXml(text: string, attr: boolean = false) {
    const escaped = text
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
    if (attr) {
        return escaped.replaceAll('"', '&quot;')
    }

    return escaped
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
        xmlMessage += ` quote="${escapeXml(formatMessageString(message.quote, enableMessageId), true)}"`
    }

    xmlMessage += `>${message.content}</message>`

    return xmlMessage
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
    const selectedMessages: Message[] = []
    let lastMessage: string | undefined
    let lastSelectedMessage: Message | undefined

    if (focusMessage && messages.includes(focusMessage)) {
        const xmlFocusMessage = formatMessageString(
            focusMessage,
            config.enableMessageId
        )
        const xmlFocusMessageToken = await model.getNumTokens(xmlFocusMessage)

        if (currentTokens + xmlFocusMessageToken <= maxTokens - 4) {
            currentTokens += xmlFocusMessageToken
            lastMessage = xmlFocusMessage
            lastSelectedMessage = focusMessage
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
        selectedMessages.unshift(messages[i])
    }

    if (lastMessage === undefined) {
        lastMessage = calculatedMessages.pop()
        lastSelectedMessage = selectedMessages.pop()
    }

    if (lastMessage === undefined || lastSelectedMessage === undefined) {
        throw new Error(
            'lastMessage is undefined, please set the max token to be bigger'
        )
    }

    return {
        recentMessages: calculatedMessages,
        lastMessage,
        contextMessages: selectedMessages.concat(lastSelectedMessage)
    } as const
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

    for (let index = tempMessages.length - 1; index >= 0; index--) {
        const imageMessage = tempMessages[index]
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

export function mapElementToString(
    session: Session,
    content: string | undefined,
    elements: h[],
    images?: MessageImage[]
) {
    content = content ?? ''
    const filteredBuffer: string[] = []
    const usedImages = new Set<string>()

    for (const element of elements) {
        if (element.type === 'text') {
            const content = element.attrs.content as string

            if (content?.trimEnd()?.length > 0) {
                filteredBuffer.push(content)
            }
        } else if (element.type === 'at') {
            let name = element.attrs?.name
            if (element.attrs.id === session.bot.selfId) {
                name = name ?? session.bot.user.name ?? '0'
            }
            if (name == null || name.length < 1) {
                name = element.attrs.id ?? '0'
            }

            filteredBuffer.push(`<at name='${name}'>${element.attrs.id}</at>`)
        } else if (element.type === 'img') {
            const imageHash = element.attrs.imageHash as string | undefined
            const imageUrl = element.attrs.imageUrl as string | undefined

            const matchedImage = images?.find((image) => {
                if (imageHash && image.hash === imageHash) {
                    return true
                }
                if (imageUrl && image.url === imageUrl) {
                    return true
                }
                return false
            })

            if (imageUrl) {
                filteredBuffer.push(`<sticker>${imageUrl}</sticker>`)
            } else if (matchedImage) {
                filteredBuffer.push(matchedImage.formatted)
                usedImages.add(matchedImage.formatted)
            } else if (images && images.length > 0) {
                for (const image of images) {
                    if (!usedImages.has(image.formatted)) {
                        filteredBuffer.push(image.formatted)
                        usedImages.add(image.formatted)
                    }
                }
            } else {
                let buffer = `[image`
                if (imageHash) {
                    buffer += `:${imageHash}`
                }
                if (imageUrl) {
                    buffer += `:${imageUrl}`
                }
                buffer += ']'
                filteredBuffer.push(buffer)
            }
        } else if (element.type === 'face') {
            filteredBuffer.push(
                `<face name='${element.attrs.name}'>${element.attrs.id}</face>`
            )
        } else if (element.type === 'file') {
            const url = element.attrs['chatluna_file_url']
            if (!url) {
                continue
            }
            const name =
                element.attrs['file'] ??
                element.attrs['name'] ??
                element.attrs['filename'] ??
                'file'
            const escapedName = escapeXml(String(name), true)
            const escapedUrl = escapeXml(String(url))

            filteredBuffer.push(`<file name="${escapedName}">${escapedUrl}</file>`)
        } else if (element.type === 'video' || element.type === 'audio') {
            const url = element.attrs['chatluna_file_url']
            if (!url) {
                continue
            }

            const fallbackName = element.type === 'audio' ? 'audio' : 'video'
            const name =
                element.attrs['file'] ??
                element.attrs['name'] ??
                element.attrs['filename'] ??
                fallbackName

            const marker = element.type === 'audio' ? 'voice' : 'video'
            filteredBuffer.push(`[${marker}:${name}:${url}]`)
        } else if (isForwardMessageElement(element)) {
            filteredBuffer.push('[聊天记录]')
        }
    }

    if (content.trimEnd().length < 1 && filteredBuffer.length < 1) {
        return ''
    }

    return filteredBuffer.join('')
}

export async function getImages(
    ctx: Context,
    model: string,
    session: Session,
    mergedMessage?: Awaited<
        ReturnType<Context['chatluna']['messageTransformer']['transform']>
    >
) {
    const transformed =
        mergedMessage ??
        (await ctx.chatluna.messageTransformer.transform(
            session,
            session.elements,
            model
        ))

    if (typeof transformed.content === 'string') {
        return undefined
    }

    const images = transformed.content.filter(isMessageContentImageUrl)

    if (!images || images.length < 1) {
        return undefined
    }

    const results: MessageImage[] = []

    for (const image of images) {
        const url =
            typeof image.image_url === 'string'
                ? image.image_url
                : image.image_url.url

        let hash: string =
            typeof image.image_url !== 'string' ? image.image_url['hash'] : ''

        if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
            hash = await hashString(url, 8)
        }

        const formatted = hash ? `[image:${hash}]` : `<sticker>${url}</sticker>`

        results.push({ url, hash, formatted })
    }

    return results
}

export function getNotEmptyString(...texts: (string | undefined)[]): string {
    for (const text of texts) {
        if (text && text?.length > 0) {
            return text
        }
    }
}
