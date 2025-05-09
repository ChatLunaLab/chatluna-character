import { SystemMessagePromptTemplate } from '@langchain/core/prompts'
import { BaseAgent, BaseAgentInput } from '../agent/base'
import { CharacterPrompt } from '../agent/prompt'
import { AgentAction } from '../agent/type'
import { AFTER_CHAT_PROMPT } from './prompt'
import { AgentFinish } from '@langchain/core/agents'
import { PresetTemplate } from '../types'

export interface AfterChatAgentInput extends BaseAgentInput {
    characterPrompt: PresetTemplate
}

export class AfterChatAgent extends BaseAgent {
    characterPrompt: PresetTemplate

    constructor(input: AfterChatAgentInput) {
        super(input)
        this.characterPrompt = input.characterPrompt
    }

    private _prompt: CharacterPrompt

    async *_execute(
        chainValues: Record<string, unknown>
    ): AsyncGenerator<AgentAction<'plan' | 'action' | 'finish'>> {
        const date = new Date()
        chainValues['weekday'] = `星期${date.getDay()}`
        chainValues['time'] = date.toLocaleString()
        chainValues['system'] =
            await this.characterPrompt.system.format(chainValues)
        chainValues['variables'] = chainValues

        for await (const step of this.executor._streamIterator(chainValues)) {
            if (step.output) {
                yield {
                    type: 'finish',
                    action: {
                        ...(step as AgentFinish),
                        returnValues: step
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
                systemPrompt:
                    SystemMessagePromptTemplate.fromTemplate(AFTER_CHAT_PROMPT)
            })
        }
        return this._prompt
    }
}
