/* eslint-disable generator-star-spacing */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {} from '@initencounter/vits'
import {
    AIMessage,
    BaseMessage,
    HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import { StructuredTool, tool } from '@langchain/core/tools'
import { Context, h, Logger, Random, Session, sleep } from 'koishi'
import { AgentEvent, MessageQueue } from 'koishi-plugin-chatluna/llm-core/agent'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { Config } from '..'
import {
    CharacterBaseMessageSnapshot,
    CharacterMessageSnapshot,
    CharacterPresetSnapshot,
    ChatLunaChain,
    GroupTemp,
    GuildConfig,
    Message,
    PrivateConfig,
    PresetTemplate,
    StreamedModelResponseChunk,
    WakeUpReplyRepeatRule
} from '../types'
import {
    createChatLunaChain,
    extractNextReplyReasons,
    formatCompletionMessages,
    formatMessage,
    formatMessageString,
    formatTimestamp,
    getElementText,
    isEmoticonStatement,
    parseResponse,
    sendElements,
    setLogger,
    trimCompletionMessages,
    voiceRender
} from '../utils/index'
import { Preset } from '../preset'

import type {} from 'koishi-plugin-chatluna/services/chat'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import { ComputedRef } from 'koishi-plugin-chatluna'

let logger: Logger

type ParsedResponse = Awaited<ReturnType<typeof parseResponse>>
type RuntimeConfig = Config & (GuildConfig | PrivateConfig)
type StreamedParsedResponseChunk = StreamedModelResponseChunk<ParsedResponse>

interface StreamedResponseContentChunk {
    responseMessage: BaseMessage
    responseContent: string
    isIntermediate: boolean
    toolCalls?: ReplyToolCall[]
    toolErrors?: string[]
}

interface ReplyToolCall {
    name: string
    args: Record<string, unknown>
}

interface NextReplyToolCondition {
    type?: unknown
    seconds?: unknown
    user_id?: unknown
    max_wait_seconds?: unknown
}

interface NextReplyToolGroup {
    conditions?: unknown
}

const replyToolProgress = '__character_reply_progress__'

function snapshotPreset(preset: PresetTemplate): CharacterPresetSnapshot {
    return {
        name: preset.name,
        status: preset.status,
        nick_name: preset.nick_name.slice(),
        input: { rawString: preset.input.rawString },
        system: { rawString: preset.system.rawString },
        mute_keyword: preset.mute_keyword?.slice(),
        path: preset.path
    }
}

function snapshotMessage(value: Message): CharacterMessageSnapshot
function snapshotMessage(value: Message[]): CharacterMessageSnapshot[]
function snapshotMessage(value: Message | Message[]) {
    return JSON.parse(JSON.stringify(value))
}

function snapshotBaseMessage(value: BaseMessage): CharacterBaseMessageSnapshot
function snapshotBaseMessage(
    value: BaseMessage[]
): CharacterBaseMessageSnapshot[]
function snapshotBaseMessage(value: BaseMessage | BaseMessage[]) {
    return JSON.parse(JSON.stringify(value))
}

class PendingMessageQueue extends MessageQueue {
    private _messages: {
        message: Message
        triggerReason?: string
    }[] = []

    constructor(
        private _enableMessageId: boolean,
        private _onDrain?: (messages: Message[]) => void
    ) {
        super()
    }

    pushRaw(message: Message, triggerReason?: string) {
        this._messages.push({ message, triggerReason })
        return true
    }

    drain() {
        const result = super.drain()

        if (this._messages.length < 1) {
            return result
        }

        const entries = this._messages.splice(0)
        const messages = entries.map((entry) => entry.message)
        this._onDrain?.(messages)

        result.push(
            new HumanMessage(
                'New messages arrived while using tools. Treat them as the latest updates in this turn.\n\n' +
                    messages
                        .map((message) =>
                            formatMessageString(message, this._enableMessageId)
                        )
                        .join('\n\n')
            )
        )

        return result
    }

    get pending() {
        return super.pending || this._messages.length > 0
    }

    takeLatestTrigger() {
        for (let i = this._messages.length - 1; i >= 0; i--) {
            const entry = this._messages[i]
            if (!entry.triggerReason) {
                continue
            }

            this._messages = []
            return entry
        }
    }
}

function extractNextReplyReasonsFromTool(value: unknown) {
    if (typeof value === 'string' && value.trim()) {
        return [value.trim()]
    }

    if (!Array.isArray(value)) {
        return []
    }

    const reasons: string[] = []

    for (const item of value) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            continue
        }

        const group = item as NextReplyToolGroup
        if (!Array.isArray(group.conditions)) {
            continue
        }

        const tokens = group.conditions
            .map((it) => {
                if (!it || typeof it !== 'object' || Array.isArray(it)) {
                    return undefined
                }

                const condition = it as NextReplyToolCondition
                if (condition.type === 'message_from_user') {
                    const userId =
                        typeof condition.user_id === 'string' ||
                        typeof condition.user_id === 'number'
                            ? String(condition.user_id).trim()
                            : ''
                    if (userId) {
                        return `id_${userId}`
                    }

                    return undefined
                }

                if (condition.type === 'no_message_from_user') {
                    const userId =
                        typeof condition.user_id === 'string' ||
                        typeof condition.user_id === 'number'
                            ? String(condition.user_id).trim()
                            : ''
                    if (
                        typeof condition.seconds === 'number' &&
                        Number.isFinite(condition.seconds) &&
                        condition.seconds > 0 &&
                        userId
                    ) {
                        if (userId === 'all') {
                            return `time_${condition.seconds}s`
                        }

                        if (
                            typeof condition.max_wait_seconds === 'number' &&
                            Number.isFinite(condition.max_wait_seconds) &&
                            condition.max_wait_seconds > 0
                        ) {
                            return `time_${condition.seconds}s_id_${userId}_max_${condition.max_wait_seconds}s`
                        }

                        return `time_${condition.seconds}s_id_${userId}`
                    }
                }

                return undefined
            })
            .filter((it) => typeof it === 'string')

        if (tokens.length > 0) {
            reasons.push(tokens.join('&'))
        }
    }

    return reasons
}

function buildNextReplyToolTags(value: unknown) {
    if (typeof value === 'string' && value.trim()) {
        const reason = value
            .trim()
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')
            .replaceAll('"', '&quot;')
        return [`<next_reply reason="${reason}" />`]
    }

    if (!Array.isArray(value)) {
        return []
    }

    const tags: string[] = []

    for (const [groupIdx, item] of value.entries()) {
        if (!item || typeof item !== 'object' || Array.isArray(item)) {
            continue
        }

        const group = item as NextReplyToolGroup
        if (!Array.isArray(group.conditions)) {
            continue
        }

        for (const conditionItem of group.conditions) {
            if (
                !conditionItem ||
                typeof conditionItem !== 'object' ||
                Array.isArray(conditionItem)
            ) {
                continue
            }

            const condition = conditionItem as NextReplyToolCondition
            if (condition.type === 'message_from_user') {
                const userId =
                    typeof condition.user_id === 'string' ||
                    typeof condition.user_id === 'number'
                        ? String(condition.user_id).trim()
                        : ''
                if (userId) {
                    const escapedUserId = userId
                        .replaceAll('&', '&amp;')
                        .replaceAll('<', '&lt;')
                        .replaceAll('>', '&gt;')
                        .replaceAll('"', '&quot;')
                    tags.push(
                        `<next_reply group="${groupIdx}" type="message_from_user" user_id="${escapedUserId}" />`
                    )
                }
                continue
            }

            if (condition.type === 'no_message_from_user') {
                const userId =
                    typeof condition.user_id === 'string' ||
                    typeof condition.user_id === 'number'
                        ? String(condition.user_id).trim()
                        : ''
                if (
                    typeof condition.seconds === 'number' &&
                    Number.isFinite(condition.seconds) &&
                    condition.seconds > 0 &&
                    userId
                ) {
                    const escapedUserId = userId
                        .replaceAll('&', '&amp;')
                        .replaceAll('<', '&lt;')
                        .replaceAll('>', '&gt;')
                        .replaceAll('"', '&quot;')
                    const maxWait =
                        userId !== 'all' &&
                        typeof condition.max_wait_seconds === 'number' &&
                        Number.isFinite(condition.max_wait_seconds) &&
                        condition.max_wait_seconds > 0
                            ? ` max_wait_seconds="${condition.max_wait_seconds}"`
                            : ''
                    tags.push(
                        `<next_reply group="${groupIdx}" type="no_message_from_user" user_id="${escapedUserId}" seconds="${condition.seconds}"${maxWait} />`
                    )
                }
            }
        }
    }

    return tags
}

