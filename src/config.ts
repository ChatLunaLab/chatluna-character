/* eslint-disable max-len */
import { Schema } from 'koishi'

import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { GuildConfig, PrivateConfig } from './types'

export interface Config extends ChatLunaPlugin.Config {
    globalPrivateConfig: PrivateConfig
    globalGroupConfig: GuildConfig

    model: string
    maxMessages?: number

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
    privateWhitelistMode: boolean
    applyPrivate: string[]
    groupWhitelistMode: boolean
    applyGroup: string[]
    searchKeywordExtraModel: string

    privateModelOverride?: { userId: string; model: string }[]
    modelOverride?: { groupId: string; model: string }[]
    privateConfigs: Record<string, PrivateConfig>
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
    multimodalFileInputMaxSize: number
    modelCompletionCount: number
    historyPull: boolean
    statusPersistence: boolean

    coolDownTime: number
    typingTime: number
    muteTime: number

    disableChatLuna: boolean
    whiteListDisableChatLunaPrivate: string[]
    whiteListDisableChatLuna: string[]

    splitVoice: boolean
    splitSentence: boolean
    isAt: boolean

    enableMessageId: boolean
}

const commonModelConfig = Schema.object({
    maxMessages: Schema.number()
        .description('存储在内存里的最大消息数量')
        .default(40)
        .min(3)
        .role('slider')
        .max(100),
    maxTokens: Schema.number()
        .default(20000)
        .min(1024)
        .max(20000)
        .description('使用聊天的最大 token 数'),
    enableMessageId: Schema.boolean()
        .description('向模型暴露平台消息 ID，以允许发送引用消息。')
        .default(true)
})

const globalPrivateModelConfig = Schema.object({
    model: Schema.dynamic('model').default('').description('使用的模型')
})

const globalGroupModelConfig = Schema.object({
    model: Schema.dynamic('model').default('').description('使用的模型')
})

const privateModelConfig = Schema.object({
    model: Schema.dynamic('model')
        .default('无')
        .description('使用的模型（选择“无”/恢复默认值后将使用全局私聊配置）')
})

const groupModelConfig = Schema.object({
    model: Schema.dynamic('model')
        .default('无')
        .description('使用的模型（选择“无”/恢复默认值后将使用全局群聊配置）')
})

const commonChatBehaviorConfig = Schema.object({
    isAt: Schema.boolean().description('是否启用@').default(false),
    splitVoice: Schema.boolean().description('是否分段发送语音').default(false),
    isNickname: Schema.boolean()
        .description('允许 bot 配置中的昵称引发回复')
        .default(true),
    isNickNameWithContent: Schema.boolean()
        .description('是否允许在对话内容里任意匹配 bot 配置中的昵称来触发对话')
        .default(false),
    isForceMute: Schema.boolean()
        .description(
            '是否启用强制禁言（当聊天涉及到关键词时则会禁言，关键词需要在预设文件里配置）'
        )
        .default(true),
    statusPersistence: Schema.boolean()
        .default(true)
        .description(
            '是否将状态变量持久化到数据库，使重启时可以恢复上次的状态'
        ),
    historyPull: Schema.boolean()
        .default(true)
        .description(
            '是否在缺失历史消息时自动从支持的 API ' +
                '（如 OneBot 及所有支持 getMessageList 的适配器）' +
                '获取历史消息，使重启插件时可以获取刚刚的上下文'
        ),
    enableLongWaitTrigger: Schema.boolean()
        .default(false)
        .description('是否启用空闲触发')
})

const commonIdleStrategyConfig = Schema.object({
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
        )
})

