import { BaseMessage } from '@langchain/core/messages'
import { PromptTemplate } from '@langchain/core/prompts'

export interface Message {
    content: string
    name: string
    id: string
    timestamp?: number
    quote?: Message
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
    input: PromptTemplate
    system: PromptTemplate
    mute_keyword?: string[]
    path?: string
}

export interface GroupInfo {
    messageCount: number
    messageTimestamps: number[]
    lastActivityScore: number
    lastScoreUpdate: number
    lastResponseTime: number // 新增字段：记录上次响应时间
}

export interface ActivityScore {
    score: number
    timestamp: number
}
