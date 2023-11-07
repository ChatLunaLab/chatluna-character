import { Context, Schema } from 'koishi'
import { Config } from '..'
import { PlatformService } from 'koishi-plugin-chatluna/lib/llm-core/platform/service'
import { ModelType } from 'koishi-plugin-chatluna/lib/llm-core/platform/types'

export function apply(ctx: Context, config: Config) {
    ctx.on('chathub/model-added', async (service) => {
        ctx.schema.set('model', Schema.union(await getModelNames(service)))
    })

    ctx.on('chathub/model-removed', async (service) => {
        ctx.schema.set('model', Schema.union(await getModelNames(service)))
    })
}

async function getModelNames(service: PlatformService) {
    return service.getAllModels(ModelType.llm).map((m) => Schema.const(m))
}
