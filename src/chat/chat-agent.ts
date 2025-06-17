import { BaseAgent, BaseAgentInput } from '../agent/base'
import { CharacterPrompt } from '../agent/prompt'
import { AgentAction } from '../agent/type'
import { AgentFinish } from '@langchain/core/agents'
import { PresetTemplate } from '../types'

export interface ChatAgentInput extends BaseAgentInput {
    characterPrompt: PresetTemplate
}

export class ChatAgent extends BaseAgent {
    characterPrompt: PresetTemplate

    constructor(input: ChatAgentInput) {
        super(input)
        this.characterPrompt = input.characterPrompt
    }

    private _prompt: CharacterPrompt

    async *_execute(
        chainValues: Record<string, unknown>
    ): AsyncGenerator<AgentAction<'action' | 'finish'>> {
        const date = new Date()
        chainValues['weekday'] = `星期${date.getDay()}`
        chainValues['time'] = date.toLocaleString()

        chainValues['variables'] = chainValues

        // TODO: image input
        const characterInputPrompt =
            await this.characterPrompt.input.format(chainValues)

        chainValues['input'] = characterInputPrompt

        for await (const step of this.executor._streamIterator(chainValues)) {
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
                systemPrompt: this.characterPrompt
            })
        }
        return this._prompt
    }
}
