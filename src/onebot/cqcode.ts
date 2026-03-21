import { Dict, h } from 'koishi'

export interface CQCode {
    type: string
    data: Dict<string>
    capture?: RegExpExecArray
}

function unescape(source: string) {
    return String(source)
        .replace(/&#91;/g, '[')
        .replace(/&#93;/g, ']')
        .replace(/&#44;/g, ',')
        .replace(/&amp;/g, '&')
}

const pattern = /\[CQ:(\w+)((,\w+=[^,\]]*)*)\]/

function from(source: string): CQCode | null {
    const capture = pattern.exec(source)
    if (!capture) return null
    const [, type, attrs] = capture
    const data: Dict<string> = {}
    if (attrs) {
        attrs
            .slice(1)
            .split(',')
            .forEach((str) => {
                const index = str.indexOf('=')
                data[str.slice(0, index)] = unescape(str.slice(index + 1))
            })
    }
    return { type, data, capture }
}

export function parseCQCode(source: string) {
    const elements: h[] = []
    let result: CQCode | null

    while ((result = from(source))) {
        const { type, data, capture } = result

        if (capture.index) {
            elements.push(
                h('text', {
                    content: unescape(source.slice(0, capture.index))
                })
            )
        }

        switch (type) {
            case 'at':
                elements.push(
                    h('at', {
                        id: data.qq,
                        name: data.name ?? data.qq
                    })
                )
                break
            case 'image':
                elements.push(
                    h('img', {
                        imageUrl: data.url ?? data.file ?? data.path,
                        imageHash: data.file,
                        sticker: false
                    })
                )
                break
            case 'face':
                elements.push(
                    h('face', {
                        id: data.id,
                        name: data.text ?? data.name ?? data.id
                    })
                )
                break
            case 'reply':
                elements.push(h('quote', { id: data.id }))
                break
            case 'record':
                {
                    const audio = h('audio', {
                        name: data.file
                    })
                    audio.attrs['chatluna_file_url'] = data.url ?? data.file
                    elements.push(audio)
                }
                break
            case 'video':
                {
                    const video = h('video', {
                        name: data.file
                    })
                    video.attrs['chatluna_file_url'] = data.url ?? data.file
                    elements.push(video)
                }
                break
            case 'file':
                {
                    const file = h('file', {
                        name: data.name ?? data.file
                    })
                    file.attrs['chatluna_file_url'] = data.url ?? data.file
                    elements.push(file)
                }
                break
            default:
                elements.push(h(type, data))
                break
        }

        source = source.slice(capture.index + capture[0].length)
    }

    if (source) {
        elements.push(h('text', { content: unescape(source) }))
    }

    return elements
}
