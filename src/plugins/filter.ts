import { Context, Session } from 'koishi'
import { Config } from '..'
import { GroupInfo, PresetTemplate } from '../types'
import { createDefaultGroupInfo } from '../service/trigger'
import {
    calculateActivityScore,
    clearStaleNextReplyTriggers,
    COOLDOWN_PENALTY,
    findNextReplyTriggerReason,
    findWakeUpTrigger,
    SCHEDULER_TICK,
    STALE_GROUP_INFO_TTL,
    THRESHOLD_RESET_TIME,
    WINDOW_SIZE
} from '../utils/index'

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

    if (!isDirect && config.enableActivityScoreTrigger !== false) {
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

function getPassiveRetryIntervalSeconds(
    info: GroupInfo,
    config: Config
): number {
    const baseMinutes = Math.max(
        config.idleTrigger.idleTriggerIntervalMinutes,
        1
    )
    const baseSeconds = baseMinutes * 60

    if (config.idleTrigger.idleTriggerRetryStyle === 'fixed') {
        return baseSeconds
    }

    const retried = Math.max(info.passiveRetryCount ?? 0, 0)
    const backoffSeconds = baseSeconds * Math.pow(2, retried)

    const maxMinutes = Math.max(
        config.idleTrigger.idleTriggerMaxIntervalMinutes ?? 60 * 24,
        1
    )
    const maxSeconds = maxMinutes * 60
    return Math.min(backoffSeconds, maxSeconds)
}

function applyIdleTriggerJitter(waitSeconds: number, config: Config): number {
    if (!config.idleTrigger.enableIdleTriggerJitter) {
        return waitSeconds
    }

    const ratio = 0.05 + Math.random() * 0.05
    const direction = Math.random() < 0.5 ? -1 : 1
    const multiplier = 1 + direction * ratio

    return Math.max(1, Math.round(waitSeconds * multiplier))
}

function findIdleTriggerReason(
    info: GroupInfo,
    copyOfConfig: Config,
    now: number
): string | undefined {
    if (!copyOfConfig.idleTrigger.enableLongWaitTrigger) {
        return undefined
    }

    const hasTriggeredSinceLastMessage =
        info.lastPassiveTriggerAt != null &&
        info.lastPassiveTriggerAt >= info.lastUserMessageTime

    if (
        hasTriggeredSinceLastMessage &&
        copyOfConfig.idleTrigger.idleTriggerRetryStyle === 'fixed' &&
        (info.passiveRetryCount ?? 0) >
            copyOfConfig.idleTrigger.idleTriggerFixedMaxRetries
    ) {
        return undefined
    }

    if (
        hasTriggeredSinceLastMessage &&
        copyOfConfig.idleTrigger.idleTriggerRetryStyle === 'exponential'
    ) {
        const baseSeconds =
            Math.max(copyOfConfig.idleTrigger.idleTriggerIntervalMinutes, 1) *
            60
        const backoffSeconds =
            baseSeconds * Math.pow(2, Math.max(info.passiveRetryCount ?? 0, 0))
        const maxSeconds =
            Math.max(
                copyOfConfig.idleTrigger.idleTriggerMaxIntervalMinutes,
                1
            ) * 60
        if (backoffSeconds >= maxSeconds) {
            return undefined
        }
    }

    if (info.currentIdleWaitSeconds == null) {
        const baseWaitSeconds = hasTriggeredSinceLastMessage
            ? getPassiveRetryIntervalSeconds(info, copyOfConfig)
            : Math.max(copyOfConfig.idleTrigger.idleTriggerIntervalMinutes, 1) *
              60
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
    globalPrivatePreset: PresetTemplate,
    globalGroupPreset: PresetTemplate,
    presetPool: Record<string, PresetTemplate>,
    preset: {
        getPresetForCache: (name: string) => PresetTemplate
    }
) {
    const globalConfig = isDirect
        ? config.globalPrivateConfig
        : config.globalGroupConfig
    const currentGuildConfig = isDirect
        ? config.privateConfigs[guildId]
        : config.configs[guildId]
    const copyOfConfig = Object.assign(
        {},
        config,
        globalConfig,
        currentGuildConfig
    )
    if (currentGuildConfig == null) {
        return {
            copyOfConfig,
            currentPreset: isDirect ? globalPrivatePreset : globalGroupPreset
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

        if (
            copyOfConfig.enableActivityScoreTrigger !== false &&
            now - info.lastUserMessageTime >= THRESHOLD_RESET_TIME
        ) {
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
            copyOfConfig.whiteListDisableChatLunaPrivate.includes(id)
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
    isAppel: boolean,
    isDirect: boolean
) {
    if (copyOfConfig.enableFixedIntervalTrigger === false) {
        if (isDirectTrigger) {
            return isAppel ? 'Mention or quote trigger' : 'Nickname trigger'
        }

        return undefined
    }

    if (copyOfConfig.messageInterval === 0) {
        if (isDirect) {
            if (isDirectTrigger) {
                return isAppel ? 'Mention or quote trigger' : 'Nickname trigger'
            }
            return undefined
        }

        if (isDirectTrigger) {
            return isAppel ? 'Mention or quote trigger' : 'Nickname trigger'
        }

        return 'Message interval reached (0 mode)'
    }

    if (info.messageCount >= copyOfConfig.messageInterval) {
        return `Message interval reached (${info.messageCount}/${copyOfConfig.messageInterval})`
    }

    if (isDirectTrigger) {
        return isAppel ? 'Mention or quote trigger' : 'Nickname trigger'
    }

    return undefined
}

function findZeroIntervalTriggerReason(
    info: GroupInfo,
    copyOfConfig: Config,
    now: number,
    isDirect: boolean
) {
    if (copyOfConfig.enableFixedIntervalTrigger === false) {
        return undefined
    }

    if (!isDirect) {
        return undefined
    }

    if (copyOfConfig.messageInterval !== 0) {
        return undefined
    }

    if (info.messageCount < 1) {
        return undefined
    }

    const wait = Math.max(copyOfConfig.messageWaitTime, 0)
    if (now - info.lastUserMessageTime < wait * 1000) {
        return undefined
    }

    return `Message wait reached (${wait}s)`
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
        isAppel,
        isDirect
    )
    if (immediateTriggerReason) {
        return immediateTriggerReason
    }

    if (isDirect) {
        return undefined
    }

    if (
        copyOfConfig.enableActivityScoreTrigger !== false &&
        info.lastActivityScore >= info.currentActivityThreshold
    ) {
        return `Activity score trigger (${info.lastActivityScore.toFixed(3)} >= ${info.currentActivityThreshold.toFixed(3)})`
    }

    return undefined
}

function hasPendingSchedulerWork(info: GroupInfo, copyOfConfig: Config) {
    return (
        (copyOfConfig.enableFixedIntervalTrigger !== false &&
            copyOfConfig.messageInterval === 0 &&
            info.messageCount > 0) ||
        copyOfConfig.idleTrigger.enableLongWaitTrigger ||
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
        (!isDirect &&
            config.groupWhitelistMode &&
            !config.applyGroup.includes(id)) ||
        (isDirect &&
            config.privateWhitelistMode &&
            !config.applyPrivate.includes(id))
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
    const store = ctx.chatluna_character_trigger
    const logger = service.logger
    const info = store.get(key)
    if (info == null) {
        return
    }

    const session = store.getLastSession(key)
    if (session == null) {
        return
    }

    const id = session.isDirect ? session.userId : session.guildId
    const globalConfig = session.isDirect
        ? config.globalPrivateConfig
        : config.globalGroupConfig
    const guildConfig = session.isDirect
        ? config.privateConfigs[id]
        : config.configs[id]
    const copyOfConfig = Object.assign({}, config, globalConfig, guildConfig)

    info.pendingNextReplies = clearStaleNextReplyTriggers(info)

    const now = Date.now()
    const triggeredWakeUpReply = findWakeUpTrigger(info, now)

    if (triggeredWakeUpReply && (service.getMessages(key)?.length ?? 0) < 1) {
        store.set(key, info)
        return
    }

    if (service.isMute(session)) {
        store.set(key, info)
        return
    }

    if (service.isResponseLocked(session)) {
        store.set(key, info)
        return
    }

    const triggerReason =
        (triggeredWakeUpReply
            ? `Triggered by wake_up_reply: ${triggeredWakeUpReply.naturalReason}`
            : undefined) ??
        findNextReplyTriggerReason(info) ??
        findZeroIntervalTriggerReason(
            info,
            copyOfConfig,
            now,
            session.isDirect
        ) ??
        findIdleTriggerReason(info, copyOfConfig, now)

    if (!triggerReason) {
        store.set(key, info)
        return
    }

    const previousLastUserMessageTime = info.lastUserMessageTime
    const triggerCollectStartedAt = Date.now()
    let triggered = false
    try {
        triggered = await service.triggerCollect(session, triggerReason)
    } catch (e) {
        logger.error(`triggerCollect failed for session ${key}`, e)
        store.set(key, info)
        return
    }

    if (!triggered) {
        store.set(key, info)
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

        await store.setWakeUpReplies(session, info.pendingWakeUpReplies ?? [])
    }

    updatePassiveRetryStateAfterTriggered(
        info,
        completedAt,
        previousLastUserMessageTime
    )

    const nextRepliesRegisteredDuringCollect = (
        info.pendingNextReplies ?? []
    ).filter((pending) => pending.sentAt >= triggerCollectStartedAt)

    markTriggered(info, copyOfConfig, completedAt, session.isDirect)
    if (nextRepliesRegisteredDuringCollect.length > 0) {
        info.pendingNextReplies = nextRepliesRegisteredDuringCollect.map(
            (pending) => ({
                ...pending,
                sentAt: completedAt
            })
        )
    }

    store.set(key, info)
}

export async function apply(ctx: Context, config: Config) {
    const service = ctx.chatluna_character
    const store = ctx.chatluna_character_trigger
    const preset = service.preset
    const logger = service.logger

    const globalPrivatePreset = await preset.getPreset(
        config.globalPrivateConfig.preset
    )
    const globalGroupPreset = await preset.getPreset(
        config.globalGroupConfig.preset
    )
    const presetPool: Record<string, PresetTemplate> = {}

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx.on('guild-member' as any, (session: Session) => {
        if (
            (config.groupWhitelistMode &&
                !config.applyGroup.includes(session.guildId)) ||
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

    ctx.setInterval(() => {
        const now = Date.now()

        for (const key of store.keys()) {
            const info = store.get(key)
            if (info == null) {
                continue
            }

            const session = store.getLastSession(key)
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
            const globalConfig = isDirect
                ? config.globalPrivateConfig
                : config.globalGroupConfig
            const copyOfConfig = Object.assign(
                {},
                config,
                globalConfig,
                guildConfig
            )
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
                store.delete(key).catch((e) => {
                    logger.error(
                        `[next_reply] recycle failed session=${key}`,
                        e
                    )
                })
                continue
            }

            if (!hasPendingSchedulerWork(info, copyOfConfig)) {
                continue
            }

            processSchedulerTickForGuild(ctx, config, key).catch((e) => {
                logger.error(`[next_reply] scheduler failed session=${key}`, e)
            })
        }
    }, SCHEDULER_TICK)

    service.addFilter((session, message) => {
        const isPrivate = session.isDirect
        const id = isPrivate ? session.userId : session.guildId
        const key = `${isPrivate ? 'private' : 'group'}:${id}`
        const now = Date.now()
        const { copyOfConfig, currentPreset } = resolveGuildPresetContext(
            id,
            key,
            isPrivate,
            config,
            globalPrivatePreset,
            globalGroupPreset,
            presetPool,
            preset
        )

        const info = store.get(key) ?? createDefaultGroupInfo(copyOfConfig, now)

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
                store
                    .setWakeUpReplies(session, nextWakeUpReplies)
                    .catch((e) => {
                        logger.error(e)
                    })
            }
        }

        const selfId = session.bot.selfId ?? session.bot.userId ?? '0'
        if (message.id === selfId) {
            store.set(key, info)
            return
        }

        if (
            shouldStopWhenDisableChatLuna(ctx, session, copyOfConfig, key, id)
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

        let isAppel = false
        if (!session.isDirect) {
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
            isAppel = Boolean(appel)
        }

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
                service.mute(session, copyOfConfig.muteTime * 1000)
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

        const shouldShowActivityScore =
            !isPrivate && copyOfConfig.enableActivityScoreTrigger !== false
        logger.debug(
            shouldShowActivityScore
                ? `messageCount: ${info.messageCount}, activityScore: ${info.lastActivityScore.toFixed(3)}. content: ${JSON.stringify(
                      Object.assign({}, message, { images: undefined })
                  )}`
                : `messageCount: ${info.messageCount}. content: ${JSON.stringify(
                      Object.assign({}, message, { images: undefined })
                  )}`
        )

        const immediateTriggerReason = resolveImmediateTriggerReason(
            info,
            copyOfConfig,
            isDirectTrigger,
            isAppel,
            session.isDirect
        )

        if (immediateTriggerReason) {
            if (!isMute) {
                markTriggered(info, copyOfConfig, now, session.isDirect)
                store.set(key, info)
                return immediateTriggerReason
            }

            info.messageCount++
            store.set(key, info)
            return
        }

        if (
            !session.isDirect &&
            copyOfConfig.enableActivityScoreTrigger !== false
        ) {
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
            store.set(key, info)
            return triggerReason
        }

        info.messageCount++
        store.set(key, info)
    })
}
