import { Context } from 'koishi'
import { Config } from '..'
import { GroupInfo } from '../types'

export const groupInfos: Record<string, GroupInfo> = {}

export async function apply(ctx: Context, config: Config) {
    const maxMessages = config.messageInterval

    const service = ctx.chatluna_character
    const preset = service.preset
    const logger = service.logger

    const selectedPreset = await preset.getPreset(config.defaultPreset)

    service.addFilter((session, message) => {
        const guildId = session.guildId
        const info = groupInfos[guildId] || {
            messageCount: 0,
            messageSendProbability: 1
        }

        let { messageCount, messageSendProbability } = info

        logger.debug(
            `messageCount: ${messageCount}, messageSendProbability: ${messageSendProbability}. content: ${JSON.stringify(
                message
            )}`
        )

        // 检查是否在名单里面
        if (
            (config.disableChatLuna &&
                config.whiteListDisableChatLuna.includes(guildId)) ||
            !config.disableChatLuna
        ) {
            // check to last five message is send for bot

            const selfId = session.bot.userId ?? session.bot.selfId ?? '0'

            const guildMessages = ctx.chatluna_character.getMessages(guildId)

            if (guildMessages == null || guildMessages.length === 0) {
                return false
            }

            let maxRecentMessage = 0

            while (maxRecentMessage < 5) {
                const currentMessage =
                    guildMessages[guildMessages?.length - 1 - maxRecentMessage]

                if (currentMessage == null) {
                    return false
                }

                if (currentMessage.id === selfId) {
                    break
                }

                maxRecentMessage++
            }
        }

        // 在计算之前先检查是否需要禁言。
        if (
            config.isForceMute &&
            session.stripped.appel &&
            selectedPreset.mute_keyword?.length > 0
        ) {
            const needMute = selectedPreset.mute_keyword.some((value) =>
                message.content.includes(value)
            )

            if (needMute) {
                logger.debug(`mute content: ${message.content}`)
                service.mute(session, config.muteTime)
                return
            }
        }

        if (service.isMute(session)) {
            return
        }

        // 保底必出
        if (
            messageCount > maxMessages ||
            messageSendProbability > 1 ||
            session.stripped.appel ||
            (config.isNickname &&
                selectedPreset.nick_name.some((value) =>
                    message.content.startsWith(value)
                ))
        ) {
            info.messageCount = 0
            info.messageSendProbability = 1

            groupInfos[session.guildId] = info
            return true
        }

        // 按照概率出
        if (Math.random() > messageSendProbability) {
            info.messageCount = 0
            info.messageSendProbability = 1

            groupInfos[session.guildId] = info
            return true
        }

        messageCount++
        messageSendProbability -= (1 / maxMessages) * 0.145

        info.messageCount = messageCount
        info.messageSendProbability = messageSendProbability

        groupInfos[session.guildId] = info

        return false
    })
}
