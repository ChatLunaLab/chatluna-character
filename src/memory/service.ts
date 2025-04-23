import { Context, Service } from 'koishi'
import {
    EnhancedMemory,
    MemoryRetrievalLayerType,
    MemoryType
} from 'koishi-plugin-chatluna-long-memory'

export class MemoryService extends Service {
    private userMemoryCache: Record<string, Record<string, string>> = {}

    constructor(public readonly ctx: Context) {
        super(ctx, 'chatluna_character_memory', true)

        // 初始化数据库表
        ctx.database.extend(
            'chatluna_character_memory',
            {
                id: 'unsigned',
                userId: 'string',
                key: 'string',
                content: 'text',
                type: 'string',
                createdAt: 'timestamp'
            },
            {
                primary: 'id',
                autoInc: true
            }
        )
    }

    /**
     * 存储用户记忆到长期记忆服务
     * @param userId 用户ID
     * @param memories 记忆列表
     * @param types 记忆层类型
     */
    async storeToLongMemory(
        userId: string,
        memories: string[],
        types:
            | MemoryRetrievalLayerType
            | MemoryRetrievalLayerType[] = MemoryRetrievalLayerType.USER
    ): Promise<void> {
        if (!this.ctx.chatluna_long_memory) {
            this.ctx
                .logger('chatluna_character_memory')
                .warn('Long memory service not available')
            return
        }

        // 使用conversationId作为用户标识
        const conversationId = `user:${userId}`
        await this.ctx.chatluna_long_memory.addMemories(
            conversationId,
            memories.map((content) => ({
                content,
                type: MemoryType.PREFERENCE,
                importance: 4,
                // 1 month
                expirationDate: new Date(Date.now() + 1000 * 60 * 60 * 24)
            })),
            types
        )
    }

    /**
     * 从长期记忆服务检索用户记忆
     * @param userId 用户ID
     * @param searchContent 搜索内容
     * @param types 记忆层类型
     */
    async retrieveFromLongMemory(
        userId: string,
        searchContent: string,
        types:
            | MemoryRetrievalLayerType
            | MemoryRetrievalLayerType[] = MemoryRetrievalLayerType.USER
    ): Promise<EnhancedMemory[]> {
        if (!this.ctx.chatluna_long_memory) {
            this.ctx
                .logger('chatluna_character_memory')
                .warn('Long memory service not available')
            return []
        }

        // 使用conversationId作为用户标识
        const conversationId = `user:${userId}`
        return await this.ctx.chatluna_long_memory.retrieveMemory(
            conversationId,
            searchContent,
            types
        )
    }

    /**
     * 存储用户记忆到数据库
     * @param userId 用户ID
     * @param key 记忆键
     * @param content 记忆内容
     * @param type 记忆类型
     */
    async storeMemory(
        userId: string,
        key: string,
        content: string,
        type: string = 'summary'
    ): Promise<void> {
        // 更新缓存
        if (!this.userMemoryCache[userId]) {
            this.userMemoryCache[userId] = {}
        }
        this.userMemoryCache[userId][key] = content

        // 检查是否已存在该记忆
        const existingMemory = await this.ctx.database.get(
            'chatluna_character_memory',
            {
                userId,
                key
            }
        )

        const now = new Date()

        if (existingMemory && existingMemory.length > 0) {
            // 更新现有记忆
            await this.ctx.database.set(
                'chatluna_character_memory',
                {
                    userId,
                    key
                },
                {
                    content,
                    type
                }
            )
        } else {
            // 创建新记忆
            await this.ctx.database.create('chatluna_character_memory', {
                userId,
                key,
                content,
                type,
                createdAt: now
            })
        }
    }

    /**
     * 检索用户记忆
     * @param userId 用户ID
     * @param key 记忆键
     */
    async getMemory(userId: string, key: string): Promise<string | null> {
        // 先从缓存中获取
        if (this.userMemoryCache[userId]?.[key]) {
            return this.userMemoryCache[userId][key]
        }

        // 从数据库获取
        const memories = await this.ctx.database.get(
            'chatluna_character_memory',
            {
                userId,
                key
            }
        )

        if (memories && memories.length > 0) {
            // 更新缓存
            if (!this.userMemoryCache[userId]) {
                this.userMemoryCache[userId] = {}
            }
            this.userMemoryCache[userId][key] = memories[0].content
            return memories[0].content
        }

        return null
    }

    /**
     * 获取用户的所有记忆
     * @param userId 用户ID
     * @param type 可选的记忆类型过滤
     */
    async getAllMemories(
        userId: string,
        type?: string
    ): Promise<CharacterMemory[]> {
        const query: Partial<CharacterMemory> = { userId }
        if (type) {
            query.type = type
        }

        return await this.ctx.database.get('chatluna_character_memory', query)
    }

    /**
     * 删除用户记忆
     * @param userId 用户ID
     * @param key 记忆键
     */
    async deleteMemory(userId: string, key: string): Promise<void> {
        // 从缓存中删除
        if (this.userMemoryCache[userId]?.[key]) {
            delete this.userMemoryCache[userId][key]
        }

        // 从数据库中删除
        await this.ctx.database.remove('chatluna_character_memory', {
            userId,
            key
        })
    }

    /**
     * 更新用户情绪摘要
     * @param userId 用户ID
     * @param emotion 情绪描述
     */
    async updateEmotionSummary(userId: string, emotion: string): Promise<void> {
        await this.storeMemory(userId, 'emotion_summary', emotion, 'emotion')
    }

    /**
     * 更新用户常识摘要
     * @param userId 用户ID
     * @param knowledge 常识内容
     */
    async updateKnowledgeSummary(
        userId: string,
        knowledge: string
    ): Promise<void> {
        await this.storeMemory(
            userId,
            'knowledge_summary',
            knowledge,
            'knowledge'
        )
    }

    /**
     * 更新用户总体摘要
     * @param userId 用户ID
     * @param summary 总结内容
     */
    async updateGeneralSummary(userId: string, summary: string): Promise<void> {
        await this.storeMemory(userId, 'general_summary', summary, 'summary')
    }

    /**
     * 获取用户情绪摘要
     * @param userId 用户ID
     */
    async getEmotionSummary(userId: string): Promise<string | null> {
        return await this.getMemory(userId, 'emotion_summary')
    }

    /**
     * 获取用户常识摘要
     * @param userId 用户ID
     */
    async getKnowledgeSummary(userId: string): Promise<string | null> {
        return await this.getMemory(userId, 'knowledge_summary')
    }

    /**
     * 获取用户总体摘要
     * @param userId 用户ID
     */
    async getGeneralSummary(userId: string): Promise<string | null> {
        return await this.getMemory(userId, 'general_summary')
    }

    static inject = ['chatluna_long_memory', 'chatluna']
}

// 定义数据库表结构
declare module 'koishi' {
    interface Tables {
        chatluna_character_memory: CharacterMemory
    }

    interface Context {
        chatluna_character_memory: MemoryService
    }
}

// 定义数据库表结构
export interface CharacterMemory {
    id: number
    userId: string
    key: string
    content: string
    type: string
    createdAt: Date
}
