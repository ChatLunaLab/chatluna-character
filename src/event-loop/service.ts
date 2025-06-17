import { Context, Disposable, Service } from 'koishi'
import { DayEvent } from './type'
import { EventLoopAgent } from './generate-agent'
import { EventDelta, EventLoopUpdateAgent } from './update-agent'
import { EventDescriptionAgent } from './event-description-agent'
import { PresetTemplate } from '../types'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { ObjectLock } from 'koishi-plugin-chatluna/utils/lock'
import { Config } from '..'
export class EventLoopService extends Service {
    private _currentEvent: Record<string, DayEvent | undefined> = {}
    private _updateIntervalDisposable: Disposable | undefined = undefined
    private _dailyRefreshIntervalDisposable: Disposable | undefined = undefined
    private _eventCache: Record<string, DayEvent[]> = {}
    private _descriptionCache: Record<string, string> = {}
    private _activePresets: Set<string> = new Set()
    private _locks: Record<string, ObjectLock> = {}

    constructor(
        public readonly ctx: Context,
        readonly config: Config
    ) {
        super(ctx, 'chatluna_character_event_loop', true)

        // 初始化数据库表
        ctx.database.extend(
            'chatluna_character_event_loop',
            {
                id: 'unsigned',
                presetKey: 'string',
                eventId: 'string',
                timeStart: 'string',
                timeEnd: 'string',
                date: 'timestamp',
                refreshInterval: 'integer',
                event: 'string',
                eventDescription: 'text',
                status: 'string',
                createdAt: 'timestamp',
                updatedAt: 'timestamp'
            },
            {
                primary: 'id',
                autoInc: true
            }
        )

        // 初始化事件描述数据库表
        ctx.database.extend(
            'chatluna_character_event_descriptions',
            {
                id: 'unsigned',
                presetKey: 'string',
                eventId: 'string',
                description: 'text',
                createdAt: 'timestamp',
                updatedAt: 'timestamp'
            },
            {
                primary: 'id',
                autoInc: true
            }
        )

        // 启动事件循环
        this.startEventLoop()

        // 启动每日刷新循环
        this.startDailyRefresh()
    }

    /**
     * 激活预设的事件循环
     * @param presetKey 预设关键字
     */
    async activatePreset(presetKey: string): Promise<void> {
        // 检查预设是否存在
        const preset =
            await this.ctx.chatluna_character_preset.getPreset(presetKey)
        if (!preset) {
            throw new Error(`Preset not found: ${presetKey}`)
        }

        // 如果已经激活，则跳过
        if (this._activePresets.has(presetKey)) {
            return
        }

        // 添加到激活预设集合
        this._activePresets.add(presetKey)

        // 生成初始事件
        await this.generateEvents(presetKey, preset)

        // 触发预设激活事件
        this.ctx.emit(
            'chatluna_character_event_loop/preset-activated',
            presetKey
        )
    }

    /**
     * 停用预设的事件循环
     * @param presetKey 预设关键字
     */
    async deactivatePreset(presetKey: string): Promise<void> {
        // 如果未激活，则跳过
        if (!this._activePresets.has(presetKey)) {
            return
        }

        // 从激活预设集合中移除
        this._activePresets.delete(presetKey)

        // 清空相关事件
        await this.ctx.database.remove('chatluna_character_event_loop', {
            presetKey
        })

        // 清空相关事件描述
        await this.ctx.database.remove(
            'chatluna_character_event_descriptions',
            {
                presetKey
            }
        )

        // 清空缓存
        delete this._eventCache[presetKey]
        delete this._currentEvent[presetKey]

        // 触发预设停用事件
        this.ctx.emit(
            'chatluna_character_event_loop/preset-deactivated',
            presetKey
        )
    }

    /**
     * 获取所有激活的预设
     */
    getActivePresets(): string[] {
        return [...this._activePresets]
    }

    /**
     * 检查预设是否已激活
     * @param presetKey 预设关键字
     */
    isPresetActive(presetKey: string): boolean {
        return this._activePresets.has(presetKey)
    }

    private _getLock(presetKey: string) {
        const lock = this._locks[presetKey] ?? new ObjectLock()
        this._locks[presetKey] = lock
        return lock
    }

    /**
     * 启动事件循环
     */
    private startEventLoop() {
        // 每5分钟更新一次事件
        this._updateIntervalDisposable = this.ctx.setInterval(
            async () => {
                try {
                    await this.updateCurrentEvent()
                } catch (e) {
                    this.ctx.logger('chatluna_character_event_loop').error(e)
                }
            },
            5 * 60 * 1000
        )
    }

