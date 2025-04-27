import { Session } from 'koishi'

export interface Message {
    content: string
    name: string
    id: string
    timestamp?: number
    quote?: Message
    uuid?: string
    images?: string[]
}

export type MessageCollectorFilter = (
    session: Session,
    message: Message,
    history: Message[]
) => Promise<boolean>

export type MessageCollectorTrigger = (
    session: Session,
    message: Message,
    history: Message[]
) => Promise<void>
