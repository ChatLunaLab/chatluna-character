// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Context, h, Logger, Service, Session, Time } from 'koishi'
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
import { isForwardMessageElement } from 'koishi-plugin-chatluna/utils/koishi'
import {
    hashString,
    isMessageContentImageUrl
} from 'koishi-plugin-chatluna/utils/string'
import { ObjectLock } from 'koishi-plugin-chatluna/utils/lock'
import { Config } from '..'
import { Preset } from '../preset'
import {
    GroupLock,
    GroupTemp,
    Message,
    MessageCollectorFilter,
    MessageImage
} from '../types'

const GEMINI_EXTRA_FILE_LIMIT_ATTR =
    'chatluna_gemini_extra_file_input_max_size_mb'

function attachGeminiExtraFileLimit(elements: h[], maxSizeMb: number) {
    if (!Number.isFinite(maxSizeMb) || maxSizeMb <= 0) {
        return
    }

    const limit = Math.floor(maxSizeMb)
    for (const element of elements) {
        if (
            element.type === 'file' ||
            element.type === 'video' ||
            element.type === 'audio'
        ) {
            element.attrs[GEMINI_EXTRA_FILE_LIMIT_ATTR] = String(limit)
        }
    }
}

export class MessageCollector extends Service {
    private _messages: Record<string, Message[]> = {}

    private _filters: MessageCollectorFilter[] = []

    private _groupLocks: Record<string, GroupLock> = {}

    private _groupMutexes: Record<string, ObjectLock> = {}

    private _groupTemp: Record<string, GroupTemp> = {}

    private _responseWaiters: Record<
        string,
        {
            resolve: () => void
            reject: (reason?: string) => void
        }[]
    > = {}

    private _lastSessions: Record<string, Session> = {}

    preset: Preset

    declare logger: Logger

    constructor(
        public readonly ctx: Context,
        public _config: Config
    ) {
        super(ctx, 'chatluna_character')
        this.logger = createLogger(ctx, 'chatluna-character')
        this.preset = new Preset(ctx)
    }

    addFilter(filter: MessageCollectorFilter) {
        this._filters.push(filter)
    }

    mute(session: Session, time: number) {
        const lock = this._getGroupLocks(session.guildId)
        let mute = lock.mute ?? 0

        if (time === 0) {
            mute = 0
        } else if (mute < new Date().getTime()) {
            mute = new Date().getTime() + time
        } else {
            mute = mute + time
        }
        lock.mute = mute
    }

    async muteAtLeast(session: Session, time: number) {
        const groupId = session.guildId
        const unlock = await this._lockByGroupId(groupId)
        try {
            const groupLock = this._getGroupLocks(groupId)
            groupLock.mute = Math.max(groupLock.mute ?? 0, Date.now() + time)
        } finally {
            unlock()
        }
    }

    collect(
        func: (
            session: Session,
            messages: Message[],
            triggerReason?: string,
            signal?: AbortSignal
        ) => Promise<void>
    ) {
        this.ctx.on('chatluna_character/message_collect', func)
    }

    getMessages(groupId: string) {
        return this._messages[groupId]
    }

    getLastSession(groupId: string) {
        return this._lastSessions[groupId]
    }

    isMute(session: Session) {
        const lock = this._getGroupLocks(session.guildId)

        return lock.mute > new Date().getTime()
    }

    isResponseLocked(session: Session) {
        const lock = this._getGroupLocks(session.guildId)
        return lock.responseLock
    }

    /**
     * Try to acquire the response lock. If the lock is already held, wait until it is released.
     * @returns A Promise that resolves to whether the lock was successfully acquired (false means cancelled)
     */
    async acquireResponseLock(
        session: Session,
        message: Message
    ): Promise<boolean> {
        const groupId = session.guildId

        const unlock = await this._lockByGroupId(groupId)

        const lock = this._getGroupLocks(groupId)

        if (!lock.responseLock) {
            lock.responseLock = true
            unlock()
            return true
        }

        // Lock is held, create waiter while holding mutex
        const waiterPromise = new Promise<boolean>((resolve) => {
            if (!this._responseWaiters[groupId]) {
                this._responseWaiters[groupId] = []
            }
            this._responseWaiters[groupId].push({
                resolve: () => resolve(true),
                reject: () => resolve(false)
            })
        })

        unlock()

        return waiterPromise
    }

    setResponseLock(session: Session) {
        const lock = this._getGroupLocks(session.guildId)
        lock.responseLock = true
    }

