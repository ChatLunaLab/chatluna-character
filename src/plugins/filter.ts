import { Context, Time } from 'koishi'
import { Config } from '..'
import { ActivityScore, GroupInfo, PresetTemplate } from '../types'

export const groupInfos: Record<string, GroupInfo> = {}

// 活跃度算法常量配置
const WINDOW_SIZE = 100 // 时间戳窗口最大容量
const RECENT_WINDOW = Time.minute * 15 // 频率统计窗口：15分钟
const SHORT_BURST_WINDOW = Time.minute * 3 // 爆发检测窗口：3分钟
const MIN_COOLDOWN_TIME = Time.second * 15 // 最小冷却时间：15秒
const COOLDOWN_PENALTY = 0.3 // 响应后降低活跃度的惩罚值
const LOW_FREQUENCY_THRESHOLD = 3 // 低频阈值：3条/分钟以下不计分
const HIGH_FREQUENCY_THRESHOLD = 40 // 高频阈值：40条/分钟
const BURST_MESSAGE_COUNT = 80 // 爆发基准：3分钟内80条消息

// 加权系数（重新引入权重控制）
const FREQUENCY_WEIGHT = 0.35 // 频率权重
const ACCELERATION_WEIGHT = 0.25 // 加速度权重
const BURST_WEIGHT = 0.25 // 爆发权重
const FRESHNESS_WEIGHT = 0.15 // 新鲜度因子基础影响

export async function apply(ctx: Context, config: Config) {
    const service = ctx.chatluna_character
    const preset = service.preset
    const logger = service.logger

    const globalPreset = await preset.getPreset(config.defaultPreset)
    const presetPool: Record<string, PresetTemplate> = {}

    service.addFilter((session, message) => {
        const guildId = session.guildId
        const now = Date.now()

        const info = groupInfos[guildId] || {
            messageCount: 0,
            messageTimestamps: [],
            lastActivityScore: 0,
            lastScoreUpdate: now,
            lastResponseTime: 0
        }

        // 更新消息时间戳
        info.messageTimestamps.push(now)
        if (info.messageTimestamps.length > WINDOW_SIZE) {
            info.messageTimestamps.shift()
        }

        // 计算新的活跃度分数，传入上次响应时间

        const currentGuildConfig = config.configs[guildId]
        let copyOfConfig = Object.assign({}, config)
        let currentPreset = globalPreset

        if (currentGuildConfig != null) {
            copyOfConfig = Object.assign({}, copyOfConfig, currentGuildConfig)
            currentPreset =
                presetPool[guildId] ??
                (() => {
                    const template = preset.getPresetForCache(
                        currentGuildConfig.preset
                    )
                    presetPool[guildId] = template
                    return template
                })()
        }

        const activity = calculateActivityScore(
            info.messageTimestamps,
            info.lastResponseTime,
            copyOfConfig.maxMessages
        )
        info.lastActivityScore = activity.score
        info.lastScoreUpdate = activity.timestamp

        logger.debug(
            `messageCount: ${info.messageCount}, activityScore: ${activity.score.toFixed(3)}. content: ${JSON.stringify(
                Object.assign({}, message, { images: undefined })
            )}`
        )

        if (
            copyOfConfig.disableChatLuna &&
            !copyOfConfig.whiteListDisableChatLuna.includes(guildId)
        ) {
            const selfId = session.bot.userId ?? session.bot.selfId ?? '0'
            const guildMessages = ctx.chatluna_character.getMessages(guildId)

            let maxRecentMessage = 0

            if (guildMessages == null || guildMessages.length === 0) {
                maxRecentMessage = 6
            }

            while (maxRecentMessage < 5) {
                const currentMessage =
                    guildMessages[guildMessages?.length - 1 - maxRecentMessage]

                if (currentMessage == null) {
                    return false
                }

                if (currentMessage.id === selfId) {
                    break
                }

                maxRecentMessage++
            }
        }

        let appel = session.stripped.appel
        const botId = session.bot.userId

        if (!appel) {
            // 从消息元素中检测是否有被艾特当前用户
            appel = session.elements.some(
                (element) =>
                    element.type === 'at' && element.attrs?.['id'] === botId
            )
        }

        if (!appel) {
            // 检测引用的消息是否为 bot 本身
            appel = session.quote?.user?.id === botId
        }

        // 在计算之前先检查是否需要禁言。
        if (
            copyOfConfig.isForceMute &&
            appel &&
            currentPreset.mute_keyword?.length > 0
        ) {
            const needMute = currentPreset.mute_keyword.some((value) =>
                message.content.includes(value)
            )

            if (needMute) {
                logger.debug(`mute content: ${message.content}`)
                service.mute(session, config.muteTime)
            }
        }

        const isMute = service.isMute(session)

        const shouldRespond =
            info.messageCount > copyOfConfig.messageInterval ||
            appel ||
            info.lastActivityScore > copyOfConfig.messageActivityScore ||
            (copyOfConfig.isNickname &&
                currentPreset.nick_name.some((value) =>
                    message.content.startsWith(value)
                )) ||
            (copyOfConfig.isNickNameWithContent &&
                currentPreset.nick_name.some((value) =>
                    message.content.includes(value)
                ))

        if (shouldRespond && !isMute) {
            info.messageCount = 0
            info.lastActivityScore = Math.max(
                0,
                info.lastActivityScore - COOLDOWN_PENALTY
            )
            info.lastResponseTime = now
            groupInfos[session.guildId] = info
            return true
        }

        info.messageCount++
        groupInfos[session.guildId] = info
        return false
    })
}

