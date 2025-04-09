import { Context, Service } from 'koishi'
import { Topic } from './type'

export class TpoicService extends Service {
    private topicMap: Record<string, Topic[]> = {}

    constructor(public readonly ctx: Context) {}
}
