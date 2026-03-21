// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import {} from '@initencounter/vits'
import { Context, Element, h, Session } from 'koishi'

import { Config } from '..'
import { logger } from './logger'

export interface ResponseElementMatch {
    type: string
    content: string
    extra?: Element['attrs']
}

export interface ResponseElementRender {
    parse: (el: Element) => ResponseElementMatch
    render: (match: ResponseElementMatch) => Element[]
    process?: (el: Element) => Promise<Element[]> | Element[]
}

export type ResponseElementRenders = Record<string, ResponseElementRender>

export function getElementText(elements: Element[]) {
    return elements
        .map((el) => {
            if (el.type === 'text') {
                return String(el.attrs.content ?? '')
            }

            if (el.children.length > 0) {
                return getElementText(el.children)
            }

            return ''
        })
        .join('')
}

function createMatch(el: Element): ResponseElementMatch {
    return {
        type: el.type,
        content: getElementText(el.children),
        extra: Object.keys(el.attrs).length > 0 ? el.attrs : undefined
    }
}

export async function voiceRender(
    ctx: Context,
    session: Session,
    input: string,
    id?: string,
    fallback?: Element[]
) {
    try {
        if (id) {
            return [
                await ctx.vits.say(
                    Object.assign(
                        {
                            speaker_id: Number.parseInt(String(id), 10),
                            input
                        },
                        { session }
                    )
                )
            ]
        }

        return [await ctx.vits.say(Object.assign({ input }, { session }))]
    } catch (e) {
        logger.error('voice render failed', e)
        return fallback ?? [h.text(input)]
    }
}

export function createResponseElementRenders(
    ctx: Context,
    session: Session,
    config?: Config
): ResponseElementRenders {
    const renders: ResponseElementRenders = {
        voice: {
            parse: createMatch,
            render: (match) => [
                h('voice', match.extra ?? {}, [h.text(match.content)])
            ],
            process: async (el) => {
                logger.debug('voice render element: ' + JSON.stringify(el))
                return await voiceRender(
                    ctx,
                    session,
                    getElementText(el.children),
                    el.attrs.id == null ? undefined : String(el.attrs.id)
                )
            }
        }
    }

    renders.markdown = {
        parse: createMatch,
        render: (match) => [
            h('markdown', match.extra ?? {}, [h.text(match.content)])
        ],
        process: async (el) => {
            return await ctx.chatluna.renderer
                .render(
                    {
                        content: el.children[0]['attrs']['content']
                    },
                    {
                        type: 'text',
                        session
                    }
                )
                .then((result) => result.flatMap((message) => message.element))
        }
    }

    renders.file = {
        parse: createMatch,
        render: (match) => [h('file', match.extra ?? {}, [h.text(match.content)])],
        process: (el) => {
            const url = getElementText(el.children).trim()
            if (url.length < 1) {
                logger.warn(
                    'file 标签缺少 URL，已跳过。attrs=' + JSON.stringify(el.attrs)
                )
                return []
            }

            const name = String(el.attrs.name ?? '').trim()
            if (name.length < 1) {
                logger.warn(
                    'file 标签缺少 name 属性，已跳过。attrs=' +
                        JSON.stringify(el.attrs)
                )
                return []
            }

            const file = h('file', { name })
            file.attrs['chatluna_file_url'] = url
            return [file]
        }
    }

    return renders
}