    /**
     * 启动每日刷新循环
     */
    private startDailyRefresh() {
        // 计算到下一个0:00的时间
        const now = new Date()
        const tomorrow = new Date(now)
        tomorrow.setDate(tomorrow.getDate() + 1)
        tomorrow.setHours(0, 0, 0, 0)

        const timeToMidnight = tomorrow.getTime() - now.getTime()

        // 设置一次性定时器，在明天0:00执行第一次刷新
        this.ctx.setTimeout(async () => {
            try {
                // 执行每日刷新
                await this.performDailyRefresh()

                // 重新设置定时器
                this.startDailyRefresh()
            } catch (e) {
                this.ctx.logger('chatluna_character_event_loop').error(e)
            }
        }, timeToMidnight)
    }

    /**
     * 执行每日刷新
     */
    private async performDailyRefresh(): Promise<void> {
        // 只更新激活的预设
        for (const presetKey of this._activePresets) {
            try {
                // 获取当前预设的所有事件
                const currentEvents = await this.getEvents(presetKey)

                // 清空该预设的所有事件
                await this.ctx.database.remove(
                    'chatluna_character_event_loop',
                    {
                        presetKey
                    }
                )

                // 清空该预设的所有事件描述
                await this.ctx.database.remove(
                    'chatluna_character_event_descriptions',
                    {
                        presetKey
                    }
                )

                // 清除缓存
                delete this._eventCache[presetKey]

                // 获取预设模板
                const preset =
                    await this.ctx.chatluna_character_preset.getPreset(
                        presetKey
                    )
                if (!preset) {
                    continue
                }

                // 生成新的事件
                const newEvents = await this.generateEvents(presetKey, preset)

                // 触发每日刷新事件
                this.ctx.emit(
                    'chatluna_character_event_loop/daily-refresh',
                    presetKey,
                    currentEvents,
                    newEvents
                )
            } catch (e) {
                this.ctx.logger('chatluna_character_event_loop').error(e)
            }
        }
    }

    /**
     * 停止事件循环
     */
    public stopEventLoop() {
        this._updateIntervalDisposable?.()
        this._dailyRefreshIntervalDisposable?.()
    }

