export interface Topic {
    id: string
    content: string
    createdAt: Date
    updatedAt: Date
}

export interface Think {
    content: string
    emotion: string
    socialTendency?: string
    createdAt: Date
    updatedAt: Date
}

export interface ThinkRecord {
    id: number
    presetKey: string
    groupId?: string
    privateId?: string
    content: string
    emotion: string
    socialTendency?: string
    createdAt: Date
    updatedAt: Date
}
