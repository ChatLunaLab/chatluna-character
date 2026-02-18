import { Context, Session, Time } from 'koishi'
import { Config } from '..'
import {
    ActivityScore,
    GroupInfo,
    NextReplyPredicate,
    PendingNextReply,
    PendingNextReplyConditionGroup,
    PendingWakeUpReply,
    PresetTemplate
} from '../types'

export const groupInfos: Record<string, GroupInfo> = {}

// 活跃度算法常量配置
const WINDOW_SIZE = 90 // 时间戳窗口最大容量
const RECENT_WINDOW = Time.second * 90 // 频率统计窗口：1.5分钟
const SHORT_BURST_WINDOW = Time.second * 30 // 爆发检测窗口：30秒
const INSTANT_WINDOW = Time.second * 20 // 短周期窗口，用于检测瞬时活跃
const MIN_COOLDOWN_TIME = Time.second * 6 // 最小冷却时间：6秒
const COOLDOWN_PENALTY = 0.8 // 响应后降低活跃度的惩罚值
const THRESHOLD_RESET_TIME = Time.minute * 10 // 十分钟无人回复时，重置活跃度阈值
const SCHEDULER_TICK = Time.second

const MIN_RECENT_MESSAGES = 6 // 进入活跃度统计的最小消息数
const SUSTAINED_RATE_THRESHOLD = 10 // 持续活跃阈值（条/分钟）
const SUSTAINED_RATE_SCALE = 3 // 持续活跃斜率，越大越平缓
const INSTANT_RATE_THRESHOLD = 9 // 瞬时活跃阈值（条/分钟）
const INSTANT_RATE_SCALE = 2 // 瞬时活跃斜率
const BURST_RATE_THRESHOLD = 12 // 突发活跃阈值（条/分钟）
const BURST_RATE_SCALE = 4 // 突发活跃斜率
const SMOOTHING_WINDOW = Time.second * 8 // 分数平滑窗口
const FRESHNESS_HALF_LIFE = Time.second * 60 // 新鲜度半衰期：60秒

function parseNextReplyToken(token: string): NextReplyPredicate | null {
    const trimmed = token.trim()
    if (!trimmed) return null

    const timeMatch = trimmed.match(/^time_(\d+)s$/i)
    if (timeMatch) {
        const seconds = Number.parseInt(timeMatch[1], 10)
        if (Number.isFinite(seconds) && seconds > 0) {
            return { type: 'time', seconds }
        }
    }

    const idMatch = trimmed.match(/^id_([\w-]+)$/i)
    if (idMatch) {
        return { type: 'id', userId: idMatch[1] }
    }

    return null
}

function parseWakeUpTimeToTimestamp(rawTime: string): number | null {
    const matched = rawTime
        .trim()
        .match(/^(\d{4})\/(\d{2})\/(\d{2})-(\d{2}):(\d{2}):(\d{2})$/)
    if (!matched) return null

    const [, rawYear, rawMonth, rawDay, rawHour, rawMinute, rawSecond] = matched

    const year = Number.parseInt(rawYear, 10)
    const month = Number.parseInt(rawMonth, 10)
    const day = Number.parseInt(rawDay, 10)
    const hour = Number.parseInt(rawHour, 10)
    const minute = Number.parseInt(rawMinute, 10)
    const second = Number.parseInt(rawSecond, 10)

    if (
        !Number.isFinite(year) ||
        !Number.isFinite(month) ||
        !Number.isFinite(day) ||
        !Number.isFinite(hour) ||
        !Number.isFinite(minute) ||
        !Number.isFinite(second)
    ) {
        return null
    }

    const date = new Date(year, month - 1, day, hour, minute, second, 0)
    if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day ||
        date.getHours() !== hour ||
        date.getMinutes() !== minute ||
        date.getSeconds() !== second
    ) {
        return null
    }

    return date.getTime()
}

