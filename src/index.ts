/* eslint-disable max-len */
import { Context, Disposable, Schema } from 'koishi'

import { ChatLunaPlugin } from 'koishi-plugin-chatluna/lib/services/chat'
import { plugins } from './plugin'
import { MessageCollector } from './service/message'

export function apply(ctx: Context, config: Config) {
    const disposables: Disposable[] = []

    ctx.on('ready', async () => {
        ctx.plugin(MessageCollector, config)
    })

    ctx.plugin(
        {
            apply: async (ctx: Context, config: Config) => {
                await ctx.chatluna_character.stickerService.init()
                await ctx.chatluna_character.preset.loadAllPreset()
                await plugins(ctx, config)
            },
            inject: {
                required: inject.required.concat(
                    'chatluna',
                    'chatluna_character'
                )
            },
            name: 'chatluna_entry_point'
        },
        config
    )

    disposables.push(
        ctx.on('message', async (session) => {
            if (!ctx.chatluna_character) {
                return
            }
            if (
                !session.isDirect &&
                config.applyGroup.some((group) => group === session.guildId)
            ) {
                await ctx.chatluna_character.broadcast(session)
            }
        })
    )

    ctx.on('dispose', () => {
        disposables.forEach((disposable) => disposable())
    })
}

export const inject = {
    required: ['chatluna', 'cache'],
    optional: ['chatluna_character']
}

export interface Config extends ChatLunaPlugin.Config {
    model: string
    maxMessages: number

    messageInterval: number
    checkPromptInject: boolean
    maxTokens: number
    applyGroup: string[]

    defaultPreset: string

    isNickname: boolean
    isForceMute: boolean
    sendStickerProbability: number

    coolDownTime: number
    typingTime: number
    muteTime: number

    disableChatHub: boolean
}

export const Config = Schema.intersect([
    Schema.object({
        applyGroup: Schema.array(Schema.string()).description('应用到的群组'),
        maxMessages: Schema.number()
            .description('存储在内存里的最大消息数量')
            .default(10)
            .min(7)
            .role('slider')
            .max(40),
        disableChatHub: Schema.boolean()
            .default(true)
            .description('在使用此插件时，是否禁用 chathub 的功能')
    }).description('基础配置'),

    Schema.object({
        model: Schema.dynamic('model').description('使用的模型'),
        maxTokens: Schema.number()
            .default(2048)
            .min(1024)
            .max(8072)
            .description('使用聊天的最大 token 数')
    }).description('模型配置'),

    Schema.object({
        isNickname: Schema.boolean()
            .description('允许 bot 配置中的昵称引发回复')
            .default(true),
        isForceMute: Schema.boolean()
            .description(
                '是否启用强制禁言（当聊天涉及到关键词时则会禁言，关键词需要在预设文件里配置）'
            )
            .default(true),
        messageInterval: Schema.number()
            .default(14)
            .min(0)
            .role('slider')
            .max(30)
            .description('随机发送消息的间隔'),

        coolDownTime: Schema.number()
            .default(10)
            .min(1)
            .max(60 * 24)
            .description('冷却发言时间（秒）'),

        typingTime: Schema.number()
            .default(440)
            .min(100)
            .role('slider')
            .max(1000)
            .description('模拟打字时的间隔（毫秒）'),

        muteTime: Schema.number()
            .default(1000 * 60)
            .min(1000)
            .max(1000 * 60 * 10 * 10)
            .description('闭嘴时的禁言时间（毫秒）'),

        sendStickerProbability: Schema.number()
            .default(0.6)
            .min(0)
            .max(1)
            .role('slider')
            .step(0.01)
            .description('发送表情的概率')
    }).description('对话设置'),

    Schema.object({
        defaultPreset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('旧梦旧念')
    })
]) as Schema<Config>

export const name = 'chatluna-character'
