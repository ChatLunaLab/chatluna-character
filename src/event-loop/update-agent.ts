import { SystemMessagePromptTemplate } from '@langchain/core/prompts'
import { BaseAgent, BaseAgentInput } from '../agent/base'
import { CharacterPrompt } from '../agent/prompt'
import { AgentAction } from '../agent/type'
import { PresetTemplate } from '../types'
import { AgentFinish } from '@langchain/core/agents'

export const GENERATE_EVENT_LOOP_UPDATE_PROMPT = `你现在需要完全代入下面 <system> 块中描述的角色，基于当前的时间 {time}（现在是{weekday}）和已有的事件循环计划，生成更新后的事件计划。

请像这个角色真实存在一样，考虑以下因素来更新计划：
1. 当前是{weekday}，可能是工作日或周末，计划应该符合这个时间点的合理安排
2. 如果今天是特殊节日或假期（如元旦、春节、劳动节等），请在计划中体现出来
3. 计划应该反映角色的性格、习惯、爱好和日常生活方式
4. 考虑角色的社交关系、工作/学习环境和生活场景
5. 你需要基于已有的事件列表进行更新，保留事件ID，并只输出变更的部分

已有的事件列表：
{events}

请输出一个变更列表（delta），包含所有需要更新的事件。每个事件必须包含id字段以便识别是哪个事件被更新。

下面是输出的 JSON 格式示例：

[{
    "id": "event-1",
    "timeStart": "00:00",
    "timeEnd": "06:03",
    "event": "睡觉",
    "eventDescription": "事件详细描述",
    "changeType": "update"
},{
    "id": "event-3",
    "timeStart": "07:30",
    "timeEnd": "08:15",
    "event": "早餐",
    "eventDescription": "事件详细描述",
    "changeType": "update"
},{
    "id": "event-5",
    "timeStart": "19:30",
    "timeEnd": "21:00",
    "event": "临时加班",
    "eventDescription": "事件详细描述",
    "changeType": "add"
},{
    "id": "event-8",
    "changeType": "delete"
}]

请注意以下字段的要求：
- id: 事件的唯一标识符，更新现有事件时必须使用原有ID，新增事件时创建新ID
- timeStart: 事件开始时间，格式为"HH:MM"
- timeEnd: 事件结束时间，格式为"HH:MM"
- event: 事件名称，简洁描述活动内容
- eventDescription: 事件的详细做事描述
- changeType: 变更类型，必须是以下三种之一：
  * "add" - 表示新增的事件
  * "update" - 表示更新的事件
  * "delete" - 表示删除的事件（只需提供id和changeType字段）

请确保：
1. 只输出需要变更的事件，不变的事件不需要包含在输出中
2. 更新后的计划结合原有计划，仍然要保持一整天时间的完整覆盖，没有时间空隙
3. 相邻事件的结束时间和开始时间应该无缝衔接
4. 事件安排符合真实人类的作息规律和角色特点

下面是 <system> 块，描述了你需要代入的角色：
<system>
{system}
</system>

请按照JSON格式输出，不要包含任何其他信息或解释，包括 Markdown 代码块等。确保输出的JSON格式正确，使用双引号而非单引号，并且没有多余的逗号。
`

export interface EventLoopUpdateAgentInput extends BaseAgentInput {
    characterPrompt: PresetTemplate
    events: string // JSON string of events with IDs
}

export interface EventDelta {
    id: string
    timeStart?: string
    timeEnd?: string
    event?: string
    status?: 'done' | 'doing' | 'todo'
    eventActions?: string[]
    changeType: 'add' | 'update' | 'delete'
}

export class EventLoopUpdateAgent extends BaseAgent {
    characterPrompt: PresetTemplate
    events: string

    constructor(input: EventLoopUpdateAgentInput) {
        super(input)
        this.characterPrompt = input.characterPrompt
        this.events = input.events
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
        chainValues['events'] = this.events
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
                    GENERATE_EVENT_LOOP_UPDATE_PROMPT
                )
            })
        }
        return this._prompt
    }
}
