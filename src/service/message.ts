// eslint-disable-next-line @typescript-eslint/no-unused-vars
import EventEmitter from 'events'
import { Context, h, Logger, Service, Session } from 'koishi'
import { createLogger } from 'koishi-plugin-chatluna/lib/utils/logger'
import { Config } from '..'
import { Preset } from '../preset'
import { GroupTemp, Message } from '../types'
import { StickerService } from './sticker'

export class MessageCollector extends Service {
    private _messages: Record<string, Message[]> = {}

    private _eventEmitter = new EventEmitter()

    private _filters: MessageCollectorFilter[] = []

    private _groupLocks: Record<string, GroupLock> = {}

    private _groupTemp: Record<string, GroupTemp> = {}

    stickerService: StickerService

    preset: Preset

    logger: Logger

    constructor(
        public readonly ctx: Context,
        public _config: Config
    ) {
        super(ctx, 'chatluna_character')
        this.stickerService = new StickerService(ctx, _config)
        this.logger = createLogger(ctx, 'chatluna-character')
        this.preset = new Preset(ctx)
    }

    addFilter(filter: MessageCollectorFilter) {
        this._filters.push(filter)
    }

    mute(session: Session, time: number) {
        const lock = this._getGroupLocks(session.guildId)
        let mute = lock.mute ?? 0
        if (mute < new Date().getTime()) {
            mute = new Date().getTime() + time
        } else {
            mute = mute + time
        }
        lock.mute = mute
    }

    collect(func: (session: Session, messages: Message[]) => Promise<void>) {
        this._eventEmitter.on('collect', func)
    }

    getMessages(groupId: string) {
        return this._messages[groupId]
    }

    isMute(session: Session) {
        const lock = this._getGroupLocks(session.guildId)

        // 移除对 at 的权重
        return lock.mute > new Date().getTime()
    }

    async updateTemp(session: Session, temp: GroupTemp) {
        await this._lock(session)

        const groupId = session.guildId

        this._groupTemp[groupId] = temp

        await this._unlock(session)
    }

    async getTemp(session: Session): Promise<GroupTemp> {
        await this._lock(session)

        const groupId = session.guildId

        const temp = this._groupTemp[groupId] ?? {
            completionMessages: []
        }

        this._groupTemp[groupId] = temp

        await this._unlock(session)

        return temp
    }

    private _getGroupLocks(groupId: string) {
        if (!this._groupLocks[groupId]) {
            this._groupLocks[groupId] = {
                lock: false,
                mute: 0
            }
        }
        return this._groupLocks[groupId]
    }

    private _lock(session: Session) {
        const groupLock = this._getGroupLocks(session.guildId)
        return new Promise<void>((resolve) => {
            const interval = setInterval(() => {
                if (!groupLock.lock) {
                    groupLock.lock = true
                    clearInterval(interval)
                    resolve()
                }
            }, 100)
        })
    }

    private _unlock(session: Session) {
        const groupLock = this._getGroupLocks(session.guildId)
        return new Promise<void>((resolve) => {
            const interval = setInterval(() => {
                if (groupLock.lock) {
                    groupLock.lock = false
                    clearInterval(interval)
                    resolve()
                }
            }, 100)
        })
    }

    clear(groupId?: string) {
        if (groupId) {
            this._messages[groupId] = []
        } else {
            this._messages = {}
        }
        this._groupTemp[groupId] = {
            completionMessages: []
        }
    }

    async broadcastOnBot(session: Session, elements: h[]) {
        if (session.isDirect) {
            return
        }

        await this._lock(session)

        const groupId = session.guildId
        const maxMessageSize = this._config.maxMessages
        const groupArray = this._messages[groupId]
            ? this._messages[groupId]
            : []

        const content = mapElementToString(session, session.content, elements)

        if (content.length < 1) {
            await this._unlock(session)
            return
        }

        const message: Message = {
            content,
            name: session.bot.user.name,
            id: session.bot.userId ?? session.bot.selfId ?? '0'
        }

        groupArray.push(message)

        if (groupArray.length > maxMessageSize) {
            while (groupArray.length > maxMessageSize) {
                groupArray.shift()
            }
        }

        this._messages[groupId] = groupArray

        await this._unlock(session)
    }

    async broadcast(session: Session) {
        if (session.isDirect) {
            return
        }

        await this._lock(session)

        const groupId = session.guildId
        const maxMessageSize = this._config.maxMessages
        const groupArray = this._messages[groupId]
            ? this._messages[groupId]
            : []

        const elements = session.elements
            ? session.elements
            : [h.text(session.content)]

        const content = mapElementToString(session, session.content, elements)

        if (content.length < 1) {
            await this._unlock(session)
            return
        }

        const message: Message = {
            content,
            name: session.author.name,
            id: session.author.id,
            quote: session.quote
                ? {
                      content: mapElementToString(
                          session,
                          session.quote.content,
                          // TODO: remove as
                          session.quote.elements as unknown as h[]
                      ),
                      name: session.quote.user.name,
                      id: session.quote.user.id
                  }
                : undefined
        }

        groupArray.push(message)

        if (groupArray.length > maxMessageSize) {
            while (groupArray.length > maxMessageSize) {
                groupArray.shift()
            }
        }

        this._messages[groupId] = groupArray

        if (
            this._filters.some((func) => func(session, message)) &&
            !this.isMute(session)
        ) {
            this._eventEmitter.emit('collect', session, groupArray)
            await this._unlock(session)
            return true
        } else {
            await this._unlock(session)
            // 禁言时还是不响应好点。。。。
            // 命令是不会受到影响的
            return this.isMute(session)
        }
    }
}

function mapElementToString(session: Session, content: string, elements: h[]) {
    const filteredBuffer: string[] = []

    if (content.trimEnd().length < 1) {
        return ''
    }

    for (const element of elements) {
        if (element.type === 'text') {
            const content = element.attrs.content as string

            if (content.trimEnd().length > 0) {
                filteredBuffer.push(content)
            }
        } else if (element.type === 'at') {
            let name = element.attrs?.name
            if (element.attrs.id === session.bot.selfId) {
                name = name ?? session.bot.user.name ?? '0'
            }
            if (name == null) {
                name = element.attrs.id ?? '0'
            }

            filteredBuffer.push(`(${name}-${element.attrs.id}-<at>)`)
        }
    }

    return filteredBuffer.join('')
}

type MessageCollectorFilter = (session: Session, message: Message) => boolean

interface GroupLock {
    lock: boolean
    mute: number
}

declare module 'koishi' {
    export interface Context {
        chatluna_character: MessageCollector
    }
}
