import { PromptTemplate } from '@langchain/core/prompts'
import fs from 'fs/promises'
import { load } from 'js-yaml'
import { Context, Schema } from 'koishi'

import {
    ChatLunaError,
    ChatLunaErrorCode
} from 'koishi-plugin-chatluna/utils/error'
import path from 'path'
import { PresetTemplate } from './types'
import { fileURLToPath } from 'url'
import { watch } from 'fs'

export class Preset {
    private readonly _presets: PresetTemplate[] = []

    private _aborter: AbortController | null = null

    constructor(private readonly ctx: Context) {
        ctx.on('dispose', () => {
            this._aborter?.abort()
        })
    }

    async loadAllPreset() {
        await this._checkPresetDir()

        const presetDir = this.resolvePresetDir()
        const files = await fs.readdir(presetDir)

        this._presets.length = 0

        for (const file of files) {
            // use file
            const extension = path.extname(file)
            if (extension !== '.yml') {
                continue
            }
            const rawText = await fs.readFile(
                path.join(presetDir, file),
                'utf-8'
            )
            const preset = loadPreset(rawText)
            preset.path = path.join(presetDir, file)
            this._presets.push(preset)
        }

        this.ctx.schema.set(
            'character-preset',
            Schema.union(
                this._presets
                    .map((preset) => preset.name)
                    .concat('无')
                    .map((name) => Schema.const(name))
            )
        )

        this.ctx.emit('chatluna_character/preset_updated')
    }

    async getPreset(
        triggerKeyword: string,
        loadForDisk: boolean = true,
        throwError: boolean = true
    ): Promise<PresetTemplate> {
        if (loadForDisk) {
            // always load for disk
            await this.loadAllPreset()
        }

        return this.getPresetForCache(triggerKeyword, throwError)
    }

    watchPreset() {
        let fsWait: NodeJS.Timeout | boolean = false

        if (this._aborter != null) {
            this._aborter.abort()
        }

        this._aborter = new AbortController()

        watch(
            this.resolvePresetDir(),
            {
                signal: this._aborter.signal
            },
            async (event, filename) => {
                if (filename) {
                    if (fsWait) return
                    fsWait = setTimeout(() => {
                        fsWait = false
                    }, 100)

                    await this.loadAllPreset()
                    this.ctx.chatluna_character.logger.debug(
                        `trigger full reload preset by ${filename}`
                    )

                    return
                }

                await this.loadAllPreset()
                this.ctx.chatluna_character.logger.debug(
                    `trigger full reload preset`
                )
            }
        )
    }

    async init() {
        await this.loadAllPreset()
        this.watchPreset()
    }

    getPresetForCache(
        triggerKeyword: string,
        throwError: boolean = true
    ): PresetTemplate {
        const preset = this._presets.find(
            (preset) => preset.name === triggerKeyword
        )

        if (preset) {
            return preset
        }

        if (throwError) {
            throw new ChatLunaError(
                ChatLunaErrorCode.PREST_NOT_FOUND,
                new Error(`No preset found for keyword ${triggerKeyword}`)
            )
        }

        return undefined
    }

    async getDefaultPreset(): Promise<PresetTemplate> {
        if (this._presets.length === 0) {
            await this.loadAllPreset()
        }

        const preset = this._presets.find((preset) => preset.name === '默认')

        if (preset) {
            // await this.cache.set('default-preset', 'chatgpt')
            return preset
        } else {
            await this._copyDefaultPresets()
            return this.getDefaultPreset()
        }

        // throw new Error("No default preset found")
    }

    async getAllPreset(): Promise<string[]> {
        await this.loadAllPreset()

        return this._presets.map((preset) => preset.name)
    }

    async resetDefaultPreset(): Promise<void> {
        await this._copyDefaultPresets()
    }

    public resolvePresetDir() {
        return path.resolve(this.ctx.baseDir, 'data/chathub/character/presets')
    }

    private async _checkPresetDir() {
        const presetDir = path.join(this.resolvePresetDir())

        // check if preset dir exists
        try {
            await fs.access(presetDir)
        } catch (err) {
            if (err.code === 'ENOENT') {
                await fs.mkdir(presetDir, { recursive: true })
                await this._copyDefaultPresets()
            } else {
                throw err
            }
        }
    }

    private async _copyDefaultPresets() {
        const currentPresetDir = path.join(this.resolvePresetDir())

        const dirname =
            __dirname?.length > 0 ? __dirname : fileURLToPath(import.meta.url)

        const defaultPresetDir = path.join(dirname, '../resources/presets')

        const files = await fs.readdir(defaultPresetDir)

        for (const file of files) {
            const filePath = path.join(defaultPresetDir, file)
            const fileStat = await fs.stat(filePath)
            if (fileStat.isFile()) {
                await fs.mkdir(currentPresetDir, { recursive: true })
                this.ctx.chatluna_character.logger.debug(
                    `copy preset file ${filePath} to ${currentPresetDir}`
                )
                await fs.copyFile(filePath, path.join(currentPresetDir, file))
            }
        }
    }
}

export function loadPreset(text: string): PresetTemplate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rawPreset = load(text) as any

    return {
        name: rawPreset.name,
        nick_name: rawPreset.nick_name,
        input: PromptTemplate.fromTemplate(rawPreset.input),
        system: PromptTemplate.fromTemplate(rawPreset.system),
        mute_keyword: rawPreset.mute_keyword ?? [],
        status: rawPreset?.status
    }
}

declare module 'koishi' {
    interface Events {
        'chatluna_character/preset_updated': () => void
    }
}