function renderToolText(value: string) {
    return value.replaceAll('\\n', '\n')
}

function createReplyTools(
    ctx: Context,
    session: Session,
    config: RuntimeConfig
): StructuredTool[] {
    const canAt = !session.isDirect && 'isAt' in config && config.isAt
    const canFace = session.platform === 'qq' || session.platform === 'onebot'
    const elementTypes = ['text', 'image', 'sticker', 'audio']

    if (canAt) {
        elementTypes.push('at')
    }

    if (canFace) {
        elementTypes.push('face')
    }

    if (ctx.vits) {
        elementTypes.push('voice')
    }

    if (session.platform !== 'qq') {
        elementTypes.push('file')

        if (session.platform === 'onebot') {
            elementTypes.push('video')
        }
    }

    if (session.platform === 'qq' && session.isDirect) {
        elementTypes.push('markdown')
    }

    const element = {
        type: 'object',
        properties: {
            type: {
                type: 'string',
                enum: elementTypes,
                description: 'Element type'
            },
            text: {
                type: 'string',
                description:
                    'Required text for type=text, type=markdown, or type=voice. ' +
                    'A plain text element must be {"type":"text","text":"..."}, not {"text":"..."}.'
            },
            url: {
                type: 'string',
                description:
                    'Required HTTP(S) URL for type=image, type=sticker, type=audio, type=file, or type=video'
            },
            id: {
                type: 'string',
                description:
                    'User ID for type=at, QQ face ID for type=face, or optional voice ID for type=voice'
            },
            name: {
                type: 'string',
                description: 'File name for type=file'
            }
        },
        required: ['type']
    }

    const message = {
        type: 'object',
        properties: {
            quote: {
                type: 'string',
                description: 'Platform message ID to quote'
            },
            content: {
                type: 'array',
                description:
                    'Ordered elements inside this message. Every element must include type. ' +
                    'text, image, at, and face can coexist. sticker, audio, file, video, voice, and markdown must be the sole element. ' +
                    'Use messages: [] when no reply is needed.',
                items: {
                    ...element
                }
            }
        },
        required: ['content']
    }

    const props: Record<string, unknown> = {
        is_final: {
            type: 'boolean',
            description:
                'Whether this is the final reply of the current turn. Use false only for temporary progress updates, and only when you call the next non-character tool in the same assistant response. Never call character_reply with is_final=false as the only tool call. Use true for the final reply of this turn.'
        },
        messages: {
            type: 'array',
            description:
                'Chat bubbles to send. Each item is one message. Use an empty array when no reply is needed.',
            items: {
                ...message
            }
        }
    }

    if (
        config.experimentalToolCallReply &&
        config.toolCalling &&
        config.toolCallReplyNextReply &&
        (!config.enableFixedIntervalTrigger || config.messageInterval !== 0)
    ) {
        props['next_reply'] = {
            type: 'array',
            description:
                "Set the next proactive trigger. Use this when you may need to speak again after this turn, such as waiting for someone's next reply, waiting for someone to finish sending a multi-part message, or speaking again after a period of silence. Examples: wait for user 123456789 to send the next message; wait until no one sends any new message for 600 seconds; wait for user 987654321 to send the first new message, then wait 10 seconds for them to stop sending more messages. Pass an array where each object is one OR group, and any group can trigger the reply. Inside each group, conditions are AND and must all be satisfied. New conditions replace old ones. If another trigger causes a reply before the condition is met, the old condition becomes invalid. Conditions are cleared after a successful trigger.",
            items: {
                type: 'object',
                properties: {
                    conditions: {
                        type: 'array',
                        description:
                            'Conditions inside the same group. All of them must be satisfied together as AND.',
                        items: {
                            type: 'object',
                            properties: {
                                type: {
                                    type: 'string',
                                    enum: [
                                        'message_from_user',
                                        'no_message_from_user'
                                    ],
                                    description:
                                        'Condition type. message_from_user means a specific user sends a new message. no_message_from_user means no new messages arrive from a target user for a period of time. Use user_id="all" to mean no one sends any new message.'
                                },
                                seconds: {
                                    type: 'number',
                                    description:
                                        'Waiting time in seconds. Required for no_message_from_user. When user_id is all, counting starts immediately. Otherwise, counting starts only after the target user sends the first new message.'
                                },
                                user_id: {
                                    type: 'string',
                                    description:
                                        'Platform user ID of the target user. Required for message_from_user and no_message_from_user. Use all to mean any user.'
                                },
                                max_wait_seconds: {
                                    type: 'number',
                                    description:
                                        'Maximum total waiting time in seconds. Optional only for no_message_from_user when user_id is not all. Counting starts after the current turn finishes and this next_reply is registered, and the trigger fires when the limit is reached even if the user never sends the first message.'
                                }
                            },
                            required: ['type']
                        }
                    }
                },
                required: ['conditions']
            }
        }
    }
    const required = ['is_final', 'messages']

    if (config.toolCallReplyStatusTag) {
        props.status = {
            type: 'string',
            description:
                'Continuously maintained status text. You MUST carry over and incrementally update the previous status; do not rewrite from scratch each time. Preserve recent history and memory entries until they are no longer relevant. Follow the exact format defined in the system prompt. Do not include XML tags in this field.'
        }
        required.push('status')
    }

    if (config.toolCallReplyThinkTag) {
        props.think = {
            type: 'string',
            description: "The character's internal thoughts about the message."
        }
        required.push('think')
    }

    for (const field of ctx.chatluna_character.getReplyToolFields()) {
        if (field.isAvailable && !field.isAvailable(ctx, session, config)) {
            continue
        }

        props[field.name] = field.schema
    }

    const tools: StructuredTool[] = []

    if (config.experimentalToolCallReply) {
        tools.push(
            tool(
                async (args) => {
                    const input = args as Record<string, unknown>

                    for (const field of ctx.chatluna_character.getReplyToolFields()) {
                        if (input[field.name] == null) {
                            continue
                        }

                        if (
                            field.isAvailable &&
                            !field.isAvailable(ctx, session, config)
                        ) {
                            continue
                        }

                        await field.invoke(
                            ctx,
                            session,
                            input[field.name],
                            config
                        )
                    }

                    return input.is_final === false
                        ? replyToolProgress
                        : {
                              lc_direct_tool_output: true,
                              replyEmitted: true
                          }
                },
                {
                    name: 'character_reply',
                    description:
                        'Send in-character reply messages. Progress updates with is_final=false must be paired with the next non-character tool call in the same assistant response. Use the literal string `\\n` for line breaks in all string fields. Do not use real newline characters. Do not wrap content in XML tags inside any field.',
                    returnDirect: false,
                    verboseParsingErrors: true,
                    schema: {
                        type: 'object',
                        properties: props,
                        required
                    }
                }
            )
        )
    }

    if (!config.toolCallReplyWakeUpReply) {
        return tools
    }

    tools.push(
        tool(
            async () => {
                const key = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
                const list =
                    ctx.chatluna_character_trigger.getWakeUpReplies(key)

                if (list.length < 1) {
                    return 'No wake_up_reply records.'
                }

                return list
                    .map((item, idx) => {
                        return `${idx + 1}. uid=${item.uid}; repeat=${item.repeatRule ?? 'once'}; time=${item.rawTime}; next=${formatTimestamp(new Date(item.triggerAt))}; reason=${item.reason || '(empty)'}`
                    })
                    .join('\n')
            },
            {
                name: 'wake_up_reply_query',
                description:
                    'Query existing wake_up_reply records for this chat. Use the returned uid with wake_up_reply_update or wake_up_reply_delete.',
                returnDirect: false,
                schema: {
                    type: 'object',
                    properties: {},
                    required: []
                }
            }
        ),
        tool(
            async (args) => {
                const input = args as Record<string, unknown>
                const key = `${session.isDirect ? 'private' : 'group'}:${session.isDirect ? session.userId : session.guildId}`
                const repeat = input.repeat
                const repeatRule: WakeUpReplyRepeatRule =
                    repeat === 'daily' ||
                    repeat === 'weekly' ||
                    repeat === 'monthly' ||
                    repeat === 'yearly'
                        ? repeat
                        : 'once'
                const item =
                    await ctx.chatluna_character_trigger.registerWakeUpReply(
                        session,
                        String(input.time),
                        typeof input.reason === 'string' ? input.reason : '',
                        repeatRule,
                        config
                    )

                if (!item) {
                    return 'Failed to create wake_up_reply: invalid time format. Use YYYY/MM/DD-HH:mm:ss for once, HH:mm:ss for daily, 1-HH:mm:ss for weekly, DD-HH:mm:ss for monthly, or MM/DD-HH:mm:ss for yearly.'
                }

                await ctx.chatluna_character_trigger.setWakeUpReplies(
                    session,
                    ctx.chatluna_character_trigger.getWakeUpReplies(key)
                )
                return `Created wake_up_reply: uid=${item.uid}.`
            },
            {
                name: 'wake_up_reply_create',
                description:
                    'Create a scheduled proactive trigger (one-shot or recurring). Use this to speak again at a specific time or on a regular schedule (daily, weekly, etc.) for reminders or planned actions.',
                returnDirect: false,
                schema: {
                    type: 'object',
                    properties: {
                        time: {
                            type: 'string',
                            description:
                                'Trigger time. once: YYYY/MM/DD-HH:mm:ss, daily: HH:mm:ss, weekly: 1-HH:mm:ss, monthly: DD-HH:mm:ss, yearly: MM/DD-HH:mm:ss.'
                        },
                        reason: {
                            type: 'string',
                            description: 'Reason or note for the future trigger'
                        },
                        repeat: {
                            type: 'string',
                            enum: [
                                'once',
                                'daily',
                                'weekly',
                                'monthly',
                                'yearly'
                            ],
                            description:
                                'Repeat rule. once is one-shot. daily, weekly, monthly, and yearly automatically reschedule after triggering.'
                        }
                    },
                    required: ['time', 'reason']
                }
            }
        ),
        tool(
            async (args) => {
                const input = args as Record<string, unknown>
                const repeat = input.repeat
                const repeatRule: WakeUpReplyRepeatRule | undefined =
                    repeat === 'once' ||
                    repeat === 'daily' ||
                    repeat === 'weekly' ||
                    repeat === 'monthly' ||
                    repeat === 'yearly'
                        ? repeat
                        : undefined
                const ok =
                    await ctx.chatluna_character_trigger.updateWakeUpReply(
                        session,
                        String(input.uid),
                        typeof input.time === 'string' ? input.time : undefined,
                        typeof input.reason === 'string'
                            ? input.reason
                            : undefined,
                        repeatRule,
                        config
                    )

                return ok
                    ? 'Updated wake_up_reply.'
                    : 'Failed to update wake_up_reply: invalid uid, repeat rule, or time format.'
            },
            {
                name: 'wake_up_reply_update',
                description:
                    'Update an existing scheduled trigger by the uid returned from wake_up_reply_query. You can modify the time, reason, or repeat rule.',
                returnDirect: false,
                schema: {
                    type: 'object',
                    properties: {
                        uid: {
                            type: 'string',
                            description:
                                'Short uid returned by wake_up_reply_query'
                        },
                        time: {
                            type: 'string',
                            description:
                                'Optional new trigger time (same formats as create)'
                        },
                        reason: {
                            type: 'string',
                            description: 'Optional new reason or note'
                        },
                        repeat: {
                            type: 'string',
                            enum: [
                                'once',
                                'daily',
                                'weekly',
                                'monthly',
                                'yearly'
                            ],
                            description: 'Optional new repeat rule'
                        }
                    },
                    required: ['uid']
                }
            }
        ),
        tool(
            async (args) => {
                const input = args as Record<string, unknown>
                const ok =
                    await ctx.chatluna_character_trigger.deleteWakeUpReply(
                        session,
                        String(input.uid)
                    )

                return ok
                    ? 'Deleted wake_up_reply.'
                    : 'Failed to delete wake_up_reply: invalid uid.'
            },
            {
                name: 'wake_up_reply_delete',
                description:
                    'Delete an existing wake_up_reply by the uid returned from wake_up_reply_query.',
                returnDirect: false,
                schema: {
                    type: 'object',
                    properties: {
                        uid: {
                            type: 'string',
                            description:
                                'Short uid returned by wake_up_reply_query'
                        }
                    },
                    required: ['uid']
                }
            }
        )
    )

    return tools
}

