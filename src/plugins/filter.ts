import { Context, Session, Time } from 'koishi'
import { Config } from '..'
import {
    ActivityScore,
    GroupInfo,
    PendingNextReply,
    PendingNextReplyConditionGroup,
    PendingWakeUpReply,
    PresetTemplate
} from '../types'
import { parseNextReplyReason, parseWakeUpTimeToTimestamp } from '../utils'

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
const STALE_GROUP_INFO_TTL = Time.hour * 24

const MIN_RECENT_MESSAGES = 6 // 进入活跃度统计的最小消息数
const SUSTAINED_RATE_THRESHOLD = 10 // 持续活跃阈值（条/分钟）
const SUSTAINED_RATE_SCALE = 3 // 持续活跃斜率，越大越平缓
const INSTANT_RATE_THRESHOLD = 9 // 瞬时活跃阈值（条/分钟）
const INSTANT_RATE_SCALE = 2 // 瞬时活跃斜率
const BURST_RATE_THRESHOLD = 12 // 突发活跃阈值（条/分钟）
const BURST_RATE_SCALE = 4 // 突发活跃斜率
const SMOOTHING_WINDOW = Time.second * 8 // 分数平滑窗口
const FRESHNESS_HALF_LIFE = Time.second * 60 // 新鲜度半衰期：60秒

function evaluateNextReplyGroup(
    group: PendingNextReplyConditionGroup,
    info: GroupInfo,
    createdAt: number
) {
    const now = Date.now()
    return group.predicates.every((predicate) => {
        if (predicate.type === 'time_id') {
            const lastMessageTimeByUserId =
                info.messageTimestampsByUserId?.[predicate.userId] ?? 0
            const anchor = Math.max(createdAt, lastMessageTimeByUserId)
            return now - anchor >= predicate.seconds * 1000
        }

        if (predicate.type === 'time') {
            return now - info.lastUserMessageTime >= predicate.seconds * 1000
        }

        const lastMessageTimeByUserId =
            info.messageTimestampsByUserId?.[predicate.userId] ?? 0
        return lastMessageTimeByUserId >= createdAt
    })
}

function markTriggered(
    info: GroupInfo,
    config: Config,
    now: number,
    isDirect = false
) {
    info.messageCount = 0
    info.lastActivityScore = Math.max(
        0,
        info.lastActivityScore - COOLDOWN_PENALTY
    )
    info.lastResponseTime = now

    if (!isDirect) {
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
    }

    info.pendingNextReplies = []
}

