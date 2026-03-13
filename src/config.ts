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
    idleTrigger: {
        enableLongWaitTrigger: boolean
        idleTriggerIntervalMinutes: number
        idleTriggerRetryStyle: 'exponential' | 'fixed'
        idleTriggerMaxIntervalMinutes: number
        idleTriggerFixedMaxRetries: number
        enableIdleTriggerJitter: boolean
    }
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

    enableLongWaitTrigger?: boolean
    idleTriggerIntervalMinutes?: number
    idleTriggerRetryStyle?: 'exponential' | 'fixed'
    idleTriggerMaxIntervalMinutes?: number
    idleTriggerFixedMaxRetries?: number
    enableIdleTriggerJitter?: boolean

    disableChatLuna: boolean
    whiteListDisableChatLunaPrivate: string[]
    whiteListDisableChatLuna: string[]

    splitVoice: boolean
    splitSentence: boolean
    isAt?: boolean

    enableMessageId: boolean
}

const commonModelConfig = Schema.object({
    maxMessages: Schema.number()
        .description('存储在内存里的最大消息数量')
        .default(40)
        .min(3)
        .role('slider')
        .max(100),
    modelCompletionCount: Schema.number()
        .default(1)
        .min(0)
        .max(6)
        .description('模型历史消息轮数，为 0 不发送之前的历史轮次'),
    maxTokens: Schema.number()
        .default(20000)
        .min(1024)
        .max(20000)
        .description('使用聊天的最大 token 数'),
    enableMessageId: Schema.boolean()
        .description('向模型暴露平台消息 ID，以允许发送引用消息。')
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
        )
}).description('上下文').collapse()

const commonChatBehaviorConfig = Schema.object({
    splitVoice: Schema.boolean().description('是否分段发送语音').default(false),
    isNickname: Schema.boolean()
        .description('允许 bot 配置中的昵称引发回复')
        .default(true),
    isNickNameWithContent: Schema.boolean()
        .description('是否允许在对话内容里任意匹配 bot 配置中的昵称来触发对话')
        .default(false)
}).description('行为').collapse()

const groupChatBehaviorConfig = Schema.object({
    ...commonChatBehaviorConfig.dict,
    isAt: Schema.boolean().description('是否启用@').default(false)
}).description('行为').collapse()

const commonMuteConfig = Schema.object({
    isForceMute: Schema.boolean()
        .description(
            '是否启用关键词触发闭嘴（当收到包含关键词的消息时会沉默，一段时间内无法被任何方式触发，关键词需要在预设文件里配置）'
        )
        .default(false),
    muteTime: Schema.number()
        .default(60)
        .min(1)
        .max(1000 * 60 * 10)
        .description('关键词触发闭嘴时的沉默时长（秒）')
}).description('闭嘴').collapse()

const commonModelFeatureConfig = Schema.object({
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
        )
}).description('工具与多模态').collapse()

const privateIdleConfig = Schema.object({
    enableLongWaitTrigger: Schema.boolean()
        .default(false)
        .description('是否启用空闲触发'),
    idleTriggerIntervalMinutes: Schema.number()
        .default(60 * 8)
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
    idleTriggerMaxIntervalMinutes: Schema.number()
        .default(60 * 24)
        .min(1)
        .max(60 * 24 * 30)
        .description(
            '指数退避空闲触发最大间隔（分钟）：达到该间隔后，不再继续空闲重试。'
        ),
    idleTriggerFixedMaxRetries: Schema.number()
        .default(3)
        .min(0)
        .max(20)
        .description('固定重试空闲触发最大连续重试次数（首次空闲触发后的重试次数）'),
    enableIdleTriggerJitter: Schema.boolean()
        .default(true)
        .description(
            '是否启用空闲触发随机抖动：对固定重试与指数退避都生效，每轮会随机提前或延后 5%-10%。'
        )
})

