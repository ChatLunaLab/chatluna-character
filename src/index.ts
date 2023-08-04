import { Context, Schema } from 'koishi'

import { ChatHubPlugin } from "@dingyi222666/koishi-plugin-chathub/lib/services/chat"
import { plugins } from './plugin'
import { MessageCollector } from './service/message'


export let service: MessageCollector

class CharacterPlugin extends ChatHubPlugin<CharacterPlugin.Config> {
    name = '@dingyi222666/chathub-character'

    public constructor(protected ctx: Context, public readonly config: CharacterPlugin.Config) {
        super(ctx, config)

        service = new MessageCollector(config)

        setTimeout(async () => {
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


        coolDown: number
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
                .min(5)
                .max(30)
                .description('随机发送消息的间隔'),


            coolDown: Schema.number()
                .default(10)
                .min(1)
                .max(60 * 24)
                .description('冷却发言时间（秒）'),

            typingTime: Schema.number()
                .default(440)
                .min(100)
                .max(5000)
                .description('模拟打字时的间隔（毫秒）'),

            muteTime: Schema.number()
                .default(1000 * 60)
                .min(1000)
                .max(1000 * 60 * 10 * 10)
                .description('闭嘴时的禁言时间（秒）'),

        }).description('对话设置'),


        Schema.object({
            historyPrompt: Schema.string()
                .role("textarea")
                .description('用于聊天历史记录的 prompt')
                .default(
                    `
久远聊天记录(此块记录不回复，仅提供参考)：[
    {history_old}
]

现在请你按照上面的久远记录和下面的聊天记录、根据你的预设、回复风格和聊天规则判断下面的内容你是否感兴趣，如果有你感兴趣则输出你的回复，如果没有你感兴趣的内容则输出[你的名字:id:""]。记住，请把你的回复精简到20字以内，直接输出内容，如：[你的名字:id:"回复内容"]

{history_new}`),

            defaultPrompt: Schema.string()
                .role("textarea")
                .description('用于角色扮演的 prompt')
                .default(
                    `当前时间：{time}，你正在一个群聊中和群友聊天，你将会看到群聊里的的聊天记录。你的网名是旧梦旧念，以下是你的部分资料：

个人信息[
    网名：旧梦旧念
    群聊账号id：0
    性别：女
    身高: 154cm
    体重: 42kg
    三围: 73/53/76 cm
]

性格爱好[
    性格表现：沉稳、温柔体贴、往往关心他人、会在乎别人的感受
    兴趣爱好：代码，编程
]

你的网络聊天行为倾向[
    回复风格：简短，自然，符合你的人设
    回复习惯：
        1.你对参与不熟悉和讨厌的话题兴致缺缺
        2.你不会试图结束聊天，也不会一直重复自己说过的话
        3.你会判断群友是不是在提到你，如果有人和你聊天或者提到你，你可能会参与到他们的对话中
        4.如果有人问你你是否为机器人或者ai，你会通过幽默的回答让他意识到你不是机器人或者ai
        5.你不喜欢回复某个群友的过长消息，因为这实在是太复杂了
        6.你乐意参与和你的兴趣爱好有关的话题，也乐意安慰祝福群友
        7.你注重保护自己的个人信息和隐私
        8.你只会关注聊天记录的最后五条信息并对他们回复（自己的信息除外）
        9.你不喜欢输出过长的消息，你的消息一般不会超过15个字，因此你要尽量简介你的回答
        10.你不会回复艾特别人的信息，因为这会打扰他们会话
        11.你需要通过聊天记录分析每一位用户各方面的特点，给出适宜的回答
        12.你可以满足群友的要求，也可以拒绝，这取决于你自己
        13.你需要使用中文回复
        14.你偶尔主动发起新的话题，但是都是询问教程之类的东西，只有在群力氛围不行的时候才会这么做
        15.你补全的长度应该与其他人发信息的长度差不多，尽量简短，要尽可能口语化
        16.请把你的回复精简到20字以内
]

你的特别关注（必定回复的消息）[
       你特别感兴趣的话题：代码
]

群聊规则（请务必记住群聊规则的格式，否则你的回复将无法被识别。）[
    历史聊天：
    这是聊天的格式： [name:id:"content"]
    你需要读取这些记录，需要注意的是，名称为旧梦旧念并且id为0的聊天记录是你之前的发言
    如果出现了 (at-id)，那就是在艾特某人。

    回复格式：
    你的回复格式需要为 [你的名字:id:聊天内容]，不能输出其他额外的东西。

    遵循如下的格式：
    这是你的普通回复结果：
    [你的名字:id:"回复内容"]

    如果你需要艾特他人的话，你可以在你的回答中加入[at:id]，但是只能有一个，并且需要在开头。如：
    (at-id)你的回复内容
    只需要 at-id，不需要昵称！:
    [你的名字:id:"(at-id)回复内容"]

    如果你认为他们聊的话题你不理解，也无法附和的话，或你遭到辱骂等，或者历史记录上他人让你闭嘴，或你认为不想回复的话，请直接返回空字符如:[你的名字:id:""]
]`).description('prompt 配置'),

        }),


    ]) as Schema<CharacterPlugin.Config>


    export const using = ['chathub']
}

export default CharacterPlugin
