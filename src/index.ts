/* eslint-disable max-len */
import { Context } from 'koishi'
import { plugins } from './plugin'
import type { Config } from './config'
import { MessageCollector } from './service/message'
import { TriggerStore } from './service/trigger'
import { dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

export function apply(ctx: Context, config: Config) {
    if (config.globalPrivateConfig.preset === 'CHARACTER' && config.defaultPreset) {
        config.globalPrivateConfig.preset = config.defaultPreset
    }

    if (config.globalGroupConfig.preset === 'CHARACTER' && config.defaultPreset) {
        config.globalGroupConfig.preset = config.defaultPreset
    }

    if (config.globalPrivateConfig.model === '' && config.model) {
        config.globalPrivateConfig.model = config.model
    }

    if (config.globalGroupConfig.model === '' && config.model) {
        config.globalGroupConfig.model = config.model
    }

    for (const userId of Object.keys(config.privateConfigs)) {
        if (
            !config.privateConfigs[userId].model ||
            config.privateConfigs[userId].model === '无'
        ) {
            config.privateConfigs[userId].model = config.globalPrivateConfig.model
        }
    }

    for (const groupId of Object.keys(config.configs)) {
        if (
            !config.configs[groupId].model ||
            config.configs[groupId].model === '无'
        ) {
            config.configs[groupId].model = config.globalGroupConfig.model
        }
    }

    if (config.globalPrivateConfig.maxMessages === 40 && config.maxMessages) {
        config.globalPrivateConfig.maxMessages = config.maxMessages
    }

    if (config.globalGroupConfig.maxMessages === 40 && config.maxMessages) {
        config.globalGroupConfig.maxMessages = config.maxMessages
    }

    if (config.globalPrivateConfig.maxTokens === 20000 && config.maxTokens) {
        config.globalPrivateConfig.maxTokens = config.maxTokens
    }

    if (config.globalGroupConfig.maxTokens === 20000 && config.maxTokens) {
        config.globalGroupConfig.maxTokens = config.maxTokens
    }

    if (config.globalPrivateConfig.image === false && config.image) {
        config.globalPrivateConfig.image = config.image
    }

    if (config.globalGroupConfig.image === false && config.image) {
        config.globalGroupConfig.image = config.image
    }

    if (config.globalPrivateConfig.imageInputMaxCount === 9 && config.imageInputMaxCount) {
        config.globalPrivateConfig.imageInputMaxCount = config.imageInputMaxCount
    }

    if (config.globalGroupConfig.imageInputMaxCount === 9 && config.imageInputMaxCount) {
        config.globalGroupConfig.imageInputMaxCount = config.imageInputMaxCount
    }

    if (config.globalPrivateConfig.imageInputMaxSize === 20 && config.imageInputMaxSize) {
        config.globalPrivateConfig.imageInputMaxSize = config.imageInputMaxSize
    }

    if (config.globalGroupConfig.imageInputMaxSize === 20 && config.imageInputMaxSize) {
        config.globalGroupConfig.imageInputMaxSize = config.imageInputMaxSize
    }

    if (
        config.globalPrivateConfig.multimodalFileInputMaxSize === 20 &&
        config.multimodalFileInputMaxSize
    ) {
        config.globalPrivateConfig.multimodalFileInputMaxSize =
            config.multimodalFileInputMaxSize
    }

    if (
        config.globalGroupConfig.multimodalFileInputMaxSize === 20 &&
        config.multimodalFileInputMaxSize
    ) {
        config.globalGroupConfig.multimodalFileInputMaxSize =
            config.multimodalFileInputMaxSize
    }

    if (config.globalPrivateConfig.toolCalling === true && config.toolCalling === false) {
        config.globalPrivateConfig.toolCalling = config.toolCalling
    }

    if (config.globalGroupConfig.toolCalling === true && config.toolCalling === false) {
        config.globalGroupConfig.toolCalling = config.toolCalling
    }

    if (config.globalPrivateConfig.isForceMute === true && config.isForceMute === false) {
        config.globalPrivateConfig.isForceMute = config.isForceMute
    }

    if (config.globalGroupConfig.isForceMute === true && config.isForceMute === false) {
        config.globalGroupConfig.isForceMute = config.isForceMute
    }

    if (config.globalPrivateConfig.coolDownTime === 0 && config.coolDownTime) {
        config.globalPrivateConfig.coolDownTime = config.coolDownTime
    }

    if (config.globalGroupConfig.coolDownTime === 0 && config.coolDownTime) {
        config.globalGroupConfig.coolDownTime = config.coolDownTime
    }

    if (config.globalPrivateConfig.muteTime === 1000 * 60 && config.muteTime) {
        config.globalPrivateConfig.muteTime = config.muteTime
    }

    if (config.globalGroupConfig.muteTime === 1000 * 60 && config.muteTime) {
        config.globalGroupConfig.muteTime = config.muteTime
    }

    if (
        config.globalGroupConfig.messageActivityScoreLowerLimit === 0.85 &&
        config.messageActivityScoreLowerLimit
    ) {
        config.globalGroupConfig.messageActivityScoreLowerLimit =
            config.messageActivityScoreLowerLimit
    }

    if (
        config.globalGroupConfig.messageActivityScoreUpperLimit === 0.85 &&
        config.messageActivityScoreUpperLimit
    ) {
        config.globalGroupConfig.messageActivityScoreUpperLimit =
            config.messageActivityScoreUpperLimit
    }

    if (config.privateModelOverride?.length > 0) {
        for (const override of config.privateModelOverride) {
            config.privateConfigs[override.userId] = Object.assign(
                {},
                config.privateConfigs[override.userId],
                {
                    model: override.model
                }
            )
        }
    }

    if (config.modelOverride?.length > 0) {
        for (const override of config.modelOverride) {
            config.configs[override.groupId] = Object.assign(
                {},
                config.configs[override.groupId],
                {
                    model: override.model
                }
            )
        }
    }

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

    ctx.inject(['console'], (ctx) => {
        const baseDir =
            typeof __dirname !== 'undefined'
                ? __dirname
                : dirname(fileURLToPath(import.meta.url))

        ;(ctx as any).console.addEntry({
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
    optional: ['chatluna_character', 'chatluna_character_trigger', 'vits', 'console']
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
