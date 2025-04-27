import { Context } from 'koishi'
import { Config } from '..'
import { GroupInfo } from '../types'

export const groupInfos: Record<string, GroupInfo> = {}

export async function apply(ctx: Context, config: Config) {
    ctx.on('message', async (session) => {
        await ctx.chatluna_character_message.receiveMessage(session)
    })
}
