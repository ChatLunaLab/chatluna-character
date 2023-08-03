import { Context, Schema, sleep } from 'koishi';
import CharacterPlugin from '..';
import { Factory } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/chat/factory"
import { createLogger } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/utils/logger"
import { service } from '..';


const logger = createLogger("chathub-character/plugins/filter")

export function apply(ctx: Context, config: CharacterPlugin.Config) {

    let maxMessages = config.maxMessages > config.messageInterval ? config.messageInterval : config.maxMessages

    const groupInfos: Record<string, GroupInfo> = {}


    service.addFilter((session, message) => {
        if (session.parsed.appel) {
            return true
        }

        const info = groupInfos[session.guildId] || {
            messageCount: 0,
            messageSendProbability: 0
        }

        let { messageCount, messageSendProbability } = info

        // 保底必出
        if (messageCount > maxMessages || messageSendProbability > 1) {
            info.messageCount = 0
            info.messageSendProbability = 0

            groupInfos[session.guildId] = info
            return true
        }

        // 按照概率出
        if (Math.random() < messageSendProbability) {
            info.messageCount = 0
            info.messageSendProbability = 0

            groupInfos[session.guildId] = info
            return true
        }

        logger.debug(`messageCount: ${messageCount}, messageSendProbability: ${messageSendProbability}. content: ${JSON.stringify(message)}`)

        messageCount++
        messageSendProbability += (1 / maxMessages) * 0.001

        info.messageCount = messageCount
        info.messageSendProbability = messageSendProbability

        groupInfos[session.guildId] = info

        return false
    })
}


interface GroupInfo {
    messageCount: number
    messageSendProbability: number
}