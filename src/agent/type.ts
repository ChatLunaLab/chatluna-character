import { AgentStep, AgentFinish } from '@langchain/core/agents'

export interface AgentPlan {
    id: string
    title: string
    status: 'pending' | 'doing' | 'done' | 'failed'
}

export interface AgentPlanAction {
    plans: AgentPlan[]
    currentPlan: AgentPlan
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface AgentFinishAction<T = any> extends AgentFinish {
    value?: T
}

export interface AgentAction<
    T extends 'plan' | 'action' | 'finish' = 'plan' | 'action' | 'finish'
> {
    type: T
    action: T extends 'plan'
        ? AgentPlanAction
        : T extends 'action'
          ? AgentStep | AgentStep[]
          : T extends 'finish'
            ? AgentFinishAction
            : AgentPlanAction | AgentStep[] | AgentFinish
}
