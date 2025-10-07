import { Context, Time } from 'koishi'
import { Config } from '..'
import { ActivityScore, GroupInfo, PresetTemplate } from '../types'

export const groupInfos: Record<string, GroupInfo> = {}

const WINDOW_SIZE = 100
const RECENT_WINDOW = Time.minute * 10
const SHORT_BURST_WINDOW = Time.minute * 1
const MIN_COOLDOWN_TIME = Time.second * 15
const COOLDOWN_PENALTY = 0.3
// const LOW_FREQUENCY_THRESHOLD = 2
const HIGH_FREQUENCY_THRESHOLD = 15
const BURST_MESSAGE_COUNT = 8

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

        let { messageCount } = info

        logger.debug(
            `messageCount: ${messageCount}, activityScore: ${activity.score.toFixed(3)}. content: ${JSON.stringify(
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
            messageCount > copyOfConfig.messageInterval ||
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

        messageCount++
        info.messageCount = messageCount
        groupInfos[session.guildId] = info
        return false
    })
}

function calculateFrequencyScore(timestamps: number[]): number {
    const now = Date.now()
    const recentMessages = timestamps.filter((ts) => now - ts <= RECENT_WINDOW)

    if (recentMessages.length === 0) return 0

    const messagesPerMinute =
        (recentMessages.length / RECENT_WINDOW) * Time.minute
    const normalized =
        Math.log(messagesPerMinute + 1) / Math.log(HIGH_FREQUENCY_THRESHOLD + 1)

    return Math.min(normalized, 1.5)
}

function calculateAccelerationScore(timestamps: number[]): number {
    if (timestamps.length < 6) return 0

    const now = Date.now()
    const recentWindow = RECENT_WINDOW / 2
    const previousWindow = RECENT_WINDOW

    const recentCount = timestamps.filter(
        (ts) => now - ts <= recentWindow
    ).length
    const recentRate = recentCount / recentWindow

    const previousCount = timestamps.filter(
        (ts) => now - ts <= previousWindow && now - ts > recentWindow
    ).length
    const previousRate = previousCount / recentWindow

    const acceleration = recentRate - previousRate
    const normalized = acceleration * Time.minute * 10

    return Math.max(-0.5, Math.min(normalized, 1))
}

function calculateBurstScore(timestamps: number[]): number {
    const now = Date.now()
    const burstMessages = timestamps.filter(
        (ts) => now - ts <= SHORT_BURST_WINDOW
    )

    if (burstMessages.length < 3) return 0

    const burstIntensity = (burstMessages.length - 2) / BURST_MESSAGE_COUNT

    return Math.min(burstIntensity, 1.2)
}

function calculateFreshnessFactor(timestamps: number[]): number {
    if (timestamps.length === 0) return 0

    const now = Date.now()
    const lastMessageTime = timestamps[timestamps.length - 1]
    const timeSinceLastMessage = now - lastMessageTime

    return Math.exp(-timeSinceLastMessage / (Time.minute * 3))
}

function calculateActivityScore(
    timestamps: number[],
    lastResponseTime?: number,
    maxMessages?: number
): ActivityScore {
    const now = Date.now()

    if (timestamps.length < 2) {
        return { score: 0, timestamp: now }
    }

    const frequencyScore = calculateFrequencyScore(timestamps)
    const accelerationScore = calculateAccelerationScore(timestamps)
    const burstScore = calculateBurstScore(timestamps)
    const freshnessFactor = calculateFreshnessFactor(timestamps)

    const rawScore =
        frequencyScore + Math.max(0, accelerationScore) + burstScore
    let score = rawScore * freshnessFactor

    if (timestamps.length >= 8) {
        const sustainedBonus = Math.min(
            Math.log(timestamps.length) / Math.log(maxMessages || 50),
            0.3
        )
        score += sustainedBonus
    }

    if (lastResponseTime) {
        const timeSinceLastResponse = now - lastResponseTime
        if (timeSinceLastResponse < MIN_COOLDOWN_TIME) {
            const cooldownFactor = timeSinceLastResponse / MIN_COOLDOWN_TIME
            score *= cooldownFactor
        }
    }

    score = Math.max(0, Math.min(score / 2, 1))

    return { score, timestamp: now }
}
