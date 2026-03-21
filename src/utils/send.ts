import type { QQBot } from '@koishijs/plugin-adapter-qq'
import OneBotBot from 'koishi-plugin-adapter-onebot'

import { Context, h, Session } from 'koishi'
import { logger } from './logger'

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
                return Array.isArray(result)
                    ? result.map((id) => String(id))
                    : [String(result)]
            }

            const { user } = session.event
            const result = await (
                session.bot as QQBot<Context>
            ).internal.sendPrivateMessage(user.id, {
                msg_type: 2,
                msg_seq: 1,
                msg_id: session.messageId,
                markdown: {
                    content: part.elements[0].attrs['content']
                }
            })

            return [String(result.id)]
        }
    },
    file: {
        split: (_elements, idx, start) => ({
            type: 'file',
            start: idx > start ? idx - 1 : idx,
            end: idx + 1
        }),
        send: async (session, part) => {
            if (session.platform !== 'onebot') {
                const result = await session.send(part.elements)
                return Array.isArray(result)
                    ? result.map((id) => String(id))
                    : [String(result)]
            }

            const ids: string[] = []
            const quote = part.elements[0]
            if (part.elements.length > 1 && quote.type === 'quote') {
                const result = await session.send([quote])
                if (Array.isArray(result)) {
                    ids.push(...result.map((id) => String(id)))
                } else {
                    ids.push(String(result))
                }
            }

            const el = part.elements[part.elements.length - 1]
            const file = String(el.attrs['chatluna_file_url'] ?? '').trim()
            const name = String(el.attrs['name'] ?? '').trim()
            if (file.length < 1 || name.length < 1) {
                logger.warn(
                    `file send skipped: missing ${file.length < 1 ? 'file' : 'name'}`
                )
                return ids
            }

            const bot = session.bot as OneBotBot<Context>
            if (session.isDirect) {
                logger.info(
                    `file send start: private user=${session.userId} name=${name}`
                )
                const data =
                    (await bot.internal._request('upload_private_file', {
                        user_id: Number(session.userId),
                        file,
                        name
                    })) as OneBotUploadResponse
                if (data.status !== 'ok') {
                    const msg = data.wording || data.message || 'unknown error'
                    throw new Error(`upload_private_file failed: ${msg}`)
                }

                const fileId = String(
                    data.data?.file_id || data.file_id || ''
                ).trim()
                if (fileId.length < 1) {
                    throw new Error('upload_private_file did not return file_id')
                }
                logger.info(
                    `file send success: private user=${session.userId} name=${name} fileId=${fileId}`
                )
                return ids
            }

            logger.info(`file send start: group group=${session.guildId} name=${name}`)

            const data =
                (await bot.internal._request('upload_group_file', {
                    group_id: Number(session.guildId),
                    file,
                    name
                })) as OneBotUploadResponse
            if (data.status !== 'ok') {
                const msg = data.wording || data.message || 'unknown error'
                throw new Error(`upload_group_file failed: ${msg}`)
            }

            const fileId = String(data.data?.file_id || data.file_id || '').trim()
            if (fileId.length < 1) {
                throw new Error('upload_group_file did not return file_id')
            }
            logger.info(
                `file send success: group group=${session.guildId} name=${name} fileId=${fileId}`
            )
            return ids
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
