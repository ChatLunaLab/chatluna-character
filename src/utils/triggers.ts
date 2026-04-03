import {
    GroupInfo,
    NextReplyPredicate,
    PendingNextReply,
    PendingNextReplyConditionGroup,
    PendingWakeUpReply
} from '../types'

export function extractNextReplyReasons(response: string): string[] {
    const reasons: string[] = []
    const regex = /<next_reply\b([^>]*)\/>/gi
    const groups = new Map<string, string[]>()
    let idx = 0

    for (const match of response.matchAll(regex)) {
        const attributes = match[1] ?? ''
        const reason = attributes.match(/\breason\s*=\s*['"]([^'"]+)['"]/i)?.[1]
        if (reason?.trim()) {
            reasons.push(reason.trim())
            continue
        }

        const type = attributes.match(/\btype\s*=\s*['"]([^'"]+)['"]/i)?.[1]
        if (!type?.trim()) {
            continue
        }

        let token: string | undefined

        if (type === 'message_from_user') {
            const userId = attributes.match(/\buser_id\s*=\s*['"]([^'"]+)['"]/i)?.[1]
            if (userId?.trim()) {
                token = `id_${userId.trim()}`
            }
        }

        if (type === 'no_message_from_user') {
            const seconds = Number.parseInt(
                attributes.match(/\bseconds\s*=\s*['"]([^'"]+)['"]/i)?.[1] ?? '',
                10
            )
            const userId = attributes.match(/\buser_id\s*=\s*['"]([^'"]+)['"]/i)?.[1]
            const maxWaitSeconds = Number.parseInt(
                attributes.match(
                    /\bmax_wait_seconds\s*=\s*['"]([^'"]+)['"]/i
                )?.[1] ?? '',
                10
            )
            if (Number.isFinite(seconds) && seconds > 0 && userId?.trim()) {
                token =
                    userId.trim() === 'all'
                        ? `time_${seconds}s`
                        : Number.isFinite(maxWaitSeconds) && maxWaitSeconds > 0
                          ? `time_${seconds}s_id_${userId.trim()}_max_${maxWaitSeconds}s`
                          : `time_${seconds}s_id_${userId.trim()}`
            }
        }

        if (!token) {
            continue
        }

        const group =
            attributes.match(/\bgroup\s*=\s*['"]([^'"]+)['"]/i)?.[1]?.trim() ??
            String(idx++)
        const current = groups.get(group) ?? []
        current.push(token)
        groups.set(group, current)
    }

    for (const tokens of groups.values()) {
        if (tokens.length > 0) {
            reasons.push(tokens.join('&'))
        }
    }

    return reasons
}

export interface WakeUpReplyTag {
    time: string
    reason: string
}

export function extractWakeUpReplies(response: string): WakeUpReplyTag[] {
    const wakeUps: WakeUpReplyTag[] = []
    const regex = /<wake_up_reply\b([^>]*)\/>/gi

    for (const match of response.matchAll(regex)) {
        const attributes = match[1] ?? ''
        const time = attributes.match(/\btime\s*=\s*['"]([^'"]+)['"]/i)?.[1]
        const reason = attributes.match(/\breason\s*=\s*['"]([^'"]*)['"]/i)?.[1]

        if (time?.trim()) {
            wakeUps.push({
                time: time.trim(),
                reason: reason?.trim() ?? ''
            })
        }
    }

    return wakeUps
}

export function parseNextReplyToken(token: string): NextReplyPredicate | null {
    const trimmed = token.trim()
    if (!trimmed) return null

    const timeWithIdAndMaxWaitMatch = trimmed.match(
        /^time_(\d+)s_id_([\w-]+)_max_(\d+)s$/i
    )
    if (timeWithIdAndMaxWaitMatch) {
        const seconds = Number.parseInt(timeWithIdAndMaxWaitMatch[1], 10)
        const userId = timeWithIdAndMaxWaitMatch[2]
        const maxWaitSeconds = Number.parseInt(
            timeWithIdAndMaxWaitMatch[3],
            10
        )
        if (
            Number.isFinite(seconds) &&
            seconds > 0 &&
            userId.length > 0 &&
            Number.isFinite(maxWaitSeconds) &&
            maxWaitSeconds > 0
        ) {
            return { type: 'time_id', seconds, userId, maxWaitSeconds }
        }
    }

    const timeWithIdMatch = trimmed.match(/^time_(\d+)s_id_([\w-]+)$/i)
    if (timeWithIdMatch) {
        const seconds = Number.parseInt(timeWithIdMatch[1], 10)
        const userId = timeWithIdMatch[2]
        if (Number.isFinite(seconds) && seconds > 0 && userId.length > 0) {
            return { type: 'time_id', seconds, userId }
        }
    }

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

export function parseWakeUpTimeToTimestamp(rawTime: string): number | null {
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

export function parseNextReplyReason(
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
            naturalReason: predicates
                .map((predicate) => {
                    if (predicate.type === 'time_id') {
                        const limit =
                            predicate.maxWaitSeconds != null
                                ? `, or trigger after ${predicate.maxWaitSeconds}s total wait`
                                : ''
                        return (
                            `time_${predicate.seconds}s_id_${predicate.userId}` +
                            `${predicate.maxWaitSeconds != null ? `_max_${predicate.maxWaitSeconds}s` : ''}: ` +
                            `after user ${predicate.userId} sends the first new message, ` +
                            `no more messages from them for ${predicate.seconds}s` +
                            limit
                        )
                    }
                    if (predicate.type === 'time') {
                        return (
                            `time_${predicate.seconds}s: ` +
                            `no new messages for ${predicate.seconds}s`
                        )
                    }
                    return (
                        `id_${predicate.userId}: ` +
                        `received a new message from user ${predicate.userId}`
                    )
                })
                .join(' and ')
        })
    }

    return groups
}

export function evaluateNextReplyGroup(
    group: PendingNextReplyConditionGroup,
    info: GroupInfo,
    sentAt: number
) {
    const now = Date.now()
    return group.predicates.every((predicate) => {
        if (predicate.type === 'time_id') {
            const lastMessageTimeByUserId =
                info.messageTimestampsByUserId?.[predicate.userId] ?? 0

            if (
                predicate.maxWaitSeconds != null &&
                now - sentAt >= predicate.maxWaitSeconds * 1000
            ) {
                return true
            }

            if (lastMessageTimeByUserId < sentAt) {
                return false
            }

            return now - lastMessageTimeByUserId >= predicate.seconds * 1000
        }

        if (predicate.type === 'time') {
            return now - info.lastUserMessageTime >= predicate.seconds * 1000
        }

        const lastMessageTimeByUserId =
            info.messageTimestampsByUserId?.[predicate.userId] ?? 0
        return lastMessageTimeByUserId >= sentAt
    })
}

export function clearStaleNextReplyTriggers(
    info: GroupInfo
): PendingNextReply[] {
    const pending = info.pendingNextReplies ?? []
    if (pending.length < 1) {
        return pending
    }

    if (!pending.some((trigger) => info.lastResponseTime > trigger.sentAt)) {
        return pending
    }

    return []
}

export function findWakeUpTrigger(
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

export function findNextReplyTriggerReason(
    info: GroupInfo
): string | undefined {
    for (const trigger of info.pendingNextReplies ?? []) {
        const matchedGroup = trigger.groups.find((group) =>
            evaluateNextReplyGroup(group, info, trigger.sentAt)
        )

        if (matchedGroup) {
            return `Triggered by next_reply: ${matchedGroup.naturalReason}`
        }
    }

    return undefined
}
