import { Context, Service } from 'koishi'
import { DayEvent } from './type'

export class EventLoopService extends Service {
    private _events: DayEvent[] = []

    private _currentEvent: DayEvent | undefined = null

    constructor(public readonly ctx: Context) {
        super(ctx, 'chatluna_event_loop_service')
    }
}
