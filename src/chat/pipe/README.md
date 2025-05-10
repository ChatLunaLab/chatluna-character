# Chat Pipeline Middleware System

This directory contains a Koa-inspired middleware pipeline system for ChatLuna character chat processing.

## Architecture

The pipeline uses a Directed Acyclic Graph (DAG) to determine the execution order of middlewares:

- Middlewares can specify which middlewares they should run `before` and `after`
- The DAG topologically sorts middlewares to create a valid execution order
- The system ensures there are no circular dependencies

## Core Components

- **PipeContext**: Shared context between middlewares containing the request, session, and state
- **Middleware**: Individual processing units that can be chained together
- **DAG Manager**: Handles middleware ordering based on their relationships
- **Chat Pipe**: The main pipeline that executes middlewares in the correct order

## Default Middlewares

Three built-in middlewares are provided that cover the standard chat flow:

1. **Before Chat Middleware**: Prepares for the chat by gathering information
2. **Chat Middleware**: Processes the actual chat response
3. **After Chat Middleware**: Handles post-processing of the chat result

## Creating Custom Middlewares

```typescript
import { createMiddleware } from '../pipe/middleware'
import { PipeContext } from '../pipe/context'

export function createMyCustomMiddleware() {
  return createMiddleware(
    {
      name: 'my-custom-middleware',
      before: ['after-chat'], // Run before the after-chat middleware
      after: ['before-chat']  // Run after the before-chat middleware
    },
    async (context, next) => {
      // Access context
      const { session, message, history } = context

      // Do processing
      context.log('Processing in my custom middleware')

      // You can modify state that other middlewares can access
      context.state.myCustomData = 'something interesting'

      // Call next to continue pipeline execution
      await next()

      // Do any post-processing after downstream middlewares complete
      context.log('Post-processing in my custom middleware')
    }
  )
}
```

## Usage Example

```typescript
import { createChatPipe, createCustomChatPipe } from './pipe'
import { createMyCustomMiddleware } from './middleware/my-custom'

// Using default middlewares
const pipe = createChatPipe(ctx)

// Or create a custom pipeline
const customPipe = createCustomChatPipe(ctx, [
  createBeforeChatMiddleware({}),
  createMyCustomMiddleware(),
  createChatMiddleware({}),
  createAfterChatMiddleware({})
])

// Execute the pipeline
const result = await pipe.execute(session, message, history, preset, model, embeddings)
```