const commonConversationConfig = Schema.object({
    toolCalling: Schema.boolean()
        .description(
            '是否启用工具调用功能（可在[**这里**]' +
                '(https://cooksleep.github.io/newapi-special-test)' +
                '测试你的 API 工具调用等能力是否正常）'
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
        .default(20)
        .min(1)
        .max(100)
        .description('最大的输入图片大小（MB）'),
    multimodalFileInputMaxSize: Schema.number()
        .default(20)
        .min(1)
        .max(100)
        .description(
            '最大的多模态文件输入大小（MB）：过大可能造成服务器卡顿、回复延迟'
        ),
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
        .description('模型历史消息轮数，为 0 不发送之前的历史轮次')
})

const globalPrivateConfigObject = Schema.intersect([
    globalPrivateModelConfig,
    commonModelConfig,
    Schema.object({
        messageInterval: Schema.number()
            .default(5)
            .min(0)
            .role('slider')
            .max(10000)
            .description('随机发送消息的间隔。私聊默认更积极。')
    }),
    commonChatBehaviorConfig,
    Schema.object({
        idleTriggerIntervalMinutes: Schema.number()
            .default(60 * 8)
            .min(1)
            .max(60 * 24 * 7)
            .description(
                '空闲触发间隔（分钟）：当超过该时间未收到新消息时，将自动触发一次回复请求。'
            )
    }),
    commonIdleStrategyConfig,
    commonConversationConfig,
    Schema.object({
        preset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('CHARACTER')
    })
]) as Schema<PrivateConfig>

const privateConfigObject = Schema.intersect([
    Schema.object({
        remark: Schema.string().default('').description('备注（无作用）')
    }),
    privateModelConfig,
    commonModelConfig,
    Schema.object({
        messageInterval: Schema.number()
            .default(5)
            .min(0)
            .role('slider')
            .max(10000)
            .description('随机发送消息的间隔。私聊默认更积极。')
    }),
    commonChatBehaviorConfig,
    Schema.object({
        idleTriggerIntervalMinutes: Schema.number()
            .default(60 * 8)
            .min(1)
            .max(60 * 24 * 7)
            .description(
                '空闲触发间隔（分钟）：当超过该时间未收到新消息时，将自动触发一次回复请求。'
            )
    }),
    commonIdleStrategyConfig,
    commonConversationConfig,
    Schema.object({
        preset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('CHARACTER')
    })
]) as Schema<PrivateConfig>

const globalGroupConfigObject = Schema.intersect([
    globalGroupModelConfig,
    commonModelConfig,
    Schema.object({
        messageInterval: Schema.number()
            .default(20)
            .min(0)
            .role('slider')
            .max(10000)
            .description('随机发送消息的间隔。群越活跃，这个值就会越高。')
    }),
    commonChatBehaviorConfig,
    Schema.object({
        idleTriggerIntervalMinutes: Schema.number()
            .default(60 * 3)
            .min(1)
            .max(60 * 24 * 7)
            .description(
                '空闲触发间隔（分钟）：当超过该时间未收到新消息时，将自动触发一次回复请求。'
            )
    }),
    commonIdleStrategyConfig,
    Schema.object({
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
                '消息活跃度分数的上限阈值。每次响应后，判断阈值会向此值靠拢。' +
                    '若下限 < 上限（如 0.1 → 0.9），则会越聊越少；' +
                    '若下限 > 上限（如 0.9 → 0.2），则会越聊越多。' +
                    '十分钟内无人回复时，会自动回退到下限。'
            )
    }),
    commonConversationConfig,
    Schema.object({
        preset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('CHARACTER')
    })
]) as Schema<GuildConfig>

const guildConfigObject = Schema.intersect([
    Schema.object({
        remark: Schema.string().default('').description('备注（无作用）')
    }),
    groupModelConfig,
    commonModelConfig,
    Schema.object({
        messageInterval: Schema.number()
            .default(20)
            .min(0)
            .role('slider')
            .max(10000)
            .description('随机发送消息的间隔。群越活跃，这个值就会越高。')
    }),
    commonChatBehaviorConfig,
    Schema.object({
        idleTriggerIntervalMinutes: Schema.number()
            .default(60 * 3)
            .min(1)
            .max(60 * 24 * 7)
            .description(
                '空闲触发间隔（分钟）：当超过该时间未收到新消息时，将自动触发一次回复请求。'
            )
    }),
    commonIdleStrategyConfig,
    Schema.object({
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
                '消息活跃度分数的上限阈值。每次响应后，判断阈值会向此值靠拢。' +
                    '若下限 < 上限（如 0.1 → 0.9），则会越聊越少；' +
                    '若下限 > 上限（如 0.9 → 0.2），则会越聊越多。' +
                    '十分钟内无人回复时，会自动回退到下限。'
            )
    }),
    commonConversationConfig,
    Schema.object({
        preset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('CHARACTER')
    })
]) as Schema<GuildConfig>