function formatReplyUserPrompt(session: Session, config: RuntimeConfig) {
    const tips: string[] = []

    if (config.experimentalToolCallReply && config.toolCalling) {
        tips.push(
            'All user-visible reply content must be sent through `character_reply`. Do not end the turn with plain text outside this tool.',
            'Before calling time-consuming tools (such as searching), send a progress update to the user with `character_reply` and call the time-consuming tool in the same assistant response. Never call `character_reply` with `is_final=false` alone. Quick tools that finish almost instantly, such as reading a voice message, do not need this.'
        )

        if (config.toolCallReplyStatusTag) {
            tips.push(
                'The `status` field must strictly follow the <status> format specified in the system prompt. Do not change that format arbitrarily, and do not include the opening or closing <status> XML tags in the field value.',
                'Your conversation context does not include previous tool call records. Use the memory section in `status` to briefly note what each tool call did (e.g. "searched X", "set wake_up for Y"). Keep these notes until the context no longer contains any related messages or the topic is clearly no longer relevant, then drop them. This prevents duplicate or conflicting operations.'
            )
        }
    }

    if (
        config.toolCallReplyNextReply &&
        (!config.enableFixedIntervalTrigger || config.messageInterval !== 0)
    ) {
        tips.push(
            'Actively decide whether this turn needs `next_reply` triggers.'
        )
    }

    if (config.toolCallReplyWakeUpReply && config.toolCalling) {
        tips.push(
            'Use independent `wake_up_reply_*` tools for future proactive triggers. Do not use XML tags for this, and do not put it inside `character_reply`. Always query existing tasks with `wake_up_reply_query` before creating, updating, or deleting them to avoid duplicates.'
        )
    }

    return tips.join('\n')
}

function buildXmlMessage(args: Record<string, unknown>) {
    const isHttpUrl = (value: unknown) => {
        return (
            typeof value === 'string' &&
            (value.startsWith('http://') || value.startsWith('https://'))
        )
    }

    const escape = (value: unknown, attr = false) => {
        const text = String(value ?? '')
            .replaceAll('&', '&amp;')
            .replaceAll('<', '&lt;')
            .replaceAll('>', '&gt;')

        if (!attr) {
            return renderToolText(text)
        }

        return text.replaceAll('"', '&quot;')
    }

    const buildElement = (el: Record<string, unknown>) => {
        if (el.type === 'text') {
            return escape(el.text)
        }

        if (el.type === 'at') {
            return `<at>${escape(el.id)}</at>`
        }

        if (el.type === 'face') {
            return `<face>${escape(el.id)}</face>`
        }

        if (el.type === 'sticker') {
            if (!isHttpUrl(el.url)) {
                return ''
            }
            return `<sticker>${escape(el.url)}</sticker>`
        }

        if (el.type === 'image') {
            if (!isHttpUrl(el.url)) {
                return ''
            }
            return `<image>${escape(el.url)}</image>`
        }

        if (el.type === 'audio') {
            if (!isHttpUrl(el.url)) {
                return ''
            }
            return `<audio>${escape(el.url)}</audio>`
        }

        if (el.type === 'file') {
            if (!isHttpUrl(el.url)) {
                return ''
            }
            return `<file name="${escape(el.name ?? 'file', true)}">${escape(el.url)}</file>`
        }

        if (el.type === 'video') {
            if (!isHttpUrl(el.url)) {
                return ''
            }
            return `<video>${escape(el.url)}</video>`
        }

        if (el.type === 'markdown') {
            return `<markdown>${escape(el.text)}</markdown>`
        }

        if (el.type === 'voice') {
            return `<voice id="${escape(el.id, true)}">${escape(el.text)}</voice>`
        }

        return ''
    }

    const quote =
        typeof args.quote === 'number' ||
        (typeof args.quote === 'string' && args.quote.length > 0)
            ? ` quote="${escape(args.quote, true)}"`
            : ''

    if (Array.isArray(args.content)) {
        const content = args.content
            .filter(
                (item) =>
                    item && typeof item === 'object' && !Array.isArray(item)
            )
            .map((item) => buildElement(item as Record<string, unknown>))
            .join('')

        return `<message${quote}>${content}</message>`
    }

    return `<message${quote}></message>`
}

function parseReplyTools(
    config: Config | GuildConfig | PrivateConfig,
    calls: ReplyToolCall[]
) {
    const messages: string[] = []
    const nextReplyReasons: string[] = []
    let status: string | undefined

    for (const call of calls) {
        if (call.name !== 'character_reply') {
            continue
        }

        if (
            config.toolCallReplyStatusTag &&
            typeof call.args.status === 'string'
        ) {
            status = call.args.status
        }

        if (Array.isArray(call.args.messages)) {
            for (const item of call.args.messages) {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    messages.push(
                        buildXmlMessage(item as Record<string, unknown>)
                    )
                }
            }
        }

        if (
            config.toolCallReplyNextReply &&
            (!config.enableFixedIntervalTrigger ||
                config.messageInterval !== 0) &&
            call.args.is_final !== false
        ) {
            nextReplyReasons.push(
                ...extractNextReplyReasonsFromTool(call.args.next_reply)
            )
        }
    }

    return {
        status,
        rawMessage: messages.join(''),
        nextReplyReasons
    }
}

