import { Context } from 'koishi'
import { Config } from '..'
import { PresetService } from '../services/preset'

export async function apply(ctx: Context, config: Config) {
    ctx.plugin(PresetService)
}