function createDefaultGroupInfo(config: Config, now: number): GroupInfo {
    return {
        messageCount: 0,
        messageTimestamps: [],
        messageTimestampsByUserId: {},
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

export function registerNextReplyTrigger(
    key: string,
    rawReason: string,
    config: Config
) {
    const groups = parseNextReplyReason(rawReason)
    if (groups.length < 1) {
        return false
    }

    const now = Date.now()
    const info =
        groupInfos[key] ??
        (() => {
            const isDirect = key.startsWith('private:')
            const id = isDirect
                ? key.slice('private:'.length)
                : key.startsWith('group:')
                  ? key.slice('group:'.length)
                  : key
            const guildConfig = isDirect
                ? config.privateConfigs[id]
                : config.configs[id]
            return createDefaultGroupInfo(
                Object.assign({}, config, guildConfig),
                now
            )
        })()

    const pending: PendingNextReply = {
        rawReason,
        groups,
        createdAt: now
    }

    // `next_reply` 设计为单次触发槽位：后设置会覆盖先设置。
    info.pendingNextReplies = [pending]

    groupInfos[key] = info
    return true
}

export function clearNextReplyTriggers(key: string) {
    const info = groupInfos[key]
    if (!info) return

    info.pendingNextReplies = []
    groupInfos[key] = info
}

export function registerWakeUpReplyTrigger(
    key: string,
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
        groupInfos[key] ??
        (() => {
            const isDirect = key.startsWith('private:')
            const id = isDirect
                ? key.slice('private:'.length)
                : key.startsWith('group:')
                  ? key.slice('group:'.length)
                  : key
            const guildConfig = isDirect
                ? config.privateConfigs[id]
                : config.configs[id]
            return createDefaultGroupInfo(
                Object.assign({}, config, guildConfig),
                now
            )
        })()

    const normalizedReason = reason.trim()
    const configuredAt = new Date(now)
    const pad = (n: number) => String(n).padStart(2, '0')
    const configuredAtText =
        `${configuredAt.getFullYear()}/${pad(configuredAt.getMonth() + 1)}` +
        `/${pad(configuredAt.getDate())}-${pad(configuredAt.getHours())}` +
        `:${pad(configuredAt.getMinutes())}:${pad(configuredAt.getSeconds())}`
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

    groupInfos[key] = info
    return true
}

function clearStaleNextReplyTriggers(info: GroupInfo) {
    const pending = info.pendingNextReplies ?? []
    if (
        pending.length > 0 &&
        pending.some((trigger) => info.lastResponseTime > trigger.createdAt)
    ) {
        info.pendingNextReplies = []
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
            return `Triggered by next_reply: ${matchedGroup.naturalReason}`
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
        // 用户新消息后的首次空闲触发，下一次间隔应立即进入退避（base * 2）。
        info.passiveRetryCount = 1
    }
    info.lastPassiveTriggerAt = completedAt
    info.currentIdleWaitSeconds = undefined
}

function resolveGuildPresetContext(
    guildId: string,
    key: string,
    isDirect: boolean,
    config: Config,
    globalPreset: PresetTemplate,
    presetPool: Record<string, PresetTemplate>,
    preset: {
        getPresetForCache: (name: string) => PresetTemplate
    }
) {
    const currentGuildConfig = isDirect
        ? config.privateConfigs[guildId]
        : config.configs[guildId]
    const copyOfConfig = Object.assign({}, config, currentGuildConfig)
    if (currentGuildConfig == null) {
        return {
            copyOfConfig,
            currentPreset: globalPreset
        }
    }

    const currentPreset =
        presetPool[key] ??
        (() => {
            const template = preset.getPresetForCache(currentGuildConfig.preset)
            presetPool[key] = template
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
    userId: string,
    now: number,
    isDirect: boolean
) {
    if (!isDirect) {
        info.messageTimestamps.push(now)
        if (info.messageTimestamps.length > WINDOW_SIZE) {
            info.messageTimestamps.shift()
        }

        if (now - info.lastUserMessageTime >= THRESHOLD_RESET_TIME) {
            info.currentActivityThreshold =
                copyOfConfig.messageActivityScoreLowerLimit
        }
    }

    info.lastUserMessageTime = now
    info.lastPassiveTriggerAt = undefined
    info.passiveRetryCount = 0
    info.currentIdleWaitSeconds = undefined
    info.lastMessageUserId = userId
    info.messageTimestampsByUserId = info.messageTimestampsByUserId ?? {}
    info.messageTimestampsByUserId[userId] = now
}

function shouldStopWhenDisableChatLuna(
    ctx: Context,
    session: Session,
    copyOfConfig: Config,
    key: string,
    id: string
) {
    if (session.isDirect) {
        return (
            copyOfConfig.disableChatLuna &&
            !copyOfConfig.whiteListDisableChatLunaPrivate.includes(id)
        )
    }

    if (
        !copyOfConfig.disableChatLuna ||
        !copyOfConfig.whiteListDisableChatLuna.includes(id)
    ) {
        return false
    }

    const selfId = session.bot.userId ?? session.bot.selfId ?? '0'
    const guildMessages = ctx.chatluna_character.getMessages(key)

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

function resolveImmediateTriggerReason(
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

    return undefined
}

function resolveTriggerReason(
    info: GroupInfo,
    copyOfConfig: Config,
    isDirectTrigger: boolean,
    isAppel: boolean,
    isDirect: boolean
) {
    const immediateTriggerReason = resolveImmediateTriggerReason(
        info,
        copyOfConfig,
        isDirectTrigger,
        isAppel
    )
    if (immediateTriggerReason) {
        return immediateTriggerReason
    }

    if (isDirect) {
        return undefined
    }

    if (info.lastActivityScore >= info.currentActivityThreshold) {
        return `Activity score trigger (${info.lastActivityScore.toFixed(3)} >= ${info.currentActivityThreshold.toFixed(3)})`
    }

    return undefined
}

function hasPendingSchedulerWork(info: GroupInfo, copyOfConfig: Config) {
    return (
        copyOfConfig.enableLongWaitTrigger ||
        (info.pendingNextReplies?.length ?? 0) > 0 ||
        (info.pendingWakeUpReplies?.length ?? 0) > 0
    )
}

function getGroupInfoLastActiveAt(info: GroupInfo) {
    return Math.max(
        info.lastUserMessageTime ?? 0,
        info.lastResponseTime ?? 0,
        info.lastScoreUpdate ?? 0
    )
}

function shouldRecycleGroupInfo(
    key: string,
    info: GroupInfo,
    copyOfConfig: Config,
    hasLastSession: boolean,
    now: number,
    config: Config
) {
    const isDirect = key.startsWith('private:')
    const id = isDirect
        ? key.slice('private:'.length)
        : key.startsWith('group:')
          ? key.slice('group:'.length)
          : key

    if (
        (!isDirect && !config.applyGroup.includes(id)) ||
        (isDirect && !config.applyPrivate.includes(id))
    ) {
        return true
    }

    if (hasPendingSchedulerWork(info, copyOfConfig)) {
        return false
    }

    if (!hasLastSession) {
        return true
    }

    const lastActiveAt = getGroupInfoLastActiveAt(info)
    if (lastActiveAt <= 0) {
        return true
    }

    return now - lastActiveAt >= STALE_GROUP_INFO_TTL
}

async function processSchedulerTickForGuild(
    ctx: Context,
    config: Config,
    key: string
) {
    const service = ctx.chatluna_character
    const logger = service.logger
    const info = groupInfos[key]
    if (info == null) {
        return
    }

    const session = service.getLastSession(key)
    if (session == null) {
        return
    }

    const id = session.isDirect ? session.userId : session.guildId
    const guildConfig = session.isDirect
        ? config.privateConfigs[id]
        : config.configs[id]
    const copyOfConfig = Object.assign({}, config, guildConfig)

    clearStaleNextReplyTriggers(info)

    const now = Date.now()
    const triggeredWakeUpReply = findWakeUpTrigger(info, now)

    if (triggeredWakeUpReply && (service.getMessages(key)?.length ?? 0) < 1) {
        groupInfos[key] = info
        return
    }

    if (service.isMute(session)) {
        return
    }

    if (service.isResponseLocked(session)) {
        return
    }

    const triggerReason =
        (triggeredWakeUpReply
            ? `Triggered by wake_up_reply: ${triggeredWakeUpReply.naturalReason}`
            : undefined) ??
        findNextReplyTriggerReason(info) ??
        findIdleTriggerReason(info, copyOfConfig, now)

    if (!triggerReason) {
        groupInfos[key] = info
        return
    }

    const previousLastUserMessageTime = info.lastUserMessageTime
    const triggerCollectStartedAt = Date.now()
    let triggered = false
    try {
        triggered = await service.triggerCollect(session, triggerReason)
    } catch (e) {
        logger.error(`triggerCollect failed for session ${key}`, e)
        groupInfos[key] = info
        return
    }

    if (!triggered) {
        groupInfos[key] = info
        return
    }

    // 以本次回复真正完成的时刻作为空闲重试锚点。
    const completedAt = Date.now()
    if (triggeredWakeUpReply) {
        info.pendingWakeUpReplies = (info.pendingWakeUpReplies ?? []).filter(
            (pending) =>
                !(
                    pending.createdAt === triggeredWakeUpReply.createdAt &&
                    pending.triggerAt === triggeredWakeUpReply.triggerAt &&
                    pending.rawTime === triggeredWakeUpReply.rawTime &&
                    pending.reason === triggeredWakeUpReply.reason
                )
        )

        await service.persistWakeUpReplies(
            session,
            info.pendingWakeUpReplies ?? []
        )
    }

    updatePassiveRetryStateAfterTriggered(
        info,
        completedAt,
        previousLastUserMessageTime
    )

    const nextRepliesRegisteredDuringCollect = (
        info.pendingNextReplies ?? []
    ).filter((pending) => pending.createdAt >= triggerCollectStartedAt)

    markTriggered(info, copyOfConfig, completedAt, session.isDirect)
    if (nextRepliesRegisteredDuringCollect.length > 0) {
        info.pendingNextReplies = nextRepliesRegisteredDuringCollect
    }

    groupInfos[key] = info
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

    ctx.on('ready', () => {
        const keys = Object.keys(service.getLoadedTemps())

        for (const key of Object.keys(groupInfos)) {
            if (!keys.includes(key)) {
                keys.push(key)
            }
        }

        for (const key of keys) {
            const wakeUps = service.getLoadedWakeUpReplies(key)
            if (wakeUps.length < 1) {
                continue
            }

            const isDirect = key.startsWith('private:')
            const id = isDirect
                ? key.slice('private:'.length)
                : key.startsWith('group:')
                  ? key.slice('group:'.length)
                  : key
            const guildConfig = isDirect
                ? config.privateConfigs[id]
                : config.configs[id]
            const copyOfConfig = Object.assign({}, config, guildConfig)
            const info =
                groupInfos[key] ??
                createDefaultGroupInfo(copyOfConfig, Date.now())

            info.pendingWakeUpReplies = [...wakeUps]
            groupInfos[key] = info
        }
    })

    ctx.setInterval(() => {
        const now = Date.now()

        for (const key of Object.keys(groupInfos)) {
            const info = groupInfos[key]
            if (info == null) {
                continue
            }

            const session = service.getLastSession(key)
            const isDirect = session
                ? session.isDirect
                : key.startsWith('private:')
            const id = session
                ? session.isDirect
                    ? session.userId
                    : session.guildId
                : key.startsWith('private:')
                  ? key.slice('private:'.length)
                  : key.startsWith('group:')
                    ? key.slice('group:'.length)
                    : key
            const guildConfig = isDirect
                ? config.privateConfigs[id]
                : config.configs[id]
            const copyOfConfig = Object.assign({}, config, guildConfig)
            const hasLastSession = session != null

            if (
                shouldRecycleGroupInfo(
                    key,
                    info,
                    copyOfConfig,
                    hasLastSession,
                    now,
                    config
                )
            ) {
                delete groupInfos[key]
                continue
            }

            if (!hasPendingSchedulerWork(info, copyOfConfig)) {
                continue
            }

            processSchedulerTickForGuild(ctx, config, key).catch((e) => {
                logger.error(
                    `[next_reply] scheduler failed session=${key}`,
                    e
                )
            })
        }
    }, SCHEDULER_TICK)

    service.addFilter((session, message) => {
        const id = session.isDirect ? session.userId : session.guildId
        const key = `${session.isDirect ? 'private' : 'group'}:${id}`
        const now = Date.now()
        const { copyOfConfig, currentPreset } = resolveGuildPresetContext(
            id,
            key,
            session.isDirect,
            config,
            globalPreset,
            presetPool,
            preset
        )

        const info = groupInfos[key] ?? (() => {
            const info = createDefaultGroupInfo(copyOfConfig, now)
            const wakeUps = service.getLoadedWakeUpReplies(key)

            if (wakeUps.length > 0) {
                info.pendingWakeUpReplies = [...wakeUps]
            }

            return info
        })()

        if (
            !service.isResponseLocked(session) &&
            (service.getMessages(key)?.length ?? 0) > 1
        ) {
            const pendingWakeUpReplies = info.pendingWakeUpReplies ?? []
            const nextWakeUpReplies = pendingWakeUpReplies.filter(
                (pending) => pending.triggerAt > now
            )

            if (nextWakeUpReplies.length !== pendingWakeUpReplies.length) {
                info.pendingWakeUpReplies = nextWakeUpReplies
                void service.persistWakeUpReplies(session, nextWakeUpReplies).catch(
                    (e) => {
                        logger.error(e)
                    }
                )
            }
        }

        const selfId = session.bot.selfId ?? session.bot.userId ?? '0'
        if (message.id === selfId) {
            groupInfos[key] = info
            return
        }

        if (
            shouldStopWhenDisableChatLuna(
                ctx,
                session,
                copyOfConfig,
                key,
                id
            )
        ) {
            return
        }

        updateIncomingMessageStats(
            info,
            copyOfConfig,
            message.id,
            now,
            session.isDirect
        )

        const botId = session.bot.selfId
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
        const isAppel = Boolean(appel)

        const muteKeywords = currentPreset.mute_keyword ?? []
        const forceMuteActive =
            copyOfConfig.isForceMute && isAppel && muteKeywords.length > 0
        const needPlainText =
            copyOfConfig.isNickname ||
            copyOfConfig.isNickNameWithContent ||
            forceMuteActive

        const plainTextContent = needPlainText
            ? (session.elements ?? [])
                  .filter((element) => element.type === 'text')
                  .map((element) => element.attrs?.content ?? '')
                  .join('')
            : ''

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

        logger.debug(
            session.isDirect
                ? `messageCount: ${info.messageCount}. content: ${JSON.stringify(
                      Object.assign({}, message, { images: undefined })
                  )}`
                : `messageCount: ${info.messageCount}, activityScore: ${info.lastActivityScore.toFixed(3)}. content: ${JSON.stringify(
                      Object.assign({}, message, { images: undefined })
                  )}`
        )

        const immediateTriggerReason = resolveImmediateTriggerReason(
            info,
            copyOfConfig,
            isDirectTrigger,
            isAppel
        )

        if (immediateTriggerReason) {
            if (!isMute) {
                markTriggered(info, copyOfConfig, now, session.isDirect)
                groupInfos[key] = info
                return immediateTriggerReason
            }

            info.messageCount++
            groupInfos[key] = info
            return
        }

        if (!session.isDirect) {
            const activity = calculateActivityScore(
                info.messageTimestamps,
                info.lastResponseTime,
                copyOfConfig.maxMessages,
                info.lastActivityScore,
                info.lastScoreUpdate
            )
            info.lastActivityScore = activity.score
            info.lastScoreUpdate = activity.timestamp
        }

        const triggerReason = resolveTriggerReason(
            info,
            copyOfConfig,
            isDirectTrigger,
            isAppel,
            session.isDirect
        )

        if (triggerReason && !isMute) {
            markTriggered(info, copyOfConfig, now, session.isDirect)
            groupInfos[key] = info
            return triggerReason
        }

        info.messageCount++
        groupInfos[key] = info
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