function renderReplyToolXml(
    ctx: Context,
    session: Session,
    config: Config | GuildConfig | PrivateConfig,
    calls: ReplyToolCall[]
) {
    const messages: string[] = []
    const actions: string[] = []
    const blocks: string[] = []
    const fields = ctx.chatluna_character.getReplyToolFields()

    for (const call of calls) {
        if (call.name !== 'character_reply') {
            continue
        }

        if (typeof call.args.status === 'string') {
            if (config.toolCallReplyStatusTag) {
                blocks.push(
                    `<status>\n${renderToolText(call.args.status)}\n</status>`
                )
            }
        }

        if (
            config.toolCallReplyThinkTag &&
            typeof call.args.think === 'string' &&
            call.args.think.trim()
        ) {
            blocks.push(
                `<think>\n${renderToolText(call.args.think.trim())}\n</think>`
            )
        }

        if (Array.isArray(call.args.messages)) {
            for (const item of call.args.messages) {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    messages.push(
                        buildXmlMessage(item as Record<string, unknown>)
                    )
                }
            }
        }

        if (
            config.toolCallReplyNextReply &&
            (!config.enableFixedIntervalTrigger ||
                config.messageInterval !== 0) &&
            call.args.is_final !== false
        ) {
            actions.push(...buildNextReplyToolTags(call.args.next_reply))
        }

        for (const field of fields) {
            if (call.args[field.name] == null) {
                continue
            }

            if (field.isAvailable && !field.isAvailable(ctx, session, config)) {
                continue
            }

            const rendered = field.render(
                ctx,
                session,
                call.args[field.name],
                config
            )
            if (Array.isArray(rendered)) {
                actions.push(
                    ...rendered.filter((item) => item.trim().length > 0)
                )
                continue
            }

            if (typeof rendered === 'string' && rendered.trim().length > 0) {
                actions.push(rendered)
            }
        }
    }

    if (actions.length > 0) {
        blocks.push(`<action>\n${actions.join('\n')}\n</action>`)
    }

    if (messages.length > 0) {
        blocks.push(`<output>\n${messages.join('\n')}\n</output>`)
    }

    if (blocks.length < 1) {
        return ''
    }

    return blocks.join('\n\n')
}

function stripInternalTriggerTags(content: string) {
    return content
        .replace(/<next_reply\b[^>]*\/>/gi, '')
        .replace(/<wake_up_reply\b[^>]*\/>/gi, '')
}

async function parseResponseContent(
    ctx: Context,
    session: Session,
    config: RuntimeConfig,
    chunk: StreamedResponseContentChunk
): Promise<StreamedParsedResponseChunk> {
    let parsedResponse: ParsedResponse
    const { responseMessage, responseContent, isIntermediate } = chunk
    const toolErrors = chunk.toolErrors ?? []
    const calls =
        config.experimentalToolCallReply && chunk.toolCalls?.length > 0
            ? filterReplyToolCalls(config, chunk.toolCalls, toolErrors)
            : undefined
    const toolState =
        calls && calls.length > 0 ? parseReplyTools(config, calls) : undefined
    const hasCalls = calls && calls.length > 0
    const renderedContent = hasCalls
        ? renderReplyToolXml(ctx, session, config, calls)
        : responseContent

    if (!hasCalls && toolErrors.length > 0) {
        throw new Error(
            `Failed to parse response: invalid character_reply tool call. ${toolErrors.join('; ')}`
        )
    }

    if (
        config.experimentalToolCallReply &&
        config.toolCalling &&
        !hasCalls &&
        !isIntermediate
    ) {
        throw new Error(
            'Failed to parse response: missing character_reply tool call'
        )
    }

    if (
        !toolState &&
        isIntermediate &&
        (/^Invoking\s+"[^"]+"\s+with\s+/i.test(responseContent.trim()) ||
            responseContent.trim().startsWith('Tool '))
    ) {
        logger.debug(
            'Failed to parse intermediate agent content, fallback to raw send: %s',
            responseContent
        )

        return {
            responseMessage,
            responseContent: renderedContent,
            toolCalls: calls,
            parsedResponse: {
                elements: [],
                rawMessage: responseContent,
                status: undefined,
                sticker: undefined,
                messageType: 'text'
            }
        }
    }

    try {
        if (toolState && toolState.rawMessage.length > 0) {
            parsedResponse = await parseResponse(
                ctx,
                session,
                `<output>${toolState.rawMessage}</output>`,
                session.isDirect ? false : (config.isAt ?? false),
                config
            )
            parsedResponse.status = toolState.status ?? parsedResponse.status
        } else if (toolState) {
            parsedResponse = {
                elements: [],
                rawMessage: '',
                status: toolState.status,
                sticker: undefined,
                messageType: 'text'
            }
        } else {
            parsedResponse = await parseResponse(
                ctx,
                session,
                stripInternalTriggerTags(responseContent),
                session.isDirect ? false : (config.isAt ?? false),
                config
            )
        }
    } catch (error) {
        if (!isIntermediate || responseMessage.content == null) {
            throw error
        }

        logger.debug(
            'Failed to parse intermediate agent content, fallback to raw send: %s',
            responseContent
        )

        parsedResponse = {
            elements: [],
            rawMessage: responseContent,
            status: undefined,
            sticker: undefined,
            messageType: 'text'
        }
    }

    return {
        responseMessage,
        responseContent: renderedContent,
        toolCalls: calls,
        parsedResponse
    }
}

function createStreamConfig(
    session: Session,
    model: ChatLunaChatModel,
    presetName: string,
    signal?: AbortSignal,
    configurable?: Record<string, unknown>
) {
    const conversationId = `${session.platform}:${
        session.isDirect ? 'private' : 'guild'
    }:${session.isDirect ? session.userId : (session.guildId ?? session.channelId)}`

    return {
        configurable: {
            session,
            model,
            userId: session.userId,
            conversationId,
            preset: presetName,
            ...(configurable ?? {})
        },
        signal
    }
}

// eslint-disable-next-line prettier/prettier
async function* streamAgentResponseContents(
    ctx: Context,
    chain: ChatLunaChain,
    session: Session,
    model: ChatLunaChatModel,
    config: RuntimeConfig,
    presetName: string,
    systemMessage: BaseMessage | undefined,
    historyMessages: BaseMessage[],
    lastMessage: BaseMessage,
    signal?: AbortSignal,
    messageQueue?: MessageQueue,
    onAgentEvent?: (event: AgentEvent) => void | Promise<void>
): AsyncGenerator<StreamedResponseContentChunk> {
    const conversationId = `${session.platform}:${
        session.isDirect ? 'private' : 'guild'
    }:${session.isDirect ? session.userId : (session.guildId ?? session.channelId)}`

    let finalReply = false

    const responseStream = chain.stream(
        {
            instructions: getMessageContent(systemMessage?.content ?? ''),
            chat_history: historyMessages,
            input: lastMessage,
            configurable: {
                session,
                conversationId,
                preset: presetName
            }
        },
        createStreamConfig(session, model, presetName, signal, {
            messageQueue,
            onAgentEvent
        })
    )

    for await (const responseChunk of responseStream) {
        const toolErrors: string[] = []
        const calls =
            config.experimentalToolCallReply &&
            responseChunk.toolCalls?.length > 0
                ? filterReplyToolCalls(
                      config,
                      responseChunk.toolCalls,
                      toolErrors
                  )
                : responseChunk.toolCalls

        if (
            calls?.some((call) => {
                return (
                    call.name === 'character_reply' &&
                    call.args.is_final !== false
                )
            })
        ) {
            finalReply = true
        }

        if (
            finalReply &&
            responseChunk.phase === 'final' &&
            (!calls || calls.length < 1)
        ) {
            continue
        }

        const responseMessage = responseChunk.message
        const responseContent = getMessageContent(responseMessage.content)
        const isIntermediate = responseChunk.phase === 'intermediate'

        if (
            isIntermediate &&
            responseChunk.toolCalls?.every((call) =>
                call.name.startsWith('wake_up_reply_')
            )
        ) {
            continue
        }

        const renderedContent =
            config.experimentalToolCallReply && calls && calls.length > 0
                ? renderReplyToolXml(ctx, session, config, calls)
                : responseContent
        if (renderedContent.trim().length < 1) {
            if (toolErrors.length > 0) {
                throw new Error(
                    `Failed to parse response: invalid character_reply tool call. ${toolErrors.join('; ')}`
                )
            }
            if (
                config.experimentalToolCallReply &&
                responseChunk.phase === 'final' &&
                !finalReply
            ) {
                throw new Error(
                    'Failed to parse response: missing character_reply tool call'
                )
            }
            continue
        }

        if (isIntermediate) {
            logger.debug(`agent intermediate response:\n${renderedContent}`)
        } else {
            logger.debug(`model response:\n${renderedContent}`)
        }

        yield {
            responseMessage,
            responseContent: renderedContent,
            isIntermediate,
            toolCalls: calls,
            toolErrors
        }
    }
}

