import { Context, h, Logger, Session } from 'koishi'
import OneBotBot from 'koishi-plugin-adapter-onebot'
import { hashString } from 'koishi-plugin-chatluna/utils/string'
import { Config } from '..'
import { parseCQCode } from '../onebot/cqcode'
import {
    KoishiMessage,
    Message,
    MessageImage,
    OneBotHistoryMessage
} from '../types'
import { getNotEmptyString, mapElementToString } from './messages'

export interface PullHistoryConfig {
    logger: Logger
    session: Session
    config: Config
    focusMessage: Message
    messageCount: number
    clearedAfter?: number
}

export async function pullHistory(cfg: PullHistoryConfig) {
    if (!cfg.config.historyPull) {
        return null
    }

    const count = Math.max(0, (cfg.config.maxMessages ?? 40) - cfg.messageCount)
    if (count < 1) {
        return []
    }

    const groupId = `${cfg.session.isDirect ? 'private' : 'group'}:${cfg.session.isDirect ? cfg.session.userId : cfg.session.guildId}`

    if (cfg.session.platform === 'qq') {
        cfg.logger.debug(
            `Skip history pull for session ${cfg.session.isDirect ? cfg.session.userId : cfg.session.guildId}: current adapter is QQ official.`
        )
        return []
    }

    cfg.logger.debug(
        `Try to pull ${count} history message(s) for session ${groupId}.`
    )

    const bot = cfg.session.bot

    if (cfg.session.platform === 'onebot') {
        return pullOneBot(cfg, count)
    }

    if (typeof bot.getMessageList === 'function') {
        return pullBot(cfg, count)
    }

    cfg.logger.debug(
        `Skip history pull for session ${cfg.session.isDirect ? cfg.session.userId : cfg.session.guildId}: ` +
            'current adapter does not support history API.'
    )

    return []
}

export function mergeMessages(list: Message[], add: Message[], max: number) {
    const map = new Map<string, Message>()

    for (const msg of list.concat(add)) {
        const key =
            msg.messageId != null
                ? `message:${msg.messageId}`
                : `fallback:${msg.id}:${msg.timestamp}:${msg.content}`
        map.set(key, msg)
    }

    const merged = [...map.values()].sort((a, b) => {
        const left = a.timestamp ?? 0
        const right = b.timestamp ?? 0
        return left - right
    })

    while (merged.length > max) {
        merged.shift()
    }

    return merged
}

export function formatHistoryLogDate(value?: Date | null) {
    if (value == null) {
        return 'none'
    }

    return value.toLocaleString('zh-CN', {
        hour12: false,
        timeZone: 'Asia/Shanghai'
    })
}

async function pullBot(
    cfg: PullHistoryConfig,
    count: number
): Promise<Message[]> {
    const bot = cfg.session.bot

    let channelId = cfg.session.channelId ?? cfg.session.guildId

    if (channelId == null || bot.getMessageList == null) {
        cfg.logger.warn(
            `Skip history pull for session ${cfg.session.isDirect ? cfg.session.userId : cfg.session.guildId}: ` +
                'Bot API requires a valid channel id.'
        )
        return []
    }

    if (cfg.session.isDirect) {
        channelId = `private:${cfg.session.userId}`
    }

    const results: Message[] = []
    let nextId: string | undefined
    let prevId: string | undefined

    while (results.length < count) {
        let resp: Awaited<ReturnType<typeof bot.getMessageList>>
        try {
            resp = await bot.getMessageList(channelId, nextId, 'before')
        } catch (err) {
            cfg.logger.warn(
                `Failed to pull Bot API history for session ${cfg.session.isDirect ? cfg.session.userId : cfg.session.guildId}`,
                err
            )
            return []
        }

        const batch = resp.data ?? []
        if (batch.length < 1) {
            break
        }

        const list = (await Promise.all(
            batch.map((msg) => toBotMsg(cfg.session, msg))
        ))
            .filter((msg): msg is Message => msg != null)
            .filter((msg) => !sameMessage(msg, cfg.focusMessage))
            .filter(
                (msg) =>
                    cfg.clearedAfter == null ||
                    msg.timestamp == null ||
                    msg.timestamp > cfg.clearedAfter
            )

        results.unshift(...list)

        const oldest = batch[0]
        const oldestTime = oldest?.timestamp ?? oldest?.createdAt ?? 0
        if (cfg.clearedAfter != null && oldestTime <= cfg.clearedAfter) {
            break
        }

        nextId = resp.prev ?? oldest?.id
        if (nextId == null || nextId.length < 1 || nextId === prevId) {
            break
        }

        prevId = nextId
    }

    return mergeMessages([], results, count)
}

