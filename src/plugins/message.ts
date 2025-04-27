import { Context } from 'koishi'
import { Config } from '..'
import { GroupInfo } from '../types'

export const groupInfos: Record<string, GroupInfo> = {}

export async function apply(ctx: Context, config: Config) {
    ctx.plugin({
        apply: async (ctx) => {
            ctx.on('message', async (session) => {
                await ctx.chatluna_character_message.receiveMessage(session)
            })
        },
        inject: ['chatluna_character_message']
    })
}
