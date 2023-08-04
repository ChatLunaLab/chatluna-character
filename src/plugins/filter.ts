import { Context, Schema, sleep } from 'koishi';
import CharacterPlugin from '..';
import { Factory } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/chat/factory"
import { createLogger } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/utils/logger"
import { service } from '..';
import { group } from 'console';


const logger = createLogger("chathub-character/plugins/filter")

export const groupInfos: Record<string, GroupInfo> = {}

export function apply(ctx: Context, config: CharacterPlugin.Config) {

    let maxMessages = config.messageInterval

    service.addFilter((session, message) => {
        const info = groupInfos[session.guildId] || {
            messageCount: 0,
            messageSendProbability: 1
        }

        let { messageCount, messageSendProbability } = info

        // 保底必出
        if ((messageCount > maxMessages || messageSendProbability > 1 || session.parsed.appel) && !service.isMute(session)) {
            info.messageCount = 0
            info.messageSendProbability = 1

            groupInfos[session.guildId] = info
            return true
        }



        // 按照概率出
        if (Math.random() > messageSendProbability && !service.isMute(session)) {
            info.messageCount = 0
            info.messageSendProbability = 1

            groupInfos[session.guildId] = info
            return true
        }

        logger.debug(`messageCount: ${messageCount}, messageSendProbability: ${messageSendProbability}. content: ${JSON.stringify(message)}`)

        messageCount++
        messageSendProbability -= (1 / maxMessages) * 0.01

        info.messageCount = messageCount
        info.messageSendProbability = messageSendProbability

        groupInfos[session.guildId] = info

        return false
    })
}


export interface GroupInfo {
    messageCount: number
    messageSendProbability: number

}