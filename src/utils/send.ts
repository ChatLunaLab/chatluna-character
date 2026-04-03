import type { QQBot } from '@koishijs/plugin-adapter-qq'
import OneBotBot from 'koishi-plugin-adapter-onebot'

import { Context, h, Session } from 'koishi'
import { logger } from './logger'

function isOneBotImageElement(el: h) {
    return el.type === 'img'
}

export interface SendPart {
    type: string
    elements: h[]
}

const sendRules: Record<string, SendRule> = {
    'markdown-qq': {
        split: (_elements, idx, start) => ({
            type: 'markdown-qq',
            start: idx > start ? idx - 1 : idx,
            end: idx + 1
        }),
        send: async (session, part) => {
            if (session.platform !== 'qq' || !session.isDirect) {
                const result = await session.send(part.elements)
                return result
            }

            const result = await (
                session.bot as QQBot<Context>
            ).internal.sendPrivateMessage(session.event.user.id, {
                msg_type: 2,
                msg_seq: 1,
                msg_id: session.messageId,
                markdown: {
                    content: part.elements[0].attrs['content']
                }
            })

            return [result.id]
        }
    },
    file: {
        split: (elements, idx, start) => ({
            type: 'file',
            start:
                idx > start && elements[idx - 1]?.type === 'quote'
                    ? idx - 1
                    : idx,
            end: idx + 1
        }),
        send: async (session, part) => {
            if (session.platform === 'qq') {
                logger.warn(
                    `file send skipped: qq platform is disabled platform=${session.platform}`
                )
                return []
            }

            if (session.platform !== 'onebot') {
                for (const el of part.elements) {
                    if (el.type !== 'file') {
                        continue
                    }

                    el.attrs['src'] = el.attrs['chatluna_file_url']
                }
                return await session.send(part.elements)
            }

            const el = part.elements[part.elements.length - 1]
            const file = String(el.attrs['chatluna_file_url'] ?? '')
            const name = String(el.attrs['name'] ?? '')
            if (file.length < 1 || name.length < 1) {
                logger.warn(
                    `file send skipped: missing ${file.length < 1 ? 'file' : 'name'}`
                )
                return []
            }

            const bot = session.bot as OneBotBot<Context>

            const action = session.isDirect
                ? 'upload_private_file'
                : 'upload_group_file'
            const target = session.isDirect
                ? `private user=${session.userId}`
                : `group group=${session.guildId}`

            const data = (await bot.internal._request(
                action,
                session.isDirect
                    ? {
                          user_id: Number(session.userId),
                          file,
                          name
                      }
                    : {
                          group_id: Number(session.guildId),
                          file,
                          name
                      }
            )) as OneBotUploadResponse
            if (data.status !== 'ok') {
                const msg = data.wording || data.message || 'unknown error'
                throw new Error(`${action} failed: ${msg}`)
            }

            const fileId = String(
                data.data?.file_id ?? data.file_id ?? ''
            ).trim()
            if (fileId.length < 1) {
                throw new Error(`${action} did not return file_id`)
            }
            logger.info(
                `file send success: ${target} name=${name} fileId=${fileId}`
            )
            return []
        }
    },
    video: {
        split: (elements, idx, start) => ({
            type: 'video',
            start:
                idx > start && elements[idx - 1]?.type === 'quote'
                    ? idx - 1
                    : idx,
            end: idx + 1
        }),
        send: async (session, part) => {
            const el = part.elements[part.elements.length - 1]
            const file = String(el.attrs['chatluna_file_url'] ?? '')
            if (file.length < 1) {
                logger.warn('video send skipped: missing file')
                return []
            }

            if (session.platform !== 'onebot') {
                el.attrs['src'] = file
                const result = await session.send(part.elements)
                return Array.isArray(result)
                    ? result.map((id) => String(id))
                    : [String(result)]
            }

            const bot = session.bot as OneBotBot<Context>
            const action = session.isDirect ? 'send_private_msg' : 'send_group_msg'
            const data = (await bot.internal._request(
                action,
                session.isDirect
                    ? {
                          user_id: Number(session.userId),
                          message: [
                              {
                                  type: 'video',
                                  data: { file }
                              }
                          ]
                      }
                    : {
                          group_id: Number(session.guildId),
                          message: [
                              {
                                  type: 'video',
                                  data: { file }
                              }
                          ]
                      }
            )) as OneBotSendMessageResponse
            if (data.status !== 'ok') {
                const msg = data.wording || data.message || 'unknown error'
                throw new Error(`${action} failed: ${msg}`)
            }

            const messageId = String(
                data.data?.message_id ?? data.message_id ?? ''
            ).trim()
            if (messageId.length < 1) {
                throw new Error(`${action} did not return message_id`)
            }

            return [messageId]
        }
    }
}

