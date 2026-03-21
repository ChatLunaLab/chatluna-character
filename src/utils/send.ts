import type { QQBot } from '@koishijs/plugin-adapter-qq'

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

async function callOnebotApi(
    internal: any,
    action: string,
    params: Record<string, any>
) {
    if (typeof internal._get === 'function') {
        return await internal._get(action, params)
    }

    if (typeof internal.request === 'function') {
        return await internal.request(action, params)
    }

    if (typeof internal.callAction === 'function') {
        return await internal.callAction(action, params)
    }

    if (typeof internal.sendAction === 'function') {
        return await internal.sendAction(action, params)
    }

    throw new Error(`OneBot internal API does not support action: ${action}`)
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
                    'file send skipped: file or name is empty attrs=' +
                        JSON.stringify(el.attrs)
                )
                return []
            }

            const internal = (session.bot as any).internal
            if (session.isDirect) {
                logger.info(
                    `file send start: private user=${session.userId} name=${name}`
                )
                const data = await callOnebotApi(internal, 'upload_private_file', {
                    user_id: Number(session.userId),
                    file,
                    name
                })

                if (data?.status && data.status !== 'ok') {
                    throw new Error(
                        `upload_private_file failed: ${data?.wording ?? data?.message ?? data?.retcode ?? 'unknown error'}`
                    )
                }

                const fileId = String(
                    data?.file_id ?? data?.data?.file_id ?? ''
                ).trim()
                if (fileId.length < 1) {
                    throw new Error('upload_private_file did not return file_id')
                }
                logger.info(
                    `file send success: private user=${session.userId} name=${name} fileId=${fileId}`
                )
                return []
            }

            logger.info(`file send start: group group=${session.guildId} name=${name}`)

            const data = await callOnebotApi(internal, 'upload_group_file', {
                group_id: Number(session.guildId),
                file,
                name
            })

            if (data?.status && data.status !== 'ok') {
                throw new Error(
                    `upload_group_file failed: ${data?.wording ?? data?.message ?? data?.retcode ?? 'unknown error'}`
                )
            }

            const fileId = String(
                data?.file_id ?? data?.data?.file_id ?? ''
            ).trim()
            if (fileId.length < 1) {
                throw new Error('upload_group_file did not return file_id')
            }
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
