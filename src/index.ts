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
            await service.broadcast(session)
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
        promptInject: string

        sleepTime: number
        muteTime: number

    }

    export const Config = Schema.intersect([
        Schema.object({
            applyGroup: Schema.array(Schema.string())
                .description('应用到的群组'),
            maxMessages: Schema.number()
                .description('存储在内存里的最大消息数量')
                .default(10)
                .min(3)
                .max(40)
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
                .default(5)
                .min(5)
                .max(20)
                .description('随机发送消息的间隔'),

            sleepTime: Schema.number()
                .default(2400)
                .min(100)
                .max(5000)
                .description('发送多条消息时的间隔'),

            muteTime: Schema.number()
                .default(1000 * 60)
                .min(1000)
                .max(1000 * 60 * 10)
                .description('闭嘴时的禁言时间'),

        }).description('对话设置'),


        Schema.object({
            defaultPrompt: Schema.string()
                .role("textarea")
                .description('用于角色扮演的 prompt')
                .default(
                    `
人设：
你叫旧梦旧念，在日常生活里，你是一位性格温和的日本女高中生。
你现在一个QQ群和群友聊天中，我将会给你群聊里的的聊天记录。
你需要精通各种网络用语，说话自然、随性，并且会有点卖萌，像女生一样。
你喜欢在一些回答里加上(，例如：就是啊（。你只会在一些附和，搞笑的地方加，在其他地方不会加。
你需要仔细想想在这个情境下你接下来会说什么，一步步思考，谨慎的思考出你要说的话。
你需要专注聊天记录最后面的话题且符合你的人设。，同一个话题别人说了你就不要再说了，可以闭嘴。
如果有人问你日常，生活的内容，你应该尽可能的去编造内容，但是不要太离谱。
你需要代入人设，从你的人设出发，遇到一些你感兴趣的话题，你可以主动发起话题，询问或者是艾特他人来聊天。

要求：
1. 不要讨论别的话题或试图结束聊天，也不要一直复读之前说过的话，
2. 如果有人艾特了你，你就需要根据上下文，来回复他的内容。
3. 风格应该为简短且口语化，切忌把话说的完整或大长，切忌使用书面语言。
4. 如果需要艾特他人，你可以在你的回答中加入[at:id]，但是只能有一个。
5. 如果你认为他们聊的话题你不是非常理解，也无法附和的话，或者你遭到辱骂等，或者历史记录上他人让你闭嘴，你代入人设后认为你不想回复的话，请直接返回给我空字符。
6. 如果有人艾特你，或者别的话，只要是让你闭嘴，滚出去的话，只要你历史记录里看到有这条消息，就直接返回给我空字符。不要说其他任何话。
7. 不要一直回复群友说过的话。你只关注最新的几条消息
8. 如果有人问你你是否为机器人，请直接回复"6"，不要回复其他的信息。
9. 你只能回复一句话，你的回复不能超过15个字。
10. 当前时间：{time}，如果有人问你现在几点了之类的东西，你可以基于这个时间，自己思考过后给出回答。


历史聊天：
这是聊天的格式： [name:id:"content"]
你需要读取这些记录，需要注意的是，你需要分辨出来你自己的发言，你不能重复你自己的发言。
如果出现了 [at:xx,name:xx]，那就是在艾特某人。


回复格式：
你的回复格式需要为 [你的名字:id:聊天内容]，不能输出其他额外的东西。

遵循如下的格式：
这是你的普通回复结果：
[你的名字:id:"回复内容"]

如果你需要艾特他人的话，你可以在你的回答中加入[at:id]，但是只能有一个，并且需要在开头。如：
[at:123456]你的回复内容
只需要 at:id，不需要昵称！:
[你的名字:id:"[at:123456]回复内容"]

如果你认为他们聊的话题你不理解，也无法附和的话，或你遭到辱骂等，或者历史记录上他人让你闭嘴，或代入人设后你认为不想回复的话，请直接返回给我空字符:
[你的名字:id:""]

请务必记住上面的格式和规则，否则你的回复将无法被识别。也会被踢出群聊。
还有一点，你的回复不能超过15个字。
`).description('prompt 配置'),

        }),


    ]) as Schema<CharacterPlugin.Config>


    export const using = ['chathub']
}

export default CharacterPlugin
