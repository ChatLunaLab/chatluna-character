import { BaseMessagePromptTemplate } from '@langchain/core/prompts'
import { StructuredTool } from '@langchain/core/tools'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { AgentAction, AgentPlan, AgentPlanAction } from './type'
import {
    CharacterPrompt,
    CURRENT_CONTEXT_FORMAT_PROMPT,
    CURRENT_PLAN_FORMAT_PROMPT,
    GENERATE_AGENT_PLAN_PROMPT
} from './prompt'
import {
    AgentExecutor,
    createOpenAIAgent,
    createReactAgent
} from 'koishi-plugin-chatluna/llm-core/agent'
import { tryParseJSON } from '../utils'

export interface BaseAgentInput {
    planModel?: ChatLunaChatModel
    planPrompt?: BaseMessagePromptTemplate
    executeModel: ChatLunaChatModel
    executeMode?: 'react' | 'function-call'
    maxIterations?: number
    tools?: StructuredTool[]
}

export interface PlanDelta {
    id: string
    title?: string
    status?: 'pending' | 'doing' | 'done' | 'failed'
    changeType: 'add' | 'update' | 'delete'
    currentPlan?: boolean
}

export abstract class BaseAgent implements BaseAgentInput {
    planModel?: ChatLunaChatModel
    planPrompt?: BaseMessagePromptTemplate
    executeModel: ChatLunaChatModel
    executeMode?: 'react' | 'function-call'
    maxIterations?: number
    tools?: StructuredTool[] = []

    planAction: AgentPlanAction
    currentPlan: AgentPlan
    allPlans: AgentPlan[] = []

    executor: AgentExecutor

    agentScratchpad: string[] = []

    constructor(input: BaseAgentInput) {
        this.planModel = input.planModel
        this.planPrompt = input.planPrompt ?? GENERATE_AGENT_PLAN_PROMPT
        this.executeModel = input.executeModel

        this.executeMode = input.executeMode
        this.maxIterations = input.maxIterations ?? 6
        this.tools = input.tools ?? []
    }

    private async _plan(
        chainValues: Record<string, unknown>
    ): Promise<AgentPlanAction> {
        if (!this.planModel) {
            throw new Error('Plan model is required for planning')
        }

        // Format the messages using the planPrompt
        const messages = await this.planPrompt.formatMessages({
            chat_history: chainValues.chat_history ?? '',
            input: chainValues.input,
            system: chainValues.system ?? '',
            plan: this.planAction ? JSON.stringify(this.allPlans) : '',
            agent_scratchpad: this.agentScratchpad.join('\n\n')
        })

        // Call the model to generate a response
        const response = await this.planModel.invoke(messages)

        // Parse the response content as JSON
        let planDeltas: PlanDelta[] = []
        let newCurrentPlan: AgentPlan | null = null
        try {
            const content = response.content as string
            planDeltas = tryParseJSON(content)

            if (!Array.isArray(planDeltas)) {
                throw new Error('Expected an array of plan deltas')
            }
        } catch (error) {
            console.error('Failed to parse plan response:', error)
            throw new Error(`Failed to parse plan response: ${error.message}`)
        }

        // Apply deltas to existing plans
        for (const delta of planDeltas) {
            if (delta.changeType === 'add') {
                const newPlan: AgentPlan = {
                    id: delta.id,
                    title: delta.title,
                    status: delta.status || 'pending'
                }
                this.allPlans.push(newPlan)

                if (delta.currentPlan) {
                    newCurrentPlan = newPlan
                }
            } else if (delta.changeType === 'update') {
                const existingPlan = this.allPlans.find(
                    (plan) => plan.id === delta.id
                )
                if (existingPlan) {
                    if (delta.title) existingPlan.title = delta.title
                    if (delta.status) existingPlan.status = delta.status

                    if (delta.currentPlan) {
                        newCurrentPlan = existingPlan
                    }
                }
            } else if (delta.changeType === 'delete') {
                this.allPlans = this.allPlans.filter(
                    (plan) => plan.id !== delta.id
                )
            }
        }

        // If no current plan is explicitly set, use the first pending plan
        if (
            !newCurrentPlan &&
            this.allPlans.some((plan) => plan.status === 'pending')
        ) {
            newCurrentPlan = this.allPlans.find(
                (plan) => plan.status === 'pending'
            )
        }

        // Create the final plan action
        const planAction: AgentPlanAction = {
            plans: this.allPlans,
            currentPlan: newCurrentPlan || this.currentPlan
        }

        return planAction
    }

