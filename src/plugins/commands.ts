import { Context } from 'koishi'
import { Config } from '..'

export function apply(ctx: Context, config: Config) {
    ctx.command('chatluna.character', '角色扮演相关命令')

    ctx.command(
        'chatluna.character.clear [group]',
        '清除当前会话或指定群组的聊天记录',
        {
            authority: 3
        }
    ).action(async ({ session }, group) => {
        const isDirect = session.isDirect
        const groupId = group ?? (isDirect ? session.userId : session.guildId)

        const key = group
            ? `group:${group}`
            : `${isDirect ? 'private' : 'group'}:${groupId}`

        if (!groupId && !isDirect) {
            await session.send('请检查你是否提供了群组或私聊用户 ID')
            return
        }

        const label = isDirect ? '私聊' : '群组'

        await session.send(`已清除${label} ${groupId} 的聊天记录`)

        await ctx.chatluna_character.clear(key)
        await ctx.chatluna_character_trigger.delete(key)
    })
}
