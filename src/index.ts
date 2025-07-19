/* eslint-disable max-len */
import { Context, Disposable, Schema } from 'koishi'

import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { plugins } from './plugin'
import { MessageCollector } from './service/message'
import { GuildConfig } from './types'

export function apply(ctx: Context, config: Config) {
    const disposables: Disposable[] = []

    ctx.on('ready', async () => {
        ctx.plugin(MessageCollector, config)

        ctx.plugin(
            {
                apply: async (ctx: Context, config: Config) => {
                    await ctx.chatluna_character.stickerService.init()
                    await ctx.chatluna_character.preset.init()
                    await plugins(ctx, config)
                },
                inject: Object.assign({}, inject2, {
                    chatluna_character: {
                        required: true
                    }
                }),
                name: 'chatluna_character_entry_point'
            },
            config
        )

        disposables.push(
            ctx.middleware((session, next) => {
                if (!ctx.chatluna_character) {
                    return next()
                }

                // 不接收自己的消息
                if (ctx.bots[session.uid]) {
                    return next()
                }

                const guildId = session.guildId

                if (!config.applyGroup.includes(guildId)) {
                    return next()
                }

                return next(async (loop) => {
                    if (!(await ctx.chatluna_character.broadcast(session))) {
                        return loop()
                    }
                })
            })
        )
    })

    ctx.on('dispose', () => {
        disposables.forEach((disposable) => disposable())
    })
}

