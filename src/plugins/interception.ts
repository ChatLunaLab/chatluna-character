import { Context } from 'koishi';
import { createLogger } from "@dingyi222666/koishi-plugin-chathub/lib/utils/logger"
import { Config } from '..';

const logger = createLogger("chathub-character")

export function apply(ctx: Context, config: Config) {

    ctx.on("chathub/before-check-sender", async (session) => {
        return ((session.parsed.appel && !session.isDirect) || !session.isDirect) && config.applyGroup.some(group => group === session.guildId) && config.disableChatHub
    })
}