const groupIdleConfig = Schema.object({
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
    idleTriggerMaxIntervalMinutes: Schema.number()
        .default(60 * 24)
        .min(1)
        .max(60 * 24 * 30)
        .description(
            '指数退避空闲触发最大间隔（分钟）：达到该间隔后，不再继续空闲重试。'
        ),
    idleTriggerFixedMaxRetries: Schema.number()
        .default(3)
        .min(0)
        .max(20)
        .description('固定重试空闲触发最大连续重试次数（首次空闲触发后的重试次数）'),
    enableIdleTriggerJitter: Schema.boolean()
        .default(true)
        .description(
            '是否启用空闲触发随机抖动：对固定重试与指数退避都生效，每轮会随机提前或延后 5%-10%。'
        )
})

const commonConversationConfig = Schema.object({
    coolDownTime: Schema.number()
        .default(0)
        .min(0)
        .max(60 * 24 * 24)
        .description(
            '冷却发言时间（秒）：当上一条消息发送完成后的 n 秒内触发的新请求会暂存，冷却结束后再发送，模拟发完消息后看新消息时的延迟。'
        ),
    typingTime: Schema.number()
        .default(200)
        .min(100)
        .role('slider')
        .max(1700)
        .description('模拟打字时每个字的“输入”时长（毫秒）'),
    largeTextSize: Schema.number()
        .default(100)
        .min(100)
        .max(1000)
        .description('大文本消息的判断阈值（每个消息的字符数）'),
    largeTextTypingTime: Schema.number()
        .default(10)
        .min(10)
        .max(1500)
        .description('发送大文本消息模拟打字时，每个字的“输入”时长（毫秒）')
}).description('延迟与模拟打字').collapse()

const globalPrivateConfigObject = Schema.intersect([
    Schema.object({
        preset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('CHARACTER'),
        model: Schema.dynamic('model').default('').description('使用的模型'),
        messageInterval: Schema.number()
            .default(0)
            .min(0)
            .role('slider')
            .max(10000)
            .description(
                '随机发送消息的间隔（条）：私聊需要更低，若设为 0 间隔，则每条消息都会触发请求。'
            )
    }).description('基础').collapse(),
    commonModelFeatureConfig,
    commonModelConfig,
    commonChatBehaviorConfig,
    Schema.object({
        idleTrigger: privateIdleConfig.default({} as Config['idleTrigger'])
    }).description('空闲触发').collapse(),
    commonMuteConfig,
    commonConversationConfig
]) as Schema<PrivateConfig>

const privateConfigObject = Schema.intersect([
    Schema.object({
        preset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('CHARACTER'),
        remark: Schema.string().default('').description('备注（无作用）'),
        model: Schema.dynamic('model')
            .default('无')
            .description('使用的模型（选择“无”后将使用全局私聊配置）'),
        messageInterval: Schema.number()
            .default(0)
            .min(0)
            .role('slider')
            .max(10000)
            .description(
                '随机发送消息的间隔（条）：私聊需要更低，若设为 0 间隔，则每条消息都会触发请求。'
            )
    }).description('基础').collapse(),
    commonModelFeatureConfig,
    commonModelConfig,
    commonChatBehaviorConfig,
    Schema.object({
        idleTrigger: privateIdleConfig.default({} as Config['idleTrigger'])
    }).description('空闲触发').collapse(),
    commonMuteConfig,
    commonConversationConfig
]) as Schema<PrivateConfig>

const globalGroupConfigObject = Schema.intersect([
    Schema.object({
        preset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('CHARACTER'),
        model: Schema.dynamic('model').default('').description('使用的模型'),
        messageInterval: Schema.number()
            .default(20)
            .min(0)
            .role('slider')
            .max(10000)
            .description(
                '随机发送消息的间隔（条）：群越活跃，这个值就越需要调高，否则将一直被高强度触发。'
            )
    }).description('基础').collapse(),
    commonModelFeatureConfig,
    commonModelConfig,
    groupChatBehaviorConfig,
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
    }).description('活跃度').collapse(),
    Schema.object({
        idleTrigger: groupIdleConfig.default({} as Config['idleTrigger'])
    }).description('空闲触发').collapse(),
    commonMuteConfig,
    commonConversationConfig
]) as Schema<GuildConfig>