function formatWakeUpDateTime(timestamp: number): string {
    const date = new Date(timestamp)
    const year = date.getFullYear()
    const month = String(date.getMonth() + 1).padStart(2, '0')
    const day = String(date.getDate()).padStart(2, '0')
    const hour = String(date.getHours()).padStart(2, '0')
    const minute = String(date.getMinutes()).padStart(2, '0')
    const second = String(date.getSeconds()).padStart(2, '0')

    return `${year}/${month}/${day}-${hour}:${minute}:${second}`
}

function buildNaturalReason(predicates: NextReplyPredicate[]): string {
    return predicates
        .map((predicate) => {
            if (predicate.type === 'time') {
                return `no new messages for ${predicate.seconds}s`
            }

            return `user ${predicate.userId} sent a message`
        })
        .join(' and ')
}

function parseNextReplyReason(
    rawReason: string
): PendingNextReplyConditionGroup[] {
    const groups: PendingNextReplyConditionGroup[] = []

    for (const branch of rawReason.split('|').map((it) => it.trim())) {
        if (!branch) continue

        const predicates = branch
            .split('&')
            .map((it) => parseNextReplyToken(it))
            .filter((it): it is NextReplyPredicate => it != null)

        if (predicates.length < 1) continue

        groups.push({
            predicates,
            naturalReason: buildNaturalReason(predicates)
        })
    }

    return groups
}

function evaluateNextReplyGroup(
    group: PendingNextReplyConditionGroup,
    info: GroupInfo,
    createdAt: number
) {
    const now = Date.now()
    return group.predicates.every((predicate) => {
        if (predicate.type === 'time') {
            return now - info.lastUserMessageTime >= predicate.seconds * 1000
        }

        return (
            info.lastMessageUserId === predicate.userId &&
            info.lastUserMessageTime >= createdAt
        )
    })
}

function clearPendingNextReplies(info: GroupInfo) {
    info.pendingNextReplies = []
}

function removePendingWakeUpReply(info: GroupInfo, target: PendingWakeUpReply) {
    info.pendingWakeUpReplies = (info.pendingWakeUpReplies ?? []).filter(
        (pending) =>
            !(
                pending.createdAt === target.createdAt &&
                pending.triggerAt === target.triggerAt &&
                pending.rawTime === target.rawTime &&
                pending.reason === target.reason
            )
    )
}

function markTriggered(info: GroupInfo, config: Config, now: number) {
    info.messageCount = 0
    info.lastActivityScore = Math.max(
        0,
        info.lastActivityScore - COOLDOWN_PENALTY
    )
    info.lastResponseTime = now

    const lowerLimit = config.messageActivityScoreLowerLimit
    const upperLimit = config.messageActivityScoreUpperLimit
    const step = (upperLimit - lowerLimit) * 0.1
    info.currentActivityThreshold = Math.max(
        Math.min(
            info.currentActivityThreshold + step,
            Math.max(lowerLimit, upperLimit)
        ),
        Math.min(lowerLimit, upperLimit)
    )

    clearPendingNextReplies(info)
}

function createDefaultGroupInfo(config: Config, now: number): GroupInfo {
    return {
        messageCount: 0,
        messageTimestamps: [],
        lastActivityScore: 0,
        lastScoreUpdate: 0,
        lastResponseTime: 0,
        currentActivityThreshold: config.messageActivityScoreLowerLimit,
        lastUserMessageTime: now,
        passiveRetryCount: 0,
        currentIdleWaitSeconds: undefined,
        pendingNextReplies: [],
        pendingWakeUpReplies: []
    }
}

function getPassiveRetryIntervalSeconds(
    info: GroupInfo,
    config: Config
): number {
    const baseMinutes = Math.max(config.idleTriggerIntervalMinutes, 1)
    const baseSeconds = baseMinutes * 60

    if (config.idleTriggerRetryStyle === 'fixed') {
        return baseSeconds
    }

    const retried = Math.max(info.passiveRetryCount ?? 0, 0)
    const backoffSeconds = baseSeconds * Math.pow(2, retried)

    if (config.enableIdleTriggerMaxInterval === false) {
        return backoffSeconds
    }

    const maxMinutes = Math.max(
        config.idleTriggerMaxIntervalMinutes ?? 60 * 24,
        1
    )
    const maxSeconds = maxMinutes * 60
    return Math.min(backoffSeconds, maxSeconds)
}

