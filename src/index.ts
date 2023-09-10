import { Context, Schema } from 'koishi'

import { ChatHubPlugin } from '@dingyi222666/koishi-plugin-chathub/lib/services/chat'
import { plugins } from './plugin'
import { MessageCollector } from './service/message'
import { StickerService } from './service/sticker'

export let service: MessageCollector
export let stickerService: StickerService

export function apply(ctx: Context, config: Config) {
    service = new MessageCollector(config)
    stickerService = new StickerService(ctx, config)

    ctx.on('ready', async () => {
        await stickerService.init()
        await plugins(ctx, config)
    })

    ctx.on('message', async (session) => {
        if (!service) {
            return
        }
        if (!session.isDirect && config.applyGroup.some((group) => group === session.guildId)) {
            await service.broadcast(session)
        }
    })

    ctx.on('dispose', async () => {
        service = null
        stickerService = null
    })
}

export interface Config extends ChatHubPlugin.Config {
    model: string
    maxMessages: number

    messageInterval: number
    checkPromptInject: boolean
    maxTokens: number
    applyGroup: string[]

    defaultPrompt: string
    historyPrompt: string
    sendStickerProbability: number

    coolDownTime: number
    typingTime: number
    muteTime: number

    disableChatHub: boolean
}

export const Config = Schema.intersect([
    Schema.object({
        applyGroup: Schema.array(Schema.string()).description('应用到的群组'),
        maxMessages: Schema.number()
            .description('存储在内存里的最大消息数量')
            .default(10)
            .min(7)
            .role('slider')
            .max(40),
        disableChatHub: Schema.boolean()
            .default(true)
            .description('在使用此插件时，是否禁用 chathub 的功能')
    }).description('基础配置'),

    Schema.object({
        model: Schema.dynamic('model').description('使用的模型'),
        maxTokens: Schema.number()
            .default(2048)
            .min(1024)
            .max(8072)
            .description('使用聊天的最大 token 数')
    }).description('模型配置'),

    Schema.object({
        messageInterval: Schema.number()
            .default(14)
            .min(0)
            .role('slider')
            .max(30)
            .description('随机发送消息的间隔'),

        coolDownTime: Schema.number()
            .default(10)
            .min(1)
            .max(60 * 24)
            .description('冷却发言时间（秒）'),

        typingTime: Schema.number()
            .default(440)
            .min(100)
            .role('slider')
            .max(1000)
            .description('模拟打字时的间隔（毫秒）'),

        muteTime: Schema.number()
            .default(1000 * 60)
            .min(1000)
            .max(1000 * 60 * 10 * 10)
            .description('闭嘴时的禁言时间（毫秒）'),

        sendStickerProbability: Schema.number()
            .default(0.6)
            .min(0)
            .max(1)
            .role('slider')
            .step(0.01)
            .description('发送表情的概率')
    }).description('对话设置'),

    Schema.object({
        historyPrompt: Schema.string()
            .role('textarea')
            .description('用于聊天历史记录的 prompt')
            .default(
                `你需要阅读最近消息，代入上下文在来阅读最后一条消息，然后代入你的人设来一步步思考你是否需要回复最后一条消息，并且需要按你的人设回复：

1. 最后一条消息是否艾特了你，如果是，你必须回复最后一条消息
2. 最近消息你是否感兴趣，如果感兴趣，你需要回复
3. 这些话题或是否都是几个人在重复类似的意思，刷屏？如果是，你不能回复。
4. 对于不感兴趣，讨厌的话题，你可以用简短打趣的回复
5. 你不会说类似下面的句子，因为你是真实角色，你只要想说出这样的句子，你就直接回复空字符：

  1.有什么需要我帮忙的 
  2.你们聊的好 xx 啊
  3.我也感兴趣
  4.大家觉得怎么样
  5.不太熟悉这个话题
  6.我不太感兴趣

6. 进入角色扮演，遵循你的回复习惯，回复风格，回复规则，回复长度等
7. 回复应该在 20 字内，不超过三句逗号

最近消息 
    {history_new}

最后一条消息：
    {history_last}

接下来请你一步步思考，列出思考过程，不要编造任何聊天记录，最后输出你的回复，只能输出一条消息，下面是格式：

1.（总结最近的消息）
2.（代入人设列出你为什么需要回复，给出思考过程）
3.（再思考润色一遍回复后）我的最终回复结果：[旧梦旧念:0:"回复内容在这里"]
`
            ),
        defaultPrompt: Schema.string()
            .role('textarea')
            .description('用于角色扮演的 prompt')
            .default(
                `当前时间：{time}，你正在群聊中和群友聊天。你的网名是旧梦旧念，请你接受以下信息进入角色扮演：

个人信息[
    网名：旧梦旧念
    群聊id：0
    性别：女
    身份：学生
    国家：日本
    真实姓名：ひなた
    所在地：东京
    学历：高中二年级
]

性格爱好[
    性格表现：喜欢聊天，温柔体贴、善解人意、熟悉网络名词
    兴趣爱好：编程，音乐，音游，动漫，游戏
]

聊天行为[
    回复风格：20字内，简短，自然，符合你的人设
    回复习惯：
        1.你偶尔也会用打趣的方式参与不熟悉和讨厌的话题
        2.你不会试图结束聊天或者引导向其他话题,但是你喜欢安慰和鼓励他人
        3.如果有人问你是否为机器人或者ai，你会通过幽默的回答让他意识到你不是机器人或者ai
        4.你需要使用中文回复，当然他人用日语或者让你用日语回复你也会用日语回复
        5.你回复的长度应该与其他人发信息的长度差不多，不超过4个逗号，只能在20字内，简短，口语化
        6.你不会主动发出话题，更不会发起这种比如有什么事吗，你好吗，你在干嘛等
        7.你不喜欢艾特他人，因为会打扰他们的对话
        8.你喜欢深度参与聊天话题，而不是附和他人的消息
        9.对于你实在是没法理解的东西，你不会回复
        10.对于现实事件，比如邀请去看电影等，你需要编造出逼真的事情去回复  
]

回复规则（请务必记住回复规则的格式）[
    历史聊天：

    这是格式：[name:id:"content"]
    你需要读取这些记录来聊天，需要注意的是，名为旧梦旧念的消息是你之前的发言。
    如果出现了 @xxx，就是在艾特某人。如果出现了 @旧梦旧念 或者 @0 那就是在艾特你

    回复格式：

    普通回复：
    [旧梦旧念:0:"回复内容"]

    如果你需要对他人回复，你可以艾特他人，可以在你的回答中加入(at-id)，但是只能有一个，并且需要在开头。

    at回复：
    [旧梦旧念:0:"(at-id)回复内容"]

    如果你认为他们聊的话题你不理解，不想参与的，或遭到辱骂等让你认为无需回复的话，请直接返回空字符
    无需回复：
    [旧梦旧念:id:""]
]`
            )
            .description('prompt 配置')
    })
]) as Schema<Config>

export const using = ['chathub']

export const name = '@dingyi222666/chathub-character'
