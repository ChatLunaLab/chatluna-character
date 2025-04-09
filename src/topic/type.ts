export interface Topic {
    summary: string
    messages: number[]
}

export interface TopicMessage {
    content: string
    userId: string
    timestamp: number
    messageId: number
}
