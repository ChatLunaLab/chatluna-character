import { Context, h } from 'koishi'
import path from 'path'
import fs, { readFile } from 'fs/promises'
import { Config } from '..'
import { fileURLToPath } from 'url'

export class StickerService {
    private _stickers: Record<string, string[]> = {}

    constructor(
        private _ctx: Context,
        private _config: Config
    ) {}

    async init() {
        const sickerDir = path.resolve(
            this._ctx.baseDir,
            'data/chathub/character/sticker'
        )

        // check if the dir exists

        try {
            await fs.access(sickerDir)
        } catch (error) {
            // copy the resource dir to the target dir
            await fs.mkdir(sickerDir, { recursive: true })
            const dirname =
                __dirname?.length > 0
                    ? __dirname
                    : fileURLToPath(import.meta.url)
            await fs.cp(
                path.resolve(dirname, '../resources/sticker'),
                sickerDir,
                {
                    recursive: true
                }
            )
        }

        // read the dir

        const dirs = await fs.readdir(sickerDir)

        for (const dirName of dirs) {
            const dir = path.resolve(sickerDir, dirName)

            const stats = await fs.stat(dir)

            if (stats.isDirectory()) {
                const stickers = await fs.readdir(dir)
                this._stickers[dirName] = stickers.map((sticker) =>
                    path.resolve(dir, sticker)
                )
            }
        }
    }

    getAllStickTypes() {
        return Object.keys(this._stickers)
    }

    async randomStickByType(type: string) {
        const allStickers = this._stickers[type]

        if (!allStickers) {
            return this.randomStick()
        }

        // random a sticker
        const index = Math.floor(Math.random() * allStickers.length)
        const sticker = allStickers[index]

        if (!sticker) {
            return undefined
        }

        this._ctx.root.chatluna_character.logger.debug(
            `send sticker: ${sticker}`
        )

        return h.image(await readFile(sticker), `image/${getFileType(sticker)}`)
    }

    async randomStick(): Promise<h> {
        const allStickers = Object.values(this._stickers).flat()
        // random a sticker
        const index = Math.floor(Math.random() * allStickers.length)
        const sticker = allStickers[index]

        if (!sticker) {
            return undefined
        }

        this._ctx.root.chatluna_character.logger.debug(
            `send sticker: ${sticker}`
        )

        return h.image(await readFile(sticker), `image/${getFileType(sticker)}`)
    }
}

function getFileType(path: string) {
    const type = path.split('.').pop().toLocaleLowerCase()
    if (type === 'jpg') {
        return 'jpeg'
    }
    return type
}
