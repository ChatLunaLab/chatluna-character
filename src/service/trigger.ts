import { Bot, Context, Service, Session } from 'koishi'
import type { Config } from '../config'
import {
    GroupInfo,
    PendingNextReply,
    PendingWakeUpReply,
    WakeUpReplyRecord
} from '../types'
import {
    parseNextReplyReason,
    parseWakeUpTimeToTimestamp
} from '../utils/index'

export class TriggerStore extends Service {
    private _infos: Record<string, GroupInfo> = {}

    private _sessions: Record<string, Session> = {}

    constructor(
        public readonly ctx: Context,
        public _config: Config
    ) {
        super(ctx, 'chatluna_character_trigger')

        this.ctx.database.extend(
            'chathub_character_wake_up_reply',
            {
                id: 'unsigned',
                sessionKey: {
                    type: 'string',
                    length: 255
                },
                botId: {
                    type: 'string',
                    length: 255
                },
                channelId: {
                    type: 'string',
                    length: 255
                },
                guildId: {
                    type: 'string',
                    length: 255,
                    nullable: true
                },
                userId: {
                    type: 'string',
                    length: 255
                },
                rawTime: {
                    type: 'string',
                    length: 255
                },
                reason: 'text',
                naturalReason: 'text',
                triggerAtV2: 'timestamp',
                createdAtV2: 'timestamp',
                updatedAt: {
                    type: 'timestamp',
                    nullable: false,
                    initial: new Date()
                }
            },
            {
                autoInc: true,
                primary: 'id'
            }
        )

        ctx.on('ready', async () => {
            // await this.prepareDatabase()

            const rows = await this.ctx.database.get(
                'chathub_character_wake_up_reply',
                {}
            )

            for (const row of rows) {
                const info =
                    this._infos[row.sessionKey] ??
                    (() => {
                        const now = Date.now()
                        const isDirect = row.sessionKey.startsWith('private:')
                        const id = isDirect
                            ? row.sessionKey.slice('private:'.length)
                            : row.sessionKey.startsWith('group:')
                              ? row.sessionKey.slice('group:'.length)
                              : row.sessionKey
                        const guildConfig = isDirect
                            ? this._config.privateConfigs[id]
                            : this._config.configs[id]
                        const globalConfig = isDirect
                            ? this._config.globalPrivateConfig
                            : this._config.globalGroupConfig
                        return createDefaultGroupInfo(
                            Object.assign(
                                {},
                                this._config,
                                globalConfig,
                                guildConfig
                            ),
                            now
                        )
                    })()

                info.pendingWakeUpReplies = info.pendingWakeUpReplies ?? []
                info.pendingWakeUpReplies.push({
                    rawTime: row.rawTime,
                    reason: row.reason,
                    naturalReason: row.naturalReason,
                    triggerAt: row.triggerAtV2.getTime(),
                    createdAt: row.createdAtV2.getTime()
                })
                this._infos[row.sessionKey] = info

                const bot = ctx.bots[row.botId]
                if (!bot || this._sessions[row.sessionKey]) {
                    continue
                }

                this._sessions[row.sessionKey] = createStoredSession(bot, row)
            }
        })

        ctx.on('bot-status-updated', async (bot) => {
            const rows = await this.ctx.database.get(
                'chathub_character_wake_up_reply',
                {}
            )

            for (const row of rows) {
                if (row.botId !== bot.sid || this._sessions[row.sessionKey]) {
                    continue
                }

                this._sessions[row.sessionKey] = createStoredSession(bot, row)
            }
        })
    }

    get(key: string) {
        return this._infos[key]
    }

    set(key: string, info: GroupInfo) {
        this._infos[key] = info
    }

    async delete(key: string) {
        delete this._infos[key]
        delete this._sessions[key]
        await this.ctx.database.remove('chathub_character_wake_up_reply', {
            sessionKey: key
        })
    }

    keys() {
        return Object.keys(this._infos)
    }

    getLastSession(key: string) {
        return this._sessions[key]
    }

    setLastSession(session: Session) {
        const key = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        this._sessions[key] = session
    }

    registerNextReply(key: string, rawReason: string, config: Config) {
        const groups = parseNextReplyReason(rawReason)
        if (groups.length < 1) {
            return false
        }

        const now = Date.now()
        const info = this._infos[key] ?? createDefaultGroupInfo(config, now)
        const pending: PendingNextReply = {
            rawReason,
            groups,
            createdAt: now
        }

        info.pendingNextReplies = [pending]
        this._infos[key] = info
        return true
    }

