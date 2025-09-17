import { Context } from 'koishi'
import { Config } from '..'
import { modelSchema } from 'koishi-plugin-chatluna/utils/schema'

export async function apply(ctx: Context, config: Config) {
    modelSchema(ctx)
}
