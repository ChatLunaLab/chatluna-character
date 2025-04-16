import { Context, Service, Session } from 'koishi'
import { Topic } from './type'
import { Message } from '../message-counter/types'
import { Config } from '..'

export class TpoicService extends Service {
    private topicMap: Record<string, Topic[]> = {}

    constructor(
        public readonly ctx: Context,
        public config: Config
    ) {
        super(ctx, 'chatluna_character_topic', true)

        // TODO: register message
    }

    async analysisTopic(session: Session, messages: Message[]) {
        // 分析新的话题
    }

    static inject = ['chatluna_character_message']
}

declare module 'koishi' {
    interface Context {
        chatluna_character_topic: TpoicService
    }
}
