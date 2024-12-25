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
            (messageCount > maxMessages ||
                appel ||
                info.lastActivityScore >= config.messageActivityScore ||
                (config.isNickname &&
                    currentPreset.nick_name.some((value) =>
                        message.content.startsWith(value)
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

function calculateIntervalScore(interval: number): number {
    return Math.max(0, 1 - interval / MAX_INTERVAL)
}

function calculateActivityScore(
    timestamps: number[],
    lastResponseTime?: number,
    maxMessages?: number
): ActivityScore {
    const now = Date.now()

    // If less than 2 messages, return minimum score
    if (timestamps.length < 2) {
        return { score: 0, timestamp: now }
    }

    // Calculate message accumulation factor (0 to 1)
    const accumulationFactor = Math.min(timestamps.length / maxMessages, 1)

    // Calculate intervals and weights as before
    const intervals: number[] = []
    const weights: number[] = []
    let totalWeight = 0

    for (let i = 1; i < timestamps.length; i++) {
        const interval = timestamps[i] - timestamps[i - 1]
        intervals.push(interval)
        const weight = Math.pow(DECAY_FACTOR, timestamps.length - i)
        weights.push(weight)
        totalWeight += weight
    }

    let weightedIntervalScore = 0
    for (let i = 0; i < intervals.length; i++) {
        const normalizedWeight = weights[i] / totalWeight
        weightedIntervalScore +=
            calculateIntervalScore(intervals[i]) * normalizedWeight
    }

    const recentInterval = now - timestamps[timestamps.length - 1]
    const recentScore = calculateIntervalScore(recentInterval)
    const randomFactor = Math.random() * BASE_PROBABILITY

    // Apply accumulation factor to the score calculation
    let score =
        (recentScore * RECENT_WEIGHT +
            weightedIntervalScore * HISTORY_WEIGHT +
            randomFactor * RANDOM_WEIGHT) *
        accumulationFactor

    if (lastResponseTime) {
        const timeSinceLastResponse = now - lastResponseTime
        if (timeSinceLastResponse < MIN_COOLDOWN_TIME) {
            score *= 0.1
        }
    }

    score = Math.max(0, Math.min(1, score))

    return { score, timestamp: now }
}

// Adjust constants for better balance
const WINDOW_SIZE = 100
const MAX_INTERVAL = Time.minute * 5
const MIN_COOLDOWN_TIME = Time.second * 10 // Increased cooldown time
const BASE_PROBABILITY = 0.02
const RECENT_WEIGHT = 0.3 // Slightly reduced
const HISTORY_WEIGHT = 0.15 // Increased
const RANDOM_WEIGHT = 0.04
const DECAY_FACTOR = 0.95
const COOLDOWN_PENALTY = 0.3
