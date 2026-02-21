/* eslint-disable max-len */
import { Context, Schema } from 'koishi'

import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { plugins } from './plugin'
import { MessageCollector } from './service/message'
import { GuildConfig } from './types'

export function apply(ctx: Context, config: Config) {
    ctx.plugin(MessageCollector, config)

    ctx.plugin(
        {
            apply: (ctx: Context, config: Config) => {
                ctx.on('ready', async () => {
                    await ctx.chatluna_character.preset.init()
                    await plugins(ctx, config)
                })
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

export const usage = `
## chatluna-character

请先阅读[**此文档**](https://chatluna.chat/ecosystem/other/character.html)了解使用方式。

### 2026.2.21

近期新增了一些让Bot可以在不被@的情况下主动维持对话状态的功能（如被动的空闲触发），部分需要搭配良好的预设提示词使用（主动的xml工具），文档中将提供最新的模板预设帮助你修改旧的预设。

建议老用户将大部分配置恢复为更新后的默认值（是否允许输入图片、工具调用等与模型能力有关的请自行根据实际情况调整）
`

export interface Config extends ChatLunaPlugin.Config {
    model: string
    maxMessages: number

    messageInterval: number
    enableLongWaitTrigger: boolean
    idleTriggerIntervalMinutes: number
    idleTriggerRetryStyle: 'exponential' | 'fixed'
    enableIdleTriggerMaxInterval: boolean
    idleTriggerMaxIntervalMinutes: number
    enableIdleTriggerJitter: boolean
    messageActivityScoreLowerLimit: number
    messageActivityScoreUpperLimit: number

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

    enableMessageId: boolean
}

export const Config = Schema.intersect([
    Schema.object({
        applyGroup: Schema.array(Schema.string()).description('应用到的群组'),
        maxMessages: Schema.number()
            .description('存储在内存里的最大消息数量')
            .default(40)
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
            .default(42000)
            .min(1024)
            .max(42000)
            .description('聊天的最大 token 数'),
        image: Schema.boolean()
            .description(
                '是否允许输入图片（注意表情包也会输入，目前仅支持原生多模态的模型）'
            )
            .default(false),
        imageInputMaxCount: Schema.number()
            .default(9)
            .min(1)
            .max(15)
            .description('最大的输入图片数量'),

        imageInputMaxSize: Schema.number()
            .default(20)
            .min(1)
            .max(20)
            .description('最大的输入图片大小（MB）'),
        toolCalling: Schema.boolean()
            .description(
                '是否启用工具调用功能（可在[**这里**](https://cooksleep.github.io/newapi-special-test)测试你的API工具调用等能力是否正常）'
            )
            .default(true)
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
            .default(false),
        splitVoice: Schema.boolean()
            .description('是否分段发送语音')
            .default(false),
        splitSentence: Schema.boolean()
            .description('是否启用自分割发送消息（仅旧版预设开启）')
            .default(false),
        enableMessageId: Schema.boolean()
            .description('向模型暴露平台消息 ID，以允许发送引用消息。')
            .default(true),
        markdownRender: Schema.boolean()
            .description(
                '是否启用 Markdown 渲染。关闭后可能会损失分割消息的精度（仅旧版预设开启）'
            )
            .default(false),
        messageInterval: Schema.number()
            .default(20)
            .min(0)
            .role('slider')
            .max(10000)
            .description('随机发送消息的最大间隔'),
        enableLongWaitTrigger: Schema.boolean()
            .default(false)
            .description('是否启用空闲触发'),
        idleTriggerIntervalMinutes: Schema.number()
            .default(60 * 3)
            .min(1)
            .max(60 * 24 * 7)
            .description(
                '空闲触发间隔（分钟）：当超过该时间未收到新消息时，将自动触发一次回复请求。'
            ),
        idleTriggerRetryStyle: Schema.union([
            Schema.const('exponential').description(
                '指数退避（默认）：首次触发后若仍无新消息，按“空闲触发间隔（分钟）”作为起始值每次乘 2（例如 2→4→8→16）。'
            ),
            Schema.const('fixed').description(
                '固定重试：始终按“空闲触发间隔（分钟）”重复触发。'
            )
        ])
            .default('exponential')
            .description('空闲触发重试风格'),
        enableIdleTriggerMaxInterval: Schema.boolean()
            .default(true)
            .description('是否启用空闲触发最大间隔限制'),
        idleTriggerMaxIntervalMinutes: Schema.number()
            .default(60 * 24)
            .min(1)
            .max(60 * 24 * 30)
            .description(
                '空闲触发最大间隔（分钟）：仅在“指数退避”下生效，关闭上面的限制时不封顶。'
            ),
        enableIdleTriggerJitter: Schema.boolean()
            .default(true)
            .description(
                '是否启用空闲触发随机抖动：对固定重试与指数退避都生效，每轮会随机提前或延后 5%-10%。'
            ),
        messageActivityScoreLowerLimit: Schema.number()
            .default(0.85)
            .min(0)
            .max(1)
            .role('slider')
            .step(0.00001)
            .description(
                '消息活跃度分数的下限阈值。初始状态或长时间无人回复后，会使用此阈值判断是否响应。'
            ),
        messageActivityScoreUpperLimit: Schema.number()
            .default(0.85)
            .min(0)
            .max(1)
            .role('slider')
            .step(0.00001)
            .description(
                '消息活跃度分数的上限阈值。每次响应后，判断阈值会向此值靠拢。若下限 < 上限（如 0.1 → 0.9），则会越聊越少；若下限 > 上限（如 0.9 → 0.2），则会越聊越多。十分钟内无人回复时，会自动回退到下限。'
            ),

        coolDownTime: Schema.number()
            .default(0)
            .min(0)
            .max(60 * 24)
            .description(
                '冷却发言时间（秒）：当上一条消息发送完成后的 n 秒内发出的请求将被丢弃。'
            ),

        typingTime: Schema.number()
            .default(200)
            .min(100)
            .role('slider')
            .max(1500)
            .description('模拟打字时的间隔（毫秒）'),

        largeTextSize: Schema.number()
            .default(100)
            .min(100)
            .max(1000)
            .description('大文本消息的判断阈值（字符数）'),

        largeTextTypingTime: Schema.number()
            .default(10)
            .min(10)
            .max(1500)
            .description('大文本消息的固定打字间隔（毫秒）'),

        muteTime: Schema.number()
            .default(1000 * 60)
            .min(1000)
            .max(1000 * 60 * 10 * 10)
            .description('闭嘴时的禁言时间（毫秒）'),

        modelCompletionCount: Schema.number()
            .default(1)
            .min(0)
            .max(6)
            .description('模型历史消息轮数，为 0 不发送之前的历史轮次'),

        defaultPreset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('CHARACTER')
    }).description('对话设置'),

    Schema.object({
        configs: Schema.dict(
            Schema.object({
                maxTokens: Schema.number()
                    .default(20000)
                    .min(1024)
                    .max(20000)
                    .description('使用聊天的最大 token 数'),

                enableMessageId: Schema.boolean()
                    .description('向模型暴露平台消息 ID，以允许发送引用消息。')
                    .default(true),
                isAt: Schema.boolean().description('是否启用@').default(false),
                splitVoice: Schema.boolean()
                    .description('是否分段发送语音')
                    .default(false),
                splitSentence: Schema.boolean()
                    .description('是否启用自分割发送消息（仅旧版预设开启）')
                    .default(false),
                markdownRender: Schema.boolean()
                    .description(
                        '是否启用 Markdown 渲染。关闭后可能会损失分割消息的精度（仅旧版预设开启）'
                    )
                    .default(false),
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
                    .default(20)
                    .min(0)
                    .role('slider')
                    .max(10000)
                    .description(
                        '随机发送消息的间隔。群越活跃，这个值就会越高。'
                    ),
                enableLongWaitTrigger: Schema.boolean()
                    .default(false)
                    .description('是否启用空闲触发'),
                idleTriggerIntervalMinutes: Schema.number()
                    .default(60 * 3)
                    .min(1)
                    .max(60 * 24 * 7)
                    .description(
                        '空闲触发间隔（分钟）：当超过该时间未收到新消息时，将自动触发一次回复请求。'
                    ),
                idleTriggerRetryStyle: Schema.union([
                    Schema.const('exponential').description(
                        '指数退避（默认）：首次触发后若仍无新消息，按“空闲触发间隔（分钟）”作为起始值每次乘 2（例如 2→4→8→16）。'
                    ),
                    Schema.const('fixed').description(
                        '固定重试：始终按“空闲触发间隔（分钟）”重复触发。'
                    )
                ])
                    .default('exponential')
                    .description('空闲触发重试风格'),
                enableIdleTriggerMaxInterval: Schema.boolean()
                    .default(true)
                    .description('是否启用空闲触发最大间隔限制'),
                idleTriggerMaxIntervalMinutes: Schema.number()
                    .default(60 * 24)
                    .min(1)
                    .max(60 * 24 * 30)
                    .description(
                        '空闲触发最大间隔（分钟）：仅在“指数退避”下生效，关闭上面的限制时不封顶。'
                    ),
                enableIdleTriggerJitter: Schema.boolean()
                    .default(true)
                    .description(
                        '是否启用空闲触发随机抖动：对固定重试与指数退避都生效，每轮会随机提前或延后 5%-10%。'
                    ),
                messageActivityScoreLowerLimit: Schema.number()
                    .default(0.85)
                    .min(0)
                    .max(1)
                    .role('slider')
                    .step(0.00001)
                    .description(
                        '消息活跃度分数的下限阈值。初始状态或长时间无人回复后，会使用此阈值判断是否响应。'
                    ),
                messageActivityScoreUpperLimit: Schema.number()
                    .default(0.85)
                    .min(0)
                    .max(1)
                    .role('slider')
                    .step(0.00001)
                    .description(
                        '消息活跃度分数的上限阈值。每次响应后，判断阈值会向此值靠拢。若下限 < 上限（如 0.1 → 0.9），则会越聊越少；若下限 > 上限（如 0.9 → 0.2），则会越聊越多。十分钟内无人回复时，会自动回退到下限。'
                    ),
                toolCalling: Schema.boolean()
                    .description(
                        '是否启用工具调用功能（可在[**这里**](https://cooksleep.github.io/newapi-special-test)测试你的API工具调用等能力是否正常）'
                    )
                    .default(true),
                image: Schema.boolean()
                    .description(
                        '是否允许输入图片（注意表情包也会输入，目前仅支持原生多模态的模型）'
                    )
                    .default(false),

                imageInputMaxCount: Schema.number()
                    .default(9)
                    .min(1)
                    .max(15)
                    .description('最大的输入图片数量'),

                imageInputMaxSize: Schema.number()
                    .default(1024 * 1024 * 1)
                    .min(1024 * 1024 * 1)
                    .max(1024 * 1024 * 20)
                    .description('最大的输入图片大小（KB）'),
                coolDownTime: Schema.number()
                    .default(0)
                    .min(0)
                    .max(60 * 24 * 24)
                    .description(
                        '冷却发言时间（秒）：当上一条消息发送完成后的 n 秒内发出的请求将被丢弃。'
                    ),

                typingTime: Schema.number()
                    .default(200)
                    .min(100)
                    .role('slider')
                    .max(1700)
                    .description('模拟打字时的间隔（毫秒）'),
                largeTextSize: Schema.number()
                    .default(100)
                    .min(100)
                    .max(1000)
                    .description('大文本消息的判断阈值（每段分句的字符数）'),

                largeTextTypingTime: Schema.number()
                    .default(10)
                    .min(10)
                    .max(1500)
                    .description('大文本消息的模拟打字间隔（毫秒）'),

                muteTime: Schema.number()
                    .default(1000 * 60)
                    .min(1000)
                    .max(1000 * 60 * 10 * 10)
                    .description('闭嘴时的禁言时间（毫秒）'),

                modelCompletionCount: Schema.number()
                    .default(1)
                    .min(0)
                    .max(6)
                    .description('模型历史消息轮数，为 0 不发送之前的历史轮次'),
                preset: Schema.dynamic('character-preset')
                    .description('使用的伪装预设')
                    .default('CHARACTER')
            })
        )
            .role('table')
            .description('分群配置，会覆盖上面的默认配置（键填写群号）')
    }).description('分群配置')
]) as unknown as Schema<Config>

export const name = 'chatluna-character'
