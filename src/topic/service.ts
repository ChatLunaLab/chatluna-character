import { Context, Service } from 'koishi'
import { Topic } from './type'
import { Message } from '../message-counter/types'
import { Config } from '..'
import { TopicAnalysisAgent } from './topic-analysis-agent'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'

export class TopicService extends Service {
    private topicMap: Record<string, Topic[]> = {} // groupId -> Topic[]
    private messageCounter: Record<string, number> = {} // groupId -> count
    private messageHistory: Record<string, Message[]> = {} // groupId -> Message[]
    private messageThreshold: number = 5 // Process after 5 messages

    constructor(
        public readonly ctx: Context,
        public config: Config
    ) {
        super(ctx, 'chatluna_character_topic', true)

        // Register handler with the message collector
        ctx.on('ready', () => {
            ctx.chatluna_character_message.addHandler(
                // Handler function - will be called when a message passes the filter
                async (session, message, history) => {
                    const groupId = session.isDirect
                        ? session.author.id
                        : session.guildId

                    await this.analyzeTopics(
                        groupId,
                        history.slice(-this.messageThreshold)
                    )
                },
                // Filter function - only process when we reach the threshold
                async (session, message, history) => {
                    //  console.log(message)
                    return history.length % this.messageThreshold === 0
                }
            )
        })
    }

    /**
     * Analyze topics from a batch of messages
     */
    async analyzeTopics(groupId: string, messages: Message[]): Promise<void> {
        try {
            // Initialize message counter for this group if not exists
            if (!this.messageCounter[groupId]) {
                this.messageCounter[groupId] = 0
            }

            // Initialize message history if not exists
            if (!this.messageHistory[groupId]) {
                this.messageHistory[groupId] = []
            }

            // Store current messages for history update later
            const currentMessages = [...messages]

            // Get existing topics
            const existingTopics = this.getTopics(groupId)

            // Format new messages for the agent
            const formattedNewMessages = JSON.stringify(
                messages.map((msg) => ({
                    name: msg.name,
                    content: msg.content,
                    id: msg.uuid
                }))
            )

            // Format history messages
            const formattedHistoryMessages = JSON.stringify(
                this.messageHistory[groupId].map((msg) => ({
                    name: msg.name,
                    content: msg.content,
                    id: msg.uuid
                }))
            )

            // Format existing topics for the agent
            const formattedTopics = existingTopics
                .map((topic) => topic.content)
                .join(', ')

            // Create the topic analysis agent
            const agent = new TopicAnalysisAgent({
                executeModel: await this.ctx.chatluna.createChatModel(
                    ...parseRawModelName(this.config.model || 'gpt-3.5-turbo')
                )
            })

            // Execute the agent
            let result
            for await (const action of agent.stream({
                messages: formattedHistoryMessages,
                messages_new: formattedNewMessages,
                topic: formattedTopics
            })) {
                if (action.type === 'finish') {
                    result = action.action
                    break
                }
            }

            if (!result || !result.output) {
                return
            }

            // Update message history with new messages
            this.messageHistory[groupId] = [
                ...this.messageHistory[groupId],
                ...currentMessages
            ]

            // Limit history size (keep last 50 messages)
            const maxHistorySize = 50
            if (this.messageHistory[groupId].length > maxHistorySize) {
                this.messageHistory[groupId] =
                    this.messageHistory[groupId].slice(-maxHistorySize)
            }

            // Extract topics from the result
            try {
                const output = result.output as string

                console.log('output', output)

                // Try to parse JSON format
                const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/i)
                if (jsonMatch && jsonMatch[1]) {
                    const jsonData = JSON.parse(
                        jsonMatch[1].replace(/{{/g, '{').replace(/}}/g, '}')
                    )

                    if (jsonData.topics && Array.isArray(jsonData.topics)) {
                        // Process each topic
                        for (const topicData of jsonData.topics) {
                            if (topicData.summary) {
                                // Create message IDs by adding the current counter
                                const messageIds = (
                                    topicData.messages || []
                                ).map((id) =>
                                    typeof id === 'number'
                                        ? this.messageCounter[groupId] + id
                                        : id
                                )

                                // Add the topic
                                this.addTopic(groupId, {
                                    id: `${groupId}-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
                                    content: topicData.summary,
                                    messageIds,
                                    createdAt: new Date(),
                                    updatedAt: new Date(),
                                    attention: topicData.attention || 0.5
                                })
                            }
                        }
                    }
                }
            } catch (error) {
                this.ctx
                    .logger('chatluna_character_topic')
                    .error('Failed to parse topics:', error)
            }

            // Update message counter
            this.messageCounter[groupId] += messages.length
        } catch (error) {
            this.ctx
                .logger('chatluna_character_topic')
                .error('Topic analysis failed:', error)
        }
    }

    /**
     * Add a topic for a group
     */
    addTopic(groupId: string, topic: Topic): void {
        if (!this.topicMap[groupId]) {
            this.topicMap[groupId] = []
        }

        // Add the new topic
        this.topicMap[groupId].push(topic)

        // Limit to 10 topics per group
        if (this.topicMap[groupId].length > 10) {
            this.topicMap[groupId].shift()
        }

        // Emit topic added event
        this.ctx.emit('chatluna_character_topic/added', groupId, topic)
    }

    /**
     * Get topics for a group
     */
    getTopics(groupId: string): Topic[] {
        return this.topicMap[groupId] || []
    }

    /**
     * Get the most recent topics for a group (limited to count)
     */
    getRecentTopics(groupId: string, count: number = 5): Topic[] {
        const topics = this.getTopics(groupId)
        return topics.slice(-Math.min(count, topics.length))
    }

    /**
     * Set the message threshold
     */
    setMessageThreshold(threshold: number): void {
        this.messageThreshold = threshold
    }

    static inject = ['chatluna', 'chatluna_character_message']
}

declare module 'koishi' {
    interface Context {
        chatluna_character_topic: TopicService
    }

    interface Events {
        'chatluna_character_topic/added': (
            groupId: string,
            topic: Topic
        ) => void
    }
}
