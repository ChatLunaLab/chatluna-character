import { Context, h } from 'koishi';
import path from 'path';
import fs from "fs/promises"
import CharacterPlugin from '..';

export class StickerService {

    private _stickers: string[]

    constructor(private _ctx: Context, private _config: CharacterPlugin.Config) { }

    async init() {
        const sickerDir = path.resolve(this._ctx.baseDir, "data/chathub/character/sticker")


        // check if the dir exists

        try {
            await fs.access(sickerDir)
        } catch (error) {
            // copy the resource dir to the target dir
            await fs.mkdir(sickerDir, { recursive: true })
            await fs.cp(path.resolve(__dirname, "../../resources/sticker"), sickerDir, { recursive: true })
        }

        // read the dir

        const files = await fs.readdir(sickerDir)

        this._stickers = files.map(file => path.resolve(sickerDir, file))

    }

    randomStick(): h | null {
        const random = Math.random()

        if (random >= this._config.sendStickerProbability) {
            return null
        }

        // random a sticker
        const index = Math.floor(Math.random() * this._stickers.length)
        const sticker = this._stickers[index]

        if (!sticker) {
            return null
        }


        return h.image("file://" + sticker.startsWith("/") ? sticker : "/" + sticker)
    }
}