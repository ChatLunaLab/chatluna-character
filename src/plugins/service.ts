import { Context } from 'koishi'
import { Config } from '..'
import { PresetService } from '../services/preset'
import { MemoryService } from '../memory/service'
import { EventLoopService } from '../event-loop/service'

export async function apply(ctx: Context, config: Config) {
    ctx.plugin(PresetService)
    ctx.plugin(MemoryService)
    ctx.plugin(EventLoopService)
}