function applyIdleTriggerJitter(waitSeconds: number, config: Config): number {
    if (!config.enableIdleTriggerJitter) {
        return waitSeconds
    }

    const ratio = 0.05 + Math.random() * 0.05
    const direction = Math.random() < 0.5 ? -1 : 1
    const multiplier = 1 + direction * ratio

    return Math.max(1, Math.round(waitSeconds * multiplier))
}

function getGroupConfig(config: Config, guildId: string) {
    const currentGuildConfig = config.configs[guildId]
    if (currentGuildConfig == null) {
        return Object.assign({}, config)
    }

    return Object.assign({}, config, currentGuildConfig)
}

export function registerNextReplyTrigger(
    groupId: string,
    rawReason: string,
    config: Config
) {
    const groups = parseNextReplyReason(rawReason)
    if (groups.length < 1) {
        return false
    }

    const now = Date.now()
    const info =
        groupInfos[groupId] ??
        createDefaultGroupInfo(getGroupConfig(config, groupId), now)

    const pending: PendingNextReply = {
        rawReason,
        groups,
        createdAt: now
    }

    // `next_reply` is designed as a single-shot trigger slot:
    // the latest setting overrides previous pending one.
    info.pendingNextReplies = [pending]

    groupInfos[groupId] = info
    return true
}

export function clearNextReplyTriggers(groupId: string) {
    const info = groupInfos[groupId]
    if (!info) return

    clearPendingNextReplies(info)
    groupInfos[groupId] = info
}

export function registerWakeUpReplyTrigger(
    groupId: string,
    rawTime: string,
    reason: string,
    config: Config
) {
    const triggerAt = parseWakeUpTimeToTimestamp(rawTime)
    if (triggerAt == null) {
        return false
    }

    const now = Date.now()
    const info =
        groupInfos[groupId] ??
        createDefaultGroupInfo(getGroupConfig(config, groupId), now)

    const normalizedReason = reason.trim()
    const configuredAtText = formatWakeUpDateTime(now)
    const pending: PendingWakeUpReply = {
        rawTime,
        reason: normalizedReason,
        naturalReason: normalizedReason
            ? `You configured this wake-up at ${configuredAtText} to trigger at ${rawTime}, note: "${normalizedReason}"`
            : `You configured this wake-up at ${configuredAtText} to trigger at ${rawTime}`,
        triggerAt,
        createdAt: now
    }

    info.pendingWakeUpReplies = info.pendingWakeUpReplies ?? []
    info.pendingWakeUpReplies.push(pending)

    groupInfos[groupId] = info
    return true
}

function clearStaleNextReplyTriggers(info: GroupInfo) {
    const pending = info.pendingNextReplies ?? []
    if (
        pending.length > 0 &&
        pending.some((trigger) => info.lastResponseTime > trigger.createdAt)
    ) {
        clearPendingNextReplies(info)
    }
}

function findWakeUpTrigger(
    info: GroupInfo,
    now: number
): PendingWakeUpReply | undefined {
    for (const wakeUp of info.pendingWakeUpReplies ?? []) {
        if (now >= wakeUp.triggerAt) {
            return wakeUp
        }
    }

    return undefined
}

function findNextReplyTriggerReason(info: GroupInfo): string | undefined {
    for (const trigger of info.pendingNextReplies ?? []) {
        const matchedGroup = trigger.groups.find((group) =>
            evaluateNextReplyGroup(group, info, trigger.createdAt)
        )

        if (matchedGroup) {
            return `Scheduled next reply: ${matchedGroup.naturalReason}`
        }
    }

    return undefined
}

