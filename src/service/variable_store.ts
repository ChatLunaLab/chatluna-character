import { Context } from 'koishi'
import { CharacterVariableRecord, GroupTemp, Message } from '../types'

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
    }

    async read(sessionKey: string, temp: GroupTemp) {
        const row = (
            await this.ctx.database.get('chathub_character_variable', [
                sessionKey
            ])
        )[0]

        temp.status = row?.status
        temp.historyClearedAt = row?.historyClearedAt
        temp.statusMessageId = row?.statusMessageId
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
                statusMessageUserId: msg?.id,
                updatedAt: new Date()
            } satisfies CharacterVariableRecord
        ])

        temp.status = s
        temp.statusMessageId = msg?.messageId
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
                statusMessageUserId: null,
                updatedAt: new Date()
            } satisfies CharacterVariableRecord
        ])
    }
}