/**
 * 计算消息频率分数
 * 原理：统计近窗口内的消息密度，使用对数归一化
 * 返回：0-1，频率越高分数越高
 */
function calculateFrequencyScore(timestamps: number[]): number {
    const now = Date.now()
    // 筛选出窗口内的消息
    const recentMessages = timestamps.filter((ts) => now - ts <= RECENT_WINDOW)

    if (recentMessages.length < 3) return 0

    // 计算每分钟消息数
    const messagesPerMinute =
        (recentMessages.length / RECENT_WINDOW) * Time.minute

    // 低于低频阈值不计分
    if (messagesPerMinute < LOW_FREQUENCY_THRESHOLD) return 0

    // 使用对数函数，增长平缓但有区分度
    const normalized =
        Math.log(messagesPerMinute - LOW_FREQUENCY_THRESHOLD + 1) /
        Math.log(HIGH_FREQUENCY_THRESHOLD + 1)

    return Math.min(normalized, 1)
}

/**
 * 计算消息加速度分数
 * 原理：对比最近窗口和之前窗口的消息速率，检测增长趋势
 * 返回：-0.5 到 1，正值表示加速，负值表示减速
 */
function calculateAccelerationScore(timestamps: number[]): number {
    // 至少需要10条消息才开始计算加速度
    if (timestamps.length < 10) return 0

    const now = Date.now()
    const recentWindow = RECENT_WINDOW / 2 // 最近一半窗口（7.5分钟）
    const previousWindow = RECENT_WINDOW // 完整窗口（15分钟）

    // 最近窗口的消息速率
    const recentCount = timestamps.filter(
        (ts) => now - ts <= recentWindow
    ).length
    const recentRate = recentCount / recentWindow

    // 之前窗口的消息速率（排除最近窗口）
    const previousCount = timestamps.filter(
        (ts) => now - ts <= previousWindow && now - ts > recentWindow
    ).length
    const previousRate = previousCount / recentWindow

    // 速率差即为加速度
    const acceleration = recentRate - previousRate
    // 归一化
    const normalized = acceleration * Time.minute * 8

    return Math.max(-0.5, Math.min(normalized, 1))
}

/**
 * 计算消息爆发分数
 * 原理：统计短时间窗口内的消息密集度，捕捉突发活跃
 * 返回：0-1.2，短时间内消息越多分数越高（允许超过1）
 */