export const Config = Schema.intersect([
    Schema.object({
        privateWhitelistMode: Schema.boolean()
            .default(true)
            .description(
                '是否启用私聊白名单模式：开启后，将仅允许 applyPrivate 中的用户使用伪装插件私聊功能'
            ),
        applyPrivate: Schema.array(Schema.string()).description('应用到的私聊'),
        groupWhitelistMode: Schema.boolean()
            .default(true)
            .description(
                '是否启用群聊白名单模式：开启后，将仅允许 applyGroup 中的群组使用伪装插件群聊功能'
            ),
        applyGroup: Schema.array(Schema.string()).description('应用到的群组'),
        disableChatLuna: Schema.boolean()
            .default(true)
            .description('在使用此插件的会话里，是否禁用 ChatLuna 主功能'),
        whiteListDisableChatLunaPrivate: Schema.array(
            Schema.string()
        ).description('启用此插件时，不禁用 ChatLuna 主功能的私聊用户 ID 列表'),
        whiteListDisableChatLuna: Schema.array(Schema.string()).description(
            '启用此插件时，不禁用 ChatLuna 主功能的群聊 ID 列表'
        )
    }).description('基础配置'),

    Schema.object({
        globalPrivateConfig: globalPrivateConfigObject.default(
            {} as PrivateConfig
        )
    }).description('全局私聊配置'),

    Schema.object({
        globalGroupConfig: globalGroupConfigObject.default({} as GuildConfig)
    }).description('全局群聊配置'),

    Schema.object({
        privateConfigs: Schema.dict(privateConfigObject)
            .role('table')
            .description(
                '分私聊配置，会覆盖上面的默认配置（键填写私聊用户 ID）'
            )
    }).description('分私聊配置'),

    Schema.object({
        configs: Schema.dict(guildConfigObject)
            .role('table')
            .description('分群配置，会覆盖上面的默认配置（键填写群号）')
    }).description('分群配置')
]) as unknown as Schema<Config>

