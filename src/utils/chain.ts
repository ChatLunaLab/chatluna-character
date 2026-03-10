/* eslint-disable generator-star-spacing */
import {
    AIMessageChunk,
    BaseMessage,
    HumanMessage
} from '@langchain/core/messages'
import { Context, Session } from 'koishi'
import { computed, ComputedRef } from 'koishi-plugin-chatluna'
import {
    AgentStep,
    createAgentExecutor,
    createToolsRef
} from 'koishi-plugin-chatluna/llm-core/agent'
import {
    ChatLunaChatPrompt,
    ChatLunaChatPromptFormat
} from 'koishi-plugin-chatluna/llm-core/chain/prompt'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { PresetTemplate } from 'koishi-plugin-chatluna/llm-core/prompt'
import { parseRawModelName } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import type {} from 'koishi-plugin-chatluna/services/chat'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'

import {
    ChatLunaChain,
    ChatLunaChainStreamChunk,
    ChatLunaRunnableConfig
} from '../types'

interface AgentExecutorStreamChunk {
    output?: BaseMessage['content']
}

interface AsyncChunkQueue<T> {
    push(value: T): void
    end(): void
    fail(error: unknown): void
    next(): Promise<IteratorResult<T>>
}

function createAgentResponseChunk(
    content: BaseMessage['content'] | undefined
): AIMessageChunk | undefined {
    if (content == null) return

    const text = getMessageContent(content)
    if (text.trim().length < 1) return

    return new AIMessageChunk({
        content
    })
}

function createAsyncChunkQueue<T>(): AsyncChunkQueue<T> {
    const values: T[] = []
    const waiters: {
        resolve: (result: IteratorResult<T>) => void
        reject: (error: unknown) => void
    }[] = []

    let ended = false
    let failure: unknown

    const flush = () => {
        while (values.length > 0 && waiters.length > 0) {
            const waiter = waiters.shift()
            if (waiter == null) {
                break
            }

            waiter.resolve({
                value: values.shift()!,
                done: false
            })
        }

        if (!ended || values.length > 0) {
            return
        }

        while (waiters.length > 0) {
            const waiter = waiters.shift()
            if (waiter == null) {
                break
            }

            if (failure != null) {
                waiter.reject(failure)
            } else {
                waiter.resolve({
                    value: undefined,
                    done: true
                })
            }
        }
    }

    return {
        push(value) {
            if (ended) {
                return
            }

            values.push(value)
            flush()
        },
        end() {
            if (ended) {
                return
            }

            ended = true
            flush()
        },
        fail(error) {
            if (ended) {
                return
            }

            failure = error
            ended = true
            flush()
        },
        async next() {
            if (values.length > 0) {
                return {
                    value: values.shift()!,
                    done: false
                }
            }

            if (ended) {
                if (failure != null) {
                    throw failure
                }

                return {
                    value: undefined,
                    done: true
                }
            }

            return new Promise<IteratorResult<T>>((resolve, reject) => {
                waiters.push({ resolve, reject })
            })
        }
    }
}