async function pullOneBot(
    cfg: PullHistoryConfig,
    count: number
): Promise<Message[]> {
    const bot = cfg.session.bot as OneBotBot<Context>

    if (bot.platform !== 'onebot') {
        cfg.logger.debug(
            `Skip history pull for session ${cfg.session.guildId}: current adapter is not OneBot.`
        )
        return []
    }

    if (cfg.session.isDirect) {
        const targetId = Number(cfg.session.userId)
        if (!Number.isFinite(targetId)) {
            cfg.logger.warn(
                `Skip history pull for private user ${cfg.session.userId}: invalid user id.`
            )
            return []
        }

        const results: OneBotHistoryMessage[] = []
        let messageSeq: number | undefined
        let oldestTime = Number.MAX_SAFE_INTEGER

        while (results.length < count) {
            const req: Record<string, unknown> = {
                user_id: targetId,
                message_seq: messageSeq,
                count: Math.min(count - results.length + 1, 20),
                reverseOrder: typeof messageSeq === 'number'
            }

            if (messageSeq == null) {
                delete req.message_seq
                delete req.reverseOrder
            }

            let batch: OneBotHistoryMessage[] = []
            try {
                const resp = await bot.internal._request(
                    'get_friend_msg_history',
                    req
                )
                batch =
                    (resp.data?.['messages'] as OneBotHistoryMessage[]) ?? []
            } catch (err) {
                cfg.logger.warn(
                    `Failed to pull OneBot private history for private user ${cfg.session.userId}`,
                    err
                )
                return []
            }

            if (batch.length < 1) {
                break
            }

            results.unshift(
                ...batch.filter((msg) => beforeFocus(msg, cfg.focusMessage))
            )

            const oldest = batch[0]
            if (oldest == null || oldest.time == null) {
                break
            }

            if (oldest.time >= oldestTime) {
                break
            }

            oldestTime = oldest.time
            messageSeq = oldest.message_seq
        }

        return (await Promise.all(
            results.map((msg) => toOneBotMsg(cfg.session, msg))
        ))
            .filter((msg): msg is Message => msg != null)
            .filter((msg) => !sameMessage(msg, cfg.focusMessage))
            .filter(
                (msg) =>
                    cfg.clearedAfter == null ||
                    (msg.timestamp != null && msg.timestamp > cfg.clearedAfter)
            )
            .slice(-count)
    }

    const targetId = Number(cfg.session.guildId)
    if (!Number.isFinite(targetId)) {
        cfg.logger.warn(
            `Skip history pull for guild ${cfg.session.guildId}: invalid group id.`
        )
        return []
    }

    let isNapCat = false
    try {
        const resp = await bot.internal._request('get_version_info', {})
        const appName = String(resp.data?.['app_name'] ?? '').toLowerCase()
        isNapCat = appName.includes('napcat')
    } catch (err) {
        cfg.logger.debug('Failed to detect OneBot app info', err)
    }

    const results: OneBotHistoryMessage[] = []
    let messageSeq: number | undefined
    let messageId: number | undefined
    let oldestTime = Number.MAX_SAFE_INTEGER

    while (results.length < count) {
        const req: Record<string, unknown> = {
            group_id: targetId,
            message_seq: messageSeq,
            message_id: messageId,
            count: Math.min(count - results.length + 1, isNapCat ? 50 : 30),
            reverseOrder: typeof messageSeq === 'number'
        }

        if (!isNapCat) {
            delete req.reverseOrder
        }

        if (messageSeq == null) {
            delete req.message_seq
            delete req.message_id
        }

        let batch: OneBotHistoryMessage[] = []
        try {
            const resp = await bot.internal._request(
                'get_group_msg_history',
                req
            )
            batch = (resp.data?.['messages'] as OneBotHistoryMessage[]) ?? []
        } catch (err) {
            cfg.logger.warn(
                `Failed to pull OneBot history for guild ${cfg.session.guildId}`,
                err
            )
            return []
        }

        if (batch.length < 1) {
            break
        }

        results.unshift(
            ...batch.filter((msg) => beforeFocus(msg, cfg.focusMessage))
        )

        const oldest = batch[0]
        if (oldest == null || oldest.time == null) {
            break
        }

        if (oldest.time >= oldestTime) {
            break
        }

        oldestTime = oldest.time
        messageSeq = oldest.message_seq
        messageId = oldest.message_id
    }

    return (await Promise.all(
        results.map((msg) => toOneBotMsg(cfg.session, msg))
    ))
        .filter((msg): msg is Message => msg != null)
        .filter((msg) => !sameMessage(msg, cfg.focusMessage))
        .filter(
            (msg) =>
                cfg.clearedAfter == null ||
                (msg.timestamp != null && msg.timestamp > cfg.clearedAfter)
        )
        .slice(-count)
}

