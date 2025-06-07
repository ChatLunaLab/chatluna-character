/* eslint-disable max-len */
import { Context, Disposable, Schema } from 'koishi'

import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { plugins } from './plugin'
import { GuildConfig } from './types'

export function apply(ctx: Context, config: Config) {
    const disposables: Disposable[] = []

    ctx.on('ready', async () => {
        await plugins(ctx, config)

        ctx.plugin(
            {
                apply: async (ctx: Context, config: Config) => {
                    ctx.logger.error('开始执行事件循环')
                    await ctx.chatluna_character_event_loop.activatePreset('煕')
                },
                inject: Object.assign({}, inject2, {
                    chatluna_character_preset: {
                        required: true
                    }
                }),
                name: 'chatluna_character_entry_point'
            },
            config
        )
    })

    disposables.push(
        ctx.middleware((session, next) => {
            /*  if (!ctx.chatluna_character) {
                return next()
            } */

            // 不接收自己的消息
            if (ctx.bots[session.uid]) {
                return next()
            }

            const guildId = session.guildId

            if (!config.applyGroup.includes(guildId)) {
                return next()
            }

            return next(async (loop) => {
                /*  if (!(await ctx.chatluna_character.broadcast(session))) {
                    return loop()
                } */
            })
        })
    )

    ctx.on('dispose', () => {
        disposables.forEach((disposable) => disposable())
    })
}

export const inject = {
    required: ['chatluna', 'database'],
    optional: ['chatluna_character', 'vits']
}

export const inject2 = {
    chatluna: {
        required: true
    },
    chatluna_character: {
        required: false
    },
    vits: {
        required: false
    }
}

export interface Config extends ChatLunaPlugin.Config {
    applyGroup: string[]
    maxMessages: number
    disableChatLuna: boolean

    model: string
    thinkingModel: string
    topicModel: string
    eventLoopModel: string
    maxTokens: number
    imageInput: boolean
    imageLimit: number

    isNickname: boolean
    isForceMute: boolean
    isAt: boolean
    messageInterval: number
    messageActivityScore: number
    coolDownTime: number
    typingTime: number
    muteTime: number
    eventLoop: boolean
    topic: boolean
    think: boolean
    defaultPreset: string

    configs: Record<string, GuildConfig>
}

