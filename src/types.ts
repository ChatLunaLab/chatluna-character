import { BaseMessage } from '@langchain/core/messages'
import { PromptTemplate } from '@langchain/core/prompts'

export interface Message {
    content: string
    name: string
    id: string
    quote?: Message
}

export interface GroupTemp {
    completionMessages: BaseMessage[]
}

export interface ModelResponse {
    think: string
    reply: string
}

export interface GuildConfig {
    preset: string
    messageInterval: number
    maxTokens: number
    isNickname: boolean
    isForceMute: boolean
    sendStickerProbability: number

    coolDownTime: number
    typingTime: number
    muteTime: number
}

export interface PresetTemplate {
    name: string
    nick_name: string[]
    input: PromptTemplate
    system: PromptTemplate
    mute_keyword?: string[]
    path?: string
}

export interface GroupInfo {
    messageCount: number
    messageSendProbability: number
}
