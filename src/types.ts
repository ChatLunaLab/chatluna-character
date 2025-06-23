import { BaseMessage } from '@langchain/core/messages'
import { ChatLunaService } from 'koishi-plugin-chatluna/services/chat'

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

export interface ChatLunaCharacterPromptTemplate {
    rawString: string
    format(
        variables: Record<string, string | number | boolean | string[]>,
        variableService: ChatLunaService['_variable']
    ): Promise<string>
}
