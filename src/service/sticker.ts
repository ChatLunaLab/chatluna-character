import { Context, h } from 'koishi'
import path from 'path'
import fs, { readFile } from 'fs/promises'
import { Config } from '..'

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
            await fs.cp(
                path.resolve(__dirname, '../../resources/sticker'),
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
