import { StructuredTool } from '@langchain/core/tools'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { AgentAction } from './type'
import { CharacterPrompt, CURRENT_CONTEXT_FORMAT_PROMPT } from './prompt'
import {
    AgentExecutor,
    createOpenAIAgent,
    createReactAgent
} from 'koishi-plugin-chatluna/llm-core/agent'

export interface BaseAgentInput {
    executeModel: ChatLunaChatModel
    executeMode?: 'react' | 'function-call'
    maxIterations?: number
    tools?: StructuredTool[]
}

export abstract class BaseAgent implements BaseAgentInput {
    executeModel: ChatLunaChatModel
    executeMode?: 'react' | 'function-call'
    maxIterations?: number
    tools?: StructuredTool[] = []

    executor: AgentExecutor

    agentScratchpad: string[] = []

    constructor(input: BaseAgentInput) {
        this.executeModel = input.executeModel
        this.executeMode = input.executeMode
        this.maxIterations = input.maxIterations ?? 6
        this.tools = input.tools ?? []
    }

    private async _getExecutionContext(chainValues: Record<string, unknown>) {
        const contextMessages =
            await CURRENT_CONTEXT_FORMAT_PROMPT.formatMessages({
                context: this.agentScratchpad.join('\n\n')
            })

        return {
            ...chainValues,
            before_agent_scratchpad: contextMessages
        }
    }

    abstract _execute(
        chainValues: Record<string, unknown>
    ): AsyncGenerator<AgentAction<'action' | 'finish'>>

    abstract get prompt(): CharacterPrompt

    async *stream(
        chainValues: Record<string, unknown>
    ): AsyncGenerator<AgentAction<'action' | 'finish'>> {
        this.agentScratchpad = []

        if (!this.executor) {
            this.executor = await this._createExecutor(
                this.executeModel,
                this.tools
            )
        }

        let currentIteration = 0
        let currentAction: AgentAction

        // 主执行循环
        while (
            this._shouldContinueExecution(currentAction) &&
            currentIteration < this.maxIterations
        ) {
            const executionContext =
                await this._getExecutionContext(chainValues)

            for await (const agentAction of this._execute(executionContext)) {
                currentAction = agentAction

                if (agentAction.type === 'finish') {
                    yield agentAction
                    return
                }

                yield agentAction
            }

            currentIteration++
        }

        if (currentIteration >= this.maxIterations) {
            throw new Error('Max iterations reached without completion')
        }
    }

    private _shouldContinueExecution(currentAction?: AgentAction): boolean {
        return !currentAction || currentAction.type !== 'finish'
    }

    protected async _createExecutor(
        llm: ChatLunaChatModel,
        tools: StructuredTool[]
    ) {
        const commonConfig = {
            tools,
            memory: undefined,
            verbose: false,
            returnIntermediateSteps: true
        }

        if (this.executeMode === 'react') {
            return AgentExecutor.fromAgentAndTools({
                ...commonConfig,
                tags: ['react'],
                agent: await createReactAgent({
                    llm,
                    tools,
                    prompt: this.prompt
                }),
                maxIterations: 6,
                handleParsingErrors: true
            })
        }

        return AgentExecutor.fromAgentAndTools({
            ...commonConfig,
            tags: ['tool-calling'],
            agent: createOpenAIAgent({
                llm,
                tools,
                prompt: this.prompt
            })
        })
    }
}
