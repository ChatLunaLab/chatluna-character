export interface DayEvent {
    timeStart: Date // "08:00"
    timeEnd: Date // "12:00"
    date: Date
    refreshInterval: number // 1000 * 60 * 60 * 24 // 1 day
    event: string // 吃早餐

    eventDescription: string // 吃早餐
}
