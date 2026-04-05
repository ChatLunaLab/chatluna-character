/* eslint-disable generator-star-spacing */
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { } from '@initencounter/vits'
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
    ChatLunaChain,
    GroupTemp,
    GuildConfig,
    Message,
    PrivateConfig,
    PresetTemplate,
    StreamedModelResponseChunk
} from '../types'
import {
    createChatLunaChain,
    extractNextReplyReasons,
    extractWakeUpReplies,
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

import type { } from 'koishi-plugin-chatluna/services/chat'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import { ComputedRef } from 'koishi-plugin-chatluna'

let logger: Logger

type ParsedResponse = Awaited<ReturnType<typeof parseResponse>>
type StreamedParsedResponseChunk = StreamedModelResponseChunk<ParsedResponse>

interface StreamedResponseContentChunk {
    responseMessage: BaseMessage
    responseContent: string
    isIntermediate: boolean
    toolCalls?: ReplyToolCall[]
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
                    if (
                        typeof condition.user_id === 'string' &&
                        condition.user_id.trim()
                    ) {
                        return `id_${condition.user_id.trim()}`
                    }

                    return undefined
                }

                if (condition.type === 'no_message_from_user') {
                    if (
                        typeof condition.seconds === 'number' &&
                        Number.isFinite(condition.seconds) &&
                        condition.seconds > 0 &&
                        typeof condition.user_id === 'string' &&
                        condition.user_id.trim()
                    ) {
                        if (condition.user_id.trim() === 'all') {
                            return `time_${condition.seconds}s`
                        }

                        if (
                            typeof condition.max_wait_seconds === 'number' &&
                            Number.isFinite(condition.max_wait_seconds) &&
                            condition.max_wait_seconds > 0
                        ) {
                            return `time_${condition.seconds}s_id_${condition.user_id.trim()}_max_${condition.max_wait_seconds}s`
                        }

                        return `time_${condition.seconds}s_id_${condition.user_id.trim()}`
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
                if (
                    typeof condition.user_id === 'string' &&
                    condition.user_id.trim()
                ) {
                    tags.push(
                        `<next_reply group="${groupIdx}" type="message_from_user" user_id="${condition.user_id.trim().replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')}" />`
                    )
                }
                continue
            }

            if (condition.type === 'no_message_from_user') {
                if (
                    typeof condition.seconds === 'number' &&
                    Number.isFinite(condition.seconds) &&
                    condition.seconds > 0 &&
                    typeof condition.user_id === 'string' &&
                    condition.user_id.trim()
                ) {
                    const userId = condition.user_id
                        .trim()
                        .replaceAll('&', '&amp;')
                        .replaceAll('<', '&lt;')
                        .replaceAll('>', '&gt;')
                        .replaceAll('"', '&quot;')
                    const maxWait =
                        condition.user_id.trim() !== 'all' &&
                            typeof condition.max_wait_seconds === 'number' &&
                            Number.isFinite(condition.max_wait_seconds) &&
                            condition.max_wait_seconds > 0
                            ? ` max_wait_seconds="${condition.max_wait_seconds}"`
                            : ''
                    tags.push(
                        `<next_reply group="${groupIdx}" type="no_message_from_user" user_id="${userId}" seconds="${condition.seconds}"${maxWait} />`
                    )
                }
            }
        }
    }

    return tags
}

