import { BaseMessage } from '@langchain/core/messages'
import { PromptTemplate } from '@langchain/core/prompts'

export interface Message {
    content: string
    name: string
    id: string
    timestamp?: number
    quote?: Message
    images?: string[]
}

export interface GroupTemp {
    completionMessages: BaseMessage[]
    status?: string
}

export interface GuildConfig {
    model: string
    thinkingModel: string
    topicModel: string
    eventLoopModel: string
    maxTokens: number
    imageInput: boolean
    imageLimit: number

    isNickname: boolean
    isForceMute: boolean
    isAt: boolean
    messageInterval: number
    messageActivityScore: number
    coolDownTime: number
    typingTime: number
    muteTime: number
    eventLoop: boolean
    topic: boolean
    think: boolean
    defaultPreset: string
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

export interface SearchAction {
    thought: string
    action: 'url' | 'search' | 'skip'
    content?: string[]
}