const guildConfigObject = Schema.intersect([
    Schema.object({
        preset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('CHARACTER'),
        remark: Schema.string().default('').description('备注（无作用）'),
        model: Schema.dynamic('model')
            .default('无')
            .description('使用的模型（选择“无”后将使用全局群聊配置）'),
        messageInterval: Schema.number()
            .default(20)
            .min(0)
            .role('slider')
            .max(10000)
            .description(
                '随机发送消息的间隔（条）：群越活跃，这个值就越需要调高，否则将一直被高强度触发。'
            )
    }).description('基础').collapse(),
    commonModelFeatureConfig,
    commonModelConfig,
    groupChatBehaviorConfig,
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
    }).description('活跃度').collapse(),
    Schema.object({
        idleTrigger: groupIdleConfig.default({} as Config['idleTrigger'])
    }).description('空闲触发').collapse(),
    commonMuteConfig,
    commonConversationConfig
]) as Schema<GuildConfig>

export const Config = Schema.intersect([
    Schema.object({
        privateWhitelistMode: Schema.boolean()
            .default(true)
            .description(
                '是否启用私聊白名单模式：开启后，将仅允许 applyPrivate 中的用户使用伪装插件私聊功能'
            ),
        applyPrivate: Schema.array(Schema.string())
            .description('应用到的私聊')
            .collapse(),
        groupWhitelistMode: Schema.boolean()
            .default(true)
            .description(
                '是否启用群聊白名单模式：开启后，将仅允许 applyGroup 中的群组使用伪装插件群聊功能'
            ),
        applyGroup: Schema.array(Schema.string())
            .description('应用到的群组')
            .collapse(),
        disableChatLuna: Schema.boolean()
            .default(true)
            .description('在使用此插件的会话里，是否禁用 ChatLuna 主功能'),
        whiteListDisableChatLunaPrivate: Schema.array(
            Schema.string()
        ).description('启用此插件时，不禁用 ChatLuna 主功能的私聊用户 ID 列表'),
        whiteListDisableChatLuna: Schema.array(Schema.string()).description(
            '启用此插件时，不禁用 ChatLuna 主功能的群聊 ID 列表'
        ),
    }).description('基础配置').collapse(),

    Schema.object({
        globalPrivateConfig: globalPrivateConfigObject.default(
            {} as PrivateConfig
        )
    }).description('全局私聊配置').collapse(),

    Schema.object({
        globalGroupConfig: globalGroupConfigObject.default({} as GuildConfig)
    }).description('全局群聊').collapse(),

    Schema.object({
        privateConfigs: Schema.dict(privateConfigObject)
            .role('table')
            .description(
                '分私聊配置，会覆盖上面的默认配置（键填写私聊用户 ID）'
            )
    }).description('分私聊').collapse(),

    Schema.object({
        configs: Schema.dict(guildConfigObject)
            .role('table')
            .description('分群聊配置，会覆盖上面的默认配置（键填写群号）')
    }).description('分群聊').collapse()
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

    if (config.globalPrivateConfig.muteTime === 60 && config.muteTime) {
        config.globalPrivateConfig.muteTime =
            config.muteTime > 1000
                ? Math.max(Math.floor(config.muteTime / 1000), 1)
                : config.muteTime
        modified = true
    }

    if (config.globalGroupConfig.muteTime === 60 && config.muteTime) {
        config.globalGroupConfig.muteTime =
            config.muteTime > 1000
                ? Math.max(Math.floor(config.muteTime / 1000), 1)
                : config.muteTime
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

    if (
        config.globalPrivateConfig.idleTrigger.enableLongWaitTrigger === false &&
        config.enableLongWaitTrigger
    ) {
        config.globalPrivateConfig.idleTrigger.enableLongWaitTrigger =
            config.enableLongWaitTrigger
        modified = true
    }

    if (
        config.globalGroupConfig.idleTrigger.enableLongWaitTrigger === false &&
        config.enableLongWaitTrigger
    ) {
        config.globalGroupConfig.idleTrigger.enableLongWaitTrigger =
            config.enableLongWaitTrigger
        modified = true
    }

    if (
        config.globalPrivateConfig.idleTrigger.idleTriggerIntervalMinutes ===
            60 * 8 &&
        config.idleTriggerIntervalMinutes
    ) {
        config.globalPrivateConfig.idleTrigger.idleTriggerIntervalMinutes =
            config.idleTriggerIntervalMinutes
        modified = true
    }

    if (
        config.globalGroupConfig.idleTrigger.idleTriggerIntervalMinutes ===
            60 * 3 &&
        config.idleTriggerIntervalMinutes
    ) {
        config.globalGroupConfig.idleTrigger.idleTriggerIntervalMinutes =
            config.idleTriggerIntervalMinutes
        modified = true
    }

    if (
        config.idleTriggerRetryStyle != null &&
        config.globalPrivateConfig.idleTrigger.idleTriggerRetryStyle ===
            'exponential'
    ) {
        config.globalPrivateConfig.idleTrigger.idleTriggerRetryStyle =
            config.idleTriggerRetryStyle
        modified = true
    }

    if (
        config.idleTriggerRetryStyle != null &&
        config.globalGroupConfig.idleTrigger.idleTriggerRetryStyle ===
            'exponential'
    ) {
        config.globalGroupConfig.idleTrigger.idleTriggerRetryStyle =
            config.idleTriggerRetryStyle
        modified = true
    }

    if (
        config.globalPrivateConfig.idleTrigger.idleTriggerMaxIntervalMinutes ===
            60 * 24 &&
        config.idleTriggerMaxIntervalMinutes
    ) {
        config.globalPrivateConfig.idleTrigger.idleTriggerMaxIntervalMinutes =
            config.idleTriggerMaxIntervalMinutes
        modified = true
    }

    if (
        config.globalGroupConfig.idleTrigger.idleTriggerMaxIntervalMinutes ===
            60 * 24 &&
        config.idleTriggerMaxIntervalMinutes
    ) {
        config.globalGroupConfig.idleTrigger.idleTriggerMaxIntervalMinutes =
            config.idleTriggerMaxIntervalMinutes
        modified = true
    }

    if (
        config.globalPrivateConfig.idleTrigger.enableIdleTriggerJitter === true &&
        config.enableIdleTriggerJitter === false
    ) {
        config.globalPrivateConfig.idleTrigger.enableIdleTriggerJitter =
            config.enableIdleTriggerJitter
        modified = true
    }

    if (
        config.globalGroupConfig.idleTrigger.enableIdleTriggerJitter === true &&
        config.enableIdleTriggerJitter === false
    ) {
        config.globalGroupConfig.idleTrigger.enableIdleTriggerJitter =
            config.enableIdleTriggerJitter
        modified = true
    }

    if (
        config.idleTriggerFixedMaxRetries != null &&
        config.globalPrivateConfig.idleTrigger.idleTriggerFixedMaxRetries === 3
    ) {
        config.globalPrivateConfig.idleTrigger.idleTriggerFixedMaxRetries =
            config.idleTriggerFixedMaxRetries
        modified = true
    }

    if (
        config.idleTriggerFixedMaxRetries != null &&
        config.globalGroupConfig.idleTrigger.idleTriggerFixedMaxRetries === 3
    ) {
        config.globalGroupConfig.idleTrigger.idleTriggerFixedMaxRetries =
            config.idleTriggerFixedMaxRetries
        modified = true
    }

    if (
        config.globalPrivateConfig.splitVoice === false &&
        config.splitVoice != null
    ) {
        config.globalPrivateConfig.splitVoice = config.splitVoice
        modified = true
    }

    if (
        config.globalGroupConfig.splitVoice === false &&
        config.splitVoice != null
    ) {
        config.globalGroupConfig.splitVoice = config.splitVoice
        modified = true
    }

    if (
        config.globalPrivateConfig.isNickname === true &&
        config.isNickname != null
    ) {
        config.globalPrivateConfig.isNickname = config.isNickname
        modified = true
    }

    if (
        config.globalGroupConfig.isNickname === true &&
        config.isNickname != null
    ) {
        config.globalGroupConfig.isNickname = config.isNickname
        modified = true
    }

    if (
        config.globalPrivateConfig.isNickNameWithContent === false &&
        config.isNickNameWithContent != null
    ) {
        config.globalPrivateConfig.isNickNameWithContent =
            config.isNickNameWithContent
        modified = true
    }

    if (
        config.globalGroupConfig.isNickNameWithContent === false &&
        config.isNickNameWithContent != null
    ) {
        config.globalGroupConfig.isNickNameWithContent =
            config.isNickNameWithContent
        modified = true
    }

    if (
        config.globalPrivateConfig.statusPersistence === true &&
        config.statusPersistence != null
    ) {
        config.globalPrivateConfig.statusPersistence = config.statusPersistence
        modified = true
    }

    if (
        config.globalGroupConfig.statusPersistence === true &&
        config.statusPersistence != null
    ) {
        config.globalGroupConfig.statusPersistence = config.statusPersistence
        modified = true
    }

    if (
        config.globalPrivateConfig.historyPull === true &&
        config.historyPull != null
    ) {
        config.globalPrivateConfig.historyPull = config.historyPull
        modified = true
    }

    if (
        config.globalGroupConfig.historyPull === true &&
        config.historyPull != null
    ) {
        config.globalGroupConfig.historyPull = config.historyPull
        modified = true
    }

    if (
        config.globalPrivateConfig.modelCompletionCount === 1 &&
        config.modelCompletionCount != null
    ) {
        config.globalPrivateConfig.modelCompletionCount =
            config.modelCompletionCount
        modified = true
    }

    if (
        config.globalGroupConfig.modelCompletionCount === 1 &&
        config.modelCompletionCount != null
    ) {
        config.globalGroupConfig.modelCompletionCount =
            config.modelCompletionCount
        modified = true
    }

    if (
        config.globalPrivateConfig.enableMessageId === true &&
        config.enableMessageId != null
    ) {
        config.globalPrivateConfig.enableMessageId = config.enableMessageId
        modified = true
    }

    if (
        config.globalGroupConfig.enableMessageId === true &&
        config.enableMessageId != null
    ) {
        config.globalGroupConfig.enableMessageId = config.enableMessageId
        modified = true
    }

    if (
        config.globalGroupConfig.isAt === false &&
        config.isAt != null
    ) {
        config.globalGroupConfig.isAt = config.isAt
        modified = true
    }

    if (
        config.globalGroupConfig.messageInterval === 20 &&
        config.messageInterval != null
    ) {
        config.globalGroupConfig.messageInterval = config.messageInterval
        modified = true
    }

    if (
        config.globalPrivateConfig.messageInterval === 0 &&
        config.messageInterval != null
    ) {
        config.globalPrivateConfig.messageInterval = config.messageInterval
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

    const legacy = config as Config & {
        defaultPreset?: string
        model?: string
        maxMessages?: number
        maxTokens?: number
        image?: boolean
        imageInputMaxCount?: number
        imageInputMaxSize?: number
        multimodalFileInputMaxSize?: number
        toolCalling?: boolean
        isForceMute?: boolean
        coolDownTime?: number
        muteTime?: number
        enableLongWaitTrigger?: boolean
        idleTriggerIntervalMinutes?: number
        idleTriggerRetryStyle?: 'exponential' | 'fixed'
        idleTriggerMaxIntervalMinutes?: number
        idleTriggerFixedMaxRetries?: number
        enableIdleTriggerJitter?: boolean
        messageInterval?: number
        splitVoice?: boolean
        isNickname?: boolean
        isNickNameWithContent?: boolean
        statusPersistence?: boolean
        historyPull?: boolean
        modelCompletionCount?: number
        isAt?: boolean
        enableMessageId?: boolean
        messageActivityScoreLowerLimit?: number
        messageActivityScoreUpperLimit?: number
    }

    if (legacy.defaultPreset != null) {
        delete legacy.defaultPreset
        modified = true
    }

    if (legacy.model != null) {
        delete legacy.model
        modified = true
    }

    if (legacy.maxMessages != null) {
        delete legacy.maxMessages
        modified = true
    }

    if (legacy.maxTokens != null) {
        delete legacy.maxTokens
        modified = true
    }

    if (legacy.image != null) {
        delete legacy.image
        modified = true
    }

    if (legacy.imageInputMaxCount != null) {
        delete legacy.imageInputMaxCount
        modified = true
    }

    if (legacy.imageInputMaxSize != null) {
        delete legacy.imageInputMaxSize
        modified = true
    }

    if (legacy.multimodalFileInputMaxSize != null) {
        delete legacy.multimodalFileInputMaxSize
        modified = true
    }

    if (legacy.toolCalling != null) {
        delete legacy.toolCalling
        modified = true
    }

    if (legacy.isForceMute != null) {
        delete legacy.isForceMute
        modified = true
    }

    if (legacy.coolDownTime != null) {
        delete legacy.coolDownTime
        modified = true
    }

    if (legacy.muteTime != null) {
        delete legacy.muteTime
        modified = true
    }

    if (legacy.enableLongWaitTrigger != null) {
        delete legacy.enableLongWaitTrigger
        modified = true
    }

    if (legacy.idleTriggerIntervalMinutes != null) {
        delete legacy.idleTriggerIntervalMinutes
        modified = true
    }

    if (legacy.idleTriggerRetryStyle != null) {
        delete legacy.idleTriggerRetryStyle
        modified = true
    }

    if (legacy.idleTriggerMaxIntervalMinutes != null) {
        delete legacy.idleTriggerMaxIntervalMinutes
        modified = true
    }

    if (legacy.idleTriggerFixedMaxRetries != null) {
        delete legacy.idleTriggerFixedMaxRetries
        modified = true
    }

    if (legacy.enableIdleTriggerJitter != null) {
        delete legacy.enableIdleTriggerJitter
        modified = true
    }

    if (legacy.messageInterval != null) {
        delete legacy.messageInterval
        modified = true
    }

    if (legacy.splitVoice != null) {
        delete legacy.splitVoice
        modified = true
    }

    if (legacy.isNickname != null) {
        delete legacy.isNickname
        modified = true
    }

    if (legacy.isNickNameWithContent != null) {
        delete legacy.isNickNameWithContent
        modified = true
    }

    if (legacy.statusPersistence != null) {
        delete legacy.statusPersistence
        modified = true
    }

    if (legacy.historyPull != null) {
        delete legacy.historyPull
        modified = true
    }

    if (legacy.modelCompletionCount != null) {
        delete legacy.modelCompletionCount
        modified = true
    }

    if (legacy.isAt != null) {
        delete legacy.isAt
        modified = true
    }

    if (legacy.enableMessageId != null) {
        delete legacy.enableMessageId
        modified = true
    }

    if (legacy.messageActivityScoreLowerLimit != null) {
        delete legacy.messageActivityScoreLowerLimit
        modified = true
    }

    if (legacy.messageActivityScoreUpperLimit != null) {
        delete legacy.messageActivityScoreUpperLimit
        modified = true
    }

    if (config.privateModelOverride != null) {
        delete config.privateModelOverride
        modified = true
    }

    if (config.modelOverride != null) {
        delete config.modelOverride
        modified = true
    }

    return modified
}
