/* eslint-disable max-len */
import { Context } from 'koishi'
import { plugins } from './plugin'
import type { Config } from './config'
import { MessageCollector } from './service/message'
import { TriggerStore } from './service/trigger'

export function apply(ctx: Context, config: Config) {
    ctx.plugin(TriggerStore, config)
    ctx.plugin(MessageCollector, config)

    ctx.plugin(
        {
            apply: (ctx: Context, config: Config) => {
                ctx.on('ready', async () => {
                    await ctx.chatluna_character.preset.init()
                    await plugins(ctx, config)
                })
            },
            inject: Object.assign({}, inject2, {
                chatluna_character: {
                    required: true
                },
                chatluna_character_trigger: {
                    required: true
                }
            }),
            name: 'chatluna_character_entry_point'
        },
        config
    )

    ctx.middleware((session, next) => {
        if (!ctx.chatluna_character) {
            return next()
        }

        // 不接收自己的消息
        if (ctx.bots[session.uid]) {
            return next()
        }

        const id = session.isDirect ? session.userId : session.guildId

        if (session.isDirect && !config.applyPrivate.includes(id)) {
            return next()
        }

        if (!session.isDirect && !config.applyGroup.includes(id)) {
            return next()
        }

        return next(async (loop) => {
            if (!(await ctx.chatluna_character.broadcast(session))) {
                return loop()
            }
        })
    })
}

export const inject = {
    required: ['chatluna', 'database'],
    optional: ['chatluna_character', 'chatluna_character_trigger', 'vits']
}

export const inject2 = {
    chatluna: {
        required: true
    },
    chatluna_character: {
        required: false
    },
    chatluna_character_trigger: {
        required: false
    },
    vits: {
        required: false
    },
    database: {
        required: true
    }
}

export const usage = `
## chatluna-character

请先阅读[**此文档**](https://chatluna.chat/ecosystem/other/character.html)了解使用方式。

### 26.2.21

近期新增了一些让Bot可以在不被@的情况下主动维持对话状态的功能（如被动的空闲触发），部分需要搭配良好的预设提示词使用（主动的xml工具），文档中将提供最新的模板预设帮助你修改旧的预设。

建议老用户将大部分配置恢复为更新后的默认值（是否允许输入图片、工具调用等与模型能力有关的请自行根据实际情况调整）

### 26.3.9

伪装现已支持私聊！更新后开启相关配置即可体验。
`

export { Config } from './config'
export const name = 'chatluna-character'
