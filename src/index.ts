import { Context, Schema } from 'koishi'

import { ChatHubPlugin } from "@dingyi222666/koishi-plugin-chathub/lib/services/chat"
import { plugins } from './plugin'

class CharacterPlugin extends ChatHubPlugin<CharacterPlugin.Config> {
    name = '@dingyi222666/chathub-character'

    public constructor(protected ctx: Context, public readonly config: CharacterPlugin.Config) {
        super(ctx, config)

        setTimeout(async () => {
            await plugins(ctx, config)
        }, 0)
    }

}

namespace CharacterPlugin {
    export interface Config extends ChatHubPlugin.Config {
        model: string,
        applyGroup: string[]
    }

    export const Config = Schema.intersect([
        Schema.object({
            model: Schema.dynamic('model')
                .description('使用的模型'),
            applyGroup: Schema.array(Schema.string())
                .description('应用到的群组')
        }).description('基础配置'),
    ]) as Schema<CharacterPlugin.Config>


    export const using = ['chathub']
}

export default CharacterPlugin
