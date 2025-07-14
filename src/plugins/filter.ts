import { Context, Time } from 'koishi'
import { Config } from '..'
import { ActivityScore, GroupInfo, PresetTemplate } from '../types'

export const groupInfos: Record<string, GroupInfo> = {}

export async function apply(ctx: Context, config: Config) {
    const maxMessages = config.messageInterval

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
            messageSendProbability: 1,
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

        let { messageCount } = info

        logger.debug(
            `messageCount: ${messageCount}, activityScore: ${activity.score.toFixed(3)}. content: ${JSON.stringify(
                Object.assign({}, message, { images: undefined })
            )}`
        )

        // 检查是否在名单里面
        if (
            copyOfConfig.disableChatLuna &&
            copyOfConfig.whiteListDisableChatLuna.includes(guildId)
        ) {
            // check to last five message is send for bot

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
        // 保底必出
        if (
            (messageCount >
                (copyOfConfig.messageInterval ?? maxMessages ?? 0) ||
                appel ||
                info.lastActivityScore > copyOfConfig.messageActivityScore ||
                (copyOfConfig.isNickname &&
                    currentPreset.nick_name.some((value) =>
                        message.content.startsWith(value)
                    )) ||
                (copyOfConfig.isNickNameWithContent &&
                    currentPreset.nick_name.some((value) =>
                        message.content.includes(value)
                    ))) &&
            !isMute
        ) {
            info.messageCount = 0

            // 记录响应时间并降低活跃度
            info.lastActivityScore -= COOLDOWN_PENALTY

            info.lastResponseTime = now
            groupInfos[session.guildId] = info
            return true
        }

        messageCount++
        info.messageCount = messageCount
        groupInfos[session.guildId] = info
        return false
    })
}

// Improved constants for the activity scoring algorithm
const WINDOW_SIZE = 100
const MAX_INTERVAL = Time.minute * 5
const MIN_COOLDOWN_TIME = Time.second * 15
const BASE_PROBABILITY = 0.02
const COOLDOWN_PENALTY = 0.3
const ENTROPY_WEIGHT = 0.4
const POISSON_WEIGHT = 0.3
const RECENCY_WEIGHT = 0.25
const RANDOM_WEIGHT = 0.05
const LAMBDA_SCALE = 30000 // Scale factor for Poisson (30 seconds)
const ENTROPY_NORMALIZER = Math.log2(MAX_INTERVAL)

/**
 * Calculate Shannon entropy for a set of time intervals
 * Higher entropy indicates more unpredictable/chaotic messaging patterns
 */
function calculateShannonEntropy(intervals: number[]): number {
    if (intervals.length < 2) return 0

    // Bin the intervals into discrete categories
    const binSize = MAX_INTERVAL / 10
    const bins: Record<number, number> = {}

    // Count occurrences in each bin
    for (const interval of intervals) {
        const binIndex = Math.min(Math.floor(interval / binSize), 9)
        bins[binIndex] = (bins[binIndex] || 0) + 1
    }

    // Calculate entropy
    let entropy = 0
    const totalCount = intervals.length

    for (const binIndex in bins) {
        const probability = bins[binIndex] / totalCount
        entropy -= probability * Math.log2(probability)
    }

    // Normalize to 0-1 range
    return Math.min(entropy / ENTROPY_NORMALIZER, 1)
}

/**
 * Calculate Poisson probability for message rate
 * Measure how unusual the current messaging rate is compared to expectation
 */
function calculatePoissonActivity(intervals: number[]): number {
    if (intervals.length < 2) return 0

    // Calculate average interval (lambda for Poisson)
    const avgInterval =
        intervals.reduce((sum, interval) => sum + interval, 0) /
        intervals.length
    if (avgInterval === 0) return 1 // Avoid division by zero

    // Calculate recent message rate (last 3 messages or fewer)
    const recentIntervals = intervals.slice(-Math.min(3, intervals.length))
    const recentAvgInterval =
        recentIntervals.reduce((sum, interval) => sum + interval, 0) /
        recentIntervals.length

    // Normalize lambda for Poisson calculation
    const lambda = avgInterval / LAMBDA_SCALE
    const recentLambda = recentAvgInterval / LAMBDA_SCALE

    // Exponential function to compare recent activity to average
    // Higher activity (lower interval) creates higher score
    const activityRatio = lambda / (recentLambda + 0.001) // Avoid division by zero

    // Scale to a 0-1 range with diminishing returns for very high activity
    return Math.min(1 - Math.exp(-activityRatio), 1)
}

/**
 * Calculates recency score using exponential decay
 * More recent messages have higher weight
 */
function calculateRecencyScore(timestamps: number[]): number {
    const now = Date.now()
    if (timestamps.length === 0) return 0

    const lastMessageTime = timestamps[timestamps.length - 1]
    const timeSinceLastMessage = now - lastMessageTime

    // Exponential decay function
    return Math.exp(-timeSinceLastMessage / MAX_INTERVAL)
}

/**
 * Advanced activity score calculation combining information theory and statistical methods
 */
function calculateActivityScore(
    timestamps: number[],
    lastResponseTime?: number,
    maxMessages?: number
): ActivityScore {
    const now = Date.now()

    // If fewer than 2 messages, return minimum score
    if (timestamps.length < 2) {
        return { score: 0, timestamp: now }
    }

    // Calculate intervals between messages
    const intervals: number[] = []
    for (let i = 1; i < timestamps.length; i++) {
        intervals.push(timestamps[i] - timestamps[i - 1])
    }

    // Calculate accumulation factor - logarithmic growth provides diminishing returns as messages accumulate
    const accumulationFactor = maxMessages
        ? Math.min(
              Math.log(timestamps.length + 1) / Math.log(maxMessages + 1),
              1
          )
        : Math.min(timestamps.length / WINDOW_SIZE, 1)

    // Information entropy score - measures randomness/unpredictability in messaging patterns
    const entropyScore = calculateShannonEntropy(intervals)

    // Poisson-based activity score - measures how unusual current activity is compared to average
    const poissonScore = calculatePoissonActivity(intervals)

    // Recency score - higher weight for more recent messages
    const recencyScore = calculateRecencyScore(timestamps)

    // Add controlled randomness for natural variability
    const randomFactor = Math.random() * BASE_PROBABILITY

    // Weighted combination of all factors
    let score =
        (entropyScore * ENTROPY_WEIGHT +
            poissonScore * POISSON_WEIGHT +
            recencyScore * RECENCY_WEIGHT +
            randomFactor * RANDOM_WEIGHT) *
        accumulationFactor

    // Apply cooldown if bot recently responded
    if (lastResponseTime) {
        const timeSinceLastResponse = now - lastResponseTime
        if (timeSinceLastResponse < MIN_COOLDOWN_TIME) {
            // Exponential cooldown - stronger effect immediately after response
            const cooldownFactor = Math.exp(
                -MIN_COOLDOWN_TIME / timeSinceLastResponse
            )
            score *= cooldownFactor
        }
    }

    // Ensure score is within valid range
    score = Math.max(0, Math.min(1, score))

    return { score, timestamp: now }
}