function findIdleTriggerReason(
    info: GroupInfo,
    copyOfConfig: Config,
    now: number
): string | undefined {
    if (!copyOfConfig.enableLongWaitTrigger) {
        return undefined
    }

    const hasTriggeredSinceLastMessage =
        info.lastPassiveTriggerAt != null &&
        info.lastPassiveTriggerAt >= info.lastUserMessageTime

    if (info.currentIdleWaitSeconds == null) {
        const baseWaitSeconds = hasTriggeredSinceLastMessage
            ? getPassiveRetryIntervalSeconds(info, copyOfConfig)
            : Math.max(copyOfConfig.idleTriggerIntervalMinutes, 1) * 60
        info.currentIdleWaitSeconds = applyIdleTriggerJitter(
            baseWaitSeconds,
            copyOfConfig
        )
    }

    const waitSeconds = info.currentIdleWaitSeconds
    const triggerAnchorTime = hasTriggeredSinceLastMessage
        ? (info.lastPassiveTriggerAt ?? info.lastUserMessageTime)
        : info.lastUserMessageTime
    const passiveReady = now - triggerAnchorTime >= waitSeconds * 1000

    if (!passiveReady) {
        return undefined
    }

    const elapsedSeconds = Math.max(
        1,
        Math.floor((now - info.lastUserMessageTime) / 1000)
    )
    return `No new messages for ${elapsedSeconds}s`
}

function updatePassiveRetryStateAfterTriggered(
    info: GroupInfo,
    completedAt: number,
    previousLastUserMessageTime: number
) {
    const userMessageArrivedDuringTrigger =
        info.lastUserMessageTime !== previousLastUserMessageTime

    if (userMessageArrivedDuringTrigger) {
        return
    }

    const hasTriggeredSinceLastMessage =
        info.lastPassiveTriggerAt != null &&
        info.lastPassiveTriggerAt >= info.lastUserMessageTime
    if (hasTriggeredSinceLastMessage) {
        info.passiveRetryCount = (info.passiveRetryCount ?? 0) + 1
    } else {
        // First idle trigger after a user message should make the next
        // interval start backoff immediately (base * 2).
        info.passiveRetryCount = 1
    }
    info.lastPassiveTriggerAt = completedAt
    info.currentIdleWaitSeconds = undefined
}

function resolveGuildPresetContext(
    guildId: string,
    config: Config,
    globalPreset: PresetTemplate,
    presetPool: Record<string, PresetTemplate>,
    preset: {
        getPresetForCache: (name: string) => PresetTemplate
    }
) {
    const copyOfConfig = getGroupConfig(config, guildId)
    const currentGuildConfig = config.configs[guildId]
    if (currentGuildConfig == null) {
        return {
            copyOfConfig,
            currentPreset: globalPreset
        }
    }

    const currentPreset =
        presetPool[guildId] ??
        (() => {
            const template = preset.getPresetForCache(currentGuildConfig.preset)
            presetPool[guildId] = template
            return template
        })()

    return {
        copyOfConfig,
        currentPreset
    }
}

function updateIncomingMessageStats(
    info: GroupInfo,
    copyOfConfig: Config,
    messageId: string,
    now: number
) {
    info.messageTimestamps.push(now)
    if (info.messageTimestamps.length > WINDOW_SIZE) {
        info.messageTimestamps.shift()
    }

    if (now - info.lastUserMessageTime >= THRESHOLD_RESET_TIME) {
        info.currentActivityThreshold =
            copyOfConfig.messageActivityScoreLowerLimit
    }

    info.lastUserMessageTime = now
    info.lastPassiveTriggerAt = undefined
    info.passiveRetryCount = 0
    info.currentIdleWaitSeconds = undefined
    info.lastMessageUserId = messageId
}

function shouldStopWhenDisableChatLuna(
    ctx: Context,
    session: Session,
    copyOfConfig: Config,
    guildId: string
) {
    if (
        !copyOfConfig.disableChatLuna ||
        !copyOfConfig.whiteListDisableChatLuna.includes(guildId)
    ) {
        return false
    }

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
            return true
        }

        if (currentMessage.id === selfId) {
            break
        }

        maxRecentMessage++
    }

    return false
}

function detectAppel(session: Session, botId: string) {
    let appel = session.stripped.appel
    if (!appel) {
        appel = session.elements.some(
            (element) =>
                element.type === 'at' && element.attrs?.['id'] === botId
        )
    }

    if (!appel) {
        appel = session.quote?.user?.id === botId
    }

    return Boolean(appel)
}

