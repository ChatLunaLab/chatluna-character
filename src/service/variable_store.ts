import { Context } from 'koishi'
import {
    CharacterVariableRecord,
    GroupTemp,
    Message,
    PendingWakeUpReply,
    WakeUpReplyRecord
} from '../types'

export class VariableStore {
    constructor(private ctx: Context) {
        this.ctx.database.extend(
            'chathub_character_variable',
            {
                sessionKey: {
                    type: 'string',
                    length: 255
                },
                status: {
                    type: 'text',
                    nullable: true
                },
                historyClearedAt: {
                    type: 'timestamp',
                    nullable: true
                },
                statusMessageId: {
                    type: 'string',
                    length: 255,
                    nullable: true
                },
                statusMessageTimestamp: {
                    type: 'integer',
                    nullable: true
                },
                statusMessageContent: {
                    type: 'text',
                    nullable: true
                },
                statusMessageUserId: {
                    type: 'string',
                    length: 255,
                    nullable: true
                },
                updatedAt: {
                    type: 'timestamp',
                    nullable: false,
                    initial: new Date()
                }
            },
            {
                autoInc: false,
                primary: 'sessionKey',
                unique: ['sessionKey']
            }
        )

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
                triggerAt: 'integer',
                createdAt: 'integer',
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
    }

    async read(sessionKey: string, temp: GroupTemp) {
        const row = (
            await this.ctx.database.get('chathub_character_variable', [sessionKey])
        )[0]

        temp.status = row?.status
        temp.historyClearedAt = row?.historyClearedAt
        temp.statusMessageId = row?.statusMessageId
        temp.statusMessageTimestamp = row?.statusMessageTimestamp
        temp.statusMessageContent = row?.statusMessageContent
        temp.statusMessageUserId = row?.statusMessageUserId
        temp.recordLoaded = true
    }

    async save(
        sessionKey: string,
        temp: GroupTemp,
        status?: string,
        msg?: Message
    ) {
        const s = status ?? null

        await this.ctx.database.upsert('chathub_character_variable', [
            {
                sessionKey,
                status: s,
                historyClearedAt: temp.historyClearedAt,
                statusMessageId: msg?.messageId,
                statusMessageTimestamp: msg?.timestamp,
                statusMessageContent: msg?.content,
                statusMessageUserId: msg?.id,
                updatedAt: new Date()
            } satisfies CharacterVariableRecord
        ])

        temp.status = s
        temp.statusMessageId = msg?.messageId
        temp.statusMessageTimestamp = msg?.timestamp
        temp.statusMessageContent = msg?.content
        temp.statusMessageUserId = msg?.id
    }

    async list(): Promise<CharacterVariableRecord[]> {
        return await this.ctx.database.get('chathub_character_variable', {})
    }

    async clear(sessionKey: string, at: Date) {
        await this.ctx.database.upsert('chathub_character_variable', [
            {
                sessionKey,
                status: null,
                historyClearedAt: at,
                statusMessageId: null,
                statusMessageTimestamp: null,
                statusMessageContent: null,
                statusMessageUserId: null,
                updatedAt: new Date()
            } satisfies CharacterVariableRecord
        ])
    }

    async listWakeUpReplies(): Promise<WakeUpReplyRecord[]> {
        return await this.ctx.database.get('chathub_character_wake_up_reply', {})
    }

    async saveWakeUpReplies(
        sessionKey: string,
        botId: string,
        channelId: string,
        guildId: string | undefined,
        userId: string,
        wakeUpReplies: PendingWakeUpReply[]
    ) {
        await this.ctx.database.remove('chathub_character_wake_up_reply', {
            sessionKey
        })

        if (wakeUpReplies.length < 1) {
            return
        }

        await Promise.all(
            wakeUpReplies.map(async (item) => {
                await this.ctx.database.create(
                    'chathub_character_wake_up_reply',
                    {
                        sessionKey,
                        botId,
                        channelId,
                        guildId,
                        userId,
                        rawTime: item.rawTime,
                        reason: item.reason,
                        naturalReason: item.naturalReason,
                        triggerAt: item.triggerAt,
                        createdAt: item.createdAt,
                        updatedAt: new Date()
                    } satisfies WakeUpReplyRecord
                )
            })
        )
    }
}
