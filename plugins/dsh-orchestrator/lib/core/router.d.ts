/**
 * Role / rule based routing: which provider, model, and reasoning effort a task
 * runs on. Pure and deterministic — the first matching rule wins.
 * @module dsh-orchestrator/core/router
 */
import type { Route, RouteSource, RoutingConfig, TaskSpec } from './types.js';
export interface ResolvedRoute {
    readonly route: Route | undefined;
    readonly source: RouteSource;
    readonly ruleName?: string;
}
/** Wildcard match supporting `*` (any run of characters). Case-insensitive. */
export declare function wildcardMatch(pattern: string, value: string): boolean;
export declare const EMPTY_ROUTING: RoutingConfig;
/**
 * Resolve the route for one task.
 * Precedence: explicit task route → first matching rule → role map → default → inherit.
 */
export declare function resolveRoute(task: TaskSpec, routing: RoutingConfig): ResolvedRoute;
/** Merge a resolved route over a base route; defined fields win. */
export declare function mergeRoute(base: Route | undefined, override: Route | undefined): Route | undefined;
/** Human-readable route label for reports and events. */
export declare function routeLabel(route: Route | undefined): string;
