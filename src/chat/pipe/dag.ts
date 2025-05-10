import { Middleware } from './middleware'

interface Node {
    middleware: Middleware
    dependencies: Set<string>
    dependents: Set<string>
}

export class DagManager {
    private nodes: Map<string, Node> = new Map()

    // Add middleware to the DAG and process its before/after relationships
    addMiddleware(middleware: Middleware): void {
        const name = middleware.name

        // Create the node if it doesn't exist
        if (!this.nodes.has(name)) {
            this.nodes.set(name, {
                middleware,
                dependencies: new Set(),
                dependents: new Set()
            })
        } else {
            // Update the middleware if node exists
            this.nodes.get(name).middleware = middleware
        }

        // Process 'before' relationships
        for (const beforeName of middleware.before) {
            // Create placeholder node if target doesn't exist yet
            if (!this.nodes.has(beforeName)) {
                this.nodes.set(beforeName, {
                    middleware: null, // Will be filled later
                    dependencies: new Set(),
                    dependents: new Set()
                })
            }

            // This middleware should run before beforeName
            // So beforeName depends on this middleware
            this.nodes.get(beforeName).dependencies.add(name)
            this.nodes.get(name).dependents.add(beforeName)
        }

        // Process 'after' relationships
        for (const afterName of middleware.after) {
            // Create placeholder node if target doesn't exist yet
            if (!this.nodes.has(afterName)) {
                this.nodes.set(afterName, {
                    middleware: null, // Will be filled later
                    dependencies: new Set(),
                    dependents: new Set()
                })
            }

            // This middleware should run after afterName
            // So this middleware depends on afterName
            this.nodes.get(name).dependencies.add(afterName)
            this.nodes.get(afterName).dependents.add(name)
        }
    }

    // Add multiple middlewares to the DAG
    addMiddlewares(middlewares: Middleware[]): void {
        for (const middleware of middlewares) {
            this.addMiddleware(middleware)
        }
    }

    // Sort middlewares based on dependencies using topological sort
    sort(): Middleware[] {
        // Check for missing middleware implementations
        for (const [name, node] of this.nodes.entries()) {
            if (!node.middleware) {
                throw new Error(
                    `Middleware '${name}' referenced in before/after but not provided`
                )
            }
        }

        const visited = new Set<string>()
        const temp = new Set<string>()
        const order: Middleware[] = []

        // Helper function for topological sort
        const visit = (nodeName: string) => {
            // If node is in temporary set, we have a cycle
            if (temp.has(nodeName)) {
                throw new Error(`Circular dependency detected: ${nodeName}`)
            }

            // Skip if already visited
            if (visited.has(nodeName)) {
                return
            }

            temp.add(nodeName)

            // Visit all dependencies first
            const node = this.nodes.get(nodeName)
            if (node) {
                for (const dep of node.dependencies) {
                    visit(dep)
                }

                // Add current node to result
                visited.add(nodeName)
                temp.delete(nodeName)
                order.push(node.middleware)
            }
        }

        // Visit all nodes
        for (const nodeName of this.nodes.keys()) {
            if (!visited.has(nodeName)) {
                visit(nodeName)
            }
        }

        return order
    }

    // Get all middlewares
    getMiddlewares(): Middleware[] {
        return Array.from(this.nodes.values())
            .filter((node) => node.middleware)
            .map((node) => node.middleware)
    }

    // Get all dependencies for a middleware
    getDependencies(name: string): string[] {
        const node = this.nodes.get(name)
        return node ? Array.from(node.dependencies) : []
    }

    // Get all dependents for a middleware
    getDependents(name: string): string[] {
        const node = this.nodes.get(name)
        return node ? Array.from(node.dependents) : []
    }
}
