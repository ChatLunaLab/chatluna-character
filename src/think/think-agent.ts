import { SystemMessagePromptTemplate } from '@langchain/core/prompts'
import { BaseAgent, BaseAgentInput } from '../agent/base'
import { CharacterPrompt } from '../agent/prompt'
import { AgentAction } from '../agent/type'
import { AgentFinish } from '@langchain/core/agents'
import { GLOBAL_THINK_PROMPT, GROUP_OR_PRIVATE_THINK_PROMPT } from './prompt'

export interface ThinkAgentInput extends BaseAgentInput {
    thinkType: 'global' | 'group'
}

export class ThinkAgent extends BaseAgent {
    thinkType: 'global' | 'group'

    constructor(input: ThinkAgentInput) {
        super(input)
        this.thinkType = input.thinkType
    }

    private _prompt: CharacterPrompt
    async *_execute(
        chainValues: Record<string, unknown>
    ): AsyncGenerator<AgentAction<'action' | 'finish'>> {
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
                systemPrompt: SystemMessagePromptTemplate.fromTemplate(
                    this.thinkType === 'global'
                        ? GLOBAL_THINK_PROMPT
                        : GROUP_OR_PRIVATE_THINK_PROMPT
                )
            })
        }
        return this._prompt
    }
}
