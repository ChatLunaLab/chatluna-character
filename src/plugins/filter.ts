import { Context } from 'koishi'
import { Config } from '..'
import { GroupInfo, PresetTemplate } from '../types'

export const groupInfos: Record<string, GroupInfo> = {}

export async function apply(ctx: Context, config: Config) {
    const maxMessages = config.messageInterval

    const service = ctx.chatluna_character
    const preset = service.preset
    const logger = service.logger

    const globalPreset = await preset.getPreset(config.defaultPreset)
    const presetPool: Record<string, PresetTemplate> = {}

    service.addFilter((session, message) => {
        const guildId = session.guildId
        const info = groupInfos[guildId] || {
            messageCount: 0,
            messageSendProbability: 1
        }
        const currentGuildConfig = config.configs[guildId]
        let copyOfConfig = Object.assign({}, config)
        let currentPreset = globalPreset

        if (currentGuildConfig != null) {
            copyOfConfig = Object.assign({}, copyOfConfig, currentGuildConfig)
            currentPreset =
                presetPool[guildId] ??
                (() => {
                    const template = preset.getPresetForCache(
                        currentGuildConfig.preset
                    )
                    presetPool[guildId] = template
                    return template
                })()
        }

        let { messageCount, messageSendProbability } = info

        logger.debug(
            `messageCount: ${messageCount}, messageSendProbability: ${messageSendProbability}. content: ${JSON.stringify(
                message
            )}`
        )

        // 检查是否在名单里面
        if (
            copyOfConfig.disableChatLuna &&
            copyOfConfig.whiteListDisableChatLuna.includes(guildId)
        ) {
            // check to last five message is send for bot

            const selfId = session.bot.userId ?? session.bot.selfId ?? '0'

            const guildMessages = ctx.chatluna_character.getMessages(guildId)

            let maxRecentMessage = 0

            if (guildMessages == null || guildMessages.length === 0) {
                maxRecentMessage = 6
            }

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
            copyOfConfig.isForceMute &&
            session.stripped.appel &&
            currentPreset.mute_keyword?.length > 0
        ) {
            const needMute = currentPreset.mute_keyword.some((value) =>
                message.content.includes(value)
            )

            if (needMute) {
                logger.debug(`mute content: ${message.content}`)
                service.mute(session, config.muteTime)
            }
        }

        const isMute = service.isMute(session)
        // 保底必出
        if (
            (messageCount > maxMessages ||
                messageSendProbability > 1 ||
                session.stripped.appel ||
                (config.isNickname &&
                    currentPreset.nick_name.some((value) =>
                        message.content.startsWith(value)
                    ))) &&
            !isMute
        ) {
            info.messageCount = 0
            info.messageSendProbability = 1

            groupInfos[session.guildId] = info
            return true
        }

        // 按照概率出
        if (Math.random() > messageSendProbability && !isMute) {
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
