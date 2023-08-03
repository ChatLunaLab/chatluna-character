import { Context, Schema, sleep } from 'koishi';
import CharacterPlugin from '..';
import { Factory } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/chat/factory"
import { createLogger } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/utils/logger"
import { service } from '..';


const logger = createLogger("chathub-character/plugins/filter")

export function apply(ctx: Context, config: CharacterPlugin.Config) {

    let maxMessages = config.maxMessages < config.messageInterval ? config.messageInterval : config.maxMessages
    let messageCount = 0
    let messageSendProbability = 0
    service.addFilter((session, message) => {
        if (session.parsed.appel) {
            return true
        }


        // 保底必出
        if (messageCount > maxMessages || messageSendProbability > 1) {
            messageCount = 0
            messageSendProbability = 0
            return true
        }

        // 按照概率出
        if (Math.random() < messageSendProbability) {
            messageCount = 0
            messageSendProbability = 0
            return true
        }

        logger.debug(`messageCount: ${messageCount}, messageSendProbability: ${messageSendProbability}. content: ${JSON.stringify(message)}`)

        messageCount++
        messageSendProbability += (1 / maxMessages) * 0.2

        return false
    })
}