async function registerResponseTriggers(
    ctx: Context,
    key: string,
    config: RuntimeConfig,
    nextReplyReasons: string[]
) {
    const store = ctx.chatluna_character_trigger

    if (nextReplyReasons.length > 0) {
        store.clearNextReplies(key)
        for (const reason of nextReplyReasons) {
            const accepted = store.registerNextReply(key, reason, config)

            if (!accepted) {
                logger.warn(
                    `Ignore invalid <next_reply reason="${reason}" /> for session ${key}`
                )
            }
        }
    }
}

async function initializeModel(
    ctx: Context,
    platform: string,
    modelName: string
) {
    return await ctx.chatluna.createChatModel(platform, modelName)
}

async function setupModelPool(
    ctx: Context,
    config: Config
): Promise<{
    globalPrivateModel: ComputedRef<ChatLunaChatModel>
    globalGroupModel: ComputedRef<ChatLunaChatModel>
    modelPool: Record<string, Promise<ComputedRef<ChatLunaChatModel>>>
}> {
    const [privatePlatform, privateModelName] = parseRawModelName(
        config.globalPrivateConfig.model
    )
    const globalPrivateModel = await initializeModel(
        ctx,
        privatePlatform,
        privateModelName
    )
    logger.info(
        'global private model loaded %c',
        config.globalPrivateConfig.model
    )

    const [groupPlatform, groupModelName] = parseRawModelName(
        config.globalGroupConfig.model
    )
    const globalGroupModel = await initializeModel(
        ctx,
        groupPlatform,
        groupModelName
    )
    logger.info('global group model loaded %c', config.globalGroupConfig.model)

    const modelPool: Record<
        string,
        Promise<ComputedRef<ChatLunaChatModel>>
    > = {}

    for (const groupId of Object.keys(config.configs)) {
        const guildConfig = config.configs[groupId]
        if (!guildConfig.model) {
            continue
        }

        if (guildConfig.model === config.globalGroupConfig.model) {
            continue
        }

        const key = `group:${groupId}`
        modelPool[key] = (async () => {
            const [platform, modelName] = parseRawModelName(guildConfig.model)
            const loadedModel = await initializeModel(ctx, platform, modelName)

            logger.info(
                'override model loaded %c for group %c',
                guildConfig.model,
                groupId
            )

            modelPool[key] = Promise.resolve(loadedModel)
            return loadedModel
        })()
    }

    for (const userId of Object.keys(config.privateConfigs)) {
        const privateConfig = config.privateConfigs[userId]
        if (!privateConfig.model) {
            continue
        }

        if (privateConfig.model === config.globalPrivateConfig.model) {
            continue
        }

        const key = `private:${userId}`
        modelPool[key] = (async () => {
            const [platform, modelName] = parseRawModelName(privateConfig.model)
            const loadedModel = await initializeModel(ctx, platform, modelName)

            logger.info(
                'override model loaded %c for private %c',
                privateConfig.model,
                userId
            )

            modelPool[key] = Promise.resolve(loadedModel)
            return loadedModel
        })()
    }

    return { globalPrivateModel, globalGroupModel, modelPool }
}

async function getConfigAndPresetForGuild(
    guildId: string,
    isDirect: boolean,
    config: Config,
    globalPrivatePreset: PresetTemplate,
    globalGroupPreset: PresetTemplate,
    presetPool: Record<string, PresetTemplate>,
    key: string,
    preset: Preset
): Promise<{ copyOfConfig: RuntimeConfig; currentPreset: PresetTemplate }> {
    const globalConfig = isDirect
        ? config.globalPrivateConfig
        : config.globalGroupConfig
    const currentGuildConfig = isDirect
        ? config.privateConfigs[guildId]
        : config.configs[guildId]
    let copyOfConfig = Object.assign({}, config, globalConfig) as RuntimeConfig
    let currentPreset = isDirect ? globalPrivatePreset : globalGroupPreset

    if (currentGuildConfig) {
        copyOfConfig = Object.assign(
            {},
            copyOfConfig,
            currentGuildConfig
        ) as RuntimeConfig
        currentPreset =
            presetPool[key] ??
            (await (async () => {
                const template = preset.getPresetForCache(
                    currentGuildConfig.preset
                )
                presetPool[key] = template
                return template
            })())

        logger.debug(
            `override config: ${JSON.stringify(copyOfConfig)} for guild ${guildId}`
        )
    }

    return { copyOfConfig, currentPreset }
}

async function prepareMessages(
    ctx: Context,
    messages: Message[],
    config: RuntimeConfig,
    session: Session,
    model: ChatLunaChatModel,
    currentPreset: PresetTemplate,
    temp: GroupTemp,
    chain?: ChatLunaChain,
    focusMessage?: Message,
    triggerReason?: string
): Promise<{
    completionMessages: BaseMessage[]
    persistedHumanMessage: BaseMessage
}> {
    const { recentMessages, lastMessage, contextMessages } =
        await formatMessage(
            messages,
            config,
            model,
            currentPreset.system.rawString,
            currentPreset.input.rawString,
            focusMessage
        )

    const formattedSystemPrompt = await currentPreset.system.format(
        {
            time: '',
            stickers: '',
            status: ''
        },
        session.app.chatluna.promptRenderer,
        {
            session
        }
    )
    if (!chain) {
        logger.debug('messages_new: ' + JSON.stringify(recentMessages))
        logger.debug('messages_last: ' + JSON.stringify(lastMessage))
    }

    if (focusMessage?.quote) {
        logger.debug('formatted_last_message: ' + lastMessage)
    }

    const historyLast = lastMessage.replaceAll('{', '{{').replaceAll('}', '}}')
    const triggerReasonText = (triggerReason ?? 'Normal message trigger')
        .replaceAll('{', '{{')
        .replaceAll('}', '}}')
    const built = {
        preset: currentPreset.name,
        conversationId: session.isDirect ? session.userId : session.guildId
    }
    const conversationType = session.isDirect
        ? `你正在与用户 ${session.username}（${session.userId}）的私聊中`
        : `你正在群聊 ${(await session.bot.getGuild(session.guildId)).name}（${session.guildId}）中`

    let historyNewMessages = recentMessages
    if (
        config.modelCompletionCount > 0 &&
        temp.lastHistoryNew &&
        temp.lastHistoryNew.length > 0
    ) {
        let overlap = Math.min(
            temp.lastHistoryNew.length,
            recentMessages.length
        )

        while (overlap > 0) {
            const previous = temp.lastHistoryNew.slice(-overlap)
            const current = recentMessages.slice(0, overlap)

            if (previous.every((msg, index) => msg === current[index])) {
                break
            }

            overlap--
        }

        if (overlap > 0) {
            historyNewMessages = ['...'].concat(recentMessages.slice(overlap))
        }
    }

    temp.lastHistoryNew = recentMessages.slice()
    const userPrompt = formatReplyUserPrompt(session, config)
    const humanMessage = new HumanMessage(
        (await currentPreset.input.format(
            {
                history_new: historyNewMessages
                    .join('\n\n')
                    .replaceAll('{', '{{')
                    .replaceAll('}', '}}'),
                history_last: historyLast,
                time: formatTimestamp(new Date()),
                stickers: '',
                status: temp.status ?? currentPreset.status ?? '',
                trigger_reason: triggerReasonText,
                prompt: session.content,
                conversationType,
                built
            },
            session.app.chatluna.promptRenderer,
            {
                session
            }
        )) + (userPrompt.length > 0 ? `\n\n${userPrompt}` : '')
    )
    const prompt = await currentPreset.input.format(
        {
            history_new: recentMessages
                .join('\n\n')
                .replaceAll('{', '{{')
                .replaceAll('}', '}}'),
            history_last: historyLast,
            time: formatTimestamp(new Date()),
            stickers: '',
            status: temp.status ?? currentPreset.status ?? '',
            trigger_reason: triggerReasonText,
            prompt: session.content,
            conversationType,
            built
        },
        session.app.chatluna.promptRenderer,
        {
            session
        }
    )
    const persistedHumanMessage = new HumanMessage(
        prompt + (userPrompt.length > 0 ? `\n\n${userPrompt}` : '')
    )

    try {
        await ctx.parallel('chatluna_character/before-chat', {
            session,
            sessionKey: `${session.isDirect ? 'private' : 'group'}:${
                session.isDirect ? session.userId : session.guildId
            }`,
            targetId: built.conversationId,
            presetName: currentPreset.name,
            preset: snapshotPreset(currentPreset),
            messages: snapshotMessage(messages),
            focusMessage: focusMessage
                ? snapshotMessage(focusMessage)
                : undefined,
            triggerReason
        })
    } catch (error) {
        logger.error(error)
    }

    const tempMessages: BaseMessage[] = []

    if (config.image) {
        for (const message of contextMessages) {
            if (message.images && message.images.length > 0) {
                /*    for (const image of message.images) {
                    const imageMessage = new HumanMessage(
                        `[image:${image.hash}]`
                    )
                    imageMessage.additional_kwargs = {
                        images: [image.url]
                    }

                } */

                const imageMessage = new HumanMessage({
                    content: message.images.flatMap((image) => [
                        { type: 'text', text: image.formatted },
                        { type: 'image_url', image_url: image.url }
                    ])
                })

                tempMessages.push(imageMessage)
            }
        }
    }

    const completionMessages = await formatCompletionMessages(
        [new SystemMessage(formattedSystemPrompt)].concat(
            temp.completionMessages
        ),
        tempMessages,
        humanMessage,
        config,
        model
    )

    if (config.modelCompletionCount > 0) {
        let previous: string[] | undefined
        for (const message of completionMessages) {
            if (message.getType() !== 'human') {
                continue
            }

            if (typeof message.content !== 'string') {
                continue
            }

            const content = message.content
            const start = content.indexOf('# 最近消息')
            const end = content.indexOf('\n# 最后消息')
            if (start < 0 || end < 0 || end <= start) {
                continue
            }

            const block = content.slice(start + '# 最近消息'.length, end).trim()

            const current =
                block.length > 0
                    ? block
                          .split('\n\n')
                          .filter((it) => it.length > 0 && it !== '...')
                    : []

            if (!previous) {
                previous = current
                continue
            }

            let overlap = Math.min(previous.length, current.length)
            while (overlap > 0) {
                const prevTail = previous.slice(-overlap)
                const currHead = current.slice(0, overlap)
                if (prevTail.every((it, index) => it === currHead[index])) {
                    break
                }
                overlap--
            }

            if (overlap > 0) {
                const changed = ['...']
                    .concat(current.slice(overlap))
                    .join('\n\n')
                message.content =
                    content.slice(0, start + '# 最近消息'.length) +
                    '\n' +
                    changed +
                    '\n' +
                    content.slice(end)
            }

            previous = current
        }
    }

    return {
        completionMessages,
        persistedHumanMessage
    }
}

