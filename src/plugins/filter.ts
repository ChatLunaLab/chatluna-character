import { Context } from 'koishi'
import { logger, Config, preset, service } from '..'

export const groupInfos: Record<string, GroupInfo> = {}

export async function apply(ctx: Context, config: Config) {
    const maxMessages = config.messageInterval

    const selectedPreset = await preset.getPreset(config.defaultPreset)

    service.addFilter((session, message) => {
        const info = groupInfos[session.guildId] || {
            messageCount: 0,
            messageSendProbability: 1
        }

        let { messageCount, messageSendProbability } = info

        // 在计算之前先检查是否需要禁言。

        if (config.isForceMute && selectedPreset.mute_keyword?.length > 0) {
            const needMute = selectedPreset.mute_keyword.some((value) =>
                message.content.includes(value)
            )

            if (needMute) {
                logger.debug(`mute content: ${message.content}`)
                service.mute(session, config.muteTime)
            }
        }

        // 保底必出
        if (
            (messageCount > maxMessages ||
                messageSendProbability > 1 ||
                session.stripped.appel ||
                (config.isNickname &&
                    selectedPreset.nick_name.some((value) =>
                        message.content.startsWith(value)
                    ))) &&
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
