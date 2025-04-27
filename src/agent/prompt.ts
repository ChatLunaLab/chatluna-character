/* eslint-disable max-len */
import {
    BaseMessage,
    HumanMessage,
    SystemMessage
} from '@langchain/core/messages'
import {
    BaseChatPromptTemplate,
    BaseMessagePromptTemplate,
    MessagesPlaceholder,
    SystemMessagePromptTemplate
} from '@langchain/core/prompts'
import { ChainValues, PartialValues } from '@langchain/core/utils/types'
import { messageTypeToOpenAIRole } from 'koishi-plugin-chatluna/llm-core/utils/count_tokens'
import { logger } from 'koishi-plugin-chatluna'
import { Logger } from 'koishi'
import { getMessageContent } from 'koishi-plugin-chatluna/utils/string'
import { PresetTemplate } from '../types'

export interface CharacterPromptInput {
    messagesPlaceholder?: MessagesPlaceholder
    tokenCounter: (text: string) => Promise<number>
    sendTokenLimit?: number
    systemPrompt?: PresetTemplate | BaseMessage[] | BaseMessagePromptTemplate
    partialVariables?: PartialValues
}

export interface CharacterPromptFormat {
    input: BaseMessage
    instructions?: string
    chat_history: BaseMessage[] | string
    variables?: ChainValues
    agent_scratchpad?: BaseMessage[] | BaseMessage
    before_agent_scrapad?: BaseMessage[] | BaseMessage
}

export class CharacterPrompt
    extends BaseChatPromptTemplate<CharacterPromptFormat>
    implements CharacterPromptInput
{
    getPreset?: () => Promise<PresetTemplate>

    tokenCounter: (text: string) => Promise<number>

    preset: PresetTemplate | BaseMessage[] | BaseMessagePromptTemplate

    sendTokenLimit?: number

    partialVariables: PartialValues = {}

    private fields: CharacterPromptInput

    constructor(fields: CharacterPromptInput) {
        super({
            inputVariables: [
                'chat_history',
                'variables',
                'input',
                'agent_scratchpad',
                'before_agent_scrapad'
            ]
        })

        this.partialVariables = fields.partialVariables

        this.tokenCounter = fields.tokenCounter

        this.sendTokenLimit = fields.sendTokenLimit ?? 4096
        this.preset = fields.systemPrompt
        this.fields = fields
    }

    _getPromptType() {
        return 'chatluna_chat' as const
    }

    private async _countMessageTokens(message: BaseMessage) {
        let result =
            (await this.tokenCounter(message.content as string)) +
            (await this.tokenCounter(
                messageTypeToOpenAIRole(message.getType())
            ))

        if (message.name) {
            result += await this.tokenCounter(message.name)
        }

        return result
    }

    async formatSystemPrompts(variables: ChainValues) {
        if (Array.isArray(this.preset)) {
            return this.preset
        }

        if (this.preset instanceof BaseMessagePromptTemplate) {
            return await this.preset.formatMessages(variables)
        }

        return [new SystemMessage(await this.preset.system.format(variables))]
    }

    async formatMessages({
        chat_history: chatHistory,
        input,
        variables,
        agent_scratchpad: agentScratchpad,
        before_agent_scrapad: beforeAgentScratchpad,
        instructions
    }: CharacterPromptFormat) {
        const result: BaseMessage[] = []
        let usedTokens = 0

        const systemPrompts = await this.formatSystemPrompts(variables)

        for (const message of systemPrompts || []) {
            const messageTokens = await this._countMessageTokens(message)
            result.push(message)
            usedTokens += messageTokens
        }

        if (instructions) {
            for (const message of [new SystemMessage(instructions)]) {
                const messageTokens = await this._countMessageTokens(message)
                result.push(message)
                usedTokens += messageTokens
            }
        }

        const inputTokens = await this.tokenCounter(
            getMessageContent(input.content)
        )

        usedTokens += inputTokens

        if (agentScratchpad) {
            if (Array.isArray(agentScratchpad)) {
                usedTokens += await agentScratchpad.reduce(
                    async (accPromise, message) => {
                        const acc = await accPromise
                        const messageTokens =
                            await this._countMessageTokens(message)
                        return acc + messageTokens
                    },
                    Promise.resolve(0)
                )
            } else {
                if (typeof agentScratchpad === 'string') {
                    agentScratchpad = new HumanMessage(agentScratchpad)
                }

                usedTokens += await this._countMessageTokens(agentScratchpad)
            }
        }

        const formatResult = await this._formatWithMessagesPlaceholder(
            chatHistory as BaseMessage[],

            usedTokens
        )

        result.push(...formatResult.messages)
        usedTokens = formatResult.usedTokens

        if (typeof input === 'string') {
            if (input !== '') {
                result.push(new HumanMessage(input))
            }
        } else {
            result.push(input)
        }

        if (agentScratchpad) {
            if (beforeAgentScratchpad) {
                if (Array.isArray(beforeAgentScratchpad)) {
                    result.push(...beforeAgentScratchpad)
                } else {
                    result.push(beforeAgentScratchpad)
                }
            }

            if (Array.isArray(agentScratchpad)) {
                result.push(...agentScratchpad)
            } else {
                result.push(agentScratchpad)
            }
        }

        if (logger?.level === Logger.DEBUG) {
            logger?.debug(
                `Used tokens: ${usedTokens} exceed limit: ${this.sendTokenLimit}`
            )

            const mapMessages = result.map((msg) => {
                console.log(msg.toDict, msg)
                const original = msg.toDict()
                const dict = structuredClone(original)
                if (dict.data == null) {
                    return dict
                }
                delete dict.data.additional_kwargs['images']
                delete dict.data.additional_kwargs['preset']
                return dict
            })

            logger?.debug(`messages: ${JSON.stringify(mapMessages)})`)
        }

        return result
    }

    private async _formatWithMessagesPlaceholder(
        chatHistory: BaseMessage[],

        usedTokens: number
    ): Promise<{ messages: BaseMessage[]; usedTokens: number }> {
        const result: BaseMessage[] = []

        for (const message of chatHistory.reverse()) {
            const messageTokens = await this._countMessageTokens(message)

            if (usedTokens + messageTokens > this.sendTokenLimit) {
                break
            }

            usedTokens += messageTokens
            result.unshift(message)
        }

        return { messages: result, usedTokens }
    }

    async partial<NewPartialVariableName extends string>(
        values: PartialValues<NewPartialVariableName>
    ) {
        const newInputVariables = this.inputVariables.filter(
            (iv) => !(iv in values)
        )

        const newPartialVariables = {
            ...(this.partialVariables ?? {}),
            ...values
        }
        const promptDict = {
            ...this.fields,
            inputVariables: newInputVariables,
            partialVariables: newPartialVariables
        }
        return new CharacterPrompt(promptDict)
    }
}

