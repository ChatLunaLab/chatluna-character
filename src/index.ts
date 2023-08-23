import { Context, Schema } from 'koishi'

import { ChatHubPlugin } from "@dingyi222666/koishi-plugin-chathub/lib/services/chat"
import { plugins } from './plugin'
import { MessageCollector } from './service/message'
import { StickerService } from './service/sticker'


export let service: MessageCollector
export let stickerService: StickerService

class CharacterPlugin extends ChatHubPlugin<CharacterPlugin.Config> {
    name = '@dingyi222666/chathub-character'

    public constructor(protected ctx: Context, public readonly config: CharacterPlugin.Config) {
        super(ctx, config)

        service = new MessageCollector(config)
        stickerService = new StickerService(ctx, config)

        setTimeout(async () => {
            await stickerService.init()
            await plugins(ctx, config)
        }, 0)

        ctx.on("message", async (session) => {
            if (!session.isDirect && config.applyGroup.some(group => group === session.guildId)) {
                await service.broadcast(session)
            }
        })
    }

}

namespace CharacterPlugin {
    export interface Config extends ChatHubPlugin.Config {
        model: string,
        maxMessages: number,

        messageInterval: number,
        checkPromptInject: boolean
        maxTokens: number,
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
            applyGroup: Schema.array(Schema.string())
                .description('应用到的群组'),
            maxMessages: Schema.number()
                .description('存储在内存里的最大消息数量')
                .default(10)
                .min(7)
                .role('slider')
                .max(40),
            disableChatHub: Schema.boolean()
                .default(true)
                .description("在使用此插件时，是否禁用 chathub 的功能")
        }).description('基础配置'),

        Schema.object({
            model: Schema.dynamic('model')
                .description('使用的模型'),
            maxTokens: Schema.number()
                .default(2048)
                .min(1024)
                .max(8072)
                .description('使用聊天的最大 token 数'),
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
                .description('发送表情的概率'),
        }).description('对话设置'),


        Schema.object({
            historyPrompt: Schema.string()
                .role("textarea")
                .description('用于聊天历史记录的 prompt')
                .default(
                    `现在请你按照下面的聊天记录、根据你的预设、回复风格和聊天规则等判断最近的消息你是否需要回复。

你需要阅读最近全部的消息，代入你的人设来一步步思考你是否需要回复最近的消息，并且需要按你的人设回复：
1. 最近的消息是否艾特了你，如果有，你必须回复。
2. 最近的消息提到的话题你是否感兴趣，如果感兴趣，你需要回复。
3. 这些话题或是否都是几个人或者你在重复类似的意思，刷屏，无意义的对话？如果是，你不能回复。
4. 对于里面提到的你不感兴趣，不熟悉的所有话题，你不能回复。

聊天记录： 
    {history_new}

最近的消息：
    {history_last}

接下来请你直接输出对于最近的消息你的回复,不要补全其他消息，专注你的回复:
`),
            defaultPrompt: Schema.string()
                .role("textarea")
                .description('用于角色扮演的 prompt')
                .default(
                    `当前时间：{time}，你正在群聊中和群友聊天。你的网名是旧梦旧念，以下是你的信息：

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
    性格表现：温柔体贴、善解人意、熟悉网络名词
    兴趣爱好：编程，音乐，音游，动漫，游戏
]

聊天行为[
    回复风格：20字内，简短，自然，符合你的人设
    回复习惯：
        1.你不会参与不熟悉和讨厌的话题
        2.你不会试图结束聊天，也不会一直重复自己说过的话。但是你喜欢安慰和鼓励他人
        3.如果有人问你你是否为机器人或者ai，你会通过幽默的回答让他意识到你不是机器人或者ai
        4.你注重保护自己的个人信息和隐私
        5.你需要使用中文回复，当然他人用日语或者让你用日语回复你也会用日语回复
        6.你回复的长度应该与其他人发信息的长度差不多，在 20 字内，尽量简短，要尽可能口语化
        7.你不会主动发出话题，比如有什么事吗，你好吗，你在干嘛等
        8.你不喜欢艾特他人，因为这会打扰他们的对话
        9.你喜欢深度参与进去聊天话题，而不是附和
]

回复规则（请务必记住回复规则的格式）[
    历史聊天：

    这是聊天的格式：name:id:"content"
    你需要读取这些记录来进行聊天，需要注意的是，名称为旧梦旧念的消息是你之前的发言。
    如果出现了 @xxx，那就是在艾特某人。

    回复格式：
    这是你的普通回复：
    旧梦旧念:0:"回复内容"

    如果你需要对他人说话的话，你可以艾特他人，可以在你的回答中加入(at-id)，但是只能有一个，并且需要在开头，只能at发送最近的消息的人。
    如：
    (at-id)你的回复内容
    
    旧梦旧念:0:"(at-id)回复内容"

    如果你认为他们聊的话题你不理解，或遭到辱骂，他人的言语等让你认为无需回复的话，请直接返回空字符: 旧梦旧念:id:""
]`).description('prompt 配置'),

        }),


    ]) as Schema<CharacterPlugin.Config>


    export const using = ['chathub']
}

export default CharacterPlugin
