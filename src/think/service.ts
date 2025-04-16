import { Context, Service, Session } from 'koishi'
import { Topic } from './type'
import { Message } from '../message-counter/types'
import { Config } from '..'

export class ThinkService extends Service {
    private globalThink: string = ''
    private groupThink: Record<string, string> = {}

    constructor(
        public readonly ctx: Context,
        public config: Config
    ) {
        super(ctx, 'chatluna_character_think', true)
    }

    static inject = ['chatluna_character_message']
}

declare module 'koishi' {
    interface Context {
        chatluna_character_think: ThinkService
    }
}
