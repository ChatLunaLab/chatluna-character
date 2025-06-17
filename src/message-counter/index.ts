import { Context, h, Service, Session } from 'koishi'
import {
    Message,
    MessageCollectorFilter,
    MessageCollectorTrigger
} from './types'
import { getNotEmptyString } from 'koishi-plugin-chatluna/utils/string'
import { ObjectLock } from 'koishi-plugin-chatluna/utils/lock'
import { Config } from '..'
import { randomUUID } from 'crypto'

export class MessageCollector extends Service {
    private _groupMessages: Record<string, Message[]> = {}
    private _privateMessages: Record<string, Message[]> = {}

    private _maxMessageCount = 200

    private _triggerFunctions: {
        trigger: MessageCollectorTrigger
        filter: MessageCollectorFilter
    }[] = []

    private _locks: Record<string, ObjectLock> = {}

    constructor(
        ctx: Context,
        public config: Config
    ) {
        // TODO: max message count in memory
        super(ctx, 'chatluna_character_message')
    }

    async addHandler(
        handler: MessageCollectorTrigger,
        trigger: MessageCollectorFilter
    ) {
        this._triggerFunctions.push({
            trigger: handler,
            filter: trigger
        })
    }

    private _getLock(session: Session) {
        const id = session.isDirect ? session.author.id : session.guildId
        const lock = this._locks[id] ?? new ObjectLock()
        this._locks[id] = lock
        return lock
    }

    async receiveMessage(session: Session) {
        const isPrivateMessage = session.isDirect

        const lock = this._getLock(session)

        const unlock = await lock.lock()
        try {
            const message: Message = {
                content: session.content,
                name: getNotEmptyString(
                    session.author?.nick,
                    session.author?.name,
                    session.event.user?.name,
                    session.username
                ),
                id: session.author.id,
                uuid: randomUUID(),
                timestamp: session.event.timestamp,
                quote: session.quote
                    ? {
                          content: mapElementToString(
                              session,
                              session.quote.content,
                              session.quote.elements ?? [
                                  h.text(session.quote.content)
                              ]
                          ),
                          name: session.quote?.user?.name,
                          id: session.quote?.user?.id
                      }
                    : undefined,
                images: this.config.imageInput
                    ? await getMessageImages(this.ctx, session)
                    : undefined
            }

            let history: Message[]
            if (isPrivateMessage) {
                const prev = this._privateMessages[session.author.id] ?? []
                prev.push(message)
                if (prev.length > this._maxMessageCount)
                    prev.splice(0, prev.length - this._maxMessageCount)

                this._privateMessages[session.author.id] = prev
                history = this._privateMessages[session.author.id]
            } else {
                const prev = this._groupMessages[session.guildId] ?? []
                prev.push(message)
                if (prev.length > this._maxMessageCount)
                    prev.splice(0, prev.length - this._maxMessageCount)

                this._groupMessages[session.guildId] = prev
                history = this._groupMessages[session.guildId]
            }

            const promises = this._triggerFunctions.map(
                async ({ trigger, filter }) => {
                    try {
                        const result = await filter(session, message, history)
                        if (result) {
                            await trigger(session, message, history)
                        }
                    } catch (error) {
                        this.ctx.logger.error(error)
                    }
                }
            )

            await Promise.all(promises)
        } finally {
            unlock()
        }
    }
}

declare module 'koishi' {
    interface Context {
        chatluna_character_message: MessageCollector
    }
}

function mapElementToString(session: Session, content: string, elements: h[]) {
    const filteredBuffer: string[] = []

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
            filteredBuffer.push(`[image]`)
        }
    }

    if (content.trimEnd().length < 1 && filteredBuffer.length < 1) {
        return ''
    }

    return filteredBuffer.join('')
}

async function getMessageImages(ctx: Context, session: Session) {
    const mergedMessage = await ctx.chatluna.messageTransformer.transform(
        session,
        session.elements
    )

    return mergedMessage.additional_kwargs?.['images'] as string[]
}
