// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Context, h, Logger, Service, Session, Time } from 'koishi'
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
import { Config } from '..'
import { Preset } from '../preset'
import { GroupTemp, Message } from '../types'
import { StickerService } from './sticker'
import {
    hashString,
    isMessageContentImageUrl
} from 'koishi-plugin-chatluna/utils/string'

export class MessageCollector extends Service {
    private _messages: Record<string, Message[]> = {}

    private _filters: MessageCollectorFilter[] = []

    private _groupLocks: Record<string, GroupLock> = {}

    private _groupTemp: Record<string, GroupTemp> = {}

    stickerService: StickerService

    preset: Preset

    declare logger: Logger

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

    muteAtLeast(session: Session, time: number) {
        const lock = this._getGroupLocks(session.guildId)
        lock.mute = Math.max(lock.mute ?? 0, Date.now() + time)
    }

    collect(func: (session: Session, messages: Message[]) => Promise<void>) {
        this.ctx.on('chatluna_character/message_collect', func)
    }

    getMessages(groupId: string) {
        return this._messages[groupId]
    }

    isMute(session: Session) {
        const lock = this._getGroupLocks(session.guildId)

        return lock.mute > new Date().getTime()
    }

    isResponseLocked(session: Session) {
        const lock = this._getGroupLocks(session.guildId)
        return lock.responseLock
    }

    setResponseLock(session: Session) {
        const lock = this._getGroupLocks(session.guildId)
        lock.responseLock = true
    }

    releaseResponseLock(session: Session) {
        const lock = this._getGroupLocks(session.guildId)
        lock.responseLock = false
        lock.pendingTrigger = undefined
    }

    setPendingTrigger(session: Session, message: Message) {
        const lock = this._getGroupLocks(session.guildId)
        lock.pendingTrigger = { session, message, timestamp: Date.now() }
    }

    takePendingTrigger(groupId: string) {
        const lock = this._getGroupLocks(groupId)
        const pendingTrigger = lock.pendingTrigger
        lock.pendingTrigger = undefined
        return pendingTrigger
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
                mute: 0,
                responseLock: false
            }
        }
        return this._groupLocks[groupId]
    }

    private _getGroupConfig(groupId: string) {
        const config = this._config
        if (!config.configs[groupId]) {
            return config
        }
        return Object.assign({}, config, config.configs[groupId])
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
            this._groupTemp[groupId] = {
                completionMessages: []
            }
            const lock = this._groupLocks[groupId]
            if (lock) lock.pendingTrigger = undefined
            return
        }

        this._messages = {}
        this._groupTemp = {}

        for (const lock of Object.values(this._groupLocks)) {
            lock.pendingTrigger = undefined
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
            id: session.bot.selfId ?? '0',
            messageId: session.messageId,
            timestamp: session.event.timestamp
        }

        groupArray.push(message)

        while (groupArray.length > maxMessageSize) {
            groupArray.shift()
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
        let groupArray = this._messages[groupId] ? this._messages[groupId] : []

        const config = this._getGroupConfig(groupId)

        const images = config.image
            ? await getImages(this.ctx, config.model, session)
            : undefined

        const elements = session.elements
            ? session.elements
            : [h.text(session.content)]

        const content = mapElementToString(
            session,
            session.content,
            elements,
            images
        )

        if (content.length < 1) {
            await this._unlock(session)
            return
        }

        const message: Message = {
            content,
            name: getNotEmptyString(
                session.author?.nick,
                session.author?.name,
                session.event.user?.name,
                session.username
            ),
            id: session.author.id,
            messageId: session.messageId,
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
                      id: session.quote?.user?.id,
                      // `session.quote.id` is the quoted message id in Koishi.
                      messageId: (session.quote as { id?: string } | undefined)
                          ?.id
                  }
                : undefined,
            images
        }

        groupArray.push(message)

        while (groupArray.length > maxMessageSize) {
            groupArray.shift()
        }

        const now = Date.now()
        groupArray = groupArray.filter((message) => {
            return (
                message.timestamp == null ||
                message.timestamp >= now - Time.hour
            )
        })

        await this._processImages(groupArray, config)

        this._messages[groupId] = groupArray

        if (
            this._filters.some((func) => func(session, message)) &&
            !this.isMute(session)
        ) {
            this.setResponseLock(session)
            this.ctx
                .parallel(
                    'chatluna_character/message_collect',
                    session,
                    groupArray
                )
                .catch((error) => this.logger.error(error))
            await this._unlock(session)
            return true
        } else {
            await this._unlock(session)
            return this.isMute(session)
        }
    }

    private async _processImages(groupArray: Message[], config: Config) {
        if (!config.image) return

        const maxCount = config.imageInputMaxCount || 3
        const maxSize =
            config.imageInputMaxSize * 1024 * 1024 || 1024 * 1024 * 10

        let currentCount = 0
        let currentSize = 0

        for (let i = groupArray.length - 1; i >= 0; i--) {
            const message = groupArray[i]
            if (!message.images || message.images.length === 0) continue

            const validImages: Awaited<ReturnType<typeof getImages>> = []

            for (const image of message.images) {
                const imageSize = await this._getImageSize(image.url)

                if (
                    currentCount < maxCount &&
                    currentSize + imageSize <= maxSize
                ) {
                    validImages.push(image)
                    currentCount++
                    currentSize += imageSize
                } else {
                    break
                }
            }

            if (validImages.length === 0) {
                delete message.images
            } else {
                message.images = validImages
            }

            if (currentCount >= maxCount || currentSize >= maxSize) {
                for (let j = i - 1; j >= 0; j--) {
                    if (groupArray[j].images) {
                        delete groupArray[j].images
                    }
                }
                break
            }
        }
    }

    private async _getImageSize(base64Image: string): Promise<number> {
        if (!base64Image.startsWith('data:')) {
            const resp = await this.ctx.http.get(base64Image, {
                responseType: 'arraybuffer'
            })
            return resp.byteLength
        }
        try {
            const base64Data = base64Image.replace(
                /^data:image\/[a-z]+;base64,/,
                ''
            )
            return Math.ceil((base64Data.length * 3) / 4)
        } catch {
            return 0
        }
    }
}