function calculateBurstScore(timestamps: number[]): number {
    const now = Date.now()
    // 短窗口内的消息
    const burstMessages = timestamps.filter(
        (ts) => now - ts <= SHORT_BURST_WINDOW
    )

    // 3分钟内至少30条消息才开始计分
    if (burstMessages.length < 30) return 0

    // 爆发强度：相对于基准值的比例
    const burstIntensity = (burstMessages.length - 29) / BURST_MESSAGE_COUNT

    return Math.min(burstIntensity, 1)
}

/**
 * 计算新鲜度因子
 * 原理：基于最后一条消息的时间，使用指数衰减函数
 * 返回：0-1，消息越新鲜因子越高，用于给整体分数加权
 */
function calculateFreshnessFactor(timestamps: number[]): number {
    if (timestamps.length === 0) return 0

    const now = Date.now()
    const lastMessageTime = timestamps[timestamps.length - 1]
    const timeSinceLastMessage = now - lastMessageTime

    // 指数衰减：4分钟半衰期
    return Math.exp(-timeSinceLastMessage / (Time.minute * 4))
}

/**
 * 计算群聊活跃度综合分数
 *
 * 算法设计：加权平衡，消息越活跃数值越高
 *
 * 核心指标：
 * 1. 频率分数(35%) - 15分钟内消息密度
 * 2. 加速度分数(25%) - 消息速率的增长趋势
 * 3. 爆发分数(25%) - 3分钟内的消息密集度
 * 4. 新鲜度因子(15%) - 基于最后消息时间的衰减
 *
 * 额外机制：
 * - 持续对话奖励：消息数量达到阈值后给予额外分数
 * - 冷却惩罚：Bot刚回复后短时间内降低触发概率
 *
 * @param timestamps 消息时间戳数组
 * @param lastResponseTime Bot上次响应时间
 * @param maxMessages 最大消息数配置
 * @returns 活跃度分数对象，score范围0-1
 */
function calculateActivityScore(
    timestamps: number[],
    lastResponseTime?: number,
    maxMessages?: number
): ActivityScore {
    const now = Date.now()

    if (timestamps.length < 2) {
        return { score: 0, timestamp: now }
    }

    // 1. 计算各项指标
    const frequencyScore = calculateFrequencyScore(timestamps)
    const accelerationScore = calculateAccelerationScore(timestamps)
    const burstScore = calculateBurstScore(timestamps)
    const freshnessFactor = calculateFreshnessFactor(timestamps)

    // 2. 加权累加（引入权重平衡各指标）
    // 只取正加速度，负加速度不惩罚
    let score =
        frequencyScore * FREQUENCY_WEIGHT +
        Math.max(0, accelerationScore) * ACCELERATION_WEIGHT +
        burstScore * BURST_WEIGHT

    // 3. 新鲜度因子的影响：混合模式（乘法+加法）
    // 乘法部分：让旧消息降权
    score = score * (0.7 + 0.3 * freshnessFactor)
    // 加法部分：新鲜度本身也贡献分数
    score += freshnessFactor * FRESHNESS_WEIGHT

    // 4. 持续对话奖励
    if (timestamps.length >= 40) {
        const sustainedBonus = Math.min(
            Math.log(timestamps.length) / Math.log(maxMessages || 100),
            0.15
        )
        score += sustainedBonus
    }

    // 5. 冷却机制：Bot刚回复后降低活跃度
    if (lastResponseTime) {
        const timeSinceLastResponse = now - lastResponseTime
        if (timeSinceLastResponse < MIN_COOLDOWN_TIME) {
            const cooldownFactor = timeSinceLastResponse / MIN_COOLDOWN_TIME
            score *= cooldownFactor
        }
    }

    // 6. 最终归一化到 0-1
    score = Math.max(0, Math.min(score, 1))

    return { score, timestamp: now }
}
