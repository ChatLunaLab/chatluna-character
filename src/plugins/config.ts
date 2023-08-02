import { Context, Schema, sleep } from 'koishi';
import CharacterPlugin from '..';
import { Factory } from "@dingyi222666/koishi-plugin-chathub/lib/llm-core/chat/factory"

export function apply(ctx: Context, config: CharacterPlugin.Config) {

    Factory.on('model-provider-added', async () => {
        ctx.schema.set('model', Schema.union(await getModelNames()))
    })

}

async function getModelNames() {
    const providers = await Factory.selectModelProviders(async (_) => true)
    const promises = providers.flatMap(async provider => {
        const models = await provider.listModels()
        return models.map(model => Schema.const(provider.name + "/" + model))
    })

    return (await Promise.all(promises)).reduce((a, b) => a.concat(b), [])
}