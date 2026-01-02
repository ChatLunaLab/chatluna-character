import { AIMessageChunk, BaseMessage } from '@langchain/core/messages'
import { Runnable, RunnableConfig } from '@langchain/core/runnables'
import { ChatLunaService } from 'koishi-plugin-chatluna/services/chat'
import { ChatLunaChatPromptFormat } from 'koishi-plugin-chatluna/llm-core/chain/prompt'

export interface Message {
    content: string
    name: string
    id: string
    /**
     * Platform message id (e.g. `session.messageId`), used when the plugin
     * chooses to expose message ids to the model.
     */
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
}

export interface ActivityScore {
    score: number
    timestamp: number
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