function buildPlainTextContent(session: Session, needPlainText: boolean) {
    if (!needPlainText) {
        return ''
    }

    return (session.elements ?? [])
        .filter((element) => element.type === 'text')
        .map((element) => element.attrs?.content ?? '')
        .join('')
}

function resolveTriggerReason(
    info: GroupInfo,
    copyOfConfig: Config,
    isDirectTrigger: boolean,
    isAppel: boolean
) {
    if (info.messageCount > copyOfConfig.messageInterval) {
        return `Message interval reached (${info.messageCount}/${copyOfConfig.messageInterval})`
    }

    if (isDirectTrigger) {
        return isAppel ? 'Mention or quote trigger' : 'Nickname trigger'
    }

    if (info.lastActivityScore >= info.currentActivityThreshold) {
        return `Activity score trigger (${info.lastActivityScore.toFixed(3)} >= ${info.currentActivityThreshold.toFixed(3)})`
    }

    return undefined
}

async function processSchedulerTickForGuild(
    ctx: Context,
    config: Config,
    guildId: string
) {
    const service = ctx.chatluna_character
    const logger = service.logger
    const info = groupInfos[guildId]
    const copyOfConfig = getGroupConfig(config, guildId)
    const session = service.getLastSession(guildId)
    if (session == null) {
        return
    }

    if (service.isMute(session) || service.isResponseLocked(session)) {
        return
    }

    clearStaleNextReplyTriggers(info)

    const now = Date.now()
    const triggeredWakeUpReply = findWakeUpTrigger(info, now)
    const triggerReason =
        (triggeredWakeUpReply
            ? `Scheduled wake-up reply: ${triggeredWakeUpReply.naturalReason}`
            : undefined) ??
        findNextReplyTriggerReason(info) ??
        findIdleTriggerReason(info, copyOfConfig, now)

    if (!triggerReason) {
        groupInfos[guildId] = info
        return
    }

    const previousLastUserMessageTime = info.lastUserMessageTime
    const triggerCollectStartedAt = Date.now()
    let triggered = false
    try {
        triggered = await service.triggerCollect(session, triggerReason)
    } catch (e) {
        logger.error(`triggerCollect failed for guild ${guildId}`, e)
        groupInfos[guildId] = info
        return
    }

    if (!triggered) {
        groupInfos[guildId] = info
        return
    }

    // Use the actual completion moment of this reply as idle retry anchor.
    const completedAt = Date.now()
    if (triggeredWakeUpReply) {
        removePendingWakeUpReply(info, triggeredWakeUpReply)
    }

    updatePassiveRetryStateAfterTriggered(
        info,
        completedAt,
        previousLastUserMessageTime
    )

    const nextRepliesRegisteredDuringCollect = (
        info.pendingNextReplies ?? []
    ).filter((pending) => pending.createdAt >= triggerCollectStartedAt)

    markTriggered(info, copyOfConfig, completedAt)
    if (nextRepliesRegisteredDuringCollect.length > 0) {
        info.pendingNextReplies = nextRepliesRegisteredDuringCollect
    }

    groupInfos[guildId] = info
}