export const Config = Schema.intersect([
    Schema.object({
        applyGroup: Schema.array(Schema.string()).description('应用到的群组'),
        maxMessages: Schema.number()
            .description('存储在内存里的最大消息数量')
            .default(10)
            .min(3)
            .role('slider')
            .max(100),
        disableChatLuna: Schema.boolean()
            .default(true)
            .description('在使用此插件的群聊里，是否禁用 ChatLuna 主功能')
    }).description('基础配置'),

    Schema.object({
        model: Schema.dynamic('model')
            .default('')
            .description('使用的主要模型'),
        thinkingModel: Schema.dynamic('model')
            .default('')
            .description('思考时使用的模型'),
        topicModel: Schema.dynamic('model')
            .default('')
            .description('分析话题时使用的模型'),
        eventLoopModel: Schema.dynamic('model')
            .default('')
            .description('事件循环使用的模型'),
        maxTokens: Schema.number()
            .default(5000)
            .min(1024)
            .max(42000)
            .description('Agent 单轮输入的最大 token 数'),
        imageInput: Schema.boolean()
            .description(
                '是否允许输入图片（注意表情包也会输入，目前仅支持原生多模态的模型）'
            )
            .default(false),
        imageLimit: Schema.number()
            .description('输入图片的张数限制')
            .default(3)
            .min(1)
            .max(10)
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
        isAt: Schema.boolean()
            .description('是否允许 bot 艾特他人')
            .default(true),
        messageInterval: Schema.number()
            .default(14)
            .min(0)
            .role('slider')
            .max(100)
            .description('发送消息的间隔条速'),
        messageActivityScore: Schema.number()
            .default(0.6)
            .min(0)
            .max(1)
            .role('slider')
            .step(0.00001)
            .description(
                '消息活跃度分数的阈值，当活跃度超过这个阈值则会发送消息'
            ),

        coolDownTime: Schema.number()
            .default(10)
            .min(1)
            .max(60 * 24)
            .description('冷却发言时间（秒）'),

        typingTime: Schema.number()
            .default(440)
            .min(100)
            .role('slider')
            .max(1500)
            .description('模拟打字时的间隔（毫秒）'),

        muteTime: Schema.number()
            .default(1000 * 60)
            .min(1000)
            .max(1000 * 60 * 10 * 10)
            .description('闭嘴时的禁言时间（毫秒）'),

        eventLoop: Schema.boolean()
            .default(false)
            .description('是否启用事件循环模块'),

        topic: Schema.boolean()
            .default(false)
            .description('是否启用话题分析模块'),

        think: Schema.boolean()
            .default(false)
            .description('是否启用全局思考/分群思考模块'),

        defaultPreset: Schema.dynamic('character-preset')
            .description('使用的预设')
            .default('煕')
    }).description('对话设置'),

    Schema.object({
        configs: Schema.dict(
            Schema.object({
                model: Schema.dynamic('model')
                    .default('')
                    .description('使用的主要模型'),
                thinkingModel: Schema.dynamic('model')
                    .default('')
                    .description('思考时使用的模型'),
                topicModel: Schema.dynamic('model')
                    .default('')
                    .description('分析话题时使用的模型'),
                eventLoopModel: Schema.dynamic('model')
                    .default('')
                    .description('事件循环使用的模型'),
                maxTokens: Schema.number()
                    .default(5000)
                    .min(1024)
                    .max(42000)
                    .description('Agent 单轮输入的最大 token 数'),
                imageInput: Schema.boolean()
                    .description(
                        '是否允许输入图片（注意表情包也会输入，目前仅支持原生多模态的模型）'
                    )
                    .default(false),
                imageLimit: Schema.number()
                    .description('输入图片的张数限制')
                    .default(3)
                    .min(1)
                    .max(10),

                isNickname: Schema.boolean()
                    .description('允许 bot 配置中的昵称引发回复')
                    .default(true),
                isForceMute: Schema.boolean()
                    .description(
                        '是否启用强制禁言（当聊天涉及到关键词时则会禁言，关键词需要在预设文件里配置）'
                    )
                    .default(true),
                isAt: Schema.boolean()
                    .description('是否允许 bot 艾特他人')
                    .default(true),
                messageInterval: Schema.number()
                    .default(14)
                    .min(0)
                    .role('slider')
                    .max(100)
                    .description('发送消息的间隔条速'),
                messageActivityScore: Schema.number()
                    .default(0.6)
                    .min(0)
                    .max(1)
                    .role('slider')
                    .step(0.00001)
                    .description(
                        '消息活跃度分数的阈值，当活跃度超过这个阈值则会发送消息'
                    ),

                coolDownTime: Schema.number()
                    .default(10)
                    .min(1)
                    .max(60 * 24)
                    .description('冷却发言时间（秒）'),

                typingTime: Schema.number()
                    .default(440)
                    .min(100)
                    .role('slider')
                    .max(1500)
                    .description('模拟打字时的间隔（毫秒）'),

                muteTime: Schema.number()
                    .default(1000 * 60)
                    .min(1000)
                    .max(1000 * 60 * 10 * 10)
                    .description('闭嘴时的禁言时间（毫秒）'),

                eventLoop: Schema.boolean()
                    .default(false)
                    .description('是否启用事件循环模块'),

                topic: Schema.boolean()
                    .default(false)
                    .description('是否启用话题分析模块'),

                think: Schema.boolean()
                    .default(false)
                    .description('是否启用全局思考/分群思考模块'),

                defaultPreset: Schema.dynamic('character-preset')
                    .description('使用的预设')
                    .default('煕')
            })
                .role('table')
                .description('分群配置，会覆盖上面的默认配置（键填写群号）')
        )
    }).description('分群配置')
]) as unknown as Schema<Config>

export const name = 'chatluna-character'
