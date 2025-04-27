import { Context, Session } from 'koishi'
import { Config } from '..'

export function apply(ctx: Context, config: Config) {
    ctx.command('chatluna.character', '角色扮演相关命令')

    ctx.command('chatluna.character.clear [group]', '清除群组的聊天记录', {
        authority: 3
    }).action(async ({ session }, group) => {
        await sendMessageToPrivate(session, `已清除群组 ${group} 的聊天记录`)
    })

    // Add event loop commands
    ctx.command('character.event', '角色事件循环').action(
        async ({ session }) => {
            return (
                '角色事件循环系统，用于管理角色的日常事件循环。\n' +
                '- character.event.activate <预设关键词>: 激活指定预设的事件循环\n' +
                '- character.event.deactivate <预设关键词>: 停用指定预设的事件循环\n' +
                '- character.event.list: 列出所有已激活的预设事件循环\n' +
                '- character.event.current <预设关键词>: 显示指定预设的当前事件\n' +
                '- character.event.all <预设关键词>: 显示指定预设的所有事件'
            )
        }
    )

    ctx.command(
        'character.event.activate <presetKey:string>',
        '激活预设的事件循环'
    ).action(async ({ session }, presetKey) => {
        if (!presetKey) {
            return '请指定要激活的预设关键词'
        }

        try {
            await ctx.chatluna_character_event_loop.activatePreset(presetKey)
            return `已成功激活预设 "${presetKey}" 的事件循环`
        } catch (e) {
            return `激活失败: ${e.message}`
        }
    })

    ctx.command(
        'character.event.deactivate <presetKey:string>',
        '停用预设的事件循环'
    ).action(async ({ session }, presetKey) => {
        if (!presetKey) {
            return '请指定要停用的预设关键词'
        }

        try {
            await ctx.chatluna_character_event_loop.deactivatePreset(presetKey)
            return `已成功停用预设 "${presetKey}" 的事件循环`
        } catch (e) {
            return `停用失败: ${e.message}`
        }
    })

    ctx.command('character.event.list', '列出所有已激活的预设事件循环').action(
        async ({ session }) => {
            const activePresets =
                ctx.chatluna_character_event_loop.getActivePresets()

            if (activePresets.length === 0) {
                return '当前没有已激活的预设事件循环'
            }

            return (
                '已激活的预设事件循环:\n' +
                activePresets.map((key) => `- ${key}`).join('\n')
            )
        }
    )

    ctx.command(
        'character.event.current <presetKey:string>',
        '显示预设的当前事件'
    ).action(async ({ session }, presetKey) => {
        if (!presetKey) {
            return '请指定预设关键词'
        }

        try {
            if (!ctx.chatluna_character_event_loop.isPresetActive(presetKey)) {
                return `预设 "${presetKey}" 的事件循环未激活`
            }

            const currentEvent =
                await ctx.chatluna_character_event_loop.getCurrentEvent(
                    presetKey
                )
            if (!currentEvent) {
                return `预设 "${presetKey}" 当前没有事件`
            }

            const description =
                await ctx.chatluna_character_event_loop.getCurrentEventDescription(
                    presetKey
                )

            const startTime = currentEvent.timeStart.toLocaleTimeString(
                'zh-CN',
                {
                    hour: '2-digit',
                    minute: '2-digit'
                }
            )

            const endTime = currentEvent.timeEnd.toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit'
            })

            let response =
                `预设 "${presetKey}" 的当前事件:\n` +
                `- 事件: ${currentEvent.event}\n` +
                `- 时间: ${startTime} - ${endTime}\n` +
                `- 描述: ${currentEvent.eventDescription}`

            if (description) {
                response += `\n\n当前活动: ${description}`
            }

            return response
        } catch (e) {
            return `获取当前事件失败: ${e.message}`
        }
    })

    ctx.command(
        'character.event.all <presetKey:string>',
        '显示预设的所有事件'
    ).action(async ({ session }, presetKey) => {
        if (!presetKey) {
            return '请指定预设关键词'
        }

        try {
            if (!ctx.chatluna_character_event_loop.isPresetActive(presetKey)) {
                return `预设 "${presetKey}" 的事件循环未激活`
            }

            const events =
                await ctx.chatluna_character_event_loop.getEvents(presetKey)
            if (!events || events.length === 0) {
                return `预设 "${presetKey}" 没有事件`
            }

            const eventsList = events
                .map((event) => {
                    const startTime = event.timeStart.toLocaleTimeString(
                        'zh-CN',
                        {
                            hour: '2-digit',
                            minute: '2-digit'
                        }
                    )

                    const endTime = event.timeEnd.toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit'
                    })

                    return `- ${startTime} - ${endTime}: ${event.event}`
                })
                .join('\n')

            return `预设 "${presetKey}" 的所有事件:\n${eventsList}`
        } catch (e) {
            return `获取所有事件失败: ${e.message}`
        }
    })
}

async function sendMessageToPrivate(session: Session, message: string) {
    await session.bot.sendPrivateMessage(session.userId, message)
}
