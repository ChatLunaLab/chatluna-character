import { Context } from 'koishi'
import { Config, service } from '..'
import { createLogger } from '@dingyi222666/koishi-plugin-chathub/lib/utils/logger'

const logger = createLogger('chathub-character')

export const groupInfos: Record<string, GroupInfo> = {}

export function apply(ctx: Context, config: Config) {
    const maxMessages = config.messageInterval

    // const selectedPreset = await preset.getPreset(config.defaultPreset)

    service.addFilter((session, message) => {
        const info = groupInfos[session.guildId] || {
            messageCount: 0,
            messageSendProbability: 1
        }

        let { messageCount, messageSendProbability } = info

        // 保底必出
        if (
            (messageCount > maxMessages ||
                messageSendProbability > 1 ||
                session.stripped.appel) &&
            !service.isMute(session)
        ) {
            info.messageCount = 0
            info.messageSendProbability = 1

            groupInfos[session.guildId] = info
            return true
        }

        // 按照概率出
        if (
            Math.random() > messageSendProbability &&
            !service.isMute(session)
        ) {
            info.messageCount = 0
            info.messageSendProbability = 1

            groupInfos[session.guildId] = info
            return true
        }

        logger.debug(
            `messageCount: ${messageCount}, messageSendProbability: ${messageSendProbability}. content: ${JSON.stringify(
                message
            )}`
        )

        messageCount++
        messageSendProbability -= (1 / maxMessages) * 0.15

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