    /**
     * 为预设生成事件
     * @param presetKey 预设关键词
     * @param characterPrompt 角色提示模板
     */
    async generateEvents(
        presetKey: string,
        characterPrompt: PresetTemplate
    ): Promise<DayEvent[]> {
        const lock = this._getLock(presetKey)
        const unlock = await lock.lock()
        try {
            // 检查是否已有事件
            const existingEvents = await this.getEvents(presetKey)
            if (existingEvents && existingEvents.length > 0) {
                // 更新现有事件的状态
                const now = new Date()
                const updatedEvents = []

                for (const event of existingEvents) {
                    let status: 'todo' | 'doing' | 'done' = 'todo'

                    if (event.timeStart <= now && now <= event.timeEnd) {
                        status = 'doing'
                    } else if (event.timeEnd < now) {
                        status = 'done'
                    } else {
                        status = 'todo'
                    }

                    // 查找事件ID
                    const eventRecords = await this.ctx.database.get(
                        'chatluna_character_event_loop',
                        {
                            presetKey,
                            event: event.event
                        }
                    )

                    if (eventRecords && eventRecords.length > 0) {
                        const eventId = eventRecords[0].eventId

                        // 更新状态
                        await this.ctx.database.set(
                            'chatluna_character_event_loop',
                            {
                                presetKey,
                                eventId
                            },
                            {
                                status,
                                updatedAt: now
                            }
                        )

                        if (status === 'doing') {
                            this._currentEvent[presetKey] = event
                            this.ctx.emit(
                                'chatluna_character_event_loop/current-event-updated',
                                presetKey,
                                event
                            )
                        }
                    }

                    updatedEvents.push({
                        ...event,
                        status
                    })
                }

                // 清除缓存，下次获取时会重新加载
                delete this._eventCache[presetKey]

                this.ctx.emit(
                    'chatluna_character_event_loop/after-update',
                    presetKey,
                    existingEvents
                )

                return existingEvents
            }

            // 创建事件生成代理
            const agent = new EventLoopAgent({
                executeModel: await this.ctx.chatluna.createChatModel(
                    ...parseRawModelName(this.config.model || 'gpt-3.5-turbo')
                ),
                characterPrompt
            })

            // 执行代理生成事件
            let result
            for await (const action of agent.stream({})) {
                if (action.type === 'finish') {
                    result = action.action
                    break
                }
            }

            if (!result || !result.value) {
                throw new Error('Failed to generate events')
            }

            // 解析生成的事件
            const eventsJson = result.value
            if (!Array.isArray(eventsJson)) {
                throw new Error('Invalid events format')
            }

            // 转换为DayEvent对象并保存
            const now = new Date()
            const events: DayEvent[] = []

            for (let i = 0; i < eventsJson.length; i++) {
                const eventData = eventsJson[i]
                const eventId = `event-${i + 1}`

                // 解析时间
                const [startHour, startMinute] = eventData.timeStart
                    .split(':')
                    .map(Number)
                const [endHour, endMinute] = eventData.timeEnd
                    .split(':')
                    .map(Number)

                const timeStart = new Date(now)
                timeStart.setHours(startHour, startMinute, 0, 0)

                const timeEnd = new Date(now)
                timeEnd.setHours(endHour, endMinute, 0, 0)

                // 设置事件状态
                let eventStatus: 'todo' | 'doing' | 'done' = 'todo'

                if (timeStart <= now && now <= timeEnd) {
                    eventStatus = 'doing'
                } else if (timeEnd < now) {
                    eventStatus = 'done'
                } else {
                    eventStatus = 'todo'
                }

                // 创建事件对象
                const event: DayEvent = {
                    timeStart,
                    timeEnd,
                    date: new Date(now),
                    refreshInterval: 24 * 60 * 60 * 1000, // 默认1天刷新一次
                    event: eventData.event,
                    eventDescription:
                        eventData.eventDescription || eventData.event
                }

                events.push(event)

                // 保存到数据库
                await this.ctx.database.create(
                    'chatluna_character_event_loop',
                    {
                        presetKey,
                        eventId,
                        timeStart: eventData.timeStart,
                        timeEnd: eventData.timeEnd,
                        date: now,
                        refreshInterval: 24 * 60 * 60 * 1000,
                        event: eventData.event,
                        eventDescription:
                            eventData.eventDescription || eventData.event,
                        status: eventStatus,
                        createdAt: now,
                        updatedAt: now
                    }
                )

                if (eventStatus === 'doing') {
                    // 设置当前事件
                    this._currentEvent[presetKey] = event

                    // 触发当前事件
                    this.ctx.emit(
                        'chatluna_character_event_loop/current-event-updated',
                        presetKey,
                        event
                    )
                }
            }

            // 更新缓存
            this._eventCache[presetKey] = events

            // 触发事件创建事件
            this.ctx.emit(
                'chatluna_character_event_loop/created',
                presetKey,
                events
            )

            this.ctx.emit(
                'chatluna_character_event_loop/after-update',
                presetKey,
                events
            )

            return events
        } finally {
            unlock()
        }
    }

    /**
     * 更新预设事件
     * @param presetKey 预设关键词
     * @param characterPrompt 角色提示模板
     */
    async updateEvents(
        presetKey?: string,
        characterPrompt?: PresetTemplate
    ): Promise<void> {
        if (!presetKey || !characterPrompt) {
            // 如果没有指定预设，则更新所有激活的预设
            for (const key of this._activePresets) {
                // 获取该预设的角色提示模板
                const preset =
                    await this.ctx.chatluna_character_preset.getPreset(key)
                if (preset) {
                    await this._updatePresetEvents(key, preset)
                }
            }
        } else {
            // 更新指定预设的事件
            await this._updatePresetEvents(presetKey, characterPrompt)
        }
    }

