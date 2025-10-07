import { Context } from 'koishi'
import { Config } from '..'

export function apply(ctx: Context, config: Config) {
    ctx.on('chatluna/before-check-sender', async (session) => {
        const guildId = session.guildId
        if (!config.applyGroup.includes(guildId) || session.isDirect) {
            return false
        }

        let appel = session.stripped.appel

        const botId = session.bot.userId

        if (!appel) {
            // 从消息元素中检测是否有被艾特当前用户
            appel = session.elements.some(
                (element) =>
                    element.type === 'at' && element.attrs?.['id'] === botId
            )
        }

        if (!appel) {
            // 检测回复的消息是否为 bot 本身
            const botId = session.bot.userId
            appel = session.quote?.user?.id === botId
        }

        if (!appel) {
            return config.disableChatLuna
        }

        // 检查是否在名单里面
        if (
            config.disableChatLuna &&
            config.whiteListDisableChatLuna?.includes(guildId)
        ) {
            // check to last five message is send for bot

            const selfId = session.bot.userId ?? session.bot.selfId ?? '0'

            const guildMessages = ctx.chatluna_character.getMessages(guildId)

            if (guildMessages == null || guildMessages.length === 0) {
                return true
            }

            let maxRecentMessage = 0

            while (maxRecentMessage < 3) {
                const currentMessage =
                    guildMessages[guildMessages?.length - 1 - maxRecentMessage]

                if (currentMessage == null) {
                    return false
                }

                if (currentMessage.id === selfId) {
                    return true
                }

                maxRecentMessage++
            }
        }

        return config.disableChatLuna
    })
}
