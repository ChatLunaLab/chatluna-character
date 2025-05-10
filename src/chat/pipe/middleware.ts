import { PipeContext } from './context'

export interface MiddlewareOptions {
    name: string
    before?: string[]
    after?: string[]
}

export type NextFunction = () => Promise<void>

export type MiddlewareFunction = (
    context: PipeContext,
    next: NextFunction
) => Promise<void>

export interface Middleware {
    name: string
    before: string[]
    after: string[]
    execute: MiddlewareFunction
}

export function createMiddleware(
    options: MiddlewareOptions,
    fn: MiddlewareFunction
): Middleware {
    return {
        name: options.name,
        before: options.before || [],
        after: options.after || [],
        execute: fn
    }
}

// This function will no longer be used as we'll rely on DAG
export function sortMiddlewares(middlewares: Middleware[]): Middleware[] {
    return middlewares
}