    async plan(chainValues: Record<string, unknown>): Promise<AgentPlanAction> {
        const newAction = await this._plan(chainValues)

        this.planAction = newAction
        this.currentPlan = newAction.currentPlan
        return newAction
    }

    abstract _execute(
        chainValues: Record<string, unknown>
    ): AsyncGenerator<AgentAction<'plan' | 'action' | 'finish'>>

    abstract get prompt(): CharacterPrompt

    async *stream(
        chainValues: Record<string, unknown>
    ): AsyncGenerator<AgentAction<'plan' | 'action' | 'finish'>> {
        this.agentScratchpad = []

        if (this.executor == null) {
            this.executor = await this._createExecutor(
                this.executeModel,
                this.tools
            )
        }

        // 如果有计划模型，则执行计划生成
        if (this.planAction == null && this.planModel != null) {
            this.planAction = await this.plan(chainValues)
        }

        let currentIteration = 0

        let currentAction: AgentAction

        while (
            (!this.checkPlanSuccess(this.planAction) ||
                (this.planAction == null && currentAction.type !== 'finish')) &&
            currentIteration < this.maxIterations
        ) {
            for await (const agentAction of this._execute({
                before_agent_scratchpad:
                    this.planAction != null
                        ? await CURRENT_PLAN_FORMAT_PROMPT.formatMessages({
                              plan: this.planAction?.currentPlan ?? '',
                              context: this.agentScratchpad.join('\n\n')
                          })
                        : undefined,
                ...chainValues
            })) {
                // 只有确定完成才会传输 finish 的 action
                currentAction = agentAction
                if (agentAction.type === 'finish' && this.planAction === null) {
                    yield agentAction
                }

                if (agentAction.type === 'finish' && this.planAction !== null) {
                    this.agentScratchpad.push(
                        ...(agentAction.action['intermediateSteps'].map(
                            (step) => JSON.stringify(step)
                        ) as string[])
                    )
                    this.agentScratchpad.push(agentAction.action['output'])

                    // console.log(2, this.agentScratchpad)
                }
            }

            // 完成后更新计划
            if (this.planAction != null) {
                this.planAction = await this.plan({
                    ...chainValues,
                    agent_scratchpad: this.agentScratchpad.join('\n\n')
                })

                yield {
                    type: 'plan',
                    action: this.planAction
                }
            }

            if (this.planAction == null && currentAction.type === 'finish') {
                return
            }

            currentIteration++
        }

        if (
            this.planAction == null &&
            currentIteration >= this.maxIterations &&
            currentAction.type !== 'finish'
        ) {
            throw new Error('Max iterations reached')
        } else if (this.planAction == null && currentAction.type === 'finish') {
            return
        }

        // 计划都完成后，在调用一次 agent 获取最终的结果。

        for await (const agentAction of this._execute({
            before_agent_scratchpad:
                await CURRENT_CONTEXT_FORMAT_PROMPT.formatMessages({
                    context: this.agentScratchpad.join('\n\n')
                }),
            ...chainValues
        })) {
            yield agentAction
        }
    }

    private checkPlanSuccess(
        action: AgentPlanAction = this.planAction
    ): boolean {
        if (action == null) {
            return false
        }
        if (action.plans.length === 0) {
            return false
        }

        return action.plans.every((plan) => {
            return plan.status === 'done'
        })
    }

    private async _createExecutor(
        llm: ChatLunaChatModel,
        tools: StructuredTool[]
    ) {
        if (this.executeMode === 'react') {
            return AgentExecutor.fromAgentAndTools({
                tags: ['react'],
                agent: await createReactAgent({
                    llm,
                    tools,
                    prompt: this.prompt
                }),
                tools,
                memory: undefined,
                verbose: false,
                maxIterations: 6,
                returnIntermediateSteps: true,
                handleParsingErrors: true
            })
        }

        return AgentExecutor.fromAgentAndTools({
            tags: ['tool-calling'],
            agent: createOpenAIAgent({
                llm,
                tools,
                prompt: this.prompt
            }),
            tools,
            returnIntermediateSteps: true,
            memory: undefined,
            verbose: false
        })
    }
}