// eslint-disable-next-line prettier/prettier
async function* streamModelResponse(
    ctx: Context,
    session: Session,
    model: ChatLunaChatModel,
    completionMessages: BaseMessage[],
    config: RuntimeConfig,
    presetName: string,
    chain?: ChatLunaChain,
    signal?: AbortSignal,
    messageQueue?: MessageQueue,
    onAgentEvent?: (event: AgentEvent) => void | Promise<void>
): AsyncGenerator<StreamedParsedResponseChunk> {
    if (signal?.aborted) return

    let err: unknown
    let failedMessage: BaseMessage | undefined
    for (let idx = 0; idx < 2; idx++) {
        try {
            let messages = completionMessages
            if (idx > 0) {
                const errText = String(err)
                if (errText.includes('Failed to parse response')) {
                    const retryPrompt =
                        config.experimentalToolCallReply && config.toolCalling
                            ? errText.includes(
                                  'invalid character_reply tool call'
                              )
                                ? `Your previous \`character_reply\` tool call was invalid, so it could not be delivered.
The parser error was: ${errText}.
Fix the missing or invalid fields named in the parser error.
Do not repeat completed external tool calls unless necessary.
Use the content from the previous reply and call \`character_reply\` again.`
                                : errText.includes(
                                        'missing character_reply tool call'
                                    )
                                  ? `Your previous reply did not call \`character_reply\`, so it could not be delivered.
The parser error was: ${errText}.
Do not repeat completed external tool calls unless necessary.
Use the content from the previous reply and send it through \`character_reply\` now.`
                                  : `Your previous reply could not be delivered through \`character_reply\`.
The parser error was: ${errText}.
Do not repeat completed external tool calls unless necessary.
Use the content from the previous reply and call \`character_reply\` now.`
                            : `Your previous reply used an invalid format and could not be delivered.
The parser error was: ${errText}.
Reply again using valid XML output with <message> tags.`
                    const failedCalls = failedMessage
                        ? (((
                              failedMessage as unknown as {
                                  tool_calls?: ReplyToolCall[]
                              }
                          ).tool_calls ?? []) as ReplyToolCall[])
                        : []
                    const appendFailed =
                        failedMessage &&
                        (!config.experimentalToolCallReply ||
                            !config.toolCalling ||
                            failedCalls.every(
                                (call) => call.name === 'character_reply'
                            ))

                    messages = completionMessages.concat(
                        ...(appendFailed ? [failedMessage] : []),
                        new HumanMessage(
                            appendFailed
                                ? retryPrompt
                                : retryPrompt.replace(
                                      /Use the content from the previous reply and call `character_reply` again\.|Use the content from the previous reply and send it through `character_reply` now\.|Use the content from the previous reply and call `character_reply` now\./,
                                      'Retry the current turn from the original user request. Do not copy or summarize the failed reply.'
                                  )
                        )
                    )
                }
            }
            const lastMessage = messages[messages.length - 1]
            const historyMessages = messages.slice(0, -1)

            const systemMessage =
                chain != null ? historyMessages.shift() : undefined

            if (chain) {
                for await (const responseChunk of streamAgentResponseContents(
                    ctx,
                    chain,
                    session,
                    model,
                    config,
                    presetName,
                    systemMessage,
                    historyMessages,
                    lastMessage,
                    signal,
                    messageQueue,
                    onAgentEvent
                )) {
                    failedMessage = responseChunk.responseMessage
                    yield await parseResponseContent(
                        ctx,
                        session,
                        config,
                        responseChunk
                    )
                }

                return
            }

            const responseMessage = await model.invoke(
                messages,
                createStreamConfig(session, model, presetName, signal)
            )
            failedMessage = responseMessage
            const responseContent = getMessageContent(responseMessage.content)

            logger.debug(`model response:\n${responseContent}`)

            yield await parseResponseContent(ctx, session, config, {
                responseMessage,
                responseContent,
                isIntermediate: false
            })
            return
        } catch (e) {
            if (signal?.aborted) return
            if (idx < 1 && String(e).includes('Failed to parse response')) {
                err = e
                logger.warn('model response failed, retry once', e)
                continue
            }
            logger.error('model requests failed', e)
            throw e
        }
    }
}

function calculateMessageDelay(
    text: string,
    elements: h[],
    typingTime: number
): number {
    let maxTime = text.length * typingTime + 100
    if (elements.length === 1 && elements[0].attrs['code'] === true) {
        maxTime *= 0.1
    }
    return maxTime
}

async function handleVoiceMessage(
    session: Session,
    ctx: Context,
    text: string,
    elements: h[]
): Promise<{
    breakSay: boolean
    sent: boolean
    messageId?: string
    elements?: h[]
}> {
    try {
        const rendered = await voiceRender(
            ctx,
            session,
            text,
            undefined,
            elements
        )
        const ids = await sendElements(session, rendered)
        return {
            breakSay: true,
            sent: true,
            messageId: ids[0],
            elements: rendered
        }
    } catch (e) {
        logger.error(e)
        try {
            const ids = await sendElements(session, elements)
            return {
                breakSay: false,
                sent: true,
                messageId: ids[0],
                elements
            }
        } catch (fallbackError) {
            logger.error(fallbackError)
            return { breakSay: false, sent: false }
        }
    }
}

