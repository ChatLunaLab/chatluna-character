import { Context } from 'koishi'
import { Config } from '..'

export function apply(ctx: Context, config: Config) {
    ctx.on('chatluna/before-check-sender', async (session) => {
        const guildId = session.guildId
        if (
            !config.applyGroup.includes(guildId) ||
            session.isDirect ||
            !session.stripped.appel
        ) {
            return false
        }

        // 检查是否在名单里面
        if (
            config.disableChatLuna &&
            config.whiteListDisableChatLuna.includes(guildId)
        ) {
            // check to last five message is send for bot

            const selfId = session.bot.userId ?? session.bot.selfId ?? '0'

            const guildMessages = ctx.chatluna_character.getMessages(guildId)

            if (guildMessages == null || guildMessages.length === 0) {
                return true
            }

            let maxRecentMessage = 0

            while (maxRecentMessage < 5) {
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