    clearNextReplies(key: string) {
        const info = this._infos[key]
        if (!info) return

        info.pendingNextReplies = []
        this._infos[key] = info
    }

    async registerWakeUpReply(
        session: Session,
        rawTime: string,
        reason: string,
        config: Config
    ) {
        const triggerAt = parseWakeUpTimeToTimestamp(rawTime)
        if (triggerAt == null) {
            return false
        }

        const key = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        const now = Date.now()
        const info = this._infos[key] ?? createDefaultGroupInfo(config, now)
        const text = reason.trim()
        const configuredAt = new Date(now)
        const pad = (n: number) => String(n).padStart(2, '0')
        const configuredAtText =
            `${configuredAt.getFullYear()}/${pad(configuredAt.getMonth() + 1)}` +
            `/${pad(configuredAt.getDate())}-${pad(configuredAt.getHours())}` +
            `:${pad(configuredAt.getMinutes())}:${pad(configuredAt.getSeconds())}`
        const pending: PendingWakeUpReply = {
            rawTime,
            reason: text,
            naturalReason: text
                ? `You configured this wake-up at ${configuredAtText} to trigger at ${rawTime}, note: "${text}"`
                : `You configured this wake-up at ${configuredAtText} to trigger at ${rawTime}`,
            triggerAt,
            createdAt: now
        }

        info.pendingWakeUpReplies = info.pendingWakeUpReplies ?? []
        info.pendingWakeUpReplies.push(pending)
        this._infos[key] = info
        return true
    }

    async setWakeUpReplies(session: Session, list: PendingWakeUpReply[]) {
        const key = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
        const now = Date.now()
        const info =
            this._infos[key] ??
            (() => {
                const guildConfig = session.isDirect
                    ? this._config.privateConfigs[session.userId]
                    : this._config.configs[session.guildId]
                const globalConfig = session.isDirect
                    ? this._config.globalPrivateConfig
                    : this._config.globalGroupConfig
                return createDefaultGroupInfo(
                    Object.assign(
                        {},
                        this._config,
                        globalConfig,
                        guildConfig
                    ),
                    now
                )
            })()

        info.pendingWakeUpReplies = [...list]
        this._infos[key] = info

        await this.ctx.database.remove('chathub_character_wake_up_reply', {
            sessionKey: key
        })

        if (list.length < 1) {
            return
        }

        await Promise.all(
            list.map(async (item) => {
                await this.ctx.database.create(
                    'chathub_character_wake_up_reply',
                    {
                        sessionKey: key,
                        botId: session.bot.sid,
                        channelId: session.channelId ?? session.userId,
                        guildId: session.guildId,
                        userId: session.userId,
                        rawTime: item.rawTime,
                        reason: item.reason,
                        naturalReason: item.naturalReason,
                        triggerAtV2: new Date(item.triggerAt),
                        createdAtV2: new Date(item.createdAt),
                        updatedAt: new Date()
                    } satisfies WakeUpReplyRecord
                )
            })
        )
    }

    getWakeUpReplies(key: string) {
        return this._infos[key]?.pendingWakeUpReplies ?? []
    }
}

declare module 'koishi' {
    export interface Context {
        chatluna_character_trigger: TriggerStore
    }
}

function createStoredSession(bot: Bot, temp: WakeUpReplyRecord) {
    const isDirect = temp.sessionKey.startsWith('private:')
    const channelId = temp.channelId ?? temp.userId

    return bot.session({
        channel: {
            id: channelId,
            type: isDirect ? 1 : 0
        },
        guild: isDirect
            ? undefined
            : {
                  id: temp.guildId
              },
        message: {
            id: '0',
            content: ''
        },
        selfId: bot.selfId,
        timestamp: Date.now(),
        type: 'message',
        user: {
            id: temp.userId,
            name: temp.userId
        }
    }) as Session
}

export function createDefaultGroupInfo(config: Config, now: number): GroupInfo {
    return {
        messageCount: 0,
        messageTimestamps: [],
        messageTimestampsByUserId: {},
        lastActivityScore: 0,
        lastScoreUpdate: 0,
        lastResponseTime: 0,
        currentActivityThreshold: config.messageActivityScoreLowerLimit,
        lastUserMessageTime: now,
        passiveRetryCount: 0,
        currentIdleWaitSeconds: undefined,
        pendingNextReplies: [],
        pendingWakeUpReplies: []
    }
}