    /**
     * 更新特定预设的事件
     * @param presetKey 预设关键词
     * @param characterPrompt 角色提示模板
     */
    private async _updatePresetEvents(
        presetKey: string,
        characterPrompt: PresetTemplate
    ): Promise<void> {
        const lock = this._getLock(presetKey)
        const unlock = await lock.lock()
        try {
            // 获取预设现有事件
            const events = await this.getEvents(presetKey)
            if (!events || events.length === 0) {
                // 如果没有事件，则生成新事件
                await this.generateEvents(presetKey, characterPrompt)
                return
            }

            // 准备事件数据
            const eventsJson = events.map((event, index) => ({
                id: `event-${index + 1}`,
                timeStart: this._formatTime(event.timeStart),
                timeEnd: this._formatTime(event.timeEnd),
                event: event.event,
                eventDescription: event.eventDescription,
                status: 'todo' // 默认状态
            }))

            // 触发更新前事件
            this.ctx.emit(
                'chatluna_character_event_loop/before-update',
                presetKey,
                events
            )

            // 创建事件更新代理
            const agent = new EventLoopUpdateAgent({
                executeModel: await this.ctx.chatluna.createChatModel(
                    ...parseRawModelName(
                        this.ctx.config.model || 'gpt-3.5-turbo'
                    )
                ),
                characterPrompt,
                events: JSON.stringify(eventsJson)
            })

            // 执行代理更新事件
            let result
            for await (const action of agent.stream({})) {
                if (action.type === 'finish') {
                    result = action.action
                    break
                }
            }

            if (!result || !result.value) {
                throw new Error('Failed to update events')
            }

            // 解析更新的事件
            const deltaJson = result.value
            if (!Array.isArray(deltaJson)) {
                throw new Error('Invalid event delta format')
            }

            // 应用更新
            const now = new Date()
            const deltas = deltaJson as EventDelta[]

            for (const delta of deltas) {
                const eventId = delta.id

                if (delta.changeType === 'delete') {
                    // 删除事件
                    await this.ctx.database.remove(
                        'chatluna_character_event_loop',
                        {
                            presetKey,
                            eventId
                        }
                    )
                    continue
                }

                if (delta.changeType === 'add') {
                    // 添加新事件
                    if (!delta.timeStart || !delta.timeEnd || !delta.event) {
                        continue // 跳过无效事件
                    }

                    // 解析时间
                    const [startHour, startMinute] = delta.timeStart
                        .split(':')
                        .map(Number)
                    const [endHour, endMinute] = delta.timeEnd
                        .split(':')
                        .map(Number)

                    const timeStart = new Date(now)
                    timeStart.setHours(startHour, startMinute, 0, 0)

                    const timeEnd = new Date(now)
                    timeEnd.setHours(endHour, endMinute, 0, 0)

                    // 创建事件
                    await this.ctx.database.create(
                        'chatluna_character_event_loop',
                        {
                            presetKey,
                            eventId,
                            timeStart: delta.timeStart,
                            timeEnd: delta.timeEnd,
                            date: now,
                            refreshInterval: 24 * 60 * 60 * 1000,
                            event: delta.event,
                            eventDescription:
                                delta.eventDescription || delta.event || '',
                            status: delta.status || 'todo',
                            createdAt: now,
                            updatedAt: now
                        }
                    )
                } else if (delta.changeType === 'update') {
                    // 更新现有事件
                    const updateData: Partial<CharacterEventLoop> = {
                        updatedAt: now
                    }

                    if (delta.timeStart) updateData.timeStart = delta.timeStart
                    if (delta.timeEnd) updateData.timeEnd = delta.timeEnd
                    if (delta.event) updateData.event = delta.event
                    if (delta.eventDescription)
                        updateData.eventDescription = delta.eventDescription
                    if (delta.status) updateData.status = delta.status

                    await this.ctx.database.set(
                        'chatluna_character_event_loop',
                        {
                            presetKey,
                            eventId
                        },
                        updateData
                    )
                }
            }

            // 清除缓存，强制下次重新加载
            delete this._eventCache[presetKey]

            // 获取更新后的事件
            const updatedEvents = await this.getEvents(presetKey, true)

            // 触发更新后事件
            this.ctx.emit(
                'chatluna_character_event_loop/after-update',
                presetKey,
                updatedEvents
            )

            // 更新当前事件
            await this._updateCurrentEvent(presetKey)
        } finally {
            unlock()
        }
    }