export function migrateConfig(config: Config): boolean {
    let modified = false

    if (
        config.globalPrivateConfig.preset === 'CHARACTER' &&
        config.defaultPreset
    ) {
        config.globalPrivateConfig.preset = config.defaultPreset
        modified = true
    }

    if (
        config.globalGroupConfig.preset === 'CHARACTER' &&
        config.defaultPreset
    ) {
        config.globalGroupConfig.preset = config.defaultPreset
        modified = true
    }

    if (config.globalPrivateConfig.model === '' && config.model) {
        config.globalPrivateConfig.model = config.model
        modified = true
    }

    if (config.globalGroupConfig.model === '' && config.model) {
        config.globalGroupConfig.model = config.model
        modified = true
    }

    for (const userId of Object.keys(config.privateConfigs)) {
        if (
            !config.privateConfigs[userId].model ||
            config.privateConfigs[userId].model === '无'
        ) {
            config.privateConfigs[userId].model =
                config.globalPrivateConfig.model
            modified = true
        }
    }

    for (const groupId of Object.keys(config.configs)) {
        if (
            !config.configs[groupId].model ||
            config.configs[groupId].model === '无'
        ) {
            config.configs[groupId].model = config.globalGroupConfig.model
            modified = true
        }
    }

    if (config.globalPrivateConfig.maxMessages === 40 && config.maxMessages) {
        config.globalPrivateConfig.maxMessages = config.maxMessages
        modified = true
    }

    if (config.globalGroupConfig.maxMessages === 40 && config.maxMessages) {
        config.globalGroupConfig.maxMessages = config.maxMessages
        modified = true
    }

    if (config.globalPrivateConfig.maxTokens === 20000 && config.maxTokens) {
        config.globalPrivateConfig.maxTokens = config.maxTokens
        modified = true
    }

    if (config.globalGroupConfig.maxTokens === 20000 && config.maxTokens) {
        config.globalGroupConfig.maxTokens = config.maxTokens
        modified = true
    }

    if (config.globalPrivateConfig.image === false && config.image) {
        config.globalPrivateConfig.image = config.image
        modified = true
    }

    if (config.globalGroupConfig.image === false && config.image) {
        config.globalGroupConfig.image = config.image
        modified = true
    }

    if (
        config.globalPrivateConfig.imageInputMaxCount === 9 &&
        config.imageInputMaxCount
    ) {
        config.globalPrivateConfig.imageInputMaxCount =
            config.imageInputMaxCount
        modified = true
    }

    if (
        config.globalGroupConfig.imageInputMaxCount === 9 &&
        config.imageInputMaxCount
    ) {
        config.globalGroupConfig.imageInputMaxCount = config.imageInputMaxCount
        modified = true
    }

    if (
        config.globalPrivateConfig.imageInputMaxSize === 20 &&
        config.imageInputMaxSize
    ) {
        config.globalPrivateConfig.imageInputMaxSize = config.imageInputMaxSize
        modified = true
    }

    if (
        config.globalGroupConfig.imageInputMaxSize === 20 &&
        config.imageInputMaxSize
    ) {
        config.globalGroupConfig.imageInputMaxSize = config.imageInputMaxSize
        modified = true
    }

    if (
        config.globalPrivateConfig.multimodalFileInputMaxSize === 20 &&
        config.multimodalFileInputMaxSize
    ) {
        config.globalPrivateConfig.multimodalFileInputMaxSize =
            config.multimodalFileInputMaxSize
        modified = true
    }

    if (
        config.globalGroupConfig.multimodalFileInputMaxSize === 20 &&
        config.multimodalFileInputMaxSize
    ) {
        config.globalGroupConfig.multimodalFileInputMaxSize =
            config.multimodalFileInputMaxSize
        modified = true
    }

    if (
        config.globalPrivateConfig.toolCalling === true &&
        config.toolCalling === false
    ) {
        config.globalPrivateConfig.toolCalling = config.toolCalling
        modified = true
    }

    if (
        config.globalGroupConfig.toolCalling === true &&
        config.toolCalling === false
    ) {
        config.globalGroupConfig.toolCalling = config.toolCalling
        modified = true
    }

    if (
        config.globalPrivateConfig.isForceMute === true &&
        config.isForceMute === false
    ) {
        config.globalPrivateConfig.isForceMute = config.isForceMute
        modified = true
    }

    if (
        config.globalGroupConfig.isForceMute === true &&
        config.isForceMute === false
    ) {
        config.globalGroupConfig.isForceMute = config.isForceMute
        modified = true
    }

    if (config.globalPrivateConfig.coolDownTime === 0 && config.coolDownTime) {
        config.globalPrivateConfig.coolDownTime = config.coolDownTime
        modified = true
    }

    if (config.globalGroupConfig.coolDownTime === 0 && config.coolDownTime) {
        config.globalGroupConfig.coolDownTime = config.coolDownTime
        modified = true
    }

    if (config.globalPrivateConfig.muteTime === 1000 * 60 && config.muteTime) {
        config.globalPrivateConfig.muteTime = config.muteTime
        modified = true
    }

    if (config.globalGroupConfig.muteTime === 1000 * 60 && config.muteTime) {
        config.globalGroupConfig.muteTime = config.muteTime
        modified = true
    }

    if (
        config.globalGroupConfig.messageActivityScoreLowerLimit === 0.85 &&
        config.messageActivityScoreLowerLimit
    ) {
        config.globalGroupConfig.messageActivityScoreLowerLimit =
            config.messageActivityScoreLowerLimit
        modified = true
    }

    if (
        config.globalGroupConfig.messageActivityScoreUpperLimit === 0.85 &&
        config.messageActivityScoreUpperLimit
    ) {
        config.globalGroupConfig.messageActivityScoreUpperLimit =
            config.messageActivityScoreUpperLimit
        modified = true
    }

    if (config.privateModelOverride?.length > 0) {
        for (const override of config.privateModelOverride) {
            config.privateConfigs[override.userId] = Object.assign(
                {},
                config.privateConfigs[override.userId],
                {
                    model: override.model
                }
            )
            modified = true
        }
    }

    if (config.modelOverride?.length > 0) {
        for (const override of config.modelOverride) {
            config.configs[override.groupId] = Object.assign(
                {},
                config.configs[override.groupId],
                {
                    model: override.model
                }
            )
            modified = true
        }
    }

    return modified
}
