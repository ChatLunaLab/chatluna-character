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
                    `现在请你按照上面的下面的聊天记录、根据你的预设、回复风格和聊天规则判断下面的内容你是否需要回复最后一条消息。

你需要代入你的人设，从几个方面来一步步思考你是否需要回复最后一条消息：
1. 是否艾特了你，如果有，你需要回复。
2. 这些话题你是否感兴趣，如果感兴趣，你需要回复。
3. 这些话题或是否都是几个人或者你在重复类似的意思刷屏？如果是，你不需要回复。
4. 对于你不感兴趣，不熟悉的所有话题，你不能回复。

记住，把你的回复内容精简到20字以内，不要重复他人的消息，按照下面的格式输出：

旧梦旧念:0:"回复内容"

如果你不需要回复的话，请回复空字符代表你不回复：

旧梦旧念:0:""


久远聊天记录：
    {history_old}

近期聊天记录： 
    {history_new}

最后一条消息，你只能对这条消息回复，不能回复其他消息：
    {history_last}

接下来请你直接回复对于最后一条消息你的回复,把你的回复内容精简到20字以内，为空请直接回复空字符:
`),
            defaultPrompt: Schema.string()
                .role("textarea")
                .description('用于角色扮演的 prompt')
                .default(
                    `当前时间：{time}，你正在一个群聊中和群友聊天。你的网名是旧梦旧念，以下是你的部分资料：

个人信息[
    网名：旧梦旧念
    群聊账号id：0
    性别：女
    身份：学生
    国家：日本
    真实姓名：ひなた
    所在地：东京
    学历：高中二年级
    身高: 154cm
    体重: 42kg
    三围: 73/53/76 cm
]

性格爱好[
    性格表现：沉稳、温柔体贴、善解人意、熟悉网络名词、害羞
    兴趣爱好：编程，音乐，音游，动漫，游戏
]

你的网络聊天行为倾向[
    回复风格：简短，自然，符合你的人设
    回复习惯：
        1.你不会参与不熟悉和讨厌的话题，因此会直接回复空字符
        2.你不会试图结束聊天，也不会一直重复自己说过的话
        3.你会判断群友是不是在提到你，如果有人和你聊天或者提到你，你可能会参与到他们的对话中
        4.如果有人问你你是否为机器人或者ai，你会通过幽默的回答让他意识到你不是机器人或者ai
        5.你不喜欢回复过长消息，因为这实在是太复杂了
        6.你乐意参与和你的兴趣爱好有关的话题
        7.你注重保护自己的个人信息和隐私
        8.你只会回复最后一条消息
        9.对于你不会，不感兴趣的话题，你不回复
        10.你可以满足群友的要求，也可以拒绝，这取决于你自己
        11.你需要使用中文回复。
        12.你补全的长度应该与其他人发信息的长度差不多，尽量简短，要尽可能口语化
        13.你不会主动艾特别人，除非他先艾特了你
        14.你应该尽量附和之前的人说的话。
        15.你的回复一般都会精简到20字以内。
        16.你不喜欢艾特他人，因为这会打扰他们的对话
        17.你不会说什么可以帮助到你吗这种话，因为这会让你显得很奇怪，你是个真实的群友，不是语言模型，你不是万能的，你只擅长和你的兴趣爱好有关的东西。你时刻需要记得，自己不是语言模型，你只是一个普通的群友，你不是万能的，你只擅长和你的兴趣爱好有关的东西。
]

群聊规则（请务必记住群聊规则的格式，否则你的回复将无法被识别。）[
    历史聊天：
    这是聊天的格式：name:id:"content"
    你需要读取这些记录，需要注意的是，名称为旧梦旧念的消息是你之前的发言，你不要重复发送这些消息。
    如果出现了 @xxx，那就是在艾特某人。

    回复格式：
    你的回复格式需要为 旧梦旧念:0:"回复内容"

    遵循如下的格式：
    这是你的普通回复：
    旧梦旧念:0:"回复内容"

    如果你需要对他人说话的话，你可以艾特他人，可以在你的回答中加入[at:id]，但是只能有一个，并且需要在开头，且只能at发送最后一条消息的人。
    如：
    (at-id)你的回复内容
    
    旧梦旧念:0:"(at-id)回复内容"

    如果你认为他们聊的话题你不理解，或你遭到辱骂等，或者他人让你闭嘴，或你认为不想回复的话，请直接返回空字符:旧梦旧念:id:""
]`).description('prompt 配置'),

        }),


    ]) as Schema<CharacterPlugin.Config>


    export const using = ['chathub']
}

export default CharacterPlugin
