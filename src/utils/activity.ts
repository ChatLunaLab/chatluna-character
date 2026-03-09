import { Time } from 'koishi'
import { ActivityScore } from '../types'

export const WINDOW_SIZE = 90
const RECENT_WINDOW = Time.second * 90
const SHORT_BURST_WINDOW = Time.second * 30
const INSTANT_WINDOW = Time.second * 20
export const MIN_COOLDOWN_TIME = Time.second * 6
export const COOLDOWN_PENALTY = 0.8
export const THRESHOLD_RESET_TIME = Time.minute * 10
export const SCHEDULER_TICK = Time.second
export const STALE_GROUP_INFO_TTL = Time.hour * 24

const MIN_RECENT_MESSAGES = 6
const SUSTAINED_RATE_THRESHOLD = 10
const SUSTAINED_RATE_SCALE = 3
const INSTANT_RATE_THRESHOLD = 9
const INSTANT_RATE_SCALE = 2
const BURST_RATE_THRESHOLD = 12
const BURST_RATE_SCALE = 4
const SMOOTHING_WINDOW = Time.second * 8
const FRESHNESS_HALF_LIFE = Time.second * 60

export function logistic(value: number): number {
    if (!Number.isFinite(value)) {
        return 0
    }

    if (value > 10) return 0.99995
    if (value < -10) return 0.00005

    return 1 / (1 + Math.exp(-value))
}

export function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max))
}

export function calculateFreshnessFactor(timestamps: number[]): number {
    if (timestamps.length === 0) return 0

    const now = Date.now()
    const lastMessageTime = timestamps[timestamps.length - 1]
    const timeSinceLastMessage = now - lastMessageTime

    return Math.exp(-timeSinceLastMessage / FRESHNESS_HALF_LIFE)
}

export function smoothScore(
    targetScore: number,
    previousScore: number,
    previousTimestamp: number,
    now: number
): number {
    if (!previousTimestamp || previousTimestamp <= 0) {
        return targetScore
    }

    const elapsed = now - previousTimestamp
    if (elapsed <= 0) {
        return targetScore
    }

    const smoothingFactor = 1 - Math.exp(-elapsed / SMOOTHING_WINDOW)
    return (
        previousScore +
        (targetScore - previousScore) * clamp(smoothingFactor, 0, 1)
    )
}

export function calculateActivityScore(
    timestamps: number[],
    lastResponseTime: number | undefined,
    maxMessages: number | undefined,
    previousScore: number,
    previousTimestamp: number
): ActivityScore {
    const now = Date.now()

    if (timestamps.length < 2) {
        const score = smoothScore(0, previousScore, previousTimestamp, now)
        return { score, timestamp: now }
    }

    const recentMessages = timestamps.filter((ts) => now - ts <= RECENT_WINDOW)
    if (recentMessages.length < MIN_RECENT_MESSAGES) {
        const score = smoothScore(0, previousScore, previousTimestamp, now)
        return { score, timestamp: now }
    }

    const sustainedRate = (recentMessages.length / RECENT_WINDOW) * Time.minute

    const instantMessages = timestamps.filter(
        (ts) => now - ts <= INSTANT_WINDOW
    )
    const instantRate = (instantMessages.length / INSTANT_WINDOW) * Time.minute

    const burstMessages = timestamps.filter(
        (ts) => now - ts <= SHORT_BURST_WINDOW
    )
    const burstRate = (burstMessages.length / SHORT_BURST_WINDOW) * Time.minute

    const sustainedComponent = logistic(
        (sustainedRate - SUSTAINED_RATE_THRESHOLD) / SUSTAINED_RATE_SCALE
    )

    const instantComponent = logistic(
        (instantRate - INSTANT_RATE_THRESHOLD) / INSTANT_RATE_SCALE
    )

    let combinedScore = sustainedComponent * 0.65 + instantComponent * 0.35

    if (burstRate > BURST_RATE_THRESHOLD) {
        const burstContribution = clamp(
            (burstRate - BURST_RATE_THRESHOLD) / BURST_RATE_SCALE,
            0,
            1
        )
        combinedScore += burstContribution * 0.25
    }

    if (instantMessages.length >= 6) {
        const startIndex = Math.max(
            timestamps.length - instantMessages.length,
            0
        )
        const relevant = timestamps.slice(startIndex)
        const intervals: number[] = []
        for (let i = 1; i < relevant.length; i++) {
            intervals.push(relevant[i] - relevant[i - 1])
        }

        if (intervals.length > 0) {
            const averageGap =
                intervals.reduce((total, value) => total + value, 0) /
                intervals.length
            const intervalComponent = logistic(
                (Time.second * 12 - averageGap) / (Time.second * 6)
            )
            combinedScore *= 0.7 + 0.3 * intervalComponent
        }
    }

    const freshnessFactor = calculateFreshnessFactor(timestamps)
    combinedScore *= 0.55 + 0.45 * freshnessFactor

    if (maxMessages && recentMessages.length >= maxMessages * 0.9) {
        combinedScore += 0.08
    }

    if (lastResponseTime) {
        const timeSinceLastResponse = now - lastResponseTime
        if (timeSinceLastResponse < MIN_COOLDOWN_TIME) {
            const cooldownRatio = timeSinceLastResponse / MIN_COOLDOWN_TIME
            combinedScore *= cooldownRatio * cooldownRatio
        }
    }

    const smoothedScore = smoothScore(
        clamp(combinedScore, 0, 1),
        previousScore,
        previousTimestamp,
        now
    )

    return { score: clamp(smoothedScore, 0, 1), timestamp: now }
}