    /**
     * 获取预设的所有事件
     * @param presetKey 预设关键词
     * @param forceRefresh 是否强制刷新缓存
     */
    async getEvents(
        presetKey: string,
        forceRefresh: boolean = false
    ): Promise<DayEvent[]> {
        const lock = this._getLock(presetKey)
        const unlock = await lock.lock()
        try {
            // 检查缓存
            if (!forceRefresh && this._eventCache[presetKey]) {
                return this._eventCache[presetKey]
            }

            // 从数据库获取
            const eventRecords = await this.ctx.database.get(
                'chatluna_character_event_loop',
                { presetKey }
            )

            if (!eventRecords || eventRecords.length === 0) {
                return []
            }

            // 检查事件是否为当天的事件
            const todayDate = new Date()
            todayDate.setHours(0, 0, 0, 0)

            const firstEventDate = new Date(eventRecords[0].date)
            firstEventDate.setHours(0, 0, 0, 0)

            // 如果不是当天的事件，清空所有事件并返回空数组
            if (todayDate.getTime() !== firstEventDate.getTime()) {
                // 清空该预设的所有事件
                await this.ctx.database.remove(
                    'chatluna_character_event_loop',
                    {
                        presetKey
                    }
                )

                // 清空该预设的所有事件描述
                await this.ctx.database.remove(
                    'chatluna_character_event_descriptions',
                    {
                        presetKey
                    }
                )

                // 清除缓存
                delete this._eventCache[presetKey]

                // 如果预设仍然激活，需要重新生成事件
                if (this._activePresets.has(presetKey)) {
                    const preset =
                        await this.ctx.chatluna_character_preset.getPreset(
                            presetKey
                        )
                    if (preset) {
                        return await this.generateEvents(presetKey, preset)
                    }
                }

                return []
            }

            // 转换为DayEvent对象
            const events: DayEvent[] = eventRecords.map((record) => {
                // 解析时间
                const [startHour, startMinute] = record.timeStart
                    .split(':')
                    .map(Number)
                const [endHour, endMinute] = record.timeEnd
                    .split(':')
                    .map(Number)

                const timeStart = new Date(record.date)
                timeStart.setHours(startHour, startMinute, 0, 0)

                const timeEnd = new Date(record.date)
                timeEnd.setHours(endHour, endMinute, 0, 0)

                return {
                    timeStart,
                    timeEnd,
                    date: new Date(record.date),
                    refreshInterval: record.refreshInterval,
                    event: record.event,
                    eventDescription: record.eventDescription
                }
            })

            // 按开始时间排序
            events.sort((a, b) => a.timeStart.getTime() - b.timeStart.getTime())

            // 更新缓存
            this._eventCache[presetKey] = events

            return events
        } finally {
            unlock()
        }
    }

    async getRecentEvents(
        presetKey: string,
        upperLimit: number = 3,
        lowerLimit: number = 1
    ): Promise<DayEvent[]> {
        const lock = this._getLock(presetKey)
        const unlock = await lock.lock()
        try {
            const events = await this.getEvents(presetKey)
            if (!events || events.length === 0) {
                return []
            }

            // 获取当前事件，然后取上限和下限之间的事件
            const currentEvent = await this.getCurrentEvent(presetKey)

            if (!currentEvent) {
                return []
            }

            const currentEventIndex = events.findIndex(
                (e) => e.timeStart === currentEvent.timeStart
            )

            const now = new Date()

            const recentEvents = events.slice(
                currentEventIndex - upperLimit,
                currentEventIndex + lowerLimit
            )

            return recentEvents.map((e) => ({
                ...e,
                status:
                    e.timeStart <= now && now <= e.timeEnd
                        ? 'doing'
                        : e.timeStart > now
                          ? 'todo'
                          : 'done'
            }))
        } finally {
            unlock()
        }
    }

    /**
     * 获取预设当前事件
     * @param presetKey 预设关键词
     */
    async getCurrentEvent(presetKey: string): Promise<DayEvent | undefined> {
        const lock = this._getLock(presetKey)
        const unlock = await lock.lock()
        try {
            // 检查是否已激活
            if (!this._activePresets.has(presetKey)) {
                return undefined
            }

            const events = await this.getEvents(presetKey)
            if (!events || events.length === 0) {
                return undefined
            }

            const now = new Date()

            // 查找当前时间段的事件
            for (const event of events) {
                if (event.timeStart <= now && now <= event.timeEnd) {
                    return event
                }
            }

            // 如果没有找到当前事件，返回最近的未来事件
            const futureEvents = events.filter((e) => e.timeStart > now)
            if (futureEvents.length > 0) {
                return futureEvents[0]
            }

            // 如果没有未来事件，返回最后一个事件
            return events[events.length - 1]
        } finally {
            unlock()
        }
    }

