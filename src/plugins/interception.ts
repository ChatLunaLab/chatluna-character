import { Context } from 'koishi'
import { Config } from '..'

export function apply(ctx: Context, config: Config) {
    ctx.on('chatluna/before-check-sender', async (session) => {
        return (
            ((session.stripped.appel && !session.isDirect) ||
                !session.isDirect) &&
            config.applyGroup.some((group) => group === session.guildId) &&
            config.disableChatHub
        )
    })
}
