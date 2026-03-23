/* eslint-disable max-len */
import { Schema } from 'koishi'

import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { GuildConfig, PrivateConfig } from './types'

export interface Config extends ChatLunaPlugin.Config {
    globalPrivateConfig: PrivateConfig
    globalGroupConfig: GuildConfig

    model: string
    maxMessages?: number

    enableFixedIntervalTrigger: boolean
    messageInterval: number
    messageWaitTime?: number
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
    enableActivityScoreTrigger: boolean

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
})
    .description('上下文')
    .collapse()

const commonChatBehaviorConfig = Schema.object({
    splitVoice: Schema.boolean().description('是否分段发送语音').default(false),
    isNickname: Schema.boolean()
        .description('允许 bot 配置中的昵称引发回复')
        .default(true),
    isNickNameWithContent: Schema.boolean()
        .description('是否允许在对话内容里任意匹配 bot 配置中的昵称来触发对话')
        .default(false)
})
    .description('行为')
    .collapse()

const groupChatBehaviorConfig = Schema.object({
    ...commonChatBehaviorConfig.dict,
    isAt: Schema.boolean().description('是否启用@').default(false)
})
    .description('行为')
    .collapse()

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
})
    .description('闭嘴')
    .collapse()

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
})
    .description('工具与多模态')
    .collapse()

const privateIdleConfig = Schema.object({
    enableLongWaitTrigger: Schema.boolean()
        .default(false)
        .description('是否启用空闲触发'),
    idleTriggerIntervalMinutes: Schema.number()
        .default(60 * 8)
        .min(1)
        .max(60 * 24 * 7)
        .description(
            '空闲触发间隔（分钟）：当超过该时间未收到新消息时，将自动触发一次回复请求'
        ),
    idleTriggerRetryStyle: Schema.union([
        Schema.const('exponential').description(
            '指数退避（默认）（首次触发后若仍无新消息，按“空闲触发间隔（分钟）”作为起始值每次乘 2，例如 2→4→8→16）'
        ),
        Schema.const('fixed').description(
            '固定重试（始终按“空闲触发间隔”重复触发）'
        )
    ])
        .default('exponential')
        .description('空闲触发重试风格'),
    idleTriggerMaxIntervalMinutes: Schema.number()
        .default(60 * 24)
        .min(1)
        .max(60 * 24 * 30)
        .description(
            '指数退避空闲触发最大间隔（分钟）：达到该间隔后，不再继续空闲重试'
        ),
    idleTriggerFixedMaxRetries: Schema.number()
        .default(3)
        .min(0)
        .max(20)
        .description(
            '固定重试空闲触发最大连续重试次数（首次空闲触发后的重试次数）'
        ),
    enableIdleTriggerJitter: Schema.boolean()
        .default(true)
        .description(
            '是否启用空闲触发随机抖动（对固定重试与指数退避都生效，每轮会随机提前或延后 5%-10%，提高随机性）'
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
            '空闲触发间隔（分钟）：当超过该时间未收到新消息时，将自动触发一次回复请求'
        ),
    idleTriggerRetryStyle: Schema.union([
        Schema.const('exponential').description(
            '指数退避（默认）（首次触发后若仍无新消息，按“空闲触发间隔（分钟）”作为起始值每次乘 2，例如 2→4→8→16）'
        ),
        Schema.const('fixed').description(
            '固定重试（始终按“空闲触发间隔”重复触发）'
        )
    ])
        .default('exponential')
        .description('空闲触发重试风格'),
    idleTriggerMaxIntervalMinutes: Schema.number()
        .default(60 * 24)
        .min(1)
        .max(60 * 24 * 30)
        .description(
            '指数退避空闲触发最大间隔（分钟）：达到该间隔后，不再继续空闲重试'
        ),
    idleTriggerFixedMaxRetries: Schema.number()
        .default(3)
        .min(0)
        .max(20)
        .description(
            '固定重试空闲触发最大连续重试次数（首次空闲触发后的重试次数）'
        ),
    enableIdleTriggerJitter: Schema.boolean()
        .default(true)
        .description(
            '是否启用空闲触发随机抖动（对固定重试与指数退避都生效，每轮会随机提前或延后 5%-10%，提高随机性）'
        )
})