export async function apply(ctx: Context, config: Config) {
    const service = ctx.chatluna_character
    const preset = service.preset
    const logger = service.logger

    const globalPreset = await preset.getPreset(config.defaultPreset)
    const presetPool: Record<string, PresetTemplate> = {}

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.on('guild-member' as any, (session: Session) => {
        if (
            !config.applyGroup.includes(session.guildId) ||
            session.event?.subtype !== 'ban' ||
            session.bot.selfId !== session.event?.user?.id
        ) {
            return
        }

        const duration = (session.event._data?.['duration'] ?? 0) * 1000

        if (duration === 0) {
            logger.warn(
                `检测到 ${session.bot.user?.name || session.selfId} 被 ${session.operatorId} 操作解禁。`
            )
            ctx.chatluna_character.mute(session, 0)
            return
        }

        logger.warn(
            `检测到 ${session.bot.user?.name || session.selfId} 被 ${session.operatorId} 操作禁言 ${duration / 1000} 秒。`
        )

        ctx.chatluna_character.mute(session, duration)
    })

    ctx.setInterval(async () => {
        for (const guildId of Object.keys(groupInfos)) {
            await processSchedulerTickForGuild(ctx, config, guildId)
        }
    }, SCHEDULER_TICK)

    service.addFilter((session, message) => {
        const guildId = session.guildId
        const now = Date.now()
        const { copyOfConfig, currentPreset } = resolveGuildPresetContext(
            guildId,
            config,
            globalPreset,
            presetPool,
            preset
        )

        const info =
            groupInfos[guildId] ?? createDefaultGroupInfo(copyOfConfig, now)

        const selfId = session.bot.selfId ?? session.bot.userId ?? '0'
        if (message.id === selfId) {
            groupInfos[guildId] = info
            return
        }

        updateIncomingMessageStats(info, copyOfConfig, message.id, now)

        const activity = calculateActivityScore(
            info.messageTimestamps,
            info.lastResponseTime,
            copyOfConfig.maxMessages,
            info.lastActivityScore,
            info.lastScoreUpdate
        )
        info.lastActivityScore = activity.score
        info.lastScoreUpdate = activity.timestamp

        logger.debug(
            `messageCount: ${info.messageCount}, activityScore: ${activity.score.toFixed(3)}. content: ${JSON.stringify(
                Object.assign({}, message, { images: undefined })
            )}`
        )

        if (
            shouldStopWhenDisableChatLuna(ctx, session, copyOfConfig, guildId)
        ) {
            return
        }

        const botId = session.bot.selfId
        const isAppel = detectAppel(session, botId)
        const muteKeywords = currentPreset.mute_keyword ?? []
        const forceMuteActive =
            copyOfConfig.isForceMute && isAppel && muteKeywords.length > 0
        const needPlainText =
            copyOfConfig.isNickname ||
            copyOfConfig.isNickNameWithContent ||
            forceMuteActive

        const plainTextContent = buildPlainTextContent(session, needPlainText)

        if (forceMuteActive) {
            const needMute = muteKeywords.some((value) =>
                plainTextContent.includes(value)
            )

            if (needMute) {
                logger.debug(`mute content: ${message.content}`)
                service.mute(session, config.muteTime)
            }
        }

        const isMute = service.isMute(session)

        const isDirectTrigger =
            isAppel ||
            (copyOfConfig.isNickname &&
                currentPreset.nick_name.some((value) =>
                    plainTextContent.startsWith(value)
                )) ||
            (copyOfConfig.isNickNameWithContent &&
                currentPreset.nick_name.some((value) =>
                    plainTextContent.includes(value)
                ))

        const triggerReason = resolveTriggerReason(
            info,
            copyOfConfig,
            isDirectTrigger,
            isAppel
        )

        if (triggerReason && !isMute) {
            markTriggered(info, copyOfConfig, now)
            groupInfos[session.guildId] = info
            return triggerReason
        }

        info.messageCount++
        groupInfos[session.guildId] = info
    })
}

function logistic(value: number): number {
    if (!Number.isFinite(value)) {
        return 0
    }

    if (value > 10) return 0.99995
    if (value < -10) return 0.00005

    return 1 / (1 + Math.exp(-value))
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(value, max))
}

/**
 * 计算消息新鲜度因子（指数衰减模型）
 */
function calculateFreshnessFactor(timestamps: number[]): number {
    if (timestamps.length === 0) return 0

    const now = Date.now()
    const lastMessageTime = timestamps[timestamps.length - 1]
    const timeSinceLastMessage = now - lastMessageTime

    return Math.exp(-timeSinceLastMessage / FRESHNESS_HALF_LIFE)
}

function smoothScore(
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

/**
 * 计算群聊活跃度综合分数
 *
 * 核心思路：
 * 1. 同时观察长/短窗口的消息速率
 * 2. 对突发消息进行额外权重处理
 * 3. 使用平滑函数降低尖峰，减少误触发
 * 4. 引入新鲜度与冷却机制
 */
function calculateActivityScore(
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
