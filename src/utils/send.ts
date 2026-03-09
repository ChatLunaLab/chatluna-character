import type { QQBot } from '@koishijs/plugin-adapter-qq'

import { Context, h, Session } from 'koishi'

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
    send?: (session: Session, part: SendPart) => Promise<void>
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
                await session.send(part.elements)
                return
            }

            const { user } = session.event
            await (session.bot as QQBot<Context>).internal.sendPrivateMessage(
                user.id,
                {
                    msg_type: 2,
                    msg_seq: 1,
                    msg_id: session.messageId,
                    markdown: {
                        content: part.elements[0].attrs['content']
                    }
                }
            )
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
    console.log(
        JSON.stringify(elements),
        JSON.stringify(splitSendElements(elements))
    )
    for (const part of splitSendElements(elements)) {
        const rule = sendRules[part.type]
        if (rule?.send) {
            await rule.send(session, part)
            continue
        }

        await session.send(part.elements)
    }
}
