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
