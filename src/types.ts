import { AIMessageChunk, BaseMessage } from '@langchain/core/messages'
import { RunnableConfig } from '@langchain/core/runnables'
import { ChatLunaService } from 'koishi-plugin-chatluna/services/chat'
import { ChatLunaChatPromptFormat } from 'koishi-plugin-chatluna/llm-core/chain/prompt'
import { Bot, Session } from 'koishi'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ChatLunaRunnableConfig = RunnableConfig<Record<string, any>>

export interface Message {
    content: string
    name: string
    id: string
    messageId?: string
    timestamp?: number
    quote?: Message
    images?: {
        url: string
        hash: string
        formatted: string
    }[]
}

export interface GroupTemp {
    completionMessages: BaseMessage[]
    lastHistoryNew?: string[]
    status?: string | null
    recordLoaded?: boolean
    historyPulled?: boolean
    historyClearedAt?: Date
    statusMessageId?: string | null
    statusMessageUserId?: string | null
}

export interface GuildConfig {
    model: string
    maxMessages: number
    preset: string
    remark: string
    enableMessageId: boolean
    enableFixedIntervalTrigger: boolean
    messageInterval: number
    idleTrigger: {
        enableLongWaitTrigger: boolean
        idleTriggerIntervalMinutes: number
        idleTriggerRetryStyle: 'exponential' | 'fixed'
        idleTriggerMaxIntervalMinutes: number
        idleTriggerFixedMaxRetries: number
        enableIdleTriggerJitter: boolean
    }
    messageActivityScoreLowerLimit: number
    messageActivityScoreUpperLimit: number
    enableActivityScoreTrigger: boolean
    maxTokens: number
    isNickname: boolean
    isNickNameWithContent: boolean
    isForceMute: boolean
    sendStickerProbability: number
    image: boolean
    imageInputMaxCount: number
    imageInputMaxSize: number
    multimodalFileInputMaxSize: number
    largeTextSize: number
    largeTextTypingTime: number
    coolDownTime: number
    splitVoice: boolean
    isAt: boolean
    typingTime: number
    muteTime: number
    modelCompletionCount: number
    toolCalling: boolean
    historyPull: boolean
    statusPersistence: boolean
}

export type PrivateConfig = Omit<
    GuildConfig,
    | 'messageActivityScoreLowerLimit'
    | 'messageActivityScoreUpperLimit'
    | 'enableActivityScoreTrigger'
    | 'isAt'
> & {
    messageWaitTime: number
}

export interface CharacterVariableRecord {
    sessionKey: string
    status?: string | null
    historyClearedAt?: Date
    statusMessageId?: string | null
    statusMessageUserId?: string | null
    updatedAt: Date
}

export interface WakeUpReplyRecord {
    id?: number
    sessionKey: string
    botId: string
    channelId: string
    guildId?: string | null
    userId: string
    rawTime: string
    reason: string
    naturalReason: string
    triggerAtV2: Date
    createdAtV2: Date
    updatedAt: Date
}

export interface OneBotHistoryMessage {
    raw_message?: string
    message_id?: number
    message_seq?: number
    time?: number
    sender?: {
        user_id?: number
        nickname?: string
        card?: string
    }
}

export interface PresetTemplate {
    name: string
    status?: string
    nick_name: string[]
    input: ChatLunaCharacterPromptTemplate
    system: ChatLunaCharacterPromptTemplate
    mute_keyword?: string[]
    path?: string
}

export interface GroupInfo {
    messageCount: number
    messageTimestamps: number[]
    messageTimestampsByUserId?: Record<string, number>
    lastActivityScore: number
    lastScoreUpdate: number
    lastResponseTime: number
    currentActivityThreshold: number
    lastUserMessageTime: number
    lastMessageUserId?: string
    lastPassiveTriggerAt?: number
    passiveRetryCount?: number
    currentIdleWaitSeconds?: number
    pendingNextReplies?: PendingNextReply[]
    pendingWakeUpReplies?: PendingWakeUpReply[]
}

export interface ActivityScore {
    score: number
    timestamp: number
}

export type NextReplyPredicate =
    | { type: 'time'; seconds: number }
    | { type: 'id'; userId: string }
    | { type: 'time_id'; seconds: number; userId: string }

export interface PendingNextReplyConditionGroup {
    predicates: NextReplyPredicate[]
    naturalReason: string
}

export interface PendingNextReply {
    rawReason: string
    groups: PendingNextReplyConditionGroup[]
    sentAt: number
}

export interface PendingWakeUpReply {
    rawTime: string
    reason: string
    naturalReason: string
    triggerAt: number
    createdAt: number
}

export interface ChatLunaChain {
    invoke(
        input: ChatLunaChatPromptFormat,
        options?: ChatLunaRunnableConfig
    ): Promise<AIMessageChunk>
    stream(
        input: ChatLunaChatPromptFormat,
        options?: ChatLunaRunnableConfig
    ): AsyncGenerator<ChatLunaChainStreamChunk>
}

export interface ChatLunaChainStreamChunk {
    message: AIMessageChunk
    phase: 'intermediate' | 'final'
}

export interface StreamedModelResponseChunk<TParsed = unknown> {
    responseMessage: BaseMessage
    responseContent: string
    parsedResponse: TParsed
}

export interface ChatLunaCharacterPromptTemplate {
    rawString: string
    format(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        variables: Record<string, any>,
        variableService: ChatLunaService['promptRenderer'],
        configurable: Parameters<
            ChatLunaService['promptRenderer']['renderTemplate']
        >[2]['configurable']
    ): Promise<string>
}

export type MessageCollectorFilter = (
    session: Session,
    message: Message
) => string | false | undefined

export interface GroupLock {
    mute: number
    responseLock: boolean
}

export type MessageImage = {
    url: string
    hash: string
    formatted: string
}

export type KoishiMessage = Awaited<ReturnType<Bot['getMessage']>>

export type PendingCooldownTrigger = {
    session: Session
    triggerReason: string
    message: Message
}

export const IMAGE_SIZE_CACHE_LIMIT = 512

export const MAX_IDLE_WAIT_SECONDS = 60 * 60 * 24 * 30

declare module 'koishi' {
    interface Tables {
        chathub_character_variable: CharacterVariableRecord
        chathub_character_wake_up_reply: WakeUpReplyRecord
    }
}
