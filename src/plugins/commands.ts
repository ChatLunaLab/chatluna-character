import { Context, Session } from 'koishi'
import { Config } from '..'
import { groupInfos } from './filter'

export function apply(ctx: Context, config: Config) {
    ctx.command('chatluna.character', '角色扮演相关命令')

    ctx.command('chatluna.character.clear [group]', '清除群组的聊天记录', {
        authority: 3
    }).action(async ({ session }, group) => {
        const groupId = group ?? session.guildId
        const messages = groupId
            ? ctx.chatluna_character.getMessages(groupId)
            : undefined

        if (!groupId) {
            await sendMessageToPrivate(session, '请检查你是否提供了群组 id')
            return
        }

        const groupInfo = groupInfos[groupId]

        if (!groupInfo && (!messages || messages.length < 1)) {
            await sendMessageToPrivate(session, '未找到该群组的聊天记录')
            return
        }

        delete groupInfos[groupId]
        await ctx.chatluna_character.clear(groupId)
        await sendMessageToPrivate(session, `已清除群组 ${groupId} 的聊天记录`)
    })
}

async function sendMessageToPrivate(session: Session, message: string) {
    await session.bot.sendPrivateMessage(session.userId, message)
}
