import { Context, Schema } from 'koishi'

import { ChatHubPlugin } from "@dingyi222666/koishi-plugin-chathub/lib/services/chat"

class CharacterPlugin extends ChatHubPlugin<CharacterPlugin.Config> {
    name = '@dingyi222666/chathub-character'

    public constructor(protected ctx: Context, public readonly config: CharacterPlugin.Config) {
        super(ctx, config)

       
    }

}

namespace CharacterPlugin {
    export interface Config extends ChatHubPlugin.Config {
        
    }

    export const Config = Schema.intersect([
        Schema.object({
          
        }).description('请求配置'),
    ]) as Schema<CharacterPlugin.Config>


    export const using = ['chathub']
}

export default CharacterPlugin
