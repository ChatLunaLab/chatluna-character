import { Context } from 'koishi'
import { Config, service } from '..'
import { groupInfos } from './filter'

export function apply(ctx: Context, config: Config) {
    ctx.command('chathub.character', '角色扮演相关命令')

    ctx.command('chathub.character.clear [group]', '清除群组的聊天记录').action(
        async ({ session }, group) => {
            if (!session.isDirect) {
                return
            }
            const groupId = group ?? session.guildId
            if (!groupId) {
                return '请检查你是否提供了群组id'
            }

            const groupInfo = groupInfos[groupId]

            if (!groupInfo) {
                return '没有找到群组信息'
            }

            groupInfo.messageCount = 0
            groupInfo.messageSendProbability = 0
            service.clear(groupId)
            return `已清除群组${groupId}的聊天记录`
        }
    )
}
