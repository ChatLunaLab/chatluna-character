import { Context, Universal } from 'koishi'
import { formatAgentTaskWakeup } from 'koishi-plugin-chatluna/llm-core/agent'
import { buildVirtualSession } from 'koishi-plugin-chatluna/utils/virtual_session'

import { Message } from '../types'

export function apply(ctx: Context) {
    ctx.on('chatluna/agent-task-finished', async (payload) => {
        if (!ctx.chatluna.config.agentTaskAutoWakeup) return
        if (payload.run.background !== true) return
        if (payload.run.state === 'aborted') return
        if (payload.source !== 'character') return
        if (payload.parentConversationId.startsWith('subagent:')) return

        const live = payload.snapshot?.session
        const routing = payload.snapshot?.routing
        const bot = routing
            ? ctx.bots[`${routing.platform}:${routing.selfId}`]
            : undefined
        const session =
            live?.bot?.status === Universal.Status.ONLINE
                ? live
                : routing && bot?.status === Universal.Status.ONLINE
                  ? await buildVirtualSession(
                        bot,
                        { ...routing, username: 'task' },
                        { message: '', messageName: 'task' }
                    )
                  : undefined

        if (session == null) {
            ctx.chatluna_character.logger.warn(
                'agent task %s finished but bot %s:%s is offline; result kept until TTL.',
                payload.taskId,
                payload.snapshot?.routing?.platform,
                payload.snapshot?.routing?.selfId
            )
            return
        }

        ctx.chatluna_character_trigger.setLastSession(session)

        const msg: Message = {
            content: formatAgentTaskWakeup(
                payload.taskId,
                payload.agentName,
                payload.run
            ),
            name: 'task',
            id: 'task',
            messageId: payload.run.runId,
            timestamp: Date.now()
        }

        await ctx.chatluna_character.triggerMessage(
            session,
            msg,
            `Triggered by sub-agent task result: ${payload.agentName}`
        )
    })
}