async function handleMessageSending(
    session: Session,
    elements: h[],
    text: string,
    parsedResponse: Awaited<ReturnType<typeof parseResponse>>,
    config: RuntimeConfig,
    ctx: Context,
    maxTime: number,
    emoticonStatement: string,
    breakSay: boolean
): Promise<{
    breakSay: boolean
    sent: boolean
    messageId?: string
    elements?: h[]
}> {
    const isVoice = parsedResponse.messageType === 'voice'
    if (isVoice && emoticonStatement !== 'text') {
        return { breakSay: false, sent: false }
    }

    const random = new Random()

    if (config.splitVoice !== true && isVoice && !breakSay) {
        const fullMaxTime =
            parsedResponse.rawMessage.length * config.typingTime + 100
        await sleep(random.int(fullMaxTime / 4, fullMaxTime / 2))
        return await handleVoiceMessage(
            session,
            ctx,
            parsedResponse.rawMessage,
            elements
        )
    }

    if (emoticonStatement !== 'span') {
        await sleep(random.int(maxTime / 2, maxTime))
    } else {
        await sleep(random.int(maxTime / 12, maxTime / 4))
    }

    let sent = false
    let messageId: string | undefined
    let sentElements: h[] | undefined
    try {
        switch (parsedResponse.messageType) {
            case 'text':
                messageId = (await sendElements(session, elements))[0]
                sentElements = elements
                sent = true
                break
            case 'voice':
                sentElements = await voiceRender(
                    ctx,
                    session,
                    text,
                    undefined,
                    elements
                )
                messageId = (await sendElements(session, sentElements))[0]
                sent = true
                break
            default:
                messageId = (await sendElements(session, elements))[0]
                sentElements = elements
                sent = true
                break
        }
    } catch (e) {
        logger.error(e)
        try {
            messageId = (await sendElements(session, elements))[0]
            sentElements = elements
            sent = true
        } catch (fallbackError) {
            logger.error(fallbackError)
        }
    }

    return { breakSay: false, sent, messageId, elements: sentElements }
}

async function handleParsedResponseChunk(
    session: Session,
    config: RuntimeConfig,
    ctx: Context,
    parsedResponse: ParsedResponse
): Promise<{
    breakSay: boolean
    sentAny: boolean
    sentMessages: { elements: h[]; messageId?: string }[]
}> {
    let breakSay = false
    let sentAny = false
    const sentMessages: { elements: h[]; messageId?: string }[] = []

    for (const elements of parsedResponse.elements) {
        const text =
            parsedResponse.messageType === 'voice'
                ? parsedResponse.rawMessage
                : getElementText(elements)
        const emoticonStatement = isEmoticonStatement(text, elements)

        if (elements.length < 1) continue

        const maxTime =
            text.length > config.largeTextSize
                ? config.largeTextTypingTime
                : calculateMessageDelay(text, elements, config.typingTime)

        const result = await handleMessageSending(
            session,
            elements,
            text,
            parsedResponse,
            config,
            ctx,
            maxTime,
            emoticonStatement,
            breakSay
        )
        breakSay = result.breakSay
        sentAny = sentAny || result.sent
        if (result.sent && result.elements) {
            sentMessages.push({
                elements: result.elements,
                messageId: result.messageId
            })
        }

        if (breakSay) {
            break
        }
    }

    return { breakSay, sentAny, sentMessages }
}

export async function apply(ctx: Context, config: Config) {
    const service = ctx.chatluna_character
    const preset = service.preset
    logger = service.logger

    if (config.globalPrivateConfig.experimentalToolCallReply) {
        if (!config.globalPrivateConfig.toolCalling) {
            throw new Error(
                'globalPrivateConfig.experimentalToolCallReply 依赖 toolCalling，globalPrivateConfig.toolCalling 不能关闭。'
            )
        }
    }

    if (config.globalGroupConfig.experimentalToolCallReply) {
        if (!config.globalGroupConfig.toolCalling) {
            throw new Error(
                'globalGroupConfig.experimentalToolCallReply 依赖 toolCalling，globalGroupConfig.toolCalling 不能关闭。'
            )
        }
    }

    for (const [id, cfg] of Object.entries(config.privateConfigs)) {
        if (!cfg.experimentalToolCallReply) {
            continue
        }

        if (!cfg.toolCalling) {
            throw new Error(
                `privateConfigs.${id}.experimentalToolCallReply 依赖 toolCalling，privateConfigs.${id}.toolCalling 不能关闭。`
            )
        }
    }

    for (const [id, cfg] of Object.entries(config.configs)) {
        if (!cfg.experimentalToolCallReply) {
            continue
        }

        if (!cfg.toolCalling) {
            throw new Error(
                `configs.${id}.experimentalToolCallReply 依赖 toolCalling，configs.${id}.toolCalling 不能关闭。`
            )
        }
    }

    setLogger(logger)

    const { globalPrivateModel, globalGroupModel, modelPool } =
        await setupModelPool(ctx, config)

    let globalPrivatePreset = preset.getPresetForCache(
        config.globalPrivateConfig.preset
    )
    let globalGroupPreset = preset.getPresetForCache(
        config.globalGroupConfig.preset
    )
    let presetPool: Record<string, PresetTemplate> = {}
    const chainPool: Record<
        string,
        {
            chain: ComputedRef<ChatLunaChain>
            reply: boolean
        }
    > = {}
    const replyToolConfigs: Record<string, RuntimeConfig> = {}

    ctx.on('chatluna_character/preset_updated', () => {
        globalPrivatePreset = preset.getPresetForCache(
            config.globalPrivateConfig.preset
        )
        globalGroupPreset = preset.getPresetForCache(
            config.globalGroupConfig.preset
        )
        presetPool = {}
    })

    service.collect(async (session, messages, triggerReason, signal) => {
        const guildId = session.isDirect ? session.userId : session.guildId
        const key = `${session.isDirect ? 'private' : 'group'}:${guildId}`
        let queue: PendingMessageQueue | undefined

        try {
            const model = await (modelPool[key] ??
                Promise.resolve(
                    session.isDirect ? globalPrivateModel : globalGroupModel
                ))

            const { copyOfConfig, currentPreset } =
                await getConfigAndPresetForGuild(
                    guildId,
                    session.isDirect,
                    config,
                    globalPrivatePreset,
                    globalGroupPreset,
                    presetPool,
                    key,
                    preset
                )

            if (model.value == null) {
                logger.warn(
                    `Model ${copyOfConfig.model} load not successful. ` +
                        'Please check your logs output.'
                )
                return
            }

            replyToolConfigs[key] = copyOfConfig
            const chainKey = key

            if (!copyOfConfig.toolCalling) {
                delete chainPool[chainKey]
            } else if (
                !chainPool[chainKey] ||
                chainPool[chainKey].reply !==
                    copyOfConfig.experimentalToolCallReply
            ) {
                chainPool[chainKey] = {
                    chain: await createChatLunaChain(
                        ctx,
                        model,
                        (currentSession) =>
                            createReplyTools(
                                ctx,
                                currentSession,
                                replyToolConfigs[key]
                            )
                    ),
                    reply: copyOfConfig.experimentalToolCallReply
                }
            }

            const latestMessages = service.getMessages(key) ?? messages
            const count = latestMessages.length
            const temp = await service.getTemp(session, latestMessages)
            const focusMessage = latestMessages[latestMessages.length - 1]

            const { completionMessages, persistedHumanMessage } =
                await prepareMessages(
                    ctx,
                    latestMessages,
                    copyOfConfig,
                    session,
                    model.value,
                    currentPreset,
                    temp,
                    chainPool[chainKey]?.chain.value,
                    focusMessage,
                    triggerReason
                )

            if (!chainPool[chainKey]) {
                logger.debug(
                    'completion message: ' +
                        JSON.stringify(
                            completionMessages.map((it) => it.content)
                        )
                )
            }

            let lastResponseMessage: BaseMessage | undefined
            const nextReplyReasons: string[] = []
            let latestStatus = temp.status
            let sentAny = false
            let hasEmptyReplies = false
            let hasNonEmptyReplies = false

            queue = new PendingMessageQueue(
                copyOfConfig.enableMessageId,
                (messages) => {
                    service.markConsumedPendingMessages(session, messages)
                }
            )

            service.startPendingMessages(session, (message, reason) => {
                queue?.pushRaw(message, reason)
            })

            try {
                for await (const chunk of streamModelResponse(
                    ctx,
                    session,
                    model.value,
                    completionMessages,
                    copyOfConfig,
                    currentPreset.name,
                    chainPool[chainKey]?.chain.value,
                    signal,
                    queue,
                    (event) => {
                        if (event.type === 'round-decision') {
                            service.setPendingMessagesWillConsume(
                                session,
                                event.canContinue === true
                            )
                            return
                        }

                        if (event.type !== 'tool-call') {
                            return
                        }

                        const action = event.actions[event.actions.length - 1]
                        if (!action) {
                            return
                        }

                        if (action.tool !== 'character_reply') {
                            service.setPendingMessagesWillConsume(session, true)
                            return
                        }

                        const args =
                            action.toolInput &&
                            typeof action.toolInput === 'object' &&
                            !Array.isArray(action.toolInput)
                                ? (action.toolInput as Record<string, unknown>)
                                : {}
                        service.setPendingMessagesWillConsume(
                            session,
                            args.is_final === false
                        )
                    }
                )) {
                    latestStatus = chunk.parsedResponse.status ?? latestStatus

                    const isEmptyReply =
                        chunk.parsedResponse.elements.length < 1 &&
                        chunk.parsedResponse.rawMessage.trim().length < 1
                    if (isEmptyReply) {
                        hasEmptyReplies = true
                    } else {
                        hasNonEmptyReplies = true
                    }

                    if (
                        copyOfConfig.experimentalToolCallReply &&
                        chunk.toolCalls
                    ) {
                        const toolState = parseReplyTools(
                            copyOfConfig,
                            chunk.toolCalls
                        )
                        nextReplyReasons.push(...toolState.nextReplyReasons)
                    } else {
                        nextReplyReasons.push(
                            ...extractNextReplyReasons(chunk.responseContent)
                        )
                    }

                    const sendResult = await handleParsedResponseChunk(
                        session,
                        copyOfConfig,
                        ctx,
                        chunk.parsedResponse
                    )
                    const responseMessage =
                        copyOfConfig.experimentalToolCallReply &&
                        chunk.toolCalls?.length
                            ? new AIMessage(chunk.responseContent)
                            : chunk.responseMessage

                    if (!sendResult.sentAny) {
                        if (
                            isEmptyReply &&
                            /<action\b/i.test(chunk.responseContent)
                        ) {
                            lastResponseMessage = responseMessage
                        }
                        continue
                    }

                    sentAny = true
                    lastResponseMessage = responseMessage
                    await ctx.chatluna_character.broadcastOnBot(
                        session,
                        sendResult.sentMessages
                    )

                    if (sendResult.breakSay) {
                        break
                    }
                }
            } finally {
                service.stopPendingMessages(session)
            }

            if (!sentAny && !lastResponseMessage) {
                if (hasEmptyReplies && !hasNonEmptyReplies) {
                    await registerResponseTriggers(
                        ctx,
                        key,
                        copyOfConfig,
                        nextReplyReasons
                    )
                }
                return
            }

            const persistedMessages = service.getMessages(key) ?? latestMessages
            if (persistedMessages.length > count) {
                temp.status = latestStatus
                await service.persistStatus(
                    session,
                    latestStatus,
                    persistedMessages[persistedMessages.length - 1]
                )
            }

            temp.completionMessages.push(persistedHumanMessage)
            if (lastResponseMessage) {
                temp.completionMessages.push(lastResponseMessage)
            }

            trimCompletionMessages(
                temp.completionMessages,
                copyOfConfig.modelCompletionCount
            )

            await registerResponseTriggers(
                ctx,
                key,
                copyOfConfig,
                nextReplyReasons
            )

            await service.muteAtLeast(session, copyOfConfig.coolDownTime * 1000)
            await ctx.parallel('chatluna_character/after-chat', {
                session,
                sessionKey: key,
                targetId: session.isDirect ? session.userId : session.guildId,
                presetName: currentPreset.name,
                preset: snapshotPreset(currentPreset),
                messages: snapshotMessage(persistedMessages),
                focusMessage: focusMessage
                    ? snapshotMessage(focusMessage)
                    : undefined,
                triggerReason,
                persistedHumanMessage: snapshotBaseMessage(
                    persistedHumanMessage
                ),
                lastResponseMessage: lastResponseMessage
                    ? snapshotBaseMessage(lastResponseMessage)
                    : undefined,
                completionMessages: snapshotBaseMessage(temp.completionMessages),
                status: latestStatus
            })
        } catch (e) {
            logger.error(e)
        } finally {
            await service.releaseResponseLock(session)

            const pending = queue?.takeLatestTrigger()
            if (pending) {
                await service.triggerCollect(
                    session,
                    pending.triggerReason!,
                    pending.message
                )
            }
        }
    })
}