    async releaseResponseLock(session: Session) {
        const groupId = session.guildId

        const unlock = await this._lockByGroupId(groupId)

        try {
            const lock = this._getGroupLocks(groupId)
            lock.responseLock = false

            const waiters = this._responseWaiters[groupId]
            if (waiters && waiters.length > 0) {
                // Cancel all old waiters, only wake up the latest one
                const latestWaiter = waiters.pop()
                for (const waiter of waiters) {
                    waiter.reject()
                }
                this._responseWaiters[groupId] = []

                if (latestWaiter) {
                    lock.responseLock = true
                    latestWaiter.resolve()
                }
            }
        } finally {
            unlock()
        }
    }

    async cancelPendingWaiters(groupId: string) {
        const unlock = await this._lockByGroupId(groupId)

        try {
            const waiters = this._responseWaiters[groupId]
            if (waiters) {
                for (const waiter of waiters) {
                    waiter.reject('cancelled')
                }
                this._responseWaiters[groupId] = []
            }
        } finally {
            unlock()
        }
    }

    async updateTemp(session: Session, temp: GroupTemp) {
        const groupId = session.guildId
        const unlock = await this._lockByGroupId(groupId)
        try {
            this._groupTemp[groupId] = temp
        } finally {
            unlock()
        }
    }

    async getTemp(session: Session): Promise<GroupTemp> {
        const groupId = session.guildId
        const unlock = await this._lockByGroupId(groupId)
        try {
            const temp = this._groupTemp[groupId] ?? {
                completionMessages: []
            }
            this._groupTemp[groupId] = temp
            return temp
        } finally {
            unlock()
        }
    }