function createReplyTools(
    ctx: Context,
    session: Session,
    config: GuildConfig | PrivateConfig
): StructuredTool[] {
    const canAt = !session.isDirect && 'isAt' in config && config.isAt
    const canFace = session.platform === 'qq' || session.platform === 'onebot'
    const part = {
        type: 'object',
        properties: {
            text: {
                type: 'string',
                description: 'Text content'
            },
            image: {
                type: 'string',
                description: 'HTTP(S) image URL'
            }
        }
    }

    const message = {
        type: 'object',
        properties: {
            text: {
                type: 'string',
                description: 'Text content'
            },
            quote: {
                type: 'string',
                description: 'Platform message ID to quote'
            },
            sticker: {
                type: 'string',
                description: 'HTTP(S) sticker URL'
            },
            image: {
                type: 'string',
                description: 'HTTP(S) image URL'
            },
            parts: {
                type: 'array',
                description: 'Multiple parts inside one message, joined in order.',
                items: {
                    ...part
                }
            }
        }
    }

    if (canAt) {
        part.properties['at'] = {
            type: 'string',
            description: 'Platform ID of the user to mention.'
        }
        message.properties['at'] = {
            type: 'string',
            description: 'Platform ID of the user to mention.'
        }
    }

    if (canFace) {
        part.properties['face'] = {
            type: 'string',
            description: 'QQ face ID'
        }
        message.properties['face'] = {
            type: 'string',
            description: 'QQ face ID'
        }
    }

    if (ctx.vits) {
        message.properties['voice'] = {
            type: 'object',
            description: 'Voice message',
            properties: {
                text: {
                    type: 'string',
                    description: 'Text to synthesize into voice'
                },
                id: {
                    type: 'string',
                    description: 'Optional voice ID'
                }
            },
            required: ['text']
        }
    }

    if (session.platform !== 'qq') {
        message.properties['file'] = {
            type: 'object',
            description: 'File message',
            properties: {
                name: {
                    type: 'string',
                    description: 'File name'
                },
                url: {
                    type: 'string',
                    description: 'HTTP(S) file URL'
                }
            },
            required: ['name', 'url']
        }

        if (session.platform === 'onebot') {
            message.properties['video'] = {
                type: 'object',
                description:
                    'Video message. Prefer this for videos within 100MB, but metadata may be lost. Use file for larger videos.',
                properties: {
                    url: {
                        type: 'string',
                        description: 'HTTP(S) video URL'
                    }
                },
                required: ['url']
            }
        }
    }

    if (session.platform === 'qq' && session.isDirect) {
        message.properties['markdown'] = {
            type: 'string',
            description: 'Markdown content, including LaTeX'
        }
    }

    const props: Record<string, unknown> = {
        is_final: {
            type: 'boolean',
            description:
                'Whether this is the final reply of the current turn. Use false only for temporary progress updates when you still need more tools or more reasoning. Use true for the final reply of this turn.'
        },
        status: {
            type: 'string',
            description: 'Updated status text.'
        },
        think: {
            type: 'string',
            description: 'The character\'s internal thoughts about the message.'
        },
        messages: {
            type: 'array',
            description: 'List of messages to send. Each object in the array is one message. Use an empty array when no reply is needed.',
            items: {
                ...message
            }
        },
        wake_up_reply: {
            type: 'array',
            description:
                'Schedule future proactive triggers. Use this when you want to speak again at a specific later time, such as for a planned reminder or joke.',
            items: {
                type: 'object',
                properties: {
                    time: {
                        type: 'string',
                        description:
                            'Trigger time in YYYY/MM/DD-HH:mm:ss format, for example 2026/02/20-21:30:00'
                    },
                    reason: {
                        type: 'string',
                        description:
                            'Reason or note for the future trigger, for example remind someone to sleep earlier'
                    }
                },
                required: ['time', 'reason']
            }
        }
    }

    if (!config.enableFixedIntervalTrigger || config.messageInterval !== 0) {
        props['next_reply'] = {
            type: 'array',
            description:
                'Set the next proactive trigger. Use this when you may need to speak again after this turn, such as waiting for someone\'s next reply, waiting for someone to finish sending a multi-part message, or speaking again after a period of silence. Examples: wait for user 123456789 to send the next message; wait until no one sends any new message for 600 seconds; wait for user 987654321 to send the first new message, then wait 10 seconds for them to stop sending more messages. Pass an array where each object is one OR group, and any group can trigger the reply. Inside each group, conditions are AND and must all be satisfied. New conditions replace old ones. If another trigger causes a reply before the condition is met, the old condition becomes invalid. Conditions are cleared after a successful trigger.',
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

    for (const field of ctx.chatluna_character.getReplyToolFields()) {
        if (field.isAvailable && !field.isAvailable(ctx, session, config)) {
            continue
        }

        props[field.name] = field.schema
    }

    return [
        tool(async (args) => {
            const input = args as Record<string, unknown>

            for (const field of ctx.chatluna_character.getReplyToolFields()) {
                if (input[field.name] == null) {
                    continue
                }

                if (field.isAvailable && !field.isAvailable(ctx, session, config)) {
                    continue
                }

                await field.invoke(ctx, session, input[field.name], config)
            }

            return input.is_final === false
                ? replyToolProgress
                : {
                    lc_direct_tool_output: true,
                    replyEmitted: true
                }
        }, {
            name: 'character_reply',
            description:
                'Send one or more in-character reply messages and required actions. All user-visible reply content must be sent through this tool. Do not end the turn with plain text output outside this tool.',
            returnDirect: false,
            schema: {
                type: 'object',
                properties: props,
                required: ['is_final', 'status', 'think', 'messages']
            }
        })
    ]
}

function formatReplyUserPrompt(session: Session, config: Config) {
    if (!config.experimentalToolCallReply || !config.toolCalling) {
        return ''
    }

    const tips = [
        'When you are about to make a potentially time-consuming tool call, such as searching, send a progress update to the user first with `character_reply`. Reading a voice message is an exception and does not need this.',
        'All user-visible reply content must be sent through `character_reply`. Do not end the turn with plain text output outside this tool.'
    ]

    if (!config.enableFixedIntervalTrigger || config.messageInterval !== 0) {
        tips.push('You should also actively decide whether this turn needs `next_reply`.')
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
            return text
        }

        return text.replaceAll('"', '&quot;')
    }

    const buildPart = (part: Record<string, unknown>) => {
        let result = ''

        if (typeof part.text === 'string') {
            result += escape(part.text)
        }

        if (typeof part.at === 'string') {
            result += `<at>${escape(part.at)}</at>`
        }

        if (typeof part.face === 'string') {
            result += `<face>${escape(part.face)}</face>`
        }

        if (typeof part.image === 'string') {
            if (!isHttpUrl(part.image)) {
                return result
            }
            result += `<image>${escape(part.image)}</image>`
        }

        return result
    }

    const quote =
        typeof args.quote === 'string' && args.quote.length > 0
            ? ` quote="${escape(args.quote, true)}"`
            : ''

    if (Array.isArray(args.parts)) {
        const content = args.parts
            .filter((item) => item && typeof item === 'object' && !Array.isArray(item))
            .map((item) => buildPart(item as Record<string, unknown>))
            .join('')

        return `<message${quote}>${content}</message>`
    }

    if (typeof args.at === 'string') {
        return `<message${quote}><at>${escape(args.at)}</at></message>`
    }

    if (typeof args.face === 'string') {
        return `<message${quote}><face>${escape(args.face)}</face></message>`
    }

    if (typeof args.sticker === 'string') {
        if (!isHttpUrl(args.sticker)) {
            return `<message${quote}></message>`
        }
        return `<message${quote}><sticker>${escape(args.sticker)}</sticker></message>`
    }

    if (typeof args.image === 'string') {
        if (!isHttpUrl(args.image)) {
            return `<message${quote}></message>`
        }
        return `<message${quote}><image>${escape(args.image)}</image></message>`
    }

    if (args.file && typeof args.file === 'object' && !Array.isArray(args.file)) {
        const file = args.file as Record<string, unknown>
        if (!isHttpUrl(file.url)) {
            return `<message${quote}></message>`
        }
        return `<message${quote}><file name="${escape(file.name ?? 'file', true)}">${escape(file.url)}</file></message>`
    }

    if (args.video && typeof args.video === 'object' && !Array.isArray(args.video)) {
        const video = args.video as Record<string, unknown>
        if (!isHttpUrl(video.url)) {
            return `<message${quote}></message>`
        }
        return `<message${quote}><video>${escape(video.url)}</video></message>`
    }

    if (typeof args.markdown === 'string') {
        return `<message${quote}><markdown>${escape(args.markdown)}</markdown></message>`
    }

    if (
        args.voice &&
        typeof args.voice === 'object' &&
        !Array.isArray(args.voice)
    ) {
        const voice = args.voice as Record<string, unknown>
        return `<message${quote}><voice id="${escape(voice.id, true)}">${escape(voice.text)}</voice></message>`
    }

    return `<message${quote}>${escape(args.text)}</message>`
}

function parseReplyTools(calls: ReplyToolCall[]) {
    const messages: string[] = []
    const nextReplyReasons: string[] = []
    const wakeUpReplies: { time: string; reason: string }[] = []
    let status: string | undefined

    for (const call of calls) {
        if (call.name !== 'character_reply') {
            continue
        }

        if (typeof call.args.status === 'string') {
            status = call.args.status
        }

        if (Array.isArray(call.args.messages)) {
            for (const item of call.args.messages) {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    messages.push(buildXmlMessage(item as Record<string, unknown>))
                }
            }
        }

        if (call.args.is_final !== false) {
            nextReplyReasons.push(
                ...extractNextReplyReasonsFromTool(call.args.next_reply)
            )
        }

        if (call.args.is_final === false || !Array.isArray(call.args.wake_up_reply)) {
            continue
        }

        for (const item of call.args.wake_up_reply) {
            if (!item || typeof item !== 'object' || Array.isArray(item)) {
                continue
            }

            const wake = item as Record<string, unknown>
            if (typeof wake.time !== 'string' || !wake.time.trim()) {
                continue
            }

            wakeUpReplies.push({
                time: wake.time.trim(),
                reason:
                    typeof wake.reason === 'string'
                        ? wake.reason.trim()
                        : ''
            })
        }
    }

    return {
        status,
        rawMessage: messages.join(''),
        nextReplyReasons,
        wakeUpReplies
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
            blocks.push(`<status>\n${call.args.status}\n</status>`)
        }

        if (typeof call.args.think === 'string' && call.args.think.trim()) {
            blocks.push(`<think>\n${call.args.think.trim()}\n</think>`)
        }

        if (Array.isArray(call.args.messages)) {
            for (const item of call.args.messages) {
                if (item && typeof item === 'object' && !Array.isArray(item)) {
                    messages.push(buildXmlMessage(item as Record<string, unknown>))
                }
            }
        }

        actions.push(...buildNextReplyToolTags(call.args.next_reply))

        if (Array.isArray(call.args.wake_up_reply)) {
            for (const item of call.args.wake_up_reply) {
                if (!item || typeof item !== 'object' || Array.isArray(item)) {
                    continue
                }

                const wake = item as Record<string, unknown>
                if (typeof wake.time !== 'string' || !wake.time.trim()) {
                    continue
                }

                const time = wake.time
                    .trim()
                    .replaceAll('&', '&amp;')
                    .replaceAll('<', '&lt;')
                    .replaceAll('>', '&gt;')
                    .replaceAll('"', '&quot;')
                const reason =
                    typeof wake.reason === 'string'
                        ? wake.reason
                            .trim()
                            .replaceAll('&', '&amp;')
                            .replaceAll('<', '&lt;')
                            .replaceAll('>', '&gt;')
                            .replaceAll('"', '&quot;')
                        : ''
                actions.push(
                    `<wake_up_reply time="${time}" reason="${reason}" />`
                )
            }
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
                actions.push(...rendered.filter((item) => item.trim().length > 0))
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
    config: Config,
    chunk: StreamedResponseContentChunk
): Promise<StreamedParsedResponseChunk> {
    let parsedResponse: ParsedResponse
    const { responseMessage, responseContent, isIntermediate } = chunk
    const toolState =
        config.experimentalToolCallReply && chunk.toolCalls?.length > 0
            ? parseReplyTools(chunk.toolCalls)
            : undefined
    const renderedContent =
        config.experimentalToolCallReply && chunk.toolCalls?.length > 0
            ? renderReplyToolXml(ctx, session, config, chunk.toolCalls)
            : responseContent

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
            toolCalls: chunk.toolCalls,
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
        toolCalls: chunk.toolCalls,
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
    const conversationId = `${session.platform}:${session.isDirect ? 'private' : 'guild'
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
    config: Config,
    presetName: string,
    systemMessage: BaseMessage | undefined,
    historyMessages: BaseMessage[],
    lastMessage: BaseMessage,
    signal?: AbortSignal,
    messageQueue?: MessageQueue,
    onAgentEvent?: (event: AgentEvent) => void | Promise<void>
): AsyncGenerator<StreamedResponseContentChunk> {
    const conversationId = `${session.platform}:${session.isDirect ? 'private' : 'guild'
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
        if (responseChunk.toolCalls?.some((call) => {
            return call.name === 'character_reply' && call.args.is_final !== false
        })) {
            finalReply = true
        }

        if (
            finalReply &&
            responseChunk.phase === 'final' &&
            (!responseChunk.toolCalls || responseChunk.toolCalls.length < 1)
        ) {
            continue
        }

        const responseMessage = responseChunk.message
        const responseContent = getMessageContent(responseMessage.content)
        const renderedContent =
            config.experimentalToolCallReply && responseChunk.toolCalls?.length > 0
                ? renderReplyToolXml(
                    ctx,
                    session,
                    config,
                    responseChunk.toolCalls
                )
                : responseContent
        if (renderedContent.trim().length < 1) {
            continue
        }

        const isIntermediate = responseChunk.phase === 'intermediate'

        if (isIntermediate) {
            logger.debug(`agent intermediate response:\n${renderedContent}`)
        } else {
            logger.debug(`model response:\n${renderedContent}`)
        }

        yield {
            responseMessage,
            responseContent: renderedContent,
            isIntermediate,
            toolCalls: responseChunk.toolCalls
        }
    }
}

async function registerResponseTriggers(
    ctx: Context,
    session: Session,
    key: string,
    config: Config,
    nextReplyReasons: string[],
    wakeUpReplies: ReturnType<typeof extractWakeUpReplies>
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

    for (const wakeUp of wakeUpReplies) {
        const accepted = await store.registerWakeUpReply(
            session,
            wakeUp.time,
            wakeUp.reason,
            config
        )

        if (!accepted) {
            logger.warn(
                `Ignore invalid <wake_up_reply time="${wakeUp.time}" ` +
                `reason="${wakeUp.reason}" /> for session ${key}`
            )
        }
    }

    if (wakeUpReplies.length > 0) {
        await store.setWakeUpReplies(session, store.getWakeUpReplies(key))
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
): Promise<{ copyOfConfig: Config; currentPreset: PresetTemplate }> {
    const globalConfig = isDirect
        ? config.globalPrivateConfig
        : config.globalGroupConfig
    const currentGuildConfig = isDirect
        ? config.privateConfigs[guildId]
        : config.configs[guildId]
    let copyOfConfig = Object.assign({}, config, globalConfig)
    let currentPreset = isDirect ? globalPrivatePreset : globalGroupPreset

    if (currentGuildConfig) {
        copyOfConfig = Object.assign({}, copyOfConfig, currentGuildConfig)
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
    config: Config,
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
    config: Config,
    presetName: string,
    chain?: ChatLunaChain,
    signal?: AbortSignal,
    messageQueue?: MessageQueue,
    onAgentEvent?: (event: AgentEvent) => void | Promise<void>
): AsyncGenerator<StreamedParsedResponseChunk> {
    if (signal?.aborted) return

    try {
        const lastMessage =
            completionMessages[completionMessages.length - 1]
        const historyMessages = completionMessages.slice(0, -1)

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
            completionMessages,
            createStreamConfig(session, model, presetName, signal)
        )
        const responseContent = getMessageContent(responseMessage.content)

        logger.debug(`model response:\n${responseContent}`)

        yield await parseResponseContent(ctx, session, config, {
            responseMessage,
            responseContent,
            isIntermediate: false
        })
    } catch (e) {
        if (signal?.aborted) return
        logger.error('model requests failed', e)
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
    config: Config,
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
    config: Config,
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

    if (config.experimentalToolCallReply) {
        if (!config.globalPrivateConfig.toolCalling) {
            throw new Error(
                'experimentalToolCallReply 依赖 toolCalling，globalPrivateConfig.toolCalling 不能关闭。'
            )
        }

        if (!config.globalGroupConfig.toolCalling) {
            throw new Error(
                'experimentalToolCallReply 依赖 toolCalling，globalGroupConfig.toolCalling 不能关闭。'
            )
        }

        for (const [id, cfg] of Object.entries(config.privateConfigs)) {
            if (!cfg.toolCalling) {
                throw new Error(
                    `experimentalToolCallReply 依赖 toolCalling，privateConfigs.${id}.toolCalling 不能关闭。`
                )
            }
        }

        for (const [id, cfg] of Object.entries(config.configs)) {
            if (!cfg.toolCalling) {
                throw new Error(
                    `experimentalToolCallReply 依赖 toolCalling，configs.${id}.toolCalling 不能关闭。`
                )
            }
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
    const replyToolConfigs: Record<string, GuildConfig | PrivateConfig> = {}

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

            replyToolConfigs[key] = copyOfConfig as unknown as
                | GuildConfig
                | PrivateConfig
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
                        copyOfConfig.experimentalToolCallReply
                            ? (currentSession) =>
                                createReplyTools(
                                    ctx,
                                    currentSession,
                                    replyToolConfigs[key]
                                )
                            : undefined
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
            const wakeUpReplies: ReturnType<typeof extractWakeUpReplies> = []
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

                    if (copyOfConfig.experimentalToolCallReply && chunk.toolCalls) {
                        const toolState = parseReplyTools(chunk.toolCalls)
                        nextReplyReasons.push(...toolState.nextReplyReasons)
                        wakeUpReplies.push(...toolState.wakeUpReplies)
                    } else {
                        nextReplyReasons.push(
                            ...extractNextReplyReasons(chunk.responseContent)
                        )
                        wakeUpReplies.push(
                            ...extractWakeUpReplies(chunk.responseContent)
                        )
                    }

                    const sendResult = await handleParsedResponseChunk(
                        session,
                        copyOfConfig,
                        ctx,
                        chunk.parsedResponse
                    )

                    if (!sendResult.sentAny) {
                        continue
                    }

                    sentAny = true
                    lastResponseMessage =
                        copyOfConfig.experimentalToolCallReply &&
                        chunk.toolCalls?.length
                            ? new AIMessage(chunk.responseContent)
                            : chunk.responseMessage
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

            if (!sentAny) {
                if (hasEmptyReplies && !hasNonEmptyReplies) {
                    await registerResponseTriggers(
                        ctx,
                        session,
                        key,
                        copyOfConfig,
                        nextReplyReasons,
                        wakeUpReplies
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
                session,
                key,
                copyOfConfig,
                nextReplyReasons,
                wakeUpReplies
            )

            service.muteAtLeast(session, copyOfConfig.coolDownTime * 1000)
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