export const CURRENT_PLAN_FORMAT_PROMPT: SystemMessagePromptTemplate =
    SystemMessagePromptTemplate.fromTemplate(
        `这是你的当前任务：{plan}。请你根据当前任务和历史聊天信息，调用合适的工具完成这个任务。`
    )

export const CURRENT_CONTEXT_FORMAT_PROMPT: SystemMessagePromptTemplate =
    SystemMessagePromptTemplate.fromTemplate(
        `这是你之前调用工具后总结输出的结果： {context}。请你根据这些结果和用户的需求进行总结输出。无需调用任何工具。`
    )

/* eslint-disable max-len */
export const GENERATE_AGENT_PLAN_PROMPT: SystemMessagePromptTemplate =
    SystemMessagePromptTemplate.fromTemplate(`你是一个智能助手，负责根据用户的需求生成和管理执行计划。请根据以下信息进行操作：

<聊天历史>
{chat_history}
</聊天历史>

<用户输入>
{input}
</用户输入>

<系统角色>
{system}
</系统角色>

<工具调用结果>
{agent_scratchpad}
</工具调用结果>

<当前计划>
{plan}
</当前计划>

请根据以上信息，执行以下任务：

如果没有提供当前计划（plan为空），请根据聊天历史和用户输入生成一个新的执行计划列表。计划应该是一系列具体、可执行的步骤，每个步骤都有明确的目标。

如果已有当前计划，请根据工具调用结果评估当前计划的完成情况，并更新计划状态。

输出要求：
1. 必须是有效的JSON格式
2. 不要包含任何额外的解释或注释
3. 使用双引号而非单引号

## 生成新计划时的输出格式示例：
{{
  "plans": [
    {{
      "title": "识别并提取用户查询中的关键信息和意图",
      "status": "pending"
    }},
    {{
      "title": "在知识库中检索与用户问题相关的技术文档和解决方案",
      "status": "pending"
    }},
    {{
      "title": "分析多个信息源并筛选最相关的解决方案",
      "status": "pending"
    }},
    {{
      "title": "组织信息并生成结构化的技术解答",
      "status": "pending"
    }},
    {{
      "title": "检查回答的准确性并添加相关示例代码",
      "status": "pending"
    }}
  ],
  "currentPlan": {{
    "title": "识别并提取用户查询中的关键信息和意图",
    "status": "pending"
  }}
}}

## 更新现有计划时的输出格式示例：

{{
  "nextPlan": {{
    "title": "在知识库中检索与用户问题相关的技术文档和解决方案"
  }},
  "currentPlan": {{
    "title": "识别并提取用户查询中的关键信息和意图",
    "status": "done"
  }}
}}

请注意：
- 生成新计划时，返回完整的plans数组和当前计划
- 更新现有计划时，只需返回nextPlan和currentPlan
- 计划状态必须是以下之一："pending"、"done"或"failed"
- nextPlan是下一个需要执行的计划，currentPlan是当前正在执行的计划

现在，请根据提供的信息生成或更新计划：`)
