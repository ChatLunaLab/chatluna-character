/* eslint-disable promise/param-names */
/**
 * 尝试解析 JSON，失败时返回 null
 */

import { BaseMessage } from '@langchain/core/messages'
import { h } from 'koishi'
import { marked, Token } from 'marked'

/**
 * 预处理内容，移除可能的 markdown 代码块标记
 */
export function preprocessContent(content: string): string {
    // 移除 markdown 代码块标记 (```json 和 ```)
    content = content.replace(
        /```(?:json|javascript|js)?\s*([\s\S]*?)```/g,
        '$1'
    )

    // 移除前后可能的空白字符
    content = content.trim()

    return content
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function tryParseJSON<T = any>(content: string): T {
    content = preprocessContent(content)

    try {
        return JSON.parse(content)
    } catch (e) {
        content = attemptToFixJSON(content)

        try {
            return JSON.parse(content)
        } catch (e) {
            console.error(`parse json failed`, content, e)
        }
    }
}

/**
 * 尝试修复常见的 JSON 格式错误
 */
export function attemptToFixJSON(content: string): string {
    let fixedContent = content

    // 修复缺少引号的键名
    fixedContent = fixedContent.replace(
        /(\{|\,)\s*([a-zA-Z0-9_]+)\s*\:/g,
        '$1"$2":'
    )

    // 修复使用单引号而非双引号的情况
    fixedContent = fixedContent.replace(/(\{|\,)\s*'([^']+)'\s*\:/g, '$1"$2":')
    fixedContent = fixedContent.replace(/\:\s*'([^']+)'/g, ':"$1"')

    // 修复缺少逗号的情况
    fixedContent = fixedContent.replace(/"\s*\}\s*"/g, '","')
    fixedContent = fixedContent.replace(/"\s*\{\s*"/g, '",{"')

    // 修复多余的逗号
    fixedContent = fixedContent.replace(/,\s*\}/g, '}')
    fixedContent = fixedContent.replace(/,\s*\]/g, ']')

    // 修复不完整的数组
    if (fixedContent.includes('[') && !fixedContent.includes(']')) {
        fixedContent += ']'
    }

    // 修复不完整的对象
    if (fixedContent.includes('{') && !fixedContent.includes('}')) {
        fixedContent += '}'
    }

    // 如果内容不是以 [ 开头但包含 [ 字符，尝试提取数组部分
    if (!fixedContent.trim().startsWith('[') && fixedContent.includes('[')) {
        const arrayMatch = fixedContent.match(/\[([\s\S]*)\]/)
        if (arrayMatch && arrayMatch[0]) {
            fixedContent = arrayMatch[0]
        }
    }

    return fixedContent
}

const tagRegExp = /<(\/?)([^!\s>/]+)([^>]*?)\s*(\/?)>/

function renderToken(token: Token): h {
    if (token.type === 'code') {
        return h('text', { code: true, content: token.text + '\n' })
    } else if (token.type === 'paragraph') {
        return h('p', render(token.tokens))
    } else if (token.type === 'image') {
        return h.image(token.href)
    } else if (token.type === 'blockquote') {
        return h('text', { content: token.text + '\n' })
    } else if (token.type === 'text') {
        return h('text', { content: token.text })
    } else if (token.type === 'em') {
        return h('em', render(token.tokens))
    } else if (token.type === 'strong') {
        return h('strong', render(token.tokens))
    } else if (token.type === 'del') {
        return h('del', render(token.tokens))
    } else if (token.type === 'link') {
        return h('a', { href: token.href }, render(token.tokens))
    } else if (token.type === 'html') {
        const cap = tagRegExp.exec(token.text)
        if (!cap) {
            return h('text', { content: token.text })
        }
        if (cap[2] === 'img') {
            if (cap[1]) return
            const src = cap[3].match(/src="([^"]+)"/)
            if (src) return h.image(src[1])
        }
    }

    return h('text', { content: token.raw })
}

function render(tokens: Token[]): h[] {
    return tokens.map(renderToken).filter(Boolean)
}

export function transform(source: string): h[]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function transform(source: TemplateStringsArray, ...args: any[]): h[]
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function transform(source: any, ...args: any[]) {
    if (!source) return []
    if (Array.isArray(source)) {
        source =
            args.map((arg, index) => source[index] + arg).join('') +
            source[args.length]
    }
    return render(marked.lexer(source))
}

export function messagesToString(messages: BaseMessage[]): string {
    const buffer: string[] = []

    for (const message of messages) {
        buffer.push(`${message.getType()}: ${message.content}`)
    }

    return buffer.join('\n')
}

/**
 * 任务等待队列类，用于管理任务间的依赖关系
 */
export class TaskQueue {
    private static _instance: TaskQueue | null = null
    private taskMap = new Map<
        string,
        {
            promise: Promise<void>
            resolve: () => void
            isReleased: boolean
        }
    >()

    /**
     * 获取全局共享实例
     */
    static getInstance(): TaskQueue {
        if (!TaskQueue._instance) {
            TaskQueue._instance = new TaskQueue()
        }
        return TaskQueue._instance
    }

    /**
     * 创建一个新的任务标记
     * @param taskId 任务标识符
     * @returns 任务标识符
     */
    createTask(taskId: string): string {
        if (this.taskMap.has(taskId)) {
            console.warn(`Task ${taskId} already exists`)
            return taskId
        }

        let resolve: () => void
        const promise = new Promise<void>((res) => {
            resolve = res
        })

        this.taskMap.set(taskId, {
            promise,
            resolve: resolve!,
            isReleased: false
        })

        return taskId
    }

    /**
     * 等待指定任务完成
     * @param taskId 要等待的任务标识符
     */
    async waitFor(taskId: string): Promise<void> {
        const task = this.taskMap.get(taskId)
        if (!task) {
            console.warn(`Task ${taskId} not found, skipping wait`)
            return
        }

        if (task.isReleased) {
            return
        }

        await task.promise
    }

    /**
     * 释放指定任务，允许等待该任务的其他任务继续执行
     * @param taskId 要释放的任务标识符
     */
    releaseTask(taskId: string): void {
        const task = this.taskMap.get(taskId)
        if (!task) {
            console.warn(`Task ${taskId} not found`)
            return
        }

        if (task.isReleased) {
            console.warn(`Task ${taskId} already released`)
            return
        }

        task.isReleased = true
        task.resolve()

        // 可选：清理已完成的任务
        // this.taskMap.delete(taskId)
    }

    /**
     * 检查任务是否已完成
     * @param taskId 任务标识符
     */
    isTaskReleased(taskId: string): boolean {
        const task = this.taskMap.get(taskId)
        return task?.isReleased ?? false
    }

    /**
     * 清理所有任务
     */
    clearAllTasks(): void {
        // 释放所有未完成的任务
        for (const task of this.taskMap.values()) {
            if (!task.isReleased) {
                task.resolve()
            }
        }
        this.taskMap.clear()
    }

    /**
     * 获取等待中的任务数量
     */
    getPendingTaskCount(): number {
        return Array.from(this.taskMap.values()).filter(
            (task) => !task.isReleased
        ).length
    }
}

/**
 * 全局任务队列实例
 */
export const globalTaskQueue = TaskQueue.getInstance()