async function toBotMsg(
    session: Session,
    msg: KoishiMessage
): Promise<Message | null> {
    const text = msg.content ?? ''
    const id = msg.user?.id ?? '0'
    const elements = msg.elements ?? h.parse(text)
    normalizeElementAssets(elements)
    const images = await getElementImages(elements)
    const content = mapElementToString(
        session,
        text,
        elements,
        images
    )

    if (content.length < 1) {
        return null
    }

    return {
        content,
        name: getNotEmptyString(
            msg.member?.name,
            msg.user?.nick,
            msg.user?.name,
            id
        ),
        id,
        messageId: msg.messageId ?? msg.id,
        timestamp: msg.timestamp ?? msg.createdAt,
        images,
        quote: msg.quote
            ? {
                  content: mapElementToString(
                      session,
                      msg.quote.content ?? '',
                      msg.quote.elements ?? h.parse(msg.quote.content ?? '')
                  ),
                  name: getNotEmptyString(
                      msg.quote.user?.name,
                      msg.quote.user?.nick,
                      msg.quote.user?.id
                  ),
                  id: msg.quote.user?.id,
                  messageId: msg.quote.id
              }
            : undefined
    }
}

async function toOneBotMsg(
    session: Session,
    msg: OneBotHistoryMessage
): Promise<Message | null> {
    const raw = msg.raw_message ?? ''
    const elements = parseCQCode(raw)
    normalizeElementAssets(elements)
    const images = await getElementImages(elements)
    const content = mapElementToString(session, raw, elements, images)

    if (content.length < 1) {
        return null
    }

    const id = msg.sender?.user_id

    return {
        content,
        name: getNotEmptyString(
            msg.sender?.nickname,
            msg.sender?.card,
            String(id ?? '0')
        ),
        id: id != null ? String(id) : '0',
        messageId: msg.message_id != null ? String(msg.message_id) : undefined,
        images,
        timestamp:
            msg.time == null
                ? undefined
                : msg.time < 1_000_000_000_000
                  ? msg.time * 1000
                  : msg.time
    }
}

function normalizeElementAssets(elements: h[]) {
    for (const element of elements) {
        if (element.type === 'img') {
            element.attrs.imageUrl ??=
                element.attrs.src ??
                element.attrs.url ??
                element.attrs.file ??
                element.attrs.path
            continue
        }

        if (
            element.type === 'file' ||
            element.type === 'video' ||
            element.type === 'audio'
        ) {
            element.attrs.chatluna_file_url ??=
                element.attrs.src ??
                element.attrs.url ??
                element.attrs.file ??
                element.attrs.path
        }
    }
}

async function getElementImages(
    elements: h[]
): Promise<MessageImage[] | undefined> {
    const images: MessageImage[] = []
    const keys = new Set<string>()

    for (const element of elements) {
        if (element.type !== 'img') {
            continue
        }

        const url = element.attrs.imageUrl as string | undefined

        if (!url) {
            continue
        }

        element.attrs.imageUrl ??= url

        let hash = (element.attrs.imageHash ?? element.attrs.file ?? '') as string
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            hash = await hashString(url, 8)
        }
        const key = `${hash}:${url}`

        if (keys.has(key)) {
            continue
        }

        keys.add(key)

        images.push({
            url,
            hash,
            formatted: hash ? `[image:${hash}]` : `<sticker>${url}</sticker>`
        })
    }

    if (images.length < 1) {
        return undefined
    }

    return images
}

function beforeFocus(msg: OneBotHistoryMessage, focus: Message) {
    if (msg.message_id != null && focus.messageId != null) {
        return String(msg.message_id) !== focus.messageId
    }

    if (focus.timestamp == null || msg.time == null) {
        return true
    }

    const time = msg.time * 1000
    return time < focus.timestamp
}

function sameMessage(left: Message, right: Message) {
    if (left.messageId != null && right.messageId != null) {
        return left.messageId === right.messageId
    }

    return (
        left.id === right.id &&
        left.timestamp === right.timestamp &&
        left.content === right.content
    )
}
