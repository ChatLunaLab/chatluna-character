import { PromptTemplate } from '@langchain/core/prompts'
import { BaseMessage } from '@langchain/core/messages'

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

export interface PresetTemplate {
    name: string
    nick_name: string[]
    input: PromptTemplate
    system: PromptTemplate
    mute_keyword?: string[]
    path?: string
}