const commonConversationConfig = Schema.object({
    coolDownTime: Schema.number()
        .default(0)
        .min(0)
        .max(60 * 24 * 24)
        .description(
            '冷却发言时间（秒）：当上一条消息发送完成后的 n 秒内触发的新请求会暂存，冷却结束后再发送，模拟发完消息后看新消息时的延迟'
        ),
    typingTime: Schema.number()
        .default(200)
        .min(100)
        .role('slider')
        .max(1700)
        .description(
            '模拟打字时每个字的“输入”时长（毫秒）：模拟发消息时的输入时间'
        ),
    largeTextSize: Schema.number()
        .default(100)
        .min(100)
        .max(1000)
        .description('大文本消息的判断阈值（每个消息的字符数）'),
    largeTextTypingTime: Schema.number()
        .default(10)
        .min(10)
        .role('slider')
        .max(1500)
        .description(
            '发送大文本消息模拟打字时，每个字的“输入”时长（毫秒）：缩小以减少长文本发送时的等待时长'
        )
})
    .description('延迟与模拟打字')
    .collapse()

const globalPrivateConfigObject = Schema.intersect([
    Schema.object({
        preset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('CHARACTER'),
        model: Schema.dynamic('model').default('').description('使用的模型'),
        enableFixedIntervalTrigger: Schema.boolean()
            .default(true)
            .description(
                '是否启用固定间隔触发功能（开启后将在收到指定条数的消息后自动触发一次）'
            ),
        messageInterval: Schema.number()
            .default(0)
            .min(0)
            .role('slider')
            .max(10000)
            .description(
                '固定间隔触发的消息间隔（条）：累计到该条数后自动触发一次；私聊设为 0 时将改为使用“发言等待时长（秒）”进行聚合触发'
            ),
        messageWaitTime: Schema.number()
            .default(10)
            .min(0)
            .max(300)
            .description(
                '发言等待时长（秒）：仅在固定间隔触发开启且消息间隔为 0 时生效，当收到一条消息后，连续 N 秒没有新消息才触发一次，用于应对用户需要一次性发送多条消息的场景'
            )
    })
        .description('基础')
        .collapse(),
    commonModelFeatureConfig,
    commonModelConfig,
    commonChatBehaviorConfig,
    Schema.object({
        idleTrigger: privateIdleConfig.default({} as Config['idleTrigger'])
    })
        .description('空闲触发')
        .collapse(),
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
        enableFixedIntervalTrigger: Schema.boolean()
            .default(true)
            .description(
                '是否启用固定间隔触发功能（开启后将在收到指定条数的消息后自动触发一次）'
            ),
        messageInterval: Schema.number()
            .default(0)
            .min(0)
            .role('slider')
            .max(10000)
            .description(
                '固定间隔触发的消息间隔（条）：累计到该条数后自动触发一次；私聊设为 0 时将改为使用“发言等待时长（秒）”进行聚合触发'
            ),
        messageWaitTime: Schema.number()
            .default(10)
            .min(0)
            .max(300)
            .description(
                '发言等待时长（秒）：仅在固定间隔触发开启且消息间隔为 0 时生效，当收到一条消息后，连续 N 秒没有新消息才触发一次，用于应对用户需要一次性发送多条消息的场景'
            )
    })
        .description('基础')
        .collapse(),
    commonModelFeatureConfig,
    commonModelConfig,
    commonChatBehaviorConfig,
    Schema.object({
        idleTrigger: privateIdleConfig.default({} as Config['idleTrigger'])
    })
        .description('空闲触发')
        .collapse(),
    commonMuteConfig,
    commonConversationConfig
]) as Schema<PrivateConfig>

