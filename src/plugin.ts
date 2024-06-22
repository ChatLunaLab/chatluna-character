import { Context } from 'koishi'
import fs from 'fs/promises'
import { Config } from '.'
import path from 'path'

export async function plugins(ctx: Context, config: Config) {
    const list = await fs.readdir(path.join(__dirname, 'plugins'))

    for (let file of list) {
        if (file.endsWith('.d.ts')) {
            file = file.slice(0, -5)
        }

        const command: {
            apply: (ctx: Context, config: Config) => PromiseLike<void> | void
        } = await import(`./plugins/${file}.ts`)

        if (command.apply) {
            await command.apply(ctx, config)
        }
    }
}
