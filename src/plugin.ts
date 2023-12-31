import { Context } from 'koishi'
import fs from 'fs/promises'
import { Config } from '.'
import path from 'path'

export async function plugins(ctx: Context, config: Config) {
    const list = await fs.readdir(path.join(__dirname, 'plugins'))

    for (const file of list) {
        if (file.endsWith('.d.ts')) {
            continue
        }

        const command: {
            apply: (ctx: Context, config: Config) => PromiseLike<void> | void
        } = await require(`./plugins/${file}`)

        if (command.apply) {
            await command.apply(ctx, config)
        }
    }
}
