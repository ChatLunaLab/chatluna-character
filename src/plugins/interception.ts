import { Context, Schema, sleep } from 'koishi';
import CharacterPlugin from '..';
import { Factory } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/chat/factory"
import { createLogger } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/utils/logger"
import { service } from '..';
import { PromptTemplate } from 'langchain';
import { Message } from '../types';
import { ChatHubBaseChatModel } from '@dingyi222666/koishi-plugin-chathub/lib/llm-core/model/base';
import { HumanMessage, SystemMessage } from 'langchain/schema';
import { parse } from 'path';

const logger = createLogger("chathub-character/plugins/interception")

export function apply(ctx: Context, config: CharacterPlugin.Config) {

    ctx.on("chathub/before-check-sender", async (session) => {
        return ((session.parsed.appel && !session.isDirect) || !session.isDirect ) && config.applyGroup.some(group => group === session.guildId) && config.disableChatHub
    })
}
