import { BaseAgent, BaseAgentInput } from '../agent/base'
import { CharacterPrompt } from '../agent/prompt'
import { AgentAction } from '../agent/type'
import { DayEvent } from './type'
import { AgentFinish } from '@langchain/core/agents'
import { SystemMessagePromptTemplate } from '@langchain/core/prompts'
import { EVENT_DESCRIPTION_PROMPT } from './prompt'

export interface EventDescriptionAgentInput extends BaseAgentInput {
    characterPrompt: string
}

export interface EventDescriptionInput {
    event: DayEvent
    currentTime: Date
    characterPrompt: string
}

export interface EventDescriptionOutput {
    description: string
}

export class EventDescriptionAgent extends BaseAgent {
    characterPrompt: string

    constructor(input: EventDescriptionAgentInput) {
        super(input)
        this.characterPrompt = input.characterPrompt
    }

    private _prompt: CharacterPrompt
    async *_execute(
        chainValues: Record<string, unknown>
    ): AsyncGenerator<AgentAction<'action' | 'finish'>> {
        const event = chainValues['event'] as DayEvent
        const currentTime = chainValues['currentTime'] as Date

        // Calculate progress stage
        const eventStartMs = event.timeStart.getTime()
        const eventEndMs = event.timeEnd.getTime()
        const currentMs = currentTime.getTime()
        const progressPercent = Math.min(
            100,
            Math.max(
                0,
                ((currentMs - eventStartMs) / (eventEndMs - eventStartMs)) * 100
            )
        )

        const progressStage =
            progressPercent < 10
                ? '刚刚开始'
                : progressPercent < 30
                  ? '初期阶段'
                  : progressPercent < 70
                    ? '进行中'
                    : progressPercent < 90
                      ? '即将完成'
                      : '收尾阶段'

        // Format times
        const timeFormatted = currentTime.toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit'
        })

        const eventTimeStart = event.timeStart.toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit'
        })

        const eventTimeEnd = event.timeEnd.toLocaleTimeString('zh-CN', {
            hour: '2-digit',
            minute: '2-digit'
        })

        // Prepare template values
        const values = {
            time: timeFormatted,
            system: this.characterPrompt,
            event: event.event,
            eventDescription: event.eventDescription,
            eventTimeStart,
            eventTimeEnd,
            progressStage,
            chat_history: [],
            input: '',
            variables: chainValues
        }

        for await (const step of this.executor._streamIterator(values)) {
            if (step.output) {
                const output = (step as AgentFinish)['output']
                yield {
                    type: 'finish',
                    action: {
                        ...(step as AgentFinish),
                        returnValues: step,
                        value: output
                    }
                }
                return
            } else {
                yield {
                    type: 'action',
                    action: step.intermediateSteps
                }
            }
        }
    }

    get prompt(): CharacterPrompt {
        if (!this._prompt) {
            this._prompt = new CharacterPrompt({
                tokenCounter: (text) => this.executeModel.getNumTokens(text),
                sendTokenLimit: 10000,
                systemPrompt: SystemMessagePromptTemplate.fromTemplate(
                    EVENT_DESCRIPTION_PROMPT
                )
            })
        }
        return this._prompt
    }

    async execute(
        input: EventDescriptionInput
    ): Promise<EventDescriptionOutput> {
        if (this.executor == null) {
            this.executor = await this._createExecutor(
                this.executeModel,
                this.tools
            )
        }

        let description = ''

        const chainValues: Record<string, unknown> = {
            event: input.event,
            currentTime: input.currentTime,
            characterPrompt: input.characterPrompt
        }

        for await (const action of this._execute(chainValues)) {
            if (action.type === 'finish' && 'value' in action.action) {
                description = (action.action.value as string) || ''
                break
            }
        }

        return { description }
    }
}
