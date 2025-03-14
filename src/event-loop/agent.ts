import {
    BaseMessagePromptTemplate,
    SystemMessagePromptTemplate
} from '@langchain/core/prompts'
import { BaseAgent, BaseAgentInput } from '../agent/base'
import { CharacterPrompt } from '../agent/prompt'
import { AgentPlanAction, AgentAction } from '../agent/type'
import { GENERATE_EVENT_LOOP_PLAN_PROMPT } from './prompt'
import { PresetTemplate } from '../types'

export interface EventLoopAgentInput extends BaseAgentInput {
    charaterPrompt: PresetTemplate
}

export class EventLoopAgent extends BaseAgent {

    constructor

    private _prompt: CharacterPrompt
    _execute(
        chainValues: Record<string, unknown>
    ): Promise<AsyncGenerator<AgentAction<'plan' | 'action' | 'finish'>>> {
        throw new Error('Method not implemented.')
    }

    get prompt(): CharacterPrompt {
        if (!this._prompt) {
            this._prompt = new CharacterPrompt({
                tokenCounter: (text) => this.executeModel.getNumTokens(text),
                sendTokenLimit: 10000,
                systemPrompt: new SystemMessagePromptTemplate(
                    GENERATE_EVENT_LOOP_PLAN_PROMPT
                )
            })
        }
        return this._prompt
    }
}