const globalGroupConfigObject = Schema.intersect([
    Schema.object({
        preset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('CHARACTER'),
        model: Schema.dynamic('model').default('').description('使用的模型'),
        enableFixedIntervalTrigger: Schema.boolean()
            .default(true)
            .description(
                '是否启用固定间隔触发功能（开启后将在收到指定条数的消息后自动触发一次）'
            ),
        messageInterval: Schema.number()
            .default(20)
            .min(0)
            .role('slider')
            .max(10000)
            .description(
                '固定间隔触发的消息间隔（条）：累计到该条数后自动触发一次；设为 0 时每一条消息都会触发请求'
            )
    })
        .description('基础')
        .collapse(),
    commonModelFeatureConfig,
    commonModelConfig,
    groupChatBehaviorConfig,
    Schema.object({
        enableActivityScoreTrigger: Schema.boolean()
            .default(true)
            .description(
                '是否启用活跃度触发（开启后会统计近期消息节奏，并在分数达到阈值时自动触发）'
            ),
        messageActivityScoreLowerLimit: Schema.number()
            .default(0.85)
            .min(0)
            .max(1)
            .role('slider')
            .step(0.00001)
            .description(
                '活跃度触发阈值下限：初始状态或长时间未收到消息后，阈值会回到该值；活跃度分数达到该阈值时可触发一次回复。'
            ),
        messageActivityScoreUpperLimit: Schema.number()
            .default(0.85)
            .min(0)
            .max(1)
            .role('slider')
            .step(0.00001)
            .description(
                '活跃度触发阈值上限：每次触发后，阈值会向该值靠拢。上限＞下限时，上限越高，连续触发越难（越聊越少）；上限＜下限时，上限越低，连续触发越容易（越聊越多）；上下限相等时，阈值保持不变。'
            )
    })
        .description('活跃度')
        .collapse(),
    Schema.object({
        idleTrigger: groupIdleConfig.default({} as Config['idleTrigger'])
    })
        .description('空闲触发')
        .collapse(),
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
        enableFixedIntervalTrigger: Schema.boolean()
            .default(true)
            .description(
                '是否启用固定间隔触发功能（开启后将在收到指定条数的消息后自动触发一次）'
            ),
        messageInterval: Schema.number()
            .default(20)
            .min(0)
            .role('slider')
            .max(10000)
            .description(
                '固定间隔触发的消息间隔（条）：累计到该条数后自动触发一次；设为 0 时每一条消息都会触发请求'
            )
    })
        .description('基础')
        .collapse(),
    commonModelFeatureConfig,
    commonModelConfig,
    groupChatBehaviorConfig,
    Schema.object({
        enableActivityScoreTrigger: Schema.boolean()
            .default(true)
            .description(
                '是否启用活跃度触发（开启后会统计近期消息节奏，并在分数达到阈值时自动触发）'
            ),
        messageActivityScoreLowerLimit: Schema.number()
            .default(0.85)
            .min(0)
            .max(1)
            .role('slider')
            .step(0.00001)
            .description(
                '活跃度触发阈值下限：初始状态或长时间未收到消息后，阈值会回到该值；活跃度分数达到该阈值时可触发一次回复。'
            ),
        messageActivityScoreUpperLimit: Schema.number()
            .default(0.85)
            .min(0)
            .max(1)
            .role('slider')
            .step(0.00001)
            .description(
                '活跃度触发阈值上限：每次触发后，阈值会向该值靠拢。上限＞下限时，上限越高，连续触发越难（越聊越少）；上限＜下限时，上限越低，连续触发越容易（越聊越多）；上下限相等时，阈值保持不变。'
            )
    })
        .description('活跃度')
        .collapse(),
    Schema.object({
        idleTrigger: groupIdleConfig.default({} as Config['idleTrigger'])
    })
        .description('空闲触发')
        .collapse(),
    commonMuteConfig,
    commonConversationConfig
]) as Schema<GuildConfig>

export const Config = Schema.intersect([
    Schema.object({
        privateWhitelistMode: Schema.boolean()
            .default(true)
            .description(
                '是否启用私聊白名单模式（开启后，将仅允许 applyPrivate 中的用户使用伪装插件私聊功能）'
            ),
        applyPrivate: Schema.array(Schema.string())
            .description('应用到的私聊')
            .collapse(),
        groupWhitelistMode: Schema.boolean()
            .default(true)
            .description(
                '是否启用群聊白名单模式（开启后，将仅允许 applyGroup 中的群组使用伪装插件群聊功能）'
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
        )
    })
        .description('基础配置')
        .collapse(),

    Schema.object({
        globalPrivateConfig: globalPrivateConfigObject.default(
            {} as PrivateConfig
        )
    })
        .description('全局私聊配置')
        .collapse(),

    Schema.object({
        globalGroupConfig: globalGroupConfigObject.default({} as GuildConfig)
    })
        .description('全局群聊配置')
        .collapse(),

    Schema.object({
        privateConfigs: Schema.dict(privateConfigObject)
            .role('table')
            .description(
                '分私聊配置，会覆盖上面的默认配置（键填写私聊用户 ID）'
            )
    })
        .description('分私聊配置')
        .collapse(),

    Schema.object({
        configs: Schema.dict(guildConfigObject)
            .role('table')
            .description('分群聊配置，会覆盖上面的默认配置（键填写群号）')
    })
        .description('分群聊配置')
        .collapse()
]) as unknown as Schema<Config>

