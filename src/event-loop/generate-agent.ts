import { SystemMessagePromptTemplate } from '@langchain/core/prompts'
import { BaseAgent, BaseAgentInput } from '../agent/base'
import { CharacterPrompt } from '../agent/prompt'
import { AgentAction } from '../agent/type'
import { GENERATE_EVENT_LOOP_PLAN_PROMPT } from './prompt'
import { PresetTemplate } from '../types'
import { AgentFinish } from '@langchain/core/agents'
import { tryParseJSON } from '../utils'

export interface EventLoopAgentInput extends BaseAgentInput {
    charaterPrompt: PresetTemplate
}

export class EventLoopAgent extends BaseAgent {
    characterPrompt: PresetTemplate

    constructor(input: EventLoopAgentInput) {
        super(input)
        this.characterPrompt = input.charaterPrompt
    }

    private _prompt: CharacterPrompt
    async *_execute(
        chainValues: Record<string, unknown>
    ): AsyncGenerator<AgentAction<'plan' | 'action' | 'finish'>> {
        const date = new Date()
        chainValues['weekday'] = `星期 ${date.getDay()}`
        chainValues['time'] = date.toLocaleString()
        chainValues['system'] =
            await this.characterPrompt.system.format(chainValues)
        chainValues['chat_history'] = []
        chainValues['input'] = ''
        chainValues['variables'] = chainValues

        for await (const step of this.executor._streamIterator(chainValues)) {
            if (step.output) {
                const output = (step as AgentFinish)['output']

                // match <o> or <s> tags
                let match = output.match(/<o>(.*)<\/o>/s)
                if (!match) {
                    match = output.match(/<s>(.*)<\/s>/s)
                }

                if (match) {
                    yield {
                        type: 'finish',
                        action: {
                            ...(step as AgentFinish),
                            returnValues: step,
                            value: tryParseJSON(match[1])
                        }
                    }
                } else {
                    yield {
                        type: 'finish',
                        action: {
                            ...(step as AgentFinish),
                            returnValues: step
                        }
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
                    GENERATE_EVENT_LOOP_PLAN_PROMPT
                )
            })
        }
        return this._prompt
    }
}
