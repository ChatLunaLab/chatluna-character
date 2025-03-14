import { StructuredTool, tool } from '@langchain/core/tools'
import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'

export class AgentStatus {
    variables: Record<string, unknown> = {}
    formatTemplate: Record<string, unknown> = {}

    constructor(
        variables: Record<string, unknown>,
        formatTemplate: Record<string, unknown>
    ) {
        this.variables = variables
        this.formatTemplate = formatTemplate
    }

    updateValues(values: Record<string, unknown>) {
        this.variables = {
            ...this.variables,
            ...values
        }
    }

    getStatus() {
        return JSON.stringify(this.variables)
    }

    getFormatTemplate() {
        return JSON.stringify(this.formatTemplate)
    }

    asWriteTool(): StructuredTool {
        return tool(
            async (values: Record<string, unknown>) => {
                this.updateValues(values)
                return 'Update status successfully'
            },
            {
                name: 'update_agent_status',
                description: 'Update agent status',
                schema: zodToJsonSchema(recordToZodSchema(this.formatTemplate))
            }
        )
    }

    asReadTool(): StructuredTool {
        return tool(
            async () => {
                return this.getStatus()
            },
            {
                name: 'read_agent_status',
                description: 'Read agent status',
                schema: zodToJsonSchema(recordToZodSchema(this.variables))
            }
        )
    }
}

function recordToZodSchema(record: Record<string, unknown>) {
    let schema = z.object({})

    for (const key in record) {
        const value = record[key]
        schema = schema.extend({
            [key]: valueToZodSchema(value)
        })
    }

    return schema
}

function valueToZodSchema(value: unknown) {
    if (typeof value === 'string') {
        return z.string()
    } else if (typeof value === 'number') {
        return z.number()
    } else if (typeof value === 'boolean') {
        return z.boolean()
    } else if (Array.isArray(value)) {
        return z.array(valueToZodSchema(value[0]))
    } else if (typeof value === 'object') {
        return recordToZodSchema(value as Record<string, unknown>)
    } else {
        return z.any()
    }
}
