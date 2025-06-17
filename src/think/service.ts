import { Context, Service } from 'koishi'
import { Think } from './type'
import { Config } from '..'
import { ThinkAgent } from './think-agent'
import { DayEvent } from '../event-loop/type'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { ObjectLock } from 'koishi-plugin-chatluna/utils/lock'

export class ThinkService extends Service {
    private globalThink: Record<string, Think> = {}
    private groupThink: Record<string, Record<string, Think>> = {}
    private privateThink: Record<string, Record<string, Think>> = {}
    private _locks: Record<string, ObjectLock> = {}

    constructor(
        public readonly ctx: Context,
        public config: Config
    ) {
        super(ctx, 'chatluna_character_think', true)

        // Listen to event loop updates
        ctx.on(
            'chatluna_character_event_loop/after-update',
            async (presetKey, events) => {
                await this.updateThink(presetKey, events)
            }
        )
    }

    private _getLock(key: string) {
        const lock = this._locks[key] ?? new ObjectLock()
        this._locks[key] = lock
        return lock
    }

    /**
     * Generate think content for a preset
     * @param presetKey Preset key
     * @param type Think type (global, group, private)
     * @param id Group or private ID (required for non-global types)
     */
    async generateThink(
        presetKey: string,
        type: 'global' | 'group' | 'private' = 'global',
        id?: string
    ): Promise<Think> {
        const lockKey = type === 'global' ? presetKey : `${presetKey}:${id}`
        const lock = this._getLock(lockKey)
        const unlock = await lock.lock()
        try {
            // Get preset from the preset service
            const preset =
                await this.ctx.chatluna_character_preset.getPreset(presetKey)

            if (!preset) {
                throw new Error(`Preset not found: ${presetKey}`)
            }

            // Get current event
            const currentEvents =
                await this.ctx.chatluna_character_event_loop.getRecentEvents(
                    presetKey
                )

            if (!currentEvents) {
                throw new Error(`No current event for preset: ${presetKey}`)
            }

            // Get topics from the topic service
            const topics =
                await this.ctx.chatluna_character_topic.getRecentTopics(id)

            // Get previous think content
            let previousThink: Think | undefined

            if (type === 'global') {
                previousThink = this.globalThink[presetKey]
            } else if (type === 'group' && id) {
                previousThink = this.groupThink[presetKey]?.[id]
            } else if (type === 'private' && id) {
                previousThink = this.privateThink[presetKey]?.[id]
            }

            // Create agent based on think type
            const agent = new ThinkAgent({
                executeModel: await this.ctx.chatluna.createChatModel(
                    ...parseRawModelName(this.config.model || 'gpt-3.5-turbo')
                ),
                thinkType: type === 'global' ? 'global' : 'group'
            })

            // Current time and weekday
            const now = new Date()
            const weekdays = [
                'Sunday',
                'Monday',
                'Tuesday',
                'Wednesday',
                'Thursday',
                'Friday',
                'Saturday'
            ]
            const weekday = weekdays[now.getDay()]

            // Execute agent
            let result
            for await (const action of agent.stream({
                time: now.toLocaleString(),
                weekday,
                event: JSON.stringify(currentEvents),
                topics: topics.map((t) => t.content).join(', '),
                think: previousThink?.content || '',
                preset: preset.name,
                system: await preset.system.format({}),
                group: type === 'group' ? id : '',
                private_id: type === 'private' ? id : ''
            })) {
                if (action.type === 'finish') {
                    result = action.action
                    break
                }
            }

            if (!result || !result.output) {
                throw new Error('Failed to generate think content')
            }

            // Parse the output
            const output = result.output as string

            // Extract content between <output> and </output> tags
            const outputMatch = output.match(/<output>([\s\S]*?)<\/output>/i)
            const content = outputMatch ? outputMatch[1].trim() : output.trim()

            // Create think object
            const think: Think = {
                content,
                createdAt: now,
                updatedAt: now
            }

            // Save the think content
            this.saveThink(presetKey, type, id, think)

            this.ctx.logger.info(
                `Generated think for ${presetKey} ${type} ${id || 'global'} ${output}`
            )

            return think
        } finally {
            unlock()
        }
    }

    /**
     * Save think content to memory cache
     */
    private saveThink(
        presetKey: string,
        type: 'global' | 'group' | 'private',
        id?: string,
        think?: Think
    ): void {
        if (!think) return

        // Update cache
        if (type === 'global') {
            this.globalThink[presetKey] = think
        } else if (type === 'group' && id) {
            if (!this.groupThink[presetKey]) {
                this.groupThink[presetKey] = {}
            }
            this.groupThink[presetKey][id] = think
        } else if (type === 'private' && id) {
            if (!this.privateThink[presetKey]) {
                this.privateThink[presetKey] = {}
            }
            this.privateThink[presetKey][id] = think
        }

        // Emit think updated event
        this.ctx.emit(
            'chatluna_character_think/updated',
            presetKey,
            type,
            id,
            think
        )
    }

    /**
     * Update think content when events are updated
     */
    private async updateThink(
        presetKey: string,
        events: DayEvent[]
    ): Promise<void> {
        // Generate new global think
        await this.generateThink(presetKey, 'global')

        // Update group thinks
        for (const groupId in this.groupThink[presetKey] || {}) {
            await this.generateThink(presetKey, 'group', groupId)
        }

        // Update private thinks
        for (const privateId in this.privateThink[presetKey] || {}) {
            await this.generateThink(presetKey, 'private', privateId)
        }
    }

    /**
     * Get think content for a preset
     */
    async getThink(
        presetKey: string,
        type: 'global' | 'group' | 'private' = 'global',
        id?: string
    ): Promise<Think | null> {
        const lockKey = type === 'global' ? presetKey : `${presetKey}:${id}`
        const lock = this._getLock(lockKey)
        const unlock = await lock.lock()
        try {
            // Check caches
            if (type === 'global' && this.globalThink[presetKey]) {
                return this.globalThink[presetKey]
            } else if (
                type === 'group' &&
                id &&
                this.groupThink[presetKey]?.[id]
            ) {
                return this.groupThink[presetKey][id]
            } else if (
                type === 'private' &&
                id &&
                this.privateThink[presetKey]?.[id]
            ) {
                return this.privateThink[presetKey][id]
            }

            return null
        } finally {
            unlock()
        }
    }

    static inject = [
        'database',
        'chatluna',
        'chatluna_character_preset',
        'chatluna_character_event_loop',
        'chatluna_character_message',
        'chatluna_character_topic'
    ]
}

declare module 'koishi' {
    interface Context {
        chatluna_character_think: ThinkService
    }

    interface Events {
        'chatluna_character_think/updated': (
            presetKey: string,
            type: 'global' | 'group' | 'private',
            id?: string,
            think?: Think
        ) => void
    }
}