function getReplyToolInputError(
    config: Config | GuildConfig | PrivateConfig,
    args: Record<string, unknown>
) {
    const missing = ['is_final', 'messages'].filter((key) => args[key] == null)

    if (config.toolCallReplyStatusTag && args.status == null) {
        missing.push('status')
    }

    if (config.toolCallReplyThinkTag && args.think == null) {
        missing.push('think')
    }

    if (missing.length > 0) {
        return `Missing required field(s): ${missing.join(', ')}`
    }

    if (typeof args.is_final !== 'boolean') {
        return 'Field is_final must be a boolean'
    }

    if (!Array.isArray(args.messages)) {
        return 'Field messages must be an array'
    }

    for (let i = 0; i < args.messages.length; i++) {
        const msg = args.messages[i]
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            return `Field messages[${i}] must be an object`
        }

        const content = (msg as Record<string, unknown>).content
        if (!Array.isArray(content)) {
            return `Field messages[${i}].content must be an array`
        }

        if (content.length < 1) {
            return `Field messages[${i}].content must not be empty. Use messages: [] when no reply is needed`
        }

        const quote = (msg as Record<string, unknown>).quote
        if (
            quote != null &&
            typeof quote !== 'string' &&
            typeof quote !== 'number'
        ) {
            return `Field messages[${i}].quote must be a string or number`
        }

        for (let j = 0; j < content.length; j++) {
            const el = content[j]
            if (!el || typeof el !== 'object' || Array.isArray(el)) {
                return `Field messages[${i}].content[${j}] must be an object`
            }

            const item = el as Record<string, unknown>
            if (typeof item.type !== 'string') {
                return (
                    `Field messages[${i}].content[${j}].type must be a string. ` +
                    'For text, use {"type":"text","text":"..."}'
                )
            }

            if (
                ![
                    'text',
                    'image',
                    'sticker',
                    'audio',
                    'at',
                    'face',
                    'voice',
                    'file',
                    'video',
                    'markdown'
                ].includes(item.type)
            ) {
                return (
                    `Field messages[${i}].content[${j}].type must be one of ` +
                    'text, image, sticker, audio, at, face, voice, file, video, markdown'
                )
            }

            if (
                [
                    'sticker',
                    'audio',
                    'file',
                    'video',
                    'voice',
                    'markdown'
                ].includes(item.type) &&
                content.length > 1
            ) {
                return `Element type ${item.type} must be the only element in messages[${i}].content`
            }

            if (
                ['text', 'markdown', 'voice'].includes(item.type) &&
                (typeof item.text !== 'string' || item.text.trim().length < 1)
            ) {
                return `Field messages[${i}].content[${j}].text must be a non-empty string for type ${item.type}`
            }

            if (
                ['at', 'face'].includes(item.type) &&
                (item.id == null ||
                    (typeof item.id !== 'string' &&
                        typeof item.id !== 'number') ||
                    String(item.id).trim().length < 1)
            ) {
                return `Field messages[${i}].content[${j}].id must be a non-empty string or number for type ${item.type}`
            }

            if (
                ['image', 'sticker', 'audio', 'file', 'video'].includes(
                    item.type
                ) &&
                (typeof item.url !== 'string' ||
                    (!item.url.startsWith('http://') &&
                        !item.url.startsWith('https://')))
            ) {
                return `Field messages[${i}].content[${j}].url must be an HTTP(S) string for type ${item.type}`
            }

            if (
                item.type === 'file' &&
                item.name != null &&
                typeof item.name !== 'string'
            ) {
                return `Field messages[${i}].content[${j}].name must be a string for type file`
            }

            if (
                item.type === 'voice' &&
                item.id != null &&
                typeof item.id !== 'string' &&
                typeof item.id !== 'number'
            ) {
                return `Field messages[${i}].content[${j}].id must be a string or number for type voice`
            }
        }
    }

    if (config.toolCallReplyStatusTag && typeof args.status !== 'string') {
        return 'Field status must be a string'
    }

    if (config.toolCallReplyThinkTag && typeof args.think !== 'string') {
        return 'Field think must be a string'
    }

    return undefined
}

function filterReplyToolCalls(
    config: Config | GuildConfig | PrivateConfig,
    calls: ReplyToolCall[],
    errors?: string[]
) {
    return calls.filter((call) => {
        if (call.name !== 'character_reply') {
            return true
        }

        const err = getReplyToolInputError(config, call.args)
        if (err) {
            errors?.push(err)
            logger.debug(`Skip invalid character_reply tool call: ${err}`)
            return false
        }

        return true
    })
}
