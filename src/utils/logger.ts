import { Logger } from 'koishi'

export let logger: Logger

export function setLogger(setLogger: Logger) {
    logger = setLogger
}