type MessageImage = {
    url: string
    hash: string
    formatted: string
}

function mapElementToString(
    session: Session,
    content: string,
    elements: h[],
    images?: MessageImage[]
) {
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

            if (matchedImage) {
                filteredBuffer.push(matchedImage.formatted)
                usedImages.add(matchedImage.formatted)
            } else if (images && images.length > 0) {
                for (const image of images) {
                    if (!usedImages.has(image.formatted)) {
                        filteredBuffer.push(image.formatted)
                        usedImages.add(image.formatted)
                    }
                }
            } else if (imageUrl) {
                filteredBuffer.push(`<sticker>${imageUrl}</sticker>`)
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
        }
    }

    if (content.trimEnd().length < 1 && filteredBuffer.length < 1) {
        return ''
    }

    return filteredBuffer.join('')
}

// 返回 base64 的图片编码
async function getImages(ctx: Context, model: string, session: Session) {
    const mergedMessage = await ctx.chatluna.messageTransformer.transform(
        session,
        session.elements,
        model
    )

    if (typeof mergedMessage.content === 'string') {
        return undefined
    }

    const images = mergedMessage.content.filter(isMessageContentImageUrl)

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

type MessageCollectorFilter = (session: Session, message: Message) => boolean

interface GroupLock {
    lock: boolean
    mute: number
    responseLock: boolean
    pendingTrigger?: PendingTrigger
}

interface PendingTrigger {
    session: Session
    message: Message
    timestamp: number
}

declare module 'koishi' {
    export interface Context {
        chatluna_character: MessageCollector
    }
    export interface Events {
        'chatluna_character/message_collect': (
            session: Session,
            message: Message[]
        ) => void | Promise<void>
    }
}

export function getNotEmptyString(...texts: (string | undefined)[]): string {
    for (const text of texts) {
        if (text && text?.length > 0) {
            return text
        }
    }
}
