import { Context } from 'koishi'
import { Config } from '..'
import { PresetService } from '../services/preset'
import { MemoryService } from '../memory/service'
import { EventLoopService } from '../event-loop/service'
import { TopicService } from '../topic/service'
import { ThinkService } from '../think/service'
import { MessageCollector } from '../message-counter'

export async function apply(ctx: Context, config: Config) {
    ctx.plugin(PresetService, config)
    ctx.plugin(MemoryService, config)
    ctx.plugin(EventLoopService, config)
    ctx.plugin(TopicService, config)
    ctx.plugin(ThinkService, config)
    ctx.plugin(MessageCollector, config)
}
