import { Context, h } from 'koishi'
import path from 'path'
import fs, { readFile } from 'fs/promises'
import { Config } from '..'
import { fileURLToPath } from 'url'

export class StickerService {
    private _stickers: string[]

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

        const files = await fs.readdir(sickerDir)

        this._stickers = files.map((file) => path.resolve(sickerDir, file))
    }

    async randomStick(): Promise<h> {
        const random = Math.random()

        if (random >= this._config.sendStickerProbability) {
            return undefined
        }

        // random a sticker
        const index = Math.floor(Math.random() * this._stickers.length)
        const sticker = this._stickers[index]

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