    /**
     * 更新当前事件并生成描述
     */
    async updateCurrentEvent(): Promise<void> {
        // 只处理激活的预设
        for (const presetKey of this._activePresets) {
            try {
                // 获取当前事件
                const currentEvent = await this.getCurrentEvent(presetKey)
                if (!currentEvent) {
                    continue
                }

                // 查找这个事件的ID
                const eventRecords = await this.ctx.database.get(
                    'chatluna_character_event_loop',
                    {
                        presetKey,
                        event: currentEvent.event
                    }
                )

                if (!eventRecords || eventRecords.length === 0) {
                    continue
                }

                const eventRecord = eventRecords[0]
                const eventId = eventRecord.eventId

                // 检查上次更新时间，避免频繁更新同一事件
                const now = new Date()
                const lastUpdate = eventRecord.updatedAt
                const timeDiff = now.getTime() - lastUpdate.getTime()

                // 如果距离上次更新不到5分钟，则跳过
                // 除非是新的事件状态（例如从todo变为doing）
                if (
                    timeDiff < 5 * 60 * 1000 &&
                    eventRecord.status === 'doing'
                ) {
                    continue
                }

                // 更新事件状态为"正在进行"
                await this.ctx.database.set(
                    'chatluna_character_event_loop',
                    {
                        presetKey,
                        eventId
                    },
                    {
                        status: 'doing',
                        updatedAt: now
                    }
                )

                // 获取角色提示模板
                const preset =
                    await this.ctx.chatluna_character_preset.getPreset(
                        presetKey
                    )
                if (!preset) {
                    continue
                }

                // 生成事件详细描述
                const description = await this.generateEventDescription(
                    presetKey,
                    currentEvent,
                    preset
                )

                // 触发当前事件更新事件
                this.ctx.emit(
                    'chatluna_character_event_loop/current-event-updated',
                    presetKey,
                    currentEvent,
                    description
                )
            } catch (e) {
                this.ctx.logger('chatluna_character_event_loop').error(e)
            }
        }
    }

    /**
     * 更新预设当前事件
     * @param presetKey 预设关键词
     */
    private async _updateCurrentEvent(presetKey: string): Promise<void> {
        // 检查是否已激活
        if (!this._activePresets.has(presetKey)) {
            return
        }

        const currentEvent = await this.getCurrentEvent(presetKey)
        if (currentEvent) {
            this._currentEvent[presetKey] = currentEvent

            // 触发当前事件更新事件
            this.ctx.emit(
                'chatluna_character_event_loop/current-event-updated',
                presetKey,
                currentEvent
            )
        }
    }

    /**
     * 为当前事件生成详细描述
     * @param presetKey 预设关键词
     * @param event 当前事件
     * @param characterPrompt 角色提示模板
     */
    async generateEventDescription(
        presetKey: string,
        event: DayEvent,
        characterPrompt: PresetTemplate
    ): Promise<string> {
        // 查找事件ID
        const eventRecords = await this.ctx.database.get(
            'chatluna_character_event_loop',
            {
                presetKey,
                event: event.event
            }
        )

        if (!eventRecords || eventRecords.length === 0) {
            return ''
        }

        const eventId = eventRecords[0].eventId

        // 获取角色描述
        const characterDescription = await characterPrompt.system.format({})

        // 创建事件描述生成代理
        const agent = new EventDescriptionAgent({
            executeModel: await this.ctx.chatluna.createChatModel(
                ...parseRawModelName(this.ctx.config.model || 'gpt-3.5-turbo')
            ),
            characterPrompt: characterDescription
        })

        // 执行代理生成描述
        let description = ''
        const now = new Date()

        try {
            const result = await agent.execute({
                event,
                currentTime: now,
                characterPrompt: characterDescription
            })

            description = result.description
        } catch (e) {
            this.ctx.logger('chatluna_character_event_loop').error(e)
            description = `${event.eventDescription} (在 ${this._formatTime(now)})`
        }

        // 保存描述到数据库
        const existingDescription = await this.ctx.database.get(
            'chatluna_character_event_descriptions',
            {
                presetKey,
                eventId
            }
        )

        if (existingDescription && existingDescription.length > 0) {
            // 更新现有描述
            await this.ctx.database.set(
                'chatluna_character_event_descriptions',
                {
                    presetKey,
                    eventId
                },
                {
                    description,
                    updatedAt: now
                }
            )
        } else {
            // 创建新描述
            await this.ctx.database.create(
                'chatluna_character_event_descriptions',
                {
                    presetKey,
                    eventId,
                    description,
                    createdAt: now,
                    updatedAt: now
                }
            )
        }

        // 更新缓存
        this._descriptionCache[`${presetKey}:${eventId}`] = description

        // 触发描述更新事件
        this.ctx.emit(
            'chatluna_character_event_loop/description-updated',
            presetKey,
            eventId,
            description
        )

        return description
    }

