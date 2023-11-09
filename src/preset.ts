import { Context, Schema } from 'koishi'

import {
    ChatLunaError,
    ChatLunaErrorCode
} from 'koishi-plugin-chatluna/lib/utils/error'
import { logger } from '.'
import fs from 'fs/promises'
import { load } from 'js-yaml'
import { PromptTemplate } from 'langchain/prompts'
import path from 'path'
import { PresetTemplate } from './types'

export class Preset {
    private readonly _presets: PresetTemplate[] = []

    constructor(private readonly ctx: Context) {}

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

        return null
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

        const defaultPresetDir = path.join(__dirname, '../resources/presets')

        const files = await fs.readdir(defaultPresetDir)

        for (const file of files) {
            const filePath = path.join(defaultPresetDir, file)
            const fileStat = await fs.stat(filePath)
            if (fileStat.isFile()) {
                await fs.mkdir(currentPresetDir, { recursive: true })
                logger.debug(
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
        mute_keyword: rawPreset.mute_keyword ?? []
    }
}
