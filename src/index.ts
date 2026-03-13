/* eslint-disable max-len */
import { Context } from 'koishi'
import { plugins } from './plugin'
import { type Config, migrateConfig } from './config'
import { MessageCollector } from './service/message'
import { TriggerStore } from './service/trigger'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

type ConsoleCtx = Context & {
    console: {
        addEntry: (entry: { dev: string; prod: string }) => void
    }
}

type WriteCtx = Context & {
    loader: {
        writeConfig: () => Promise<void>
    }
    scope: {
        config: Record<string, unknown>
    }
}

export function apply(ctx: Context, config: Config) {
    const changed = migrateConfig(config)
    let started = false

    ctx.plugin(TriggerStore, config)
    ctx.plugin(MessageCollector, config)
    ctx.plugin(
        {
            apply: (ctx: Context, config: Config) => {
                ctx.on('ready', async () => {
                    if (started) {
                        return
                    }
                    started = true
                    if (changed) {
                        const x = ctx as WriteCtx
                        Object.assign(x.scope.config, config)
                        await x.loader.writeConfig()
                    }
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

    ctx.inject(['console'], (ctx) => {
        const baseDir =
            typeof __dirname !== 'undefined'
                ? __dirname
                : dirname(fileURLToPath(import.meta.url))

        ;(ctx as ConsoleCtx).console.addEntry({
            dev: resolve(baseDir, '../dist'),
            prod: resolve(baseDir, '../dist')
        })
    })

    ctx.middleware((session, next) => {
        if (!ctx.chatluna_character) {
            return next()
        }

        // 不接收自己的消息
        if (ctx.bots[session.uid]) {
            return next()
        }

        const id = session.isDirect ? session.userId : session.guildId

        if (
            session.isDirect &&
            config.privateWhitelistMode &&
            !config.applyPrivate.includes(id)
        ) {
            return next()
        }

        if (
            !session.isDirect &&
            config.groupWhitelistMode &&
            !config.applyGroup.includes(id)
        ) {
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
    optional: [
        'chatluna_character',
        'chatluna_character_trigger',
        'vits',
        'console'
    ]
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
    console: {
        required: false
    },
    database: {
        required: true
    }
}

export const usage = `
## chatluna-character

请先阅读[**此文档**](https://chatluna.chat/ecosystem/other/character.html)了解使用方式。

### 26.02.21

近期新增了一些让Bot可以在不被@的情况下主动维持对话状态的功能（如被动的空闲触发），部分需要搭配良好的预设提示词使用（主动的xml工具），文档中将提供最新的模板预设帮助你修改旧的预设。

建议老用户将大部分配置恢复为更新后的默认值（是否允许输入图片、工具调用等与模型能力有关的请自行根据实际情况调整）

### 26.03.09

伪装插件现已支持私聊！更新后开启相关配置即可体验，私聊预设与群聊预设通用，仅需调整少量关于 Bot 所在环境的描述。

建议为私聊添加单独的分私聊配置，分私聊配置中的各项默认值已经针对私聊场景做了调整（是否允许输入图片、工具调用等与模型能力有关的请自行根据实际情况调整）。

注意：旧版本的预设格式（不支持消息自分割的版本）将会无效，请手动参考文档更新到最新版的预设格式。
`

export { Config } from './config'
export const name = 'chatluna-character'