    /**
     * 获取事件描述
     * @param presetKey 预设关键词
     * @param eventId 事件ID
     */
    async getEventDescription(
        presetKey: string,
        eventId: string
    ): Promise<string | null> {
        // 先从缓存中查找
        const cacheKey = `${presetKey}:${eventId}`
        if (this._descriptionCache[cacheKey]) {
            return this._descriptionCache[cacheKey]
        }

        // 从数据库中查找
        const descriptions = await this.ctx.database.get(
            'chatluna_character_event_descriptions',
            {
                presetKey,
                eventId
            }
        )

        if (!descriptions || descriptions.length === 0) {
            return null
        }

        // 更新缓存
        const description = descriptions[0].description
        this._descriptionCache[cacheKey] = description

        return description
    }

    /**
     * 获取当前事件描述
     * @param presetKey 预设关键词
     */
    async getCurrentEventDescription(
        presetKey: string
    ): Promise<string | null> {
        // 检查是否已激活
        if (!this._activePresets.has(presetKey)) {
            return null
        }

        const currentEvent = await this.getCurrentEvent(presetKey)
        if (!currentEvent) {
            return null
        }

        // 查找事件ID
        const eventRecords = await this.ctx.database.get(
            'chatluna_character_event_loop',
            {
                presetKey,
                event: currentEvent.event
            }
        )

        if (!eventRecords || eventRecords.length === 0) {
            return null
        }

        const eventId = eventRecords[0].eventId
        return await this.getEventDescription(presetKey, eventId)
    }

    /**
     * 格式化时间为HH:MM格式
     * @param date 日期对象
     */
    private _formatTime(date: Date): string {
        const hours = date.getHours().toString().padStart(2, '0')
        const minutes = date.getMinutes().toString().padStart(2, '0')
        return `${hours}:${minutes}`
    }

    /**
     * 自定义预设事件
     * @param presetKey 预设关键词
     * @param eventId 事件ID
     * @param updates 更新内容
     */
    async customizeEvent(
        presetKey: string,
        eventId: string,
        updates: Partial<{
            timeStart: string
            timeEnd: string
            event: string
            eventDescription: string
            status: 'done' | 'doing' | 'todo'
        }>
    ): Promise<void> {
        const lock = this._getLock(presetKey)
        const unlock = await lock.lock()
        try {
            // 检查是否已激活
            if (!this._activePresets.has(presetKey)) {
                throw new Error(`Preset is not active: ${presetKey}`)
            }

            // 更新数据库
            await this.ctx.database.set(
                'chatluna_character_event_loop',
                {
                    presetKey,
                    eventId
                },
                {
                    ...updates,
                    updatedAt: new Date()
                }
            )

            // 清除缓存
            delete this._eventCache[presetKey]

            // 如果事件内容发生了变化，可能需要重新生成描述
            if (updates.event || updates.eventDescription) {
                delete this._descriptionCache[`${presetKey}:${eventId}`]

                // 删除旧的描述记录
                await this.ctx.database.remove(
                    'chatluna_character_event_descriptions',
                    {
                        presetKey,
                        eventId
                    }
                )
            }

            // 触发事件自定义事件
            this.ctx.emit(
                'chatluna_character_event_loop/event-customized',
                presetKey,
                eventId,
                updates
            )

            // 更新当前事件
            await this.updateCurrentEvent()
        } finally {
            unlock()
        }
    }

    /**
     * 删除预设事件
     * @param presetKey 预设关键词
     * @param eventId 事件ID
     */
    async deleteEvent(presetKey: string, eventId: string): Promise<void> {
        const lock = this._getLock(presetKey)
        const unlock = await lock.lock()
        try {
            // 检查是否已激活
            if (!this._activePresets.has(presetKey)) {
                throw new Error(`Preset is not active: ${presetKey}`)
            }

            // 从数据库删除事件
            await this.ctx.database.remove('chatluna_character_event_loop', {
                presetKey,
                eventId
            })

            // 从数据库删除描述
            await this.ctx.database.remove(
                'chatluna_character_event_descriptions',
                {
                    presetKey,
                    eventId
                }
            )

            // 清除缓存
            delete this._eventCache[presetKey]
            delete this._descriptionCache[`${presetKey}:${eventId}`]

            // 触发事件删除事件
            this.ctx.emit(
                'chatluna_character_event_loop/event-deleted',
                presetKey,
                eventId
            )

            // 更新当前事件
            await this.updateCurrentEvent()
        } finally {
            unlock()
        }
    }

