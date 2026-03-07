// eslint-disable-next-line @typescript-eslint/no-unused-vars
import { Bot, Context, h, Logger, Service, Session, Time } from 'koishi'
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
    IMAGE_SIZE_CACHE_LIMIT,
    Message,
    MessageCollectorFilter,
    MessageImage,
    OneBotHistoryMessage
} from '../types'
import { parseCQCode } from '../onebot/cqcode'
import { VariableStore } from './variable_store'
import { attachMultimodalFileLimit } from '../utils'

interface BotAPIMessage {
    id?: string
    userId?: string
    content?: string
    elements?: h[]
    messageId?: string
    timestamp?: number
    createdAt?: number
    member?: {
        name?: string
    }
    user?: {
        id?: string
        nick?: string
        name?: string
        avatar?: string
    }
    guild?: {
        id?: string
    }
    quote?: {
        id?: string
        content?: string
        elements?: h[]
        user?: {
            id?: string
            nick?: string
            name?: string
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

    private _imageSizeCache: Record<string, number> = {}

    private _imageSizeCacheCount = 0

    private _store: VariableStore

    preset: Preset

    declare logger: Logger

    constructor(
        public readonly ctx: Context,
        public _config: Config
    ) {
        super(ctx, 'chatluna_character')
        this.logger = createLogger(ctx, 'chatluna-character')
        this.preset = new Preset(ctx)
        this._store = new VariableStore(ctx)
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
     * @returns A Promise that resolves to whether the lock was successfully
     * acquired (false means cancelled)
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

    async getTemp(session: Session, msgs?: Message[]): Promise<GroupTemp> {
        const groupId = session.guildId
        const unlock = await this._lockByGroupId(groupId)
        try {
            const temp = this._getOrCreateGroupTemp(groupId)

            if (!temp.recordLoaded) {
                await this._store.read(groupId, temp)
            }

            if (
                msgs &&
                temp.status != null &&
                msgs.length > 0 &&
                (temp.statusMessageId != null ||
                    temp.statusMessageTimestamp != null ||
                    temp.statusMessageContent != null) &&
                !msgs.some((msg) => {
                    if (
                        temp.statusMessageId != null &&
                        msg.messageId != null &&
                        temp.statusMessageId === msg.messageId
                    ) {
                        return true
                    }

                    return (
                        temp.statusMessageTimestamp != null &&
                        temp.statusMessageContent != null &&
                        temp.statusMessageUserId != null &&
                        msg.timestamp === temp.statusMessageTimestamp &&
                        msg.content === temp.statusMessageContent &&
                        msg.id === temp.statusMessageUserId
                    )
                })
            ) {
                temp.status = null
            }

            this._groupTemp[groupId] = temp
            return temp
        } finally {
            unlock()
        }
    }

    async persistStatus(
        session: Session,
        status?: string,
        anchorMessage?: Message
    ) {
        const groupId = session.guildId
        const config = this._getGroupConfig(groupId)

        if (!config.statusPersistence) {
            return
        }

        const unlock = await this._lockByGroupId(groupId)
        try {
            const temp = this._getOrCreateGroupTemp(groupId)
            if (!temp.recordLoaded) {
                await this._store.read(groupId, temp)
            }
            this._groupTemp[groupId] = temp
            await this._store.save(groupId, temp, status, anchorMessage)
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

    private _getOrCreateGroupTemp(groupId: string): GroupTemp {
        return this._groupTemp[groupId] ?? newTemp()
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
            const config = this._getGroupConfig(groupId)
            const clearedAt = new Date()
            const unlock = await this._lockByGroupId(groupId)
            try {
                this._messages[groupId] = []
                this._groupTemp[groupId] = newTemp(clearedAt)
                delete this._lastSessions[groupId]
                // Cancel waiters directly while holding lock
                const waiters = this._responseWaiters[groupId]
                if (waiters) {
                    for (const waiter of waiters) {
                        waiter.reject('cancelled')
                    }
                    this._responseWaiters[groupId] = []
                }

                if (config.statusPersistence || config.historyPull) {
                    await this._store.clear(groupId, clearedAt)
                }
            } finally {
                unlock()
            }
            return
        }

        // For clear-all, acquire locks in sorted order to prevent deadlocks
        const groupIds = Object.keys(this._groupLocks).sort()
        const unlocks: (() => void)[] = []
        for (const gid of groupIds) {
            unlocks.push(await this._lockByGroupId(gid))
        }

        try {
            const clearedAt = new Date()
            this._messages = {}
            this._groupTemp = Object.fromEntries(
                groupIds.map((groupId) => [groupId, newTemp(clearedAt)])
            )
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

            await Promise.all(
                groupIds.map(async (groupId) => {
                    const config = this._getGroupConfig(groupId)
                    if (config.statusPersistence || config.historyPull) {
                        await this._store.clear(groupId, clearedAt)
                    }
                })
            )
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

        attachMultimodalFileLimit(elements, config.multimodalFileInputMaxSize)

        const preMessage = config.image
            ? await this.ctx.chatluna.messageTransformer.transform(
                  session,
                  elements,
                  config.model
              )
            : undefined

        const images = config.image
            ? await getImages(this.ctx, config.model, session, preMessage)
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
            await this.pullHistory(session, message)
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

    async pullHistory(session: Session, focusMessage: Message) {
        const groupId = session.guildId
        const cfg = this._getGroupConfig(groupId)
        const max = cfg.maxMessages

        if (!cfg.historyPull) {
            return
        }

        const temp = await this.getTemp(session)
        const cutoff = temp.historyClearedAt?.getTime()
        const msgs = this._messages[groupId] ?? []
        const count = Math.max(0, max - msgs.length)

        if (count < 1) {
            temp.historyPulled = true
            return
        }

        if (temp.historyPulled) {
            return
        }

        this.logger.debug(
            `Try to pull ${count} history message(s) for guild ${groupId}.`
        )

        const list = await this._pull(
            session,
            count,
            focusMessage,
            cutoff
        )

        const unlock = await this._lockByGroupId(groupId)
        try {
            const current = this._groupTemp[groupId] ?? temp
            if (current.historyClearedAt?.getTime() !== cutoff) {
                return
            }

            current.historyPulled = true
            this._groupTemp[groupId] = current

            if (list.length < 1) {
                this.logger.debug(
                    `No history messages pulled for guild ${groupId}. ` +
                        `Cutoff: ${formatLogDate(current.historyClearedAt)}.`
                )
                return
            }

            this.logger.debug(
                `Pulled ${list.length} history message(s) for guild ${groupId}. ` +
                    `Cutoff: ${formatLogDate(current.historyClearedAt)}.`
            )

            this._messages[groupId] = mergeMessages(
                this._messages[groupId] ?? [],
                list,
                max
            )
        } finally {
            unlock()
        }
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

    private async _pull(
        session: Session,
        count: number,
        focusMessage: Message,
        clearedAfter?: number
    ): Promise<Message[]> {
        if (session.platform === 'onebot') {
            return this._pullOneBot(session, count, focusMessage, clearedAfter)
        }

        if (typeof session.bot.getMessageList === 'function') {
            return this._pullBot(session, count, focusMessage, clearedAfter)
        }

        this.logger.debug(
            `Skip history pull for guild ${session.guildId}: ` +
                'current adapter does not support history API.'
        )
        return []
    }

    private async _pullBot(
        session: Session,
        count: number,
        focusMessage: Message,
        clearedAfter?: number
    ): Promise<Message[]> {
        const bot = session.bot as Bot & {
            getMessageList: Bot['getMessageList']
        }

        const targetId = session.channelId ?? session.guildId

        if (targetId == null || bot.getMessageList == null) {
            this.logger.warn(
                `Skip history pull for guild ${session.guildId}: ` +
                    'Bot API requires a valid channel id.'
            )
            return []
        }

        const results: Message[] = []
        let nextId: string | undefined
        let previousNextId: string | undefined

        while (results.length < count) {
            let response: Awaited<ReturnType<typeof bot.getMessageList>>
            try {
                response = await bot.getMessageList(targetId, nextId, 'before')
            } catch (error) {
                this.logger.warn(
                    `Failed to pull Bot API history for guild ${session.guildId}`,
                    error
                )
                return []
            }

            const batch = response.data ?? []
            if (batch.length < 1) {
                break
            }

            const list = batch
                .map((msg) => toBotMsg(session, msg))
                .filter((message): message is Message => message != null)
                .filter((message) => !sameMessage(message, focusMessage))
                .filter(
                    (message) =>
                        clearedAfter == null ||
                        message.timestamp == null ||
                        message.timestamp > clearedAfter
                )

            results.unshift(...list)

            const oldestMessage = batch[0]
            const oldestTimestamp =
                oldestMessage?.timestamp ?? oldestMessage?.createdAt ?? 0
            if (clearedAfter != null && oldestTimestamp <= clearedAfter) {
                break
            }
            nextId = response.prev ?? oldestMessage?.id
            if (nextId == null || nextId.length < 1) {
                break
            }

            if (nextId === previousNextId) {
                break
            }

            previousNextId = nextId
        }

        return mergeMessages([], results, count)
    }

    private async _pullOneBot(
        session: Session,
        count: number,
        focusMessage: Message,
        clearedAfter?: number
    ): Promise<Message[]> {
        const bot = session.bot as Session['bot'] & {
            platform: string
            internal?: {
                _request: (
                    action: string,
                    params: Record<string, unknown>
                ) => Promise<{ data?: Record<string, unknown> }>
            }
        }

        if (bot.platform !== 'onebot' || bot.internal?._request == null) {
            this.logger.debug(
                `Skip history pull for guild ${session.guildId}: current adapter is not OneBot.`
            )
            return []
        }

        const targetId = Number(session.guildId)
        if (!Number.isFinite(targetId)) {
            this.logger.warn(
                `Skip history pull for guild ${session.guildId}: invalid group id.`
            )
            return []
        }

        let isNapCat = false
        try {
            const versionInfo = await bot.internal._request(
                'get_version_info',
                {}
            )
            const appName = String(
                versionInfo.data?.['app_name'] ?? ''
            ).toLowerCase()
            isNapCat = appName.includes('napcat')
        } catch (error) {
            this.logger.debug('Failed to detect OneBot app info', error)
        }

        const results: OneBotHistoryMessage[] = []
        let fetchedCount = 0
        let messageSeq: number | undefined
        let messageId: number | undefined
        let oldestMessageTime = Number.MAX_SAFE_INTEGER
        const focusTimestamp = focusMessage.timestamp

        while (fetchedCount < count) {
            const requestPackage: Record<string, unknown> = {
                group_id: targetId,
                message_seq: messageSeq,
                message_id: messageId,
                count: Math.min(count - fetchedCount + 1, isNapCat ? 50 : 30),
                reverseOrder: typeof messageSeq === 'number'
            }

            if (!isNapCat) {
                delete requestPackage.reverseOrder
            }

            if (messageSeq == null) {
                delete requestPackage.message_seq
                delete requestPackage.message_id
            }

            let batch: OneBotHistoryMessage[] = []
            try {
                const response = await bot.internal._request(
                    'get_group_msg_history',
                    requestPackage
                )
                batch =
                    (response.data?.['messages'] as OneBotHistoryMessage[]) ??
                    []
            } catch (error) {
                this.logger.warn(
                    `Failed to pull OneBot history for guild ${session.guildId}`,
                    error
                )
                return []
            }

            if (batch.length < 1) {
                break
            }

            const filteredBatch = batch.filter((message) => {
                if (
                    message.message_id != null &&
                    focusMessage.messageId != null
                ) {
                    return String(message.message_id) !== focusMessage.messageId
                }

                if (focusTimestamp == null || message.time == null) {
                    return true
                }

                const messageTimestamp =
                    message.time < 1_000_000_000_000
                        ? message.time * 1000
                        : message.time
                return messageTimestamp < focusTimestamp
            })

            results.unshift(...filteredBatch)
            fetchedCount = results.length

            const oldest = batch[0]
            if (oldest == null || oldest.time == null) {
                break
            }

            if (oldest.time >= oldestMessageTime) {
                break
            }

            oldestMessageTime = oldest.time
            messageSeq = oldest.message_seq
            messageId = oldest.message_id
        }

        return results
            .map((msg) => {
                const raw = msg.raw_message ?? ''
                const content = mapElementToString(
                    session,
                    raw,
                    parseCQCode(raw)
                )

                if (content.length < 1) {
                    return null
                }

                const id = msg.sender?.user_id

                return {
                    content,
                    name: getNotEmptyString(
                        msg.sender?.nickname,
                        msg.sender?.card,
                        String(id ?? '0')
                    ),
                    id: id != null ? String(id) : '0',
                    messageId:
                        msg.message_id != null
                            ? String(msg.message_id)
                            : undefined,
                    timestamp:
                        msg.time == null
                            ? undefined
                            : msg.time < 1_000_000_000_000
                                ? msg.time * 1000
                                : msg.time
                } as Message
            })
            .filter((message): message is Message => message != null)
            .filter((message) => !sameMessage(message, focusMessage))
            .filter(
                (message) =>
                    clearedAfter == null ||
                    (message.timestamp != null &&
                        message.timestamp > clearedAfter)
            )
            .slice(-count)
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
                const imageSize = await this._getCachedImageSize(image)

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

    private async _getCachedImageSize(image: MessageImage): Promise<number> {
        const cacheKey = image.hash || image.url
        const cachedSize = this._imageSizeCache[cacheKey]
        if (cachedSize != null) {
            return cachedSize
        }

        const imageSize = await this._getImageSize(image.url)

        if (this._imageSizeCacheCount >= IMAGE_SIZE_CACHE_LIMIT) {
            this._imageSizeCache = {}
            this._imageSizeCacheCount = 0
        }

        this._imageSizeCache[cacheKey] = imageSize
        this._imageSizeCacheCount++
        return imageSize
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

function newTemp(clearedAt?: Date): GroupTemp {
    return {
        completionMessages: [],
        historyPulled: false,
        historyClearedAt: clearedAt,
        status: null,
        statusMessageId: null,
        statusMessageTimestamp: null,
        statusMessageContent: null,
        statusMessageUserId: null,
        recordLoaded: clearedAt != null
    }
}

function toBotMsg(session: Session, msg: BotAPIMessage): Message | null {
    const text = msg.content ?? ''
    const id = msg.userId ?? msg.user?.id ?? '0'
    const content = mapElementToString(
        session,
        text,
        msg.elements ?? h.parse(text)
    )

    if (content.length < 1) {
        return null
    }

    return {
        content,
        name: getNotEmptyString(
            msg.member?.name,
            msg.user?.nick,
            msg.user?.name,
            id
        ),
        id,
        messageId: msg.messageId ?? msg.id,
        timestamp: msg.timestamp ?? msg.createdAt,
        quote: msg.quote
            ? {
                  content: mapElementToString(
                      session,
                      msg.quote.content ?? '',
                      msg.quote.elements ?? h.parse(msg.quote.content ?? '')
                  ),
                  name: getNotEmptyString(
                      msg.quote.user?.name,
                      msg.quote.user?.nick,
                      msg.quote.user?.id
                  ),
                  id: msg.quote.user?.id,
                  messageId: msg.quote.id
              }
            : undefined
    }
}

function sameMessage(left: Message, right: Message) {
    if (left.messageId != null && right.messageId != null) {
        return left.messageId === right.messageId
    }

    return (
        left.id === right.id &&
        left.timestamp === right.timestamp &&
        left.content === right.content
    )
}

function mergeMessages(list: Message[], add: Message[], max: number) {
    const map = new Map<string, Message>()

    for (const msg of list.concat(add)) {
        const key =
            msg.messageId != null
                ? `message:${msg.messageId}`
                : `fallback:${msg.id}:${msg.timestamp}:${msg.content}`
        map.set(key, msg)
    }

    const merged = [...map.values()].sort((a, b) => {
        const left = a.timestamp ?? 0
        const right = b.timestamp ?? 0
        return left - right
    })

    while (merged.length > max) {
        merged.shift()
    }

    return merged
}

function formatLogDate(value?: Date | null) {
    if (value == null) {
        return 'none'
    }

    return value.toLocaleString('zh-CN', {
        hour12: false,
        timeZone: 'Asia/Shanghai'
    })
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
            let fallbackName = 'file'
            if (element.type === 'video') {
                fallbackName = 'video'
            } else if (element.type === 'audio') {
                fallbackName = 'audio'
            }
            const name =
                element.attrs['file'] ??
                element.attrs['name'] ??
                element.attrs['filename'] ??
                fallbackName

            const marker = element.type === 'audio' ? 'voice' : element.type
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
