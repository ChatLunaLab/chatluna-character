import type { QQBot } from '@koishijs/plugin-adapter-qq'
import OneBotBot from 'koishi-plugin-adapter-onebot'

import { Context, h, Session } from 'koishi'
import { logger } from './logger'

export interface SendPart {
    type: string
    elements: h[]
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
    status?: string
    wording?: string
    message?: string
    retcode?: number | string
    file_id?: string
    data?: {
        file_id?: string
    }
}

function getUploadFileId(data: OneBotUploadResponse, action: string) {
    if (data.status && data.status !== 'ok') {
        let msg = 'unknown error'
        if (data.wording) {
            msg = data.wording
        } else if (data.message) {
            msg = data.message
        } else if (data.retcode != null) {
            msg = String(data.retcode)
        }

        throw new Error(
            `${action} failed: ${msg}`
        )
    }

    const raw = data.file_id || data.data?.file_id || ''
    const id = String(raw).trim()
    if (id.length < 1) {
        throw new Error(`${action} did not return file_id`)
    }

    return id
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

            const el = part.elements[0]
            const file = String(el.attrs['chatluna_file_url'] ?? '').trim()
            const name = String(el.attrs['name'] ?? '').trim()
            if (file.length < 1 || name.length < 1) {
                logger.warn(
                    `file send skipped: missing ${file.length < 1 ? 'file' : 'name'}`
                )
                return []
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
                const fileId = getUploadFileId(data, 'upload_private_file')
                logger.info(
                    `file send success: private user=${session.userId} name=${name} fileId=${fileId}`
                )
                return []
            }

            logger.info(`file send start: group group=${session.guildId} name=${name}`)

            const data =
                (await bot.internal._request('upload_group_file', {
                    group_id: Number(session.guildId),
                    file,
                    name
                })) as OneBotUploadResponse
            const fileId = getUploadFileId(data, 'upload_group_file')
            logger.info(
                `file send success: group group=${session.guildId} name=${name} fileId=${fileId}`
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
