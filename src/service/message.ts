import { Context, h, Logger, Service, Session, Time } from 'koishi'
import { createLogger } from 'koishi-plugin-chatluna/utils/logger'
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
    PendingCooldownTrigger
} from '../types'
import {
    attachMultimodalFileLimit,
    pullHistory as doPullHistory,
    formatHistoryLogDate,
    getImages,
    getNotEmptyString,
    mapElementToString,
    mergeMessages
} from '../utils/index'
import { VariableStore } from './variable_store'

const MAX_TIMEOUT_MS = 2147483647

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

    private _imageSizeCache: Record<string, number> = {}

    private _imageSizeCacheCount = 0

    private _pendingCooldownTriggers: Record<string, PendingCooldownTrigger> =
        {}

    private _cooldownTriggerTimers: Record<
        string,
        ReturnType<typeof setTimeout>
    > = {}

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

        ctx.on('ready', async () => {
            const rows = await this._store.list()

            for (const row of rows) {
                this._groupTemp[row.sessionKey] = {
                    completionMessages: [],
                    status: row.status,
                    recordLoaded: true,
                    historyPulled: false,
                    historyClearedAt: row.historyClearedAt,
                    statusMessageId: row.statusMessageId,
                    statusMessageUserId: row.statusMessageUserId
                }
            }
        })

        ctx.on('dispose', () => {
            for (const timer of Object.values(this._cooldownTriggerTimers)) {
                clearTimeout(timer)
            }
            this._cooldownTriggerTimers = {}
        })
    }

    addFilter(filter: MessageCollectorFilter) {
        this._filters.push(filter)
    }

    mute(session: Session, time: number) {
        const lock = this._getGroupLocks(
            `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        )
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
        const key = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        const unlock = await this._lockByGroupId(key)
        try {
            const groupLock = this._getGroupLocks(key)
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

    isMute(session: Session) {
        const lock = this._getGroupLocks(
            `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        )

        return lock.mute > new Date().getTime()
    }

    isResponseLocked(session: Session) {
        const lock = this._getGroupLocks(
            `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        )
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
        const groupId = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`

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
        const lock = this._getGroupLocks(
            `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        )
        lock.responseLock = true
    }

    async releaseResponseLock(session: Session) {
        const groupId = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`

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
        const groupId = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        const unlock = await this._lockByGroupId(groupId)
        try {
            this._groupTemp[groupId] = temp
        } finally {
            unlock()
        }
    }

    async getTemp(session: Session, msgs?: Message[]): Promise<GroupTemp> {
        const groupId = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
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
                temp.statusMessageId != null &&
                !msgs.some((msg) => {
                    return (
                        msg.messageId != null &&
                        temp.statusMessageUserId != null &&
                        temp.statusMessageId === msg.messageId &&
                        temp.statusMessageUserId === msg.id
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
        const groupId = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        const guildConfig = session.isDirect
            ? this._config.privateConfigs[session.userId]
            : this._config.configs[session.guildId]
        const globalConfig = session.isDirect
            ? this._config.globalPrivateConfig
            : this._config.globalGroupConfig
        const config = Object.assign(
            {},
            this._config,
            globalConfig,
            guildConfig
        )

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
            const isDirect = groupId.startsWith('private:')
            const id = isDirect
                ? groupId.slice('private:'.length)
                : groupId.startsWith('group:')
                  ? groupId.slice('group:'.length)
                  : groupId
            const guildConfig = isDirect
                ? this._config.privateConfigs[id]
                : this._config.configs[id]
            const globalConfig = isDirect
                ? this._config.globalPrivateConfig
                : this._config.globalGroupConfig
            const config = Object.assign(
                {},
                this._config,
                globalConfig,
                guildConfig
            )
            const clearedAt = new Date()
            const unlock = await this._lockByGroupId(groupId)
            try {
                this._messages[groupId] = []
                this._groupTemp[groupId] = newTemp(clearedAt)

                delete this._pendingCooldownTriggers[groupId]
                const timer = this._cooldownTriggerTimers[groupId]
                if (timer) {
                    clearTimeout(timer)
                    delete this._cooldownTriggerTimers[groupId]
                }

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

            // Cancel waiters directly while holding locks
            for (const gid of groupIds) {
                const waiters = this._responseWaiters[gid]
                if (waiters) {
                    for (const waiter of waiters) {
                        waiter.reject('cancelled')
                    }
                    this._responseWaiters[gid] = []
                }

                delete this._pendingCooldownTriggers[gid]
                const timer = this._cooldownTriggerTimers[gid]
                if (timer) {
                    clearTimeout(timer)
                    delete this._cooldownTriggerTimers[gid]
                }
            }

            await Promise.all(
                groupIds.map(async (groupId) => {
                    const isDirect = groupId.startsWith('private:')
                    const id = isDirect
                        ? groupId.slice('private:'.length)
                        : groupId.startsWith('group:')
                          ? groupId.slice('group:'.length)
                          : groupId
                    const guildConfig = isDirect
                        ? this._config.privateConfigs[id]
                        : this._config.configs[id]
                    const globalConfig = isDirect
                        ? this._config.globalPrivateConfig
                        : this._config.globalGroupConfig
                    const config = Object.assign(
                        {},
                        this._config,
                        globalConfig,
                        guildConfig
                    )
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

    async broadcastOnBot(
        session: Session,
        messages: { elements: h[]; messageId?: string }[]
    ) {
        for (const item of messages) {
            const content = mapElementToString(session, '', item.elements)

            if (content.length < 1) {
                continue
            }

            const message: Message = {
                content,
                name: session.bot.user.name,
                id: session.bot.selfId ?? '0',
                messageId: item.messageId ?? session.messageId,
                timestamp: session.event.timestamp
            }

            await this._addMessage(session, message)
        }
    }

    async broadcast(session: Session) {
        const groupId = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        this.ctx.chatluna_character_trigger.setLastSession(session)
        const guildConfig = session.isDirect
            ? this._config.privateConfigs[session.userId]
            : this._config.configs[session.guildId]
        const globalConfig = session.isDirect
            ? this._config.globalPrivateConfig
            : this._config.globalGroupConfig
        const config = Object.assign(
            {},
            this._config,
            globalConfig,
            guildConfig
        )

        const elements = session.elements
            ? session.elements
            : [h.text(session.content)]

        attachMultimodalFileLimit(elements, config.multimodalFileInputMaxSize)

        const hasMultimodalFile = elements.some(
            (element) =>
                element.type === 'file' ||
                element.type === 'video' ||
                element.type === 'audio'
        )

        const preMessage =
            config.image || hasMultimodalFile
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

        const quote = session.quote
            ? {
                  content: await (async () => {
                      const quoted = (this._messages[groupId] ?? []).find(
                          (msg) =>
                              msg.messageId != null &&
                              String(msg.messageId) === String(session.quote.id)
                      )
                      if (quoted) {
                          return quoted.content
                      }

                      const quotedElements = session.quote.elements ?? [
                          h.text(session.quote.content)
                      ]

                      if (session.isDirect) {
                          await this.ctx.chatluna.messageTransformer.transform(
                              session,
                              quotedElements,
                              config.model
                          )
                      }

                      return mapElementToString(
                          session,
                          session.quote.content,
                          quotedElements
                      )
                  })(),
                  name: session.quote?.user?.name,
                  id: session.quote?.user?.id,
                  messageId: session.quote.id,
                  timestamp: session.quote.timestamp
              }
            : undefined

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
            quote,
            images
        }

        const triggerReason = await this._addMessage(session, message, {
            filterExpiredMessages: true,
            processImages: config
        })

        if (triggerReason && !this.isMute(session)) {
            const unlock = await this._lockByGroupId(groupId)
            try {
                delete this._pendingCooldownTriggers[groupId]

                const timer = this._cooldownTriggerTimers[groupId]
                if (timer) {
                    clearTimeout(timer)
                    delete this._cooldownTriggerTimers[groupId]
                }
            } finally {
                unlock()
            }

            await this.pullHistory(session, message)
            const triggered = await this.triggerCollect(
                session,
                triggerReason,
                message
            )
            return triggered
        }

        if (triggerReason) {
            const unlock = await this._lockByGroupId(groupId)

            try {
                this._pendingCooldownTriggers[groupId] = {
                    session,
                    triggerReason,
                    message
                }

                const lock = this._getGroupLocks(groupId)
                const delay = Math.max(lock.mute - Date.now(), 0)
                const timer = this._cooldownTriggerTimers[groupId]
                if (timer) {
                    clearTimeout(timer)
                }

                this._cooldownTriggerTimers[groupId] = setTimeout(
                    () => {
                        this._flushCooldownTrigger(groupId).catch((err) => {
                            this.logger.error(err)
                        })
                    },
                    Math.min(delay, MAX_TIMEOUT_MS)
                )
            } finally {
                unlock()
            }

            return true
        }

        return this.isMute(session)
    }

    async triggerCollect(
        session: Session,
        triggerReason: string,
        message?: Message,
        signal?: AbortSignal
    ) {
        const groupId = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
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
        const groupId = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        const guildConfig = session.isDirect
            ? this._config.privateConfigs[session.userId]
            : this._config.configs[session.guildId]
        const globalConfig = session.isDirect
            ? this._config.globalPrivateConfig
            : this._config.globalGroupConfig
        const cfg = Object.assign({}, this._config, globalConfig, guildConfig)

        const temp = await this.getTemp(session)

        if (temp.historyPulled) {
            return
        }

        const cutoff = temp.historyClearedAt?.getTime()
        const list = await doPullHistory({
            logger: this.logger,
            session,
            config: cfg,
            focusMessage,
            messageCount: this._messages[groupId]?.length ?? 0,
            clearedAfter: cutoff
        })

        if (list == null) {
            return
        }

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
                    `No history messages pulled for session ${groupId}. ` +
                        `Cutoff: ${formatHistoryLogDate(current.historyClearedAt)}.`
                )
                return
            }

            this.logger.debug(
                `Pulled ${list.length} history message(s) for session ${groupId}. ` +
                    `Cutoff: ${formatHistoryLogDate(current.historyClearedAt)}.`
            )

            this._messages[groupId] = mergeMessages(
                this._messages[groupId] ?? [],
                list,
                cfg.maxMessages ?? 40
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
        const unlock = await this._lockByGroupId(
            `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        )

        try {
            const groupId = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
            const guildConfig = session.isDirect
                ? this._config.privateConfigs[session.userId]
                : this._config.configs[session.guildId]
            const globalConfig = session.isDirect
                ? this._config.globalPrivateConfig
                : this._config.globalGroupConfig
            const maxMessageSize =
                Object.assign({}, this._config, globalConfig, guildConfig)
                    .maxMessages ?? 40
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

    private async _flushCooldownTrigger(groupId: string) {
        const unlock = await this._lockByGroupId(groupId)

        let pending: PendingCooldownTrigger | undefined
        try {
            pending = this._pendingCooldownTriggers[groupId]
            if (!pending) {
                delete this._cooldownTriggerTimers[groupId]
                return
            }

            const lock = this._getGroupLocks(groupId)
            if (lock.mute > Date.now()) {
                const delay = Math.max(lock.mute - Date.now(), 0)
                this._cooldownTriggerTimers[groupId] = setTimeout(
                    () => {
                        this._flushCooldownTrigger(groupId).catch((err) => {
                            this.logger.error(err)
                        })
                    },
                    Math.min(delay, MAX_TIMEOUT_MS)
                )
                return
            }

            delete this._pendingCooldownTriggers[groupId]
            delete this._cooldownTriggerTimers[groupId]
        } finally {
            unlock()
        }

        if (!pending) {
            return
        }

        await this.pullHistory(pending.session, pending.message)
        await this.triggerCollect(
            pending.session,
            pending.triggerReason,
            pending.message
        )
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
        statusMessageUserId: null,
        recordLoaded: clearedAt != null
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
