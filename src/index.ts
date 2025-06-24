/* eslint-disable max-len */
import { Context, Disposable, Schema } from 'koishi'

import { ChatLunaPlugin } from 'koishi-plugin-chatluna/services/chat'
import { plugins } from './plugin'
import { MessageCollector } from './service/message'
import { GuildConfig } from './types'

export function apply(ctx: Context, config: Config) {
    const disposables: Disposable[] = []

    ctx.on('ready', async () => {
        ctx.plugin(MessageCollector, config)

        ctx.plugin(
            {
                apply: async (ctx: Context, config: Config) => {
                    await ctx.chatluna_character.stickerService.init()
                    await ctx.chatluna_character.preset.init()
                    await plugins(ctx, config)
                },
                inject: Object.assign({}, inject2, {
                    chatluna_character: {
                        required: true
                    }
                }),
                name: 'chatluna_character_entry_point'
            },
            config
        )

        disposables.push(
            ctx.middleware((session, next) => {
                if (!ctx.chatluna_character) {
                    return next()
                }

                // 不接收自己的消息
                if (ctx.bots[session.uid]) {
                    return next()
                }

                const guildId = session.guildId

                if (!config.applyGroup.includes(guildId)) {
                    return next()
                }

                return next(async (loop) => {
                    if (!(await ctx.chatluna_character.broadcast(session))) {
                        return loop()
                    }
                })
            })
        )
    })

    ctx.on('dispose', () => {
        disposables.forEach((disposable) => disposable())
    })
}

export const inject = {
    required: ['chatluna'],
    optional: ['chatluna_character', 'vits']
}

export const inject2 = {
    chatluna: {
        required: true
    },
    chatluna_character: {
        required: false
    },
    vits: {
        required: false
    }
}

export interface Config extends ChatLunaPlugin.Config {
    model: string
    maxMessages: number

    messageInterval: number
    messageActivityScore: number

    maxTokens: number
    applyGroup: string[]
    searchKeywordExtraModel: string

    modelOverride: { groupId: string; model: string }[]
    configs: Record<string, GuildConfig>

    defaultPreset: string
    isNickname: boolean
    search: boolean
    largeTextSize: number
    largeTextTypingTime: number

    searchSummaryType: string
    searchPrompt: string
    isForceMute: boolean
    sendStickerProbability: number
    image: boolean
    imageInputMaxCount: number
    imageInputMaxSize: number
    modelCompletionCount: number

    coolDownTime: number
    typingTime: number
    muteTime: number

    disableChatLuna: boolean
    whiteListDisableChatLuna: string[]

    splitVoice: boolean
    splitSentence: boolean
    isAt: boolean
}