export function splitSendElements(elements: h[]) {
    const parts: SendPart[] = []
    let start = 0

    for (let idx = 0; idx < elements.length; idx++) {
        const rule = sendRules[elements[idx].type]
        if (!rule) {
            continue
        }

        const part = rule.split(elements, idx, start)
        if (start < part.start) {
            parts.push({
                type: 'default',
                elements: elements.slice(start, part.start)
            })
        }

        parts.push({
            type: part.type,
            elements: elements.slice(part.start, part.end)
        })
        start = part.end
        idx = part.end - 1
    }

    if (start < elements.length) {
        parts.push({
            type: 'default',
            elements: elements.slice(start)
        })
    }

    return parts
}

export async function sendElements(session: Session, elements: h[]) {
    const ids: string[] = []

    for (const part of splitSendElements(elements)) {
        if (
            session.platform === 'onebot' &&
            part.type === 'default' &&
            part.elements.some(isOneBotImageElement)
        ) {
            const message: OneBotMessageSegment[] = []

            for (const el of part.elements) {
                if (el.type === 'quote') {
                    message.push({
                        type: 'reply',
                        data: {
                            id: String(el.attrs.id ?? '')
                        }
                    })
                    continue
                }

                if (el.type === 'text') {
                    message.push({
                        type: 'text',
                        data: {
                            text: String(el.attrs.content ?? '')
                        }
                    })
                    continue
                }

                if (el.type === 'at') {
                    message.push({
                        type: 'at',
                        data: {
                            qq: String(el.attrs.id ?? '')
                        }
                    })
                    continue
                }

                if (el.type === 'face') {
                    message.push({
                        type: 'face',
                        data: {
                            id: String(el.attrs.id ?? '')
                        }
                    })
                    continue
                }

                if (el.type === 'img') {
                    const file = String(
                        el.attrs.src ??
                            el.attrs.url ??
                            el.attrs.imageUrl ??
                            ''
                    )
                    if (file.length < 1) {
                        continue
                    }

                    message.push({
                        type: 'image',
                        data: {
                            file,
                            url: file,
                            sub_type: el.attrs.sticker ? 1 : 0
                        }
                    })
                }
            }

            if (message.length < 1) {
                continue
            }

            const bot = session.bot as OneBotBot<Context>
            const action = session.isDirect ? 'send_private_msg' : 'send_group_msg'
            const data = (await bot.internal._request(
                action,
                session.isDirect
                    ? {
                          user_id: Number(session.userId),
                          message
                      }
                    : {
                          group_id: Number(session.guildId),
                          message
                      }
            )) as OneBotSendMessageResponse
            if (data.status !== 'ok') {
                const msg = data.wording || data.message || 'unknown error'
                throw new Error(`${action} failed: ${msg}`)
            }

            const messageId = String(
                data.data?.message_id ?? data.message_id ?? ''
            ).trim()
            if (messageId.length > 0) {
                ids.push(messageId)
            }
            continue
        }

        const rule = sendRules[part.type]
        if (rule?.send) {
            ids.push(...(await rule.send(session, part)))
            continue
        }

        const result = await session.send(part.elements)
        if (Array.isArray(result)) {
            ids.push(...result.map((id) => String(id)))
            continue
        }

        ids.push(String(result))
    }

    return ids
}

interface SendSplit {
    type: string
    start: number
    end: number
}

interface SendRule {
    split: (elements: h[], idx: number, start: number) => SendSplit
    send?: (session: Session, part: SendPart) => Promise<string[]>
}

interface OneBotUploadResponse {
    status: 'ok' | 'failed'
    retcode: number
    data?: {
        file_id?: string
    }
    message: string
    wording: string
    stream?: string
    file_id?: string
}

interface OneBotSendMessageResponse {
    status: 'ok' | 'failed'
    retcode: number
    data?: {
        message_id?: number
    }
    message: string
    wording: string
    message_id?: number
}

interface OneBotMessageSegment {
    type: string
    data: Record<string, string | number>
}