export const inject = {
    required: ['chatluna'],
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
    model: string
    maxMessages: number

    messageInterval: number
    messageActivityScore: number

    maxTokens: number
    applyGroup: string[]
    searchKeywordExtraModel: string

    modelOverride: { groupId: string; model: string }[]
    configs: Record<string, GuildConfig>

    defaultPreset: string
    isNickname: boolean
    isNickNameWithContent: boolean

    largeTextSize: number
    largeTextTypingTime: number
    markdownRender: boolean

    toolCalling: boolean
    toolCallingPrompt: string
    toolCallingModel: string
    isForceMute: boolean
    sendStickerProbability: number
    image: boolean
    imageInputMaxCount: number
    imageInputMaxSize: number
    modelCompletionCount: number

    coolDownTime: number
    typingTime: number
    muteTime: number

    disableChatLuna: boolean
    whiteListDisableChatLuna: string[]

    splitVoice: boolean
    splitSentence: boolean
    isAt: boolean
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
            .description('在使用此插件的群聊里，是否禁用 ChatLuna 主功能'),
        whiteListDisableChatLuna: Schema.array(Schema.string()).description(
            '在使用此插件时，不禁用 ChatLuna 主功能的群聊列表'
        )
    }).description('基础配置'),

    Schema.object({
        model: Schema.dynamic('model').default('').description('使用的模型'),
        modelOverride: Schema.array(
            Schema.object({
                groupId: Schema.string().required().description('群组 ID'),
                model: Schema.dynamic('model').default('').description('模型')
            })
        ).description('针对某个群的模型设置，会覆盖上面的配置'),
        maxTokens: Schema.number()
            .default(5000)
            .min(1024)
            .max(42000)
            .description('聊天的最大 token 数'),
        image: Schema.boolean()
            .description(
                '是否允许输入图片（注意表情包也会输入，目前仅支持原生多模态的模型）'
            )
            .default(false),
        imageInputMaxCount: Schema.number()
            .default(3)
            .min(1)
            .max(15)
            .description('最大的输入图片数量'),

        imageInputMaxSize: Schema.number()
            .default(3)
            .min(1)
            .max(20)
            .description('最大的输入图片大小（MB）'),
        toolCalling: Schema.boolean()
            .description('是否启用工具调用功能')
            .default(false),
        toolCallingPrompt: Schema.string()
            .description('工具调用的提示词')
            .role('textarea')
            .default(`你是一个智能助手，能够根据用户的意图调用相应的工具来提供帮助。并输出合理的 markdown 文档。

  指令说明

  - 当用户表达明确意图时（如搜索资料、发起聊天、观看视频、拍照等），你应该分析其需求并调用相应的工具
  - 如果用户只是进行普通对话或没有明确的工具使用意图，则直接回复，不要调用工具
  - 优先根据上下文和用户的具体需求选择最合适的工具

  上下文信息

  当前时间：{time}

  历史消息：
  {chat_history}

  用户当前问题:
  {question}


  请根据用户问题的具体内容和意图，决定是否需要调用工具以及调用哪个工具。
  如果不需要调用工具，请直接回复 [skip]。否则在调用了工具后，请输出基于上下文和工具调用结果的 markdown 文档回复。
  `),
        toolCallingModel: Schema.dynamic('model')
            .default('')
            .description('工具调用使用的模型')
    }).description('模型配置'),

    Schema.object({
        isNickname: Schema.boolean()
            .description('允许 bot 配置中的昵称引发回复')
            .default(true),
        isNickNameWithContent: Schema.boolean()
            .description(
                '是否允许在对话内容里任意匹配 bot 配置中的昵称来触发对话'
            )
            .default(false),
        isForceMute: Schema.boolean()
            .description(
                '是否启用强制禁言（当聊天涉及到关键词时则会禁言，关键词需要在预设文件里配置）'
            )
            .default(true),
        isAt: Schema.boolean()
            .description('是否允许 bot 艾特他人')
            .default(true),
        splitVoice: Schema.boolean()
            .description('是否分段发送语音')
            .default(false),
        splitSentence: Schema.boolean()
            .description(
                '是否启用自分割发送消息 **注意请确保你的预设和模型在使用时支持自分割消息，否则请不要关闭**'
            )
            .default(true),
        markdownRender: Schema.boolean()
            .description(
                '是否启用 Markdown 渲染。关闭后可能会损失分割消息的精度'
            )
            .default(true),
        messageInterval: Schema.number()
            .default(14)
            .min(0)
            .role('slider')
            .max(10000)
            .description('随机发送消息的间隔'),
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

        largeTextSize: Schema.number()
            .default(300)
            .min(100)
            .max(1000)
            .description('大文本消息的判断阈值（字符数）'),

        largeTextTypingTime: Schema.number()
            .default(100)
            .min(10)
            .max(1500)
            .description('大文本消息的固定打字间隔（毫秒）'),

        muteTime: Schema.number()
            .default(1000 * 60)
            .min(1000)
            .max(1000 * 60 * 10 * 10)
            .description('闭嘴时的禁言时间（毫秒）'),

        modelCompletionCount: Schema.number()
            .default(3)
            .min(0)
            .max(6)
            .description('模型历史消息轮数，为 0 不发送之前的历史轮次'),

        sendStickerProbability: Schema.number()
            .default(0.0)
            .min(0)
            .max(1)
            .role('slider')
            .step(0.01)
            .description('发送表情的概率（即将废弃，将制作新的表情系统插件）'),
        defaultPreset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('煕')
    }).description('对话设置'),

    Schema.object({
        configs: Schema.dict(
            Schema.object({
                maxTokens: Schema.number()
                    .default(4000)
                    .min(1024)
                    .max(20000)
                    .description('使用聊天的最大 token 数'),

                isAt: Schema.boolean().description('是否启用@').default(true),
                splitVoice: Schema.boolean()
                    .description('是否分段发送语音')
                    .default(false),
                splitSentence: Schema.boolean()
                    .description(
                        '是否启用自分割发送消息 **注意请确保你的预设和模型在使用时支持自分割消息，否则请不要关闭**'
                    )
                    .default(true),
                markdownRender: Schema.boolean()
                    .description(
                        '是否启用 Markdown 渲染。关闭后可能会损失分割消息的精度'
                    )
                    .default(true),
                isNickname: Schema.boolean()
                    .description('允许 bot 配置中的昵称引发回复')
                    .default(true),
                isNickNameWithContent: Schema.boolean()
                    .description(
                        '是否允许在对话内容里任意匹配 bot 配置中的昵称来触发对话'
                    )
                    .default(false),
                isForceMute: Schema.boolean()
                    .description(
                        '是否启用强制禁言（当聊天涉及到关键词时则会禁言，关键词需要在预设文件里配置）'
                    )
                    .default(true),
                messageInterval: Schema.number()
                    .default(10)
                    .min(0)
                    .role('slider')
                    .max(10000)
                    .description('随机发送消息的间隔'),
                messageActivityScore: Schema.number()
                    .default(0.6)
                    .min(0)
                    .max(1)
                    .role('slider')
                    .step(0.00001)
                    .description(
                        '消息活跃度分数的阈值，当活跃度超过这个阈值则会发送消息'
                    ),
                toolCalling: Schema.boolean()
                    .description('是否启用工具调用功能')
                    .default(false),
                image: Schema.boolean()
                    .description(
                        '是否允许输入图片（注意表情包也会输入，目前仅支持原生多模态的模型）'
                    )
                    .default(false),

                imageInputMaxCount: Schema.number()
                    .default(3)
                    .min(1)
                    .max(15)
                    .description('最大的输入图片数量'),

                imageInputMaxSize: Schema.number()
                    .default(1024 * 1024 * 10)
                    .min(1024 * 1024 * 1)
                    .max(1024 * 1024 * 20)
                    .description('最大的输入图片大小（KB）'),
                coolDownTime: Schema.number()
                    .default(10)
                    .min(1)
                    .max(60 * 24 * 24)
                    .description('冷却发言时间（秒）'),

                typingTime: Schema.number()
                    .default(440)
                    .min(100)
                    .role('slider')
                    .max(1700)
                    .description('模拟打字时的间隔（毫秒）'),
                largeTextSize: Schema.number()
                    .default(300)
                    .min(100)
                    .max(1000)
                    .description('大文本消息的判断阈值（每段分句的字符数）'),

                largeTextTypingTime: Schema.number()
                    .default(100)
                    .min(10)
                    .max(1500)
                    .description('大文本消息的模拟打字间隔（毫秒）'),

                muteTime: Schema.number()
                    .default(1000 * 60)
                    .min(1000)
                    .max(1000 * 60 * 10 * 10)
                    .description('闭嘴时的禁言时间（毫秒）'),

                modelCompletionCount: Schema.number()
                    .default(3)
                    .min(0)
                    .max(6)
                    .description('模型历史消息轮数，为 0 不发送之前的历史轮次'),

                sendStickerProbability: Schema.number()
                    .default(0)
                    .min(0)
                    .max(1)
                    .role('slider')
                    .step(0.01)
                    .description('发送表情的概率'),
                preset: Schema.dynamic('character-preset')
                    .description('使用的伪装预设')
                    .default('煕')
            })
        )
            .role('table')
            .description('分群配置，会覆盖上面的默认配置（键填写群号）')
    }).description('分群配置')
]) as unknown as Schema<Config>

export const name = 'chatluna-character'
