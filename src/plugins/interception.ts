import { Context } from 'koishi'
import { Config } from '..'

export function apply(ctx: Context, config: Config) {
    ctx.on('chathub/before-check-sender', async (session) => {
        return (
            ((session.stripped.appel && !session.isDirect) ||
                !session.isDirect) &&
            config.applyGroup.some((group) => group === session.guildId) &&
            config.disableChatHub
        )
    })
}