export const Config = Schema.intersect([
    Schema.object({
        applyGroup: Schema.array(Schema.string()).description('应用到的群组'),
        maxMessages: Schema.number()
            .description('存储在内存里的最大消息数量')
            .default(10)
            .min(3)
            .role('slider')
            .max(100),
        disableChatLuna: Schema.boolean()
            .default(true)
            .description('在使用此插件的群聊里，是否禁用 ChatLuna 主功能'),
        whiteListDisableChatLuna: Schema.array(Schema.string()).description(
            '在使用此插件时，不禁用 ChatLuna 主功能的群聊列表'
        )
    }).description('基础配置'),

    Schema.object({
        model: Schema.dynamic('model').default('').description('使用的模型'),
        modelOverride: Schema.array(
            Schema.object({
                groupId: Schema.string().required().description('群组 ID'),
                model: Schema.dynamic('model').default('').description('模型')
            })
        ).description('针对某个群的模型设置，会覆盖上面的配置'),
        maxTokens: Schema.number()
            .default(5000)
            .min(1024)
            .max(42000)
            .description('聊天的最大 token 数'),
        image: Schema.boolean()
            .description(
                '是否允许输入图片（注意表情包也会输入，目前仅支持原生多模态的模型）'
            )
            .default(false),
        imageInputMaxCount: Schema.number()
            .default(3)
            .min(1)
            .max(15)
            .description('最大的输入图片数量'),

        imageInputMaxSize: Schema.number()
            .default(3)
            .min(1)
            .max(20)
            .description('最大的输入图片大小（MB）'),
        search: Schema.boolean()
            .description('是否启用联网搜索功能')
            .default(false),
        searchSummaryType: Schema.union([
            Schema.const('speed').description('性能模式'),
            Schema.const('balanced').description('平衡模式'),
            Schema.const('quality').description('质量模式')
        ])
            .description('搜索结果的摘要模式')
            .default('speed'),
        searchPrompt: Schema.string().description('搜索提示词').role('textarea')
            .default(`Analyze the follow-up question and return a JSON response based on the given conversation context.

Rules:
- CRITICAL: Use the exact same language as the input. Do not translate or change the language under any circumstances.
- Make the question self-contained and clear
- Optimize for search engine queries
- Do not add any explanations or additional content
- Base your response on a comprehensive analysis of the chat history
- Return your response in the following JSON format ONLY:
  {{
    "thought": "your reasoning about what to do with this question. Use the text language as the input",
    "action": "skip" | "search" | "url",
    "content": ["string1", "string2", ...] (optional array of strings)
  }}

Action types explanation:
1. "skip" - Use when the question doesn't require an internet search (e.g., personal opinions, simple calculations, or information already provided in the chat history)
   Example: {{ "thought": "This is asking for a personal opinion which doesn't require search", "action": "skip" }}

2. "search" - Use when you need to generate search-engine-friendly questions
   Example: For "What's the weather like in Tokyo and New York?"
   {{ "thought": "This requires checking current weather in two different cities", "action": "search", "content": ["Current latest weather in Tokyo", "Current latest weather in New York"] }}

3. "url" - Use when the message contains one or more URLs that should be browsed
   Example: For "Can you summarize the information from https://example.com/article and https://example.org/data?"
   {{ "thought": "This requires browsing two specific URLs to gather information", "action": "url", "content": ["https://example.com/article", "https://example.org/data"] }}

IMPORTANT: Your JSON response MUST be in the same language as the follow up input. This is crucial for maintaining context and accuracy.

Chat History:
{chat_history}
Follow-up Input: {question}
JSON Response:`),
        searchKeywordExtraModel: Schema.dynamic('model')
            .default('')
            .description('搜索时使用的模型')
    }).description('模型配置'),

    Schema.object({
        isNickname: Schema.boolean()
            .description('允许 bot 配置中的昵称引发回复')
            .default(true),
        isForceMute: Schema.boolean()
            .description(
                '是否启用强制禁言（当聊天涉及到关键词时则会禁言，关键词需要在预设文件里配置）'
            )
            .default(true),
        isAt: Schema.boolean()
            .description('是否允许 bot 艾特他人')
            .default(true),
        splitVoice: Schema.boolean()
            .description('是否分段发送语音')
            .default(false),
        splitSentence: Schema.boolean()
            .description(
                '是否启用自分割发送消息 **注意请确保你的预设和模型在使用时支持自分割消息，否则请不要关闭**'
            )
            .default(true),
        messageInterval: Schema.number()
            .default(14)
            .min(0)
            .role('slider')
            .max(10000)
            .description('随机发送消息的间隔'),
        messageActivityScore: Schema.number()
            .default(0.6)
            .min(0)
            .max(1)
            .role('slider')
            .step(0.00001)
            .description(
                '消息活跃度分数的阈值，当活跃度超过这个阈值则会发送消息'
            ),

        coolDownTime: Schema.number()
            .default(10)
            .min(1)
            .max(60 * 24)
            .description('冷却发言时间（秒）'),

        typingTime: Schema.number()
            .default(440)
            .min(100)
            .role('slider')
            .max(1500)
            .description('模拟打字时的间隔（毫秒）'),

        largeTextSize: Schema.number()
            .default(300)
            .min(100)
            .max(1000)
            .description('大文本消息的判断阈值（字符数）'),

        largeTextTypingTime: Schema.number()
            .default(100)
            .min(10)
            .max(1500)
            .description('大文本消息的固定打字间隔（毫秒）'),

        muteTime: Schema.number()
            .default(1000 * 60)
            .min(1000)
            .max(1000 * 60 * 10 * 10)
            .description('闭嘴时的禁言时间（毫秒）'),

        modelCompletionCount: Schema.number()
            .default(3)
            .min(0)
            .max(6)
            .description('模型历史消息轮数，为 0 不发送之前的历史轮次'),

        sendStickerProbability: Schema.number()
            .default(0.0)
            .min(0)
            .max(1)
            .role('slider')
            .step(0.01)
            .description('发送表情的概率（即将废弃，将制作新的表情系统插件）'),
        defaultPreset: Schema.dynamic('character-preset')
            .description('使用的伪装预设')
            .default('煕')
    }).description('对话设置'),

    Schema.object({
        configs: Schema.dict(
            Schema.object({
                maxTokens: Schema.number()
                    .default(4000)
                    .min(1024)
                    .max(20000)
                    .description('使用聊天的最大 token 数'),

                isAt: Schema.boolean().description('是否启用@').default(true),
                splitVoice: Schema.boolean()
                    .description('是否分段发送语音')
                    .default(false),
                splitSentence: Schema.boolean()
                    .description(
                        '是否启用自分割发送消息 **注意请确保你的预设和模型在使用时支持自分割消息，否则请不要关闭**'
                    )
                    .default(true),
                isNickname: Schema.boolean()
                    .description('允许 bot 配置中的昵称引发回复')
                    .default(true),
                isForceMute: Schema.boolean()
                    .description(
                        '是否启用强制禁言（当聊天涉及到关键词时则会禁言，关键词需要在预设文件里配置）'
                    )
                    .default(true),
                messageInterval: Schema.number()
                    .default(10)
                    .min(0)
                    .role('slider')
                    .max(10000)
                    .description('随机发送消息的间隔'),
                messageActivityScore: Schema.number()
                    .default(0.6)
                    .min(0)
                    .max(1)
                    .role('slider')
                    .step(0.00001)
                    .description(
                        '消息活跃度分数的阈值，当活跃度超过这个阈值则会发送消息'
                    ),
                search: Schema.boolean()
                    .description('是否启用联网搜索功能')
                    .default(false),
                image: Schema.boolean()
                    .description(
                        '是否允许输入图片（注意表情包也会输入，目前仅支持原生多模态的模型）'
                    )
                    .default(false),

                imageInputMaxCount: Schema.number()
                    .default(3)
                    .min(1)
                    .max(15)
                    .description('最大的输入图片数量'),

                imageInputMaxSize: Schema.number()
                    .default(1024 * 1024 * 10)
                    .min(1024 * 1024 * 1)
                    .max(1024 * 1024 * 20)
                    .description('最大的输入图片大小（KB）'),
                coolDownTime: Schema.number()
                    .default(10)
                    .min(1)
                    .max(60 * 24 * 24)
                    .description('冷却发言时间（秒）'),

                typingTime: Schema.number()
                    .default(440)
                    .min(100)
                    .role('slider')
                    .max(1700)
                    .description('模拟打字时的间隔（毫秒）'),
                largeTextSize: Schema.number()
                    .default(300)
                    .min(100)
                    .max(1000)
                    .description('大文本消息的判断阈值（每段分句的字符数）'),

                largeTextTypingTime: Schema.number()
                    .default(100)
                    .min(10)
                    .max(1500)
                    .description('大文本消息的模拟打字间隔（毫秒）'),

                muteTime: Schema.number()
                    .default(1000 * 60)
                    .min(1000)
                    .max(1000 * 60 * 10 * 10)
                    .description('闭嘴时的禁言时间（毫秒）'),

                modelCompletionCount: Schema.number()
                    .default(3)
                    .min(0)
                    .max(6)
                    .description('模型历史消息轮数，为 0 不发送之前的历史轮次'),

                sendStickerProbability: Schema.number()
                    .default(0)
                    .min(0)
                    .max(1)
                    .role('slider')
                    .step(0.01)
                    .description('发送表情的概率'),
                preset: Schema.dynamic('character-preset')
                    .description('使用的伪装预设')
                    .default('煕')
            })
        )
            .role('table')
            .description('分群配置，会覆盖上面的默认配置（键填写群号）')
    }).description('分群配置')
]) as unknown as Schema<Config>

export const name = 'chatluna-character'