    /**
     * 添加预设事件
     * @param presetKey 预设关键词
     * @param event 事件内容
     */
    async addEvent(
        presetKey: string,
        event: {
            timeStart: string
            timeEnd: string
            event: string
            eventDescription?: string
            status?: 'done' | 'doing' | 'todo'
        }
    ): Promise<string> {
        const lock = this._getLock(presetKey)
        const unlock = await lock.lock()
        try {
            // 检查是否已激活
            if (!this._activePresets.has(presetKey)) {
                throw new Error(`Preset is not active: ${presetKey}`)
            }

            const now = new Date()

            // 生成事件ID
            const events = await this.ctx.database.get(
                'chatluna_character_event_loop',
                { presetKey }
            )
            const eventId = `event-${events.length + 1}`

            // 创建事件
            await this.ctx.database.create('chatluna_character_event_loop', {
                presetKey,
                eventId,
                timeStart: event.timeStart,
                timeEnd: event.timeEnd,
                date: now,
                refreshInterval: 24 * 60 * 60 * 1000,
                event: event.event,
                eventDescription: event.eventDescription || event.event,
                status: event.status || 'todo',
                createdAt: now,
                updatedAt: now
            })

            // 清除缓存
            delete this._eventCache[presetKey]

            // 触发事件添加事件
            this.ctx.emit(
                'chatluna_character_event_loop/event-added',
                presetKey,
                eventId,
                event
            )

            // 更新当前事件
            await this.updateCurrentEvent()

            return eventId
        } finally {
            unlock()
        }
    }

    // 注入依赖
    static inject = ['database', 'chatluna', 'chatluna_character_preset']
}

// 定义数据库表结构
declare module 'koishi' {
    interface Tables {
        chatluna_character_event_loop: CharacterEventLoop
        chatluna_character_event_descriptions: CharacterEventDescription
    }

    interface Context {
        chatluna_character_event_loop: EventLoopService
    }

    // 定义事件
    interface Events {
        'chatluna_character_event_loop/created': (
            presetKey: string,
            events: DayEvent[]
        ) => void
        'chatluna_character_event_loop/before-update': (
            presetKey: string,
            events: DayEvent[]
        ) => void
        'chatluna_character_event_loop/after-update': (
            presetKey: string,
            events: DayEvent[]
        ) => void
        'chatluna_character_event_loop/current-event-updated': (
            presetKey: string,
            event: DayEvent,
            description?: string
        ) => void
        'chatluna_character_event_loop/event-customized': (
            presetKey: string,
            eventId: string,
            updates: Partial<{
                timeStart: string
                timeEnd: string
                event: string
                eventDescription: string
                status: 'done' | 'doing' | 'todo'
            }>
        ) => void
        'chatluna_character_event_loop/event-deleted': (
            presetKey: string,
            eventId: string
        ) => void
        'chatluna_character_event_loop/event-added': (
            presetKey: string,
            eventId: string,
            event: {
                timeStart: string
                timeEnd: string
                event: string
                eventDescription?: string
                status?: 'done' | 'doing' | 'todo'
            }
        ) => void
        'chatluna_character_event_loop/daily-refresh': (
            presetKey: string,
            oldEvents: DayEvent[],
            newEvents: DayEvent[]
        ) => void
        'chatluna_character_event_loop/description-updated': (
            presetKey: string,
            eventId: string,
            description: string
        ) => void
        'chatluna_character_event_loop/preset-activated': (
            presetKey: string
        ) => void
        'chatluna_character_event_loop/preset-deactivated': (
            presetKey: string
        ) => void
    }
}

// 定义事件描述数据库表
export interface CharacterEventDescription {
    id: number
    presetKey: string
    eventId: string
    description: string
    createdAt: Date
    updatedAt: Date
}

// 定义数据库表结构
export interface CharacterEventLoop {
    id: number
    presetKey: string
    eventId: string
    timeStart: string
    timeEnd: string
    date: Date
    refreshInterval: number
    event: string
    eventDescription: string
    status: 'done' | 'doing' | 'todo'
    createdAt: Date
    updatedAt: Date
}
