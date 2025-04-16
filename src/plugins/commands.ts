import { Context, Session } from 'koishi'
import { Config } from '..'

export function apply(ctx: Context, config: Config) {
    ctx.command('chatluna.character', '角色扮演相关命令')

    ctx.command('chatluna.character.clear [group]', '清除群组的聊天记录', {
        authority: 3
    }).action(async ({ session }, group) => {
        await sendMessageToPrivate(session, `已清除群组 ${group} 的聊天记录`)
    })
}

async function sendMessageToPrivate(session: Session, message: string) {
    await session.bot.sendPrivateMessage(session.userId, message)
}