    private _getGroupLocks(groupId: string) {
        if (!this._groupLocks[groupId]) {
            this._groupLocks[groupId] = {
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

    private _getMutex(groupId: string): ObjectLock {
        if (!this._groupMutexes[groupId]) {
            this._groupMutexes[groupId] = new ObjectLock()
        }
        return this._groupMutexes[groupId]
    }

    private _lockByGroupId(groupId: string): Promise<() => void> {
        return this._getMutex(groupId).lock()
    }

    async clear(groupId?: string) {
        if (groupId) {
            const unlock = await this._lockByGroupId(groupId)
            try {
                this._messages[groupId] = []
                this._groupTemp[groupId] = {
                    completionMessages: []
                }
                delete this._lastSessions[groupId]
                // Cancel waiters directly while holding lock
                const waiters = this._responseWaiters[groupId]
                if (waiters) {
                    for (const waiter of waiters) {
                        waiter.reject('cancelled')
                    }
                    this._responseWaiters[groupId] = []
                }
            } finally {
                unlock()
            }
            return
        }

        // For clear-all, acquire locks in sorted order to prevent deadlocks
        const groupIds = Object.keys(this._groupLocks).sort()
        const unlocks: Array<() => void> = []
        for (const gid of groupIds) {
            unlocks.push(await this._lockByGroupId(gid))
        }

        try {
            this._messages = {}
            this._groupTemp = {}
            this._lastSessions = {}

            // Cancel waiters directly while holding locks
            for (const gid of groupIds) {
                const waiters = this._responseWaiters[gid]
                if (waiters) {
                    for (const waiter of waiters) {
                        waiter.reject('cancelled')
                    }
                    this._responseWaiters[gid] = []
                }
            }
        } finally {
            // Release in reverse order
            for (let i = unlocks.length - 1; i >= 0; i--) {
                unlocks[i]()
            }
        }
    }

    async broadcastOnBot(session: Session, elements: h[]) {
        if (session.isDirect) {
            return
        }

        const content = mapElementToString(session, session.content, elements)

        if (content.length < 1) {
            return
        }

        const message: Message = {
            content,
            name: session.bot.user.name,
            id: session.bot.selfId ?? '0',
            messageId: session.messageId,
            timestamp: session.event.timestamp
        }

        await this._addMessage(session, message)
    }

    async broadcast(session: Session) {
        if (session.isDirect) {
            return
        }

        const groupId = session.guildId
        this._lastSessions[groupId] = session
        const config = this._getGroupConfig(groupId)

        const elements = session.elements
            ? session.elements
            : [h.text(session.content)]
        attachGeminiExtraFileLimit(elements, config.geminiExtraFileInputMaxSize)
        const mergedMessage = await this.ctx.chatluna.messageTransformer.transform(
            session,
            elements,
            config.model
        )

        const images = config.image
            ? await getImages(this.ctx, config.model, session, mergedMessage)
            : undefined

        const content = mapElementToString(
            session,
            session.content,
            elements,
            images
        )

        if (content.length < 1) {
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
                      messageId: session.quote.id
                  }
                : undefined,
            images
        }

        const triggerReason = await this._addMessage(session, message, {
            filterExpiredMessages: true,
            processImages: config
        })

        if (triggerReason && !this.isMute(session)) {
            const triggered = await this.triggerCollect(
                session,
                triggerReason,
                message
            )
            return triggered
        } else {
            return this.isMute(session)
        }
    }

    async triggerCollect(
        session: Session,
        triggerReason: string,
        message?: Message,
        signal?: AbortSignal
    ) {
        const groupId = session.guildId
        const focusMessage = message ?? this._messages[groupId]?.at(-1)
        const acquired = await this.acquireResponseLock(
            session,
            focusMessage ?? {
                content: '',
                name: session.bot.user?.name ?? session.selfId,
                id: session.bot.selfId ?? '0'
            }
        )

        if (!acquired) {
            return false
        }

        await this.ctx.parallel(
            'chatluna_character/message_collect',
            session,
            this._messages[groupId] ?? [],
            triggerReason,
            signal
        )

        return true
    }

    private async _addMessage(
        session: Session,
        message: Message,
        options?: {
            filterExpiredMessages?: boolean
            processImages?: Config
        }
    ): Promise<string | undefined> {
        const unlock = await this._lockByGroupId(session.guildId)

        try {
            const groupId = session.guildId
            const maxMessageSize = this._config.maxMessages
            let groupArray = this._messages[groupId] ?? []

            groupArray.push(message)

            while (groupArray.length > maxMessageSize) {
                groupArray.shift()
            }

            if (options?.filterExpiredMessages) {
                const now = Date.now()
                groupArray = groupArray.filter((msg) => {
                    return (
                        msg.timestamp == null ||
                        msg.timestamp >= now - Time.hour
                    )
                })
            }

            if (options?.processImages) {
                await this._processImages(groupArray, options.processImages)
            }

            this._messages[groupId] = groupArray

            for (const filter of this._filters) {
                const reason = filter(session, message)
                if (typeof reason === 'string' && reason.length > 0) {
                    return reason
                }
            }

            return undefined
        } finally {
            unlock()
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
        try {
            if (!base64Image.startsWith('data:')) {
                const resp = await this.ctx.http.get(base64Image, {
                    responseType: 'arraybuffer'
                })
                return resp.byteLength
            }
            const base64Data = base64Image.replace(
                /^data:image\/[a-z]+;base64,/,
                ''
            )
            return Math.ceil((base64Data.length * 3) / 4)
        } catch (e) {
            this.logger.error(e, base64Image)
            return 0
        }
    }
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

            if (imageUrl) {
                filteredBuffer.push(`<sticker>${imageUrl}</sticker>`)
            } else if (matchedImage) {
                filteredBuffer.push(matchedImage.formatted)
                usedImages.add(matchedImage.formatted)
            } else if (images && images.length > 0) {
                for (const image of images) {
                    if (!usedImages.has(image.formatted)) {
                        filteredBuffer.push(image.formatted)
                        usedImages.add(image.formatted)
                    }
                }
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
        } else if (
            element.type === 'file' ||
            element.type === 'video' ||
            element.type === 'audio'
        ) {
            const url = element.attrs['chatluna_file_url']
            if (!url) {
                continue
            }
            const name =
                element.attrs['file'] ??
                element.attrs['name'] ??
                element.attrs['filename'] ??
                (element.type === 'video'
                    ? 'video'
                    : element.type === 'audio'
                    ? 'audio'
                    : 'file')

            const marker = element.type === 'audio' ? 'voice' : 'file'
            filteredBuffer.push(`[${marker}:${name}:${url}]`)
        } else if (isForwardMessageElement(element)) {
            filteredBuffer.push('[聊天记录]')
        }
    }

    if (content.trimEnd().length < 1 && filteredBuffer.length < 1) {
        return ''
    }

    return filteredBuffer.join('')
}

// 返回 base64 的图片编码
async function getImages(
    ctx: Context,
    model: string,
    session: Session,
    mergedMessage?: Awaited<
        ReturnType<Context['chatluna']['messageTransformer']['transform']>
    >
) {
    const transformed =
        mergedMessage ??
        (await ctx.chatluna.messageTransformer.transform(
            session,
            session.elements,
            model
        ))

    if (typeof transformed.content === 'string') {
        return undefined
    }

    const images = transformed.content.filter(isMessageContentImageUrl)

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

export function getNotEmptyString(...texts: (string | undefined)[]): string {
    for (const text of texts) {
        if (text && text?.length > 0) {
            return text
        }
    }
}

declare module 'koishi' {
    export interface Context {
        chatluna_character: MessageCollector
    }
    export interface Events {
        'chatluna_character/message_collect': (
            session: Session,
            message: Message[],
            triggerReason?: string,
            signal?: AbortSignal
        ) => void | Promise<void>
    }
}
