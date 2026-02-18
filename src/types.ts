import { AIMessageChunk, BaseMessage } from '@langchain/core/messages'
import { Runnable, RunnableConfig } from '@langchain/core/runnables'
import { ChatLunaService } from 'koishi-plugin-chatluna/services/chat'
import { ChatLunaChatPromptFormat } from 'koishi-plugin-chatluna/llm-core/chain/prompt'
import { Session } from 'koishi'

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
    status?: string
}

export interface GuildConfig {
    preset: string
    enableMessageId: boolean
    messageInterval: number
    enableLongWaitTrigger: boolean
    idleTriggerIntervalMinutes: number
    idleTriggerRetryStyle: 'exponential' | 'fixed'
    enableIdleTriggerMaxInterval: boolean
    idleTriggerMaxIntervalMinutes: number
    enableIdleTriggerJitter: boolean
    messageActivityScoreLowerLimit: number
    messageActivityScoreUpperLimit: number
    maxTokens: number
    isNickname: boolean
    isNickNameWithContent: boolean
    isForceMute: boolean
    sendStickerProbability: number
    image: boolean
    imageInputMaxCount: number
    imageInputMaxSize: number
    splitSentence: boolean
    markdownRender: boolean
    largeTextSize: number
    largeTextTypingTime: number
    coolDownTime: number
    splitVoice: boolean
    isAt: boolean
    typingTime: number
    muteTime: number
    modelCompletionCount: number
    toolCalling: boolean
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

export interface PendingNextReplyConditionGroup {
    predicates: NextReplyPredicate[]
    naturalReason: string
}

export interface PendingNextReply {
    rawReason: string
    groups: PendingNextReplyConditionGroup[]
    createdAt: number
}

export interface PendingWakeUpReply {
    rawTime: string
    reason: string
    naturalReason: string
    triggerAt: number
    createdAt: number
}

export type ChatLunaChain = Runnable<
    ChatLunaChatPromptFormat,
    AIMessageChunk,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    RunnableConfig<Record<string, any>>
>
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
    lock: boolean
    mute: number
    responseLock: boolean
}

export type MessageImage = {
    url: string
    hash: string
    formatted: string
}
