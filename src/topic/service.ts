import { Context, Service, Session } from 'koishi'
import { Topic } from './type'
import { Message } from '../message-counter/types'
import { Config } from '..'
import { TopicAnalysisAgent } from './topic-analysis-agent'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'

export class TopicService extends Service {
    private topicMap: Record<string, Topic[]> = {}
    private messageCounter: number = 0;
    private pendingMessages: Record<string, Message[]> = {};
    private messageThreshold: number = 5; // Process after 5 messages

    constructor(
        public readonly ctx: Context,
        public config: Config
    ) {
        super(ctx, 'chatluna_character_topic', true)

        // Register a filter with the message collector
        ctx.on('ready', () => {
            ctx.chatluna_character_message.addTrigger(
                async (session, message, history) => {
                    await this.handleNewMessage(session, message, history);
                },
                async () => true // Always trigger for all messages
            );
        });
    }

    /**
     * Handle a new message from the message collector
     */
    private async handleNewMessage(session: Session, message: Message, history: Message[]): Promise<void> {
        const groupId = session.isDirect ? session.author.id : session.guildId;

        // Initialize pending messages array if not exists
        if (!this.pendingMessages[groupId]) {
            this.pendingMessages[groupId] = [];
        }

        // Add message to pending
        this.pendingMessages[groupId].push(message);

        // Process if we've reached the threshold
        if (this.pendingMessages[groupId].length >= this.messageThreshold) {
            const presetKey = await this.getActivePreset(session);
            if (presetKey) {
                await this.analyzeTopics(presetKey, groupId, this.pendingMessages[groupId]);
            }
            // Clear the pending messages
            this.pendingMessages[groupId] = [];
        }
    }

    /**
     * Get active preset for the current session
     */
    private async getActivePreset(session: Session): Promise<string | null> {
        try {
            // Get active presets from the event loop service
            const activePresets = this.ctx.chatluna_character_event_loop.getActivePresets();

            // For now just return the first active preset
            // In a more advanced implementation, you might want to map sessions to specific presets
            return activePresets.length > 0 ? activePresets[0] : null;
        } catch (error) {
            this.ctx.logger('chatluna_character_topic').error(error);
            return null;
        }
    }

    /**
     * Analyze topics from a batch of messages
     */
    private async analyzeTopics(presetKey: string, groupId: string, messages: Message[]): Promise<void> {
        try {
            // Get existing topics
            const existingTopics = this.getTopics(presetKey);

            // Format messages for the agent
            const formattedMessages = messages.map((msg, index) => {
                return `[${this.messageCounter + index + 1}] ${msg.name}: ${msg.content}`;
            }).join('\n');

            // Format existing topics for the agent
            const formattedTopics = existingTopics.map(topic => topic.content).join(', ');

            // Create the topic analysis agent
            const agent = new TopicAnalysisAgent({
                executeModel: await this.ctx.chatluna.createChatModel(
                    ...parseRawModelName(this.config.model || 'gpt-3.5-turbo')
                )
            });

            // Execute the agent
            let result;
            for await (const action of agent.stream({
                messages: formattedMessages,
                topic: formattedTopics
            })) {
                if (action.type === 'finish') {
                    result = action.action;
                    break;
                }
            }

            if (!result || !result.output) {
                return;
            }

            // Extract topics from the result
            try {
                const output = result.output as string;

                // Try to parse JSON format
                const jsonMatch = output.match(/```json\s*([\s\S]*?)\s*```/i);
                if (jsonMatch && jsonMatch[1]) {
                    const jsonData = JSON.parse(jsonMatch[1].replace(/{{/g, '{').replace(/}}/g, '}'));

                    if (jsonData.topics && Array.isArray(jsonData.topics)) {
                        // Process each topic
                        for (const topicData of jsonData.topics) {
                            if (topicData.summary) {
                                // Create message IDs by adding the current counter
                                const messageIds = (topicData.messages || []).map(
                                    id => typeof id === 'number' ? this.messageCounter + id : id
                                );

                                // Add the topic
                                this.addTopic(presetKey, {
                                    id: `${presetKey}-${Date.now()}-${Math.random().toString(36).substring(2, 10)}`,
                                    content: topicData.summary,
                                    messageIds: messageIds,
                                    createdAt: new Date(),
                                    updatedAt: new Date(),
                                    attention: topicData.attention || 0.5
                                });
                            }
                        }
                    }
                }
            } catch (error) {
                this.ctx.logger('chatluna_character_topic').error(
                    'Failed to parse topics:', error
                );
            }

            // Update message counter
            this.messageCounter += messages.length;

        } catch (error) {
            this.ctx.logger('chatluna_character_topic').error(
                'Topic analysis failed:', error
            );
        }
    }

    /**
     * Add a topic for a preset
     */
    addTopic(presetKey: string, topic: Topic): void {
        if (!this.topicMap[presetKey]) {
            this.topicMap[presetKey] = [];
        }

        // Add the new topic
        this.topicMap[presetKey].push(topic);

        // Limit to 10 topics per preset
        if (this.topicMap[presetKey].length > 10) {
            this.topicMap[presetKey].shift();
        }

        // Emit topic added event
        this.ctx.emit(
            'chatluna_character_topic/added',
            presetKey,
            topic
        );
    }

    /**
     * Get topics for a preset
     */
    getTopics(presetKey: string): Topic[] {
        return this.topicMap[presetKey] || [];
    }

    /**
     * Get the most recent topics for a preset (limited to count)
     */
    getRecentTopics(presetKey: string, count: number = 5): Topic[] {
        const topics = this.topicMap[presetKey] || [];
        return topics.slice(-Math.min(count, topics.length));
    }

    static inject = ['chatluna', 'chatluna_character_message', 'chatluna_character_event_loop']
}

declare module 'koishi' {
    interface Context {
        chatluna_character_topic: TopicService
    }

    interface Events {
        'chatluna_character_topic/added': (
            presetKey: string,
            topic: Topic
        ) => void
    }
}
