import { Context, Schema, sleep } from 'koishi';
import CharacterPlugin from '..';
import { Factory } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/chat/factory"

export function apply(ctx: Context, config: CharacterPlugin.Config) {

    ctx.on("chathub/before-check-sender",async (session) => {
        return session.parsed.appel && !session.isDirect && config.applyGroup.some(group => group === session.guildId)
    })
}