export async function createChatLunaChain(
    ctx: Context,
    llmRef: ComputedRef<ChatLunaChatModel>,
    session: Session
): Promise<ComputedRef<ChatLunaChain>> {
    const logger = ctx.chatluna_character.logger
    const currentPreset = computed(
        () =>
            ({
                triggerKeyword: [''],
                rawText: '',
                messages: [],
                config: {}
            }) satisfies PresetTemplate
    )

    const chatPrompt = computed(() => {
        const llm = llmRef.value
        return new ChatLunaChatPrompt({
            preset: currentPreset,
            tokenCounter: (text) => llm.getNumTokens(text),
            sendTokenLimit:
                llm.invocationParams().maxTokenLimit ??
                llm.getModelMaxContextSize(),
            contextManager: ctx.chatluna.contextManager,
            promptRenderService: ctx.chatluna.promptRenderer
        })
    })

    const embeddingsRef = await createEmbeddingsModel(ctx)
    const toolListRef = ctx.chatluna.platform.getTools()
    const toolsListRef = computed(() =>
        toolListRef.value.map((tool) => ctx.chatluna.platform.getTool(tool))
    )

    const toolsRef = createToolsRef({
        tools: toolsListRef,
        embeddings: embeddingsRef.value
    })

    const executorRef = createAgentExecutor({
        llm: llmRef,
        tools: toolsRef.tools,
        prompt: chatPrompt.value,
        agentMode: 'tool-calling',
        returnIntermediateSteps: false,
        handleParsingErrors: true,
        instructions: computed(() => undefined)
    })

    return computed(() => {
        const updateToolsIfNeeded = (
            input: ChatLunaChatPromptFormat,
            options?: ChatLunaRunnableConfig
        ) => {
            // Update tools before execution
            if (options?.configurable?.session) {
                const copyOfMessages =
                    typeof input['chat_history'] === 'string'
                        ? [new HumanMessage(input['chat_history'])]
                        : [...input['chat_history']]

                if (copyOfMessages.length === 0) {
                    copyOfMessages.push(input.input)
                }

                toolsRef.update(options.configurable.session, copyOfMessages)
            }
        }

        async function* stream(
            input: ChatLunaChatPromptFormat,
            options?: ChatLunaRunnableConfig
        ): AsyncGenerator<ChatLunaChainStreamChunk> {
            updateToolsIfNeeded(input, options)

            const chunkQueue = createAsyncChunkQueue<ChatLunaChainStreamChunk>()
            let buf = ''

            const emitEarlyIntermediate = (action: AgentStep['action']) => {
                const chunk = createAgentResponseChunk(
                    buf.length > 0 ? buf : action.content
                )

                buf = ''

                if (chunk == null) {
                    return
                }

                chunkQueue.push({
                    message: chunk,
                    phase: 'intermediate'
                })
            }

            const streamOptions: ChatLunaRunnableConfig = {
                ...(options ?? {}),
                callbacks: [
                    ...(Array.isArray(options?.callbacks)
                        ? options.callbacks
                        : options?.callbacks != null
                          ? [options.callbacks]
                          : []),
                    {
                        handleLLMNewToken(token: string) {
                            buf += token
                        },
                        handleAgentAction(action: AgentStep['action']) {
                            const text = JSON.stringify(
                                {
                                    tool: action.tool,
                                    toolInput: action.toolInput,
                                    content: action.content
                                },
                                null,
                                2
                            )
                            const content =
                                text.length > 2000
                                    ? text.slice(0, 2000) + '\n...[truncated]'
                                    : text

                            logger.debug(`agent tool call:\n${content}`)
                            emitEarlyIntermediate(action)
                        },
                        handleToolEnd(output: unknown) {
                            let result = output

                            if (typeof output === 'string') {
                                const raw = output.replace(/\\n/g, '\n')
                                try {
                                    result = JSON.parse(raw)
                                } catch {
                                    result = raw
                                }
                            }
                            const text =
                                typeof result === 'string'
                                    ? result
                                    : JSON.stringify(result, null, 2)
                            const content =
                                text.length > 2000
                                    ? text.slice(0, 2000) + '\n...[truncated]'
                                    : text

                            logger.debug(`agent tool result:\n${content}`)
                        }
                    }
                ]
            }

            const producer = (async () => {
                try {
                    const response = (await executorRef.value.invoke(
                        input,
                        streamOptions
                    )) as AgentExecutorStreamChunk

                    buf = ''

                    if ('output' in response) {
                        const responseChunk = createAgentResponseChunk(
                            response.output
                        )

                        if (responseChunk) {
                            chunkQueue.push({
                                message: responseChunk,
                                phase: 'final'
                            })
                        }
                    }

                    chunkQueue.end()
                } catch (error) {
                    chunkQueue.fail(error)
                }
            })()

            try {
                while (true) {
                    const { value, done } = await chunkQueue.next()
                    if (done) {
                        break
                    }

                    if (value) {
                        yield value
                    }
                }
            } finally {
                await producer
            }
        }

        return {
            async invoke(input, options) {
                updateToolsIfNeeded(input, options)

                const response = (await executorRef.value.invoke(
                    input,
                    options ?? {}
                )) as AgentExecutorStreamChunk

                return new AIMessageChunk({
                    content: response.output ?? ''
                })
            },
            stream
        }
    })
}

export function createEmbeddingsModel(ctx: Context) {
    const modelName = ctx.chatluna.config.defaultEmbeddings

    const [platform, model] = parseRawModelName(modelName)

    return ctx.chatluna.createEmbeddings(platform, model)
}
