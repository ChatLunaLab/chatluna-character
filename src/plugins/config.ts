import { Context, Schema } from 'koishi'
import { Config } from '..'
import { PlatformService } from '@dingyi222666/koishi-plugin-chathub/lib/llm-core/platform/service'
import { ModelType } from '@dingyi222666/koishi-plugin-chathub/lib/llm-core/platform/types'

export function apply(ctx: Context, config: Config) {
    ctx.on('chathub/model-added', async (service, platform, client) => {
        ctx.schema.set('model', Schema.union(await getModelNames(service)))
    })
}

async function getModelNames(service: PlatformService) {
    return service.getAllModels(ModelType.llm).map((m) => Schema.const(m))
}
