import { SystemMessagePromptTemplate } from '@langchain/core/prompts'
import { BaseAgent, BaseAgentInput } from '../agent/base'
import { CharacterPrompt } from '../agent/prompt'
import { AgentAction } from '../agent/type'
import { AgentFinish } from '@langchain/core/agents'
import { GLOBAL_THINK_PROMPT } from './prompt'

export interface GlobalThinkAgentInput extends BaseAgentInput {}

export class GlobalThinkAgent extends BaseAgent {
    constructor(input: GlobalThinkAgentInput) {
        super(input)
    }

    private _prompt: CharacterPrompt
    async *_execute(
        chainValues: Record<string, unknown>
    ): AsyncGenerator<AgentAction<'plan' | 'action' | 'finish'>> {
        chainValues['chat_history'] = []
        chainValues['input'] = ''
        chainValues['variables'] = chainValues

        for await (const step of this.executor._streamIterator(chainValues)) {
            if (step.output) {
                yield {
                    type: 'finish',
                    action: step as AgentFinish
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
                    SystemMessagePromptTemplate.fromTemplate(
                        GLOBAL_THINK_PROMPT
                    )
            })
        }
        return this._prompt
    }
}
