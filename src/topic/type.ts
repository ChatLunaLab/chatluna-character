export interface Topic {
    id: string
    content: string
    messageIds?: number[]
    attention?: number
    createdAt: Date
    updatedAt: Date
}

export interface TopicMessage {
    content: string
    userId: string
    timestamp: number
    messageId: number
}
