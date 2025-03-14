import { AgentStep, AgentFinish } from '@langchain/core/agents'

export interface AgentPlan {
    title: string
    status: 'pending' | 'done' | 'failed'
}

export interface AgentPlanAction {
    plans: AgentPlan[]
    currentPlan: AgentPlan
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
            ? AgentFinish
            : AgentPlanAction | AgentStep[] | AgentFinish
}
