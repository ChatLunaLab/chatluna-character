/* eslint-disable max-len */
import { Context } from 'koishi'
import { plugins } from './plugin'
import { type Config, migrateConfig } from './config'
import { MessageCollector } from './service/message'
import { TriggerStore } from './service/trigger'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'
import type {} from '@koishijs/plugin-console'

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
                        Object.assign(ctx.scope.config, config)
                        await ctx.loader.writeConfig()
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

        ctx.console.addEntry({
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

### 26.03.09

伪装插件现已支持私聊！更新后开启相关配置即可体验，私聊预设与群聊预设通用，仅需调整少量关于 Bot 所在环境的描述。

注意：旧版本的预设格式（不支持消息自分割的版本）将会无效，请手动参考文档更新到最新版的预设格式。

### 26.03.13

对配置页面进行了重构，增强了可读性。

可以迁移到新版的参数均已保留，但仍建议自行检查是否有遗漏。
`

export { Config } from './config'
export const name = 'chatluna-character'
