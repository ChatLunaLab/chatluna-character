import { AIMessageChunk, BaseMessage } from '@langchain/core/messages'
import { Runnable, RunnableConfig } from '@langchain/core/runnables'
import { ChatLunaService } from 'koishi-plugin-chatluna/services/chat'
import { ChatLunaChatPromptFormat } from 'koishi-plugin-chatluna/llm-core/chain/prompt'

export interface Message {
    content: string
    name: string
    id: string
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
    messageInterval: number
    maxTokens: number
    isNickname: boolean
    isForceMute: boolean
    sendStickerProbability: number
    image: boolean
    imageInputMaxCount: number
    imageInputMaxSize: number
    splitSentence: boolean
    markdownRender: boolean

    coolDownTime: number
    splitVoice: boolean
    isAt: boolean
    typingTime: number
    messageProbability: number
    muteTime: number
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