type LegacyConfig = Config & {
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

type CommonMigration = {
    key:
        | 'maxMessages'
        | 'maxTokens'
        | 'image'
        | 'imageInputMaxCount'
        | 'imageInputMaxSize'
        | 'multimodalFileInputMaxSize'
        | 'toolCalling'
        | 'isForceMute'
        | 'coolDownTime'
        | 'splitVoice'
        | 'isNickname'
        | 'isNickNameWithContent'
        | 'statusPersistence'
        | 'historyPull'
        | 'modelCompletionCount'
        | 'enableMessageId'
    privateDefault: number | boolean
    groupDefault: number | boolean
    onlyFalse?: boolean
}

type IdleMigration = {
    key:
        | 'enableLongWaitTrigger'
        | 'idleTriggerIntervalMinutes'
        | 'idleTriggerRetryStyle'
        | 'idleTriggerMaxIntervalMinutes'
        | 'idleTriggerFixedMaxRetries'
        | 'enableIdleTriggerJitter'
    privateDefault: number | boolean | 'exponential' | 'fixed'
    groupDefault: number | boolean | 'exponential' | 'fixed'
    onlyFalse?: boolean
}

type GroupMigration = {
    key:
        | 'messageActivityScoreLowerLimit'
        | 'messageActivityScoreUpperLimit'
        | 'isAt'
    defaultValue: number | boolean
}

type CommonValue = number | boolean
type IdleValue = number | boolean | 'exponential' | 'fixed'

const commonMigrations: CommonMigration[] = [
    { key: 'maxMessages', privateDefault: 40, groupDefault: 40 },
    { key: 'maxTokens', privateDefault: 20000, groupDefault: 20000 },
    { key: 'image', privateDefault: false, groupDefault: false },
    { key: 'imageInputMaxCount', privateDefault: 9, groupDefault: 9 },
    { key: 'imageInputMaxSize', privateDefault: 20, groupDefault: 20 },
    {
        key: 'multimodalFileInputMaxSize',
        privateDefault: 20,
        groupDefault: 20
    },
    {
        key: 'toolCalling',
        privateDefault: true,
        groupDefault: true,
        onlyFalse: true
    },
    {
        key: 'isForceMute',
        privateDefault: true,
        groupDefault: true,
        onlyFalse: true
    },
    { key: 'coolDownTime', privateDefault: 0, groupDefault: 0 },
    { key: 'splitVoice', privateDefault: false, groupDefault: false },
    { key: 'isNickname', privateDefault: true, groupDefault: true },
    {
        key: 'isNickNameWithContent',
        privateDefault: false,
        groupDefault: false
    },
    {
        key: 'statusPersistence',
        privateDefault: true,
        groupDefault: true
    },
    { key: 'historyPull', privateDefault: true, groupDefault: true },
    { key: 'modelCompletionCount', privateDefault: 1, groupDefault: 1 },
    { key: 'enableMessageId', privateDefault: true, groupDefault: true }
]

const idleMigrations: IdleMigration[] = [
    {
        key: 'enableLongWaitTrigger',
        privateDefault: false,
        groupDefault: false
    },
    {
        key: 'idleTriggerIntervalMinutes',
        privateDefault: 60 * 8,
        groupDefault: 60 * 3
    },
    {
        key: 'idleTriggerRetryStyle',
        privateDefault: 'exponential',
        groupDefault: 'exponential'
    },
    {
        key: 'idleTriggerMaxIntervalMinutes',
        privateDefault: 60 * 24,
        groupDefault: 60 * 24
    },
    {
        key: 'idleTriggerFixedMaxRetries',
        privateDefault: 3,
        groupDefault: 3
    },
    {
        key: 'enableIdleTriggerJitter',
        privateDefault: true,
        groupDefault: true,
        onlyFalse: true
    }
]

const groupMigrations: GroupMigration[] = [
    { key: 'messageActivityScoreLowerLimit', defaultValue: 0.85 },
    { key: 'messageActivityScoreUpperLimit', defaultValue: 0.85 },
    { key: 'isAt', defaultValue: false }
]

const legacyKeys = [
    'defaultPreset',
    'model',
    'maxMessages',
    'maxTokens',
    'image',
    'imageInputMaxCount',
    'imageInputMaxSize',
    'multimodalFileInputMaxSize',
    'toolCalling',
    'isForceMute',
    'coolDownTime',
    'muteTime',
    'enableLongWaitTrigger',
    'idleTriggerIntervalMinutes',
    'idleTriggerRetryStyle',
    'idleTriggerMaxIntervalMinutes',
    'idleTriggerFixedMaxRetries',
    'enableIdleTriggerJitter',
    'messageInterval',
    'splitVoice',
    'isNickname',
    'isNickNameWithContent',
    'statusPersistence',
    'historyPull',
    'modelCompletionCount',
    'isAt',
    'enableMessageId',
    'messageActivityScoreLowerLimit',
    'messageActivityScoreUpperLimit'
] as const

export function migrateConfig(config: Config): boolean {
    let modified = false

    const legacy = config as LegacyConfig
    const privateGlobal = config.globalPrivateConfig as unknown as Record<
        CommonMigration['key'],
        CommonValue
    >
    const groupGlobal = config.globalGroupConfig as unknown as Record<
        CommonMigration['key'] | GroupMigration['key'],
        CommonValue
    >
    const privateIdle = config.globalPrivateConfig
        .idleTrigger as unknown as Record<IdleMigration['key'], IdleValue>
    const groupIdle = config.globalGroupConfig.idleTrigger as unknown as Record<
        IdleMigration['key'],
        IdleValue
    >

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

    for (const userId in config.privateConfigs) {
        if (
            !config.privateConfigs[userId].model ||
            config.privateConfigs[userId].model === '无'
        ) {
            config.privateConfigs[userId].model =
                config.globalPrivateConfig.model
            modified = true
        }
    }

    for (const groupId in config.configs) {
        if (
            !config.configs[groupId].model ||
            config.configs[groupId].model === '无'
        ) {
            config.configs[groupId].model = config.globalGroupConfig.model
            modified = true
        }
    }

    // 旧版大多数公共字段都在顶层，这里只在新结构仍是迁移基准值时覆盖。
    for (const item of commonMigrations) {
        const value = legacy[item.key] as CommonValue | undefined

        if (value == null || (item.onlyFalse && value !== false)) {
            continue
        }

        if (privateGlobal[item.key] === item.privateDefault) {
            privateGlobal[item.key] = value
            modified = true
        }

        if (groupGlobal[item.key] === item.groupDefault) {
            groupGlobal[item.key] = value
            modified = true
        }
    }

    // 老版本的 muteTime 可能是毫秒，这里保持原来的秒级兼容逻辑。
    if (config.globalPrivateConfig.muteTime === 60 && legacy.muteTime != null) {
        config.globalPrivateConfig.muteTime =
            legacy.muteTime > 1000
                ? Math.max(Math.floor(legacy.muteTime / 1000), 1)
                : legacy.muteTime
        modified = true
    }

    if (config.globalGroupConfig.muteTime === 60 && legacy.muteTime != null) {
        config.globalGroupConfig.muteTime =
            legacy.muteTime > 1000
                ? Math.max(Math.floor(legacy.muteTime / 1000), 1)
                : legacy.muteTime
        modified = true
    }

    for (const item of groupMigrations) {
        const value = legacy[item.key] as CommonValue | undefined

        if (value != null && groupGlobal[item.key] === item.defaultValue) {
            groupGlobal[item.key] = value
            modified = true
        }
    }

    for (const item of idleMigrations) {
        const value = legacy[item.key] as IdleValue | undefined

        if (value == null || (item.onlyFalse && value !== false)) {
            continue
        }

        if (privateIdle[item.key] === item.privateDefault) {
            privateIdle[item.key] = value
            modified = true
        }

        if (groupIdle[item.key] === item.groupDefault) {
            groupIdle[item.key] = value
            modified = true
        }
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

    // messageInterval 的默认值在私聊和群聊里不同，单独处理最直观。
    if (legacy.messageInterval != null) {
        if (config.globalPrivateConfig.messageInterval === 0) {
            config.globalPrivateConfig.messageInterval = legacy.messageInterval
            modified = true
        }

        if (config.globalGroupConfig.messageInterval === 20) {
            config.globalGroupConfig.messageInterval = legacy.messageInterval
            modified = true
        }

        delete legacy.messageInterval
        modified = true
    }

    // 迁移完成后清理旧字段，避免下次启动再次命中旧逻辑。
    for (const key of legacyKeys) {
        if (legacy[key] != null) {
            delete legacy[key]
            modified = true
        }
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
