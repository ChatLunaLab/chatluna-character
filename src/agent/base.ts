import { BaseMessagePromptTemplate } from '@langchain/core/prompts'
import { StructuredTool } from '@langchain/core/tools'
import { ChatLunaChatModel } from 'koishi-plugin-chatluna/llm-core/platform/model'
import { AgentAction, AgentPlan, AgentPlanAction } from './type'
import {
    CharacterPrompt,
    CURRENT_CONTEXT_FORMAT_PROMOPT,
    CURRENT_PLAN_FORMAT_PROMOPT,
    GENERATE_AGENT_PLAN_PROMPT
} from './prompt'
import {
    AgentExecutor,
    createOpenAIAgent,
    createReactAgent
} from 'koishi-plugin-chatluna/llm-core/agent'
import { messagesToString, tryParseJSON } from '../utils'

export interface BaseAgentInput {
    planModel?: ChatLunaChatModel
    planPrompt?: BaseMessagePromptTemplate
    executeModel: ChatLunaChatModel
    executeMode?: 'react' | 'function-call'
    maxIterations?: number
    tools?: StructuredTool[]
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
            system: messagesToString(
                await this.prompt.formatSystemPrompts(chainValues)
            ),
            plan: JSON.stringify(this.planAction),
            agent_scratchpad: this.agentScratchpad.join('\n\n')
        })

        // Call the model to generate a response
        const response = await this.planModel.invoke(messages)

        // Parse the response content as JSON
        let planAction: AgentPlanAction
        try {
            const content = response.content as string
            const parsedContent = tryParseJSON(content)

            if (parsedContent.plans) {
                // This is a new plan generation
                planAction = {
                    plans: parsedContent.plans,
                    currentPlan: parsedContent.currentPlan
                }
            } else if (parsedContent.nextPlan && parsedContent.currentPlan) {
                // This is a plan update
                // Update the current plan status
                const updatedPlans =
                    this.planAction?.plans.map((plan) => {
                        if (plan.title === parsedContent.currentPlan.title) {
                            return {
                                ...plan,
                                status: parsedContent.currentPlan.status
                            }
                        }
                        return plan
                    }) || []

                // Find the next plan
                const nextPlanIndex = updatedPlans.findIndex(
                    (plan) => plan.title === parsedContent.nextPlan.title
                )

                planAction = {
                    plans: updatedPlans,
                    currentPlan:
                        nextPlanIndex >= 0
                            ? updatedPlans[nextPlanIndex]
                            : parsedContent.nextPlan
                }
            } else {
                throw new Error('Invalid plan format')
            }
        } catch (error) {
            console.error('Failed to parse plan response:', error)
            throw new Error(`Failed to parse plan response: ${error.message}`)
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
                before_agent_scrapad:
                    await CURRENT_PLAN_FORMAT_PROMOPT.formatMessages({
                        plan: this.planAction?.currentPlan ?? ''
                    }),
                ...chainValues
            })) {
                console.log(2, agentAction)
                // 只有确定完成才会传输 finish 的 action
                if (this.planAction != null && agentAction.type === 'finish') {
                    currentAction = agentAction
                    yield agentAction
                } else if (agentAction.type !== 'finish') {
                    currentAction = agentAction
                    yield agentAction
                }
            }

            // 将 agent 调用的结果缓存
            this.agentScratchpad.push(
                (currentAction as AgentAction<'finish'>).action.returnValues
                    .output
            )

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
            before_agent_scrapad:
                await CURRENT_CONTEXT_FORMAT_PROMOPT.formatMessages({
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
