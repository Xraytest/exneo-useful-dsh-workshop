/**
 * Model-facing prompt text and the structured contracts the orchestrator asks
 * its own helper subagents to satisfy. Kept in core so the engine is testable
 * without a harness and every prompt is one reviewable artifact.
 * @module dsh-orchestrator/core/prompts
 */
import type { JsonObject, Plan, TaskOutput, TaskSpec } from './types.js'

/** Plan contract handed to the planner subagent as its structured output schema. */
export const PLAN_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    goal: { type: 'string', description: 'Restatement of the objective' },
    rationale: { type: 'string', description: 'Why the work is split this way' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: 'lower-case slug, unique, e.g. "scan-api"' },
          title: { type: 'string' },
          role: { type: 'string', description: 'e.g. researcher, coder, reviewer, writer' },
          prompt: { type: 'string', description: 'Self-contained instruction for the worker' },
          dependsOn: { type: 'array', items: { type: 'string' } },
          acceptance: { type: 'array', items: { type: 'string' } },
          critical: { type: 'boolean' },
          outputSchema: {
            type: 'object',
            additionalProperties: true,
            description: 'Optional object-rooted JSON Schema for this task result',
          },
        },
        required: ['id', 'title', 'role', 'prompt'],
      },
    },
    synthesis: {
      type: 'object',
      additionalProperties: false,
      properties: { enabled: { type: 'boolean' }, prompt: { type: 'string' } },
    },
  },
  required: ['tasks'],
}

/** Critic contract. */
export const CRITIC_SCHEMA: JsonObject = {
  type: 'object',
  additionalProperties: false,
  properties: {
    pass: { type: 'boolean' },
    reason: { type: 'string' },
    fixes: { type: 'array', items: { type: 'string' } },
  },
  required: ['pass', 'reason'],
}

const clip = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`

export interface PlannerInput {
  readonly goal: string
  readonly context?: string
  readonly maxTasks: number
  readonly roles: readonly string[]
  readonly structuredOutputSupported: boolean
}

export function plannerPrompt(input: PlannerInput): string {
  return [
    'You are the PLANNING stage of an orchestrator running inside DeepSeek Harness.',
    'Decompose the objective into a directed acyclic graph of delegated tasks. You do not execute the work yourself.',
    '',
    `OBJECTIVE:\n${input.goal}`,
    input.context ? `\nCONTEXT:\n${clip(input.context, 6000)}` : '',
    '',
    'RULES:',
    `- At most ${input.maxTasks} tasks. Prefer the smallest graph that covers the objective.`,
    '- Every task id is a unique lower-case slug matching [a-z][a-z0-9_-]{0,31}.',
    '- dependsOn lists task ids that must finish first; the graph must be acyclic. Independent tasks stay independent so they can run in parallel.',
    `- role is one of: ${input.roles.join(', ')} (or a new short role name when none fits).`,
    '- Each worker starts with NO memory of this conversation. Every prompt must be self-contained: state the inputs, the exact deliverable, the files or paths involved, and the definition of done.',
    '- acceptance is a short list of checkable criteria for that task.',
    '- Set critical=false only for genuinely optional enrichment.',
    '- Add outputSchema only when a downstream task needs machine-readable fields. It must be an object-rooted JSON Schema using type/oneOf/properties/required/additionalProperties/items/enum/const only.',
    input.structuredOutputSupported
      ? '- Reply with the plan JSON only.'
      : '- Reply with the plan JSON only, inside a single ```json fenced block.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export function planRepairPrompt(issues: readonly string[], previous: unknown): string {
  return [
    'Your previous plan was rejected by the orchestrator validator.',
    'Return a corrected plan JSON that fixes EVERY issue below. Keep the same objective and keep valid tasks unchanged.',
    '',
    'ISSUES:',
    ...issues.map((issue) => `- ${issue}`),
    '',
    'PREVIOUS PLAN:',
    clip(JSON.stringify(previous ?? null, null, 2), 6000),
  ].join('\n')
}

export interface ReplanInput {
  readonly goal: string
  readonly plan: Plan
  readonly failures: ReadonlyArray<{ id: string; title: string; detail: string }>
  readonly succeeded: readonly string[]
  readonly remainingBudgetNote?: string
}

export function replanPrompt(input: ReplanInput): string {
  return [
    'You are the RE-PLANNING stage of an orchestrator. A previous plan failed part of its work.',
    'Produce a NEW plan that completes the objective with the remaining work only.',
    '',
    `OBJECTIVE:\n${input.goal}`,
    `\nALREADY COMPLETED (do not redo, you may depend on their results by restating needed facts in the prompt):\n${input.succeeded.join(', ') || '(none)'}`,
    '\nFAILURES:',
    ...input.failures.map((failure) => `- ${failure.id} (${failure.title}): ${clip(failure.detail, 600)}`),
    input.remainingBudgetNote ? `\nBUDGET NOTE: ${input.remainingBudgetNote}` : '',
    '',
    'RULES: fewer, smaller, more concrete tasks than before. Avoid the failure cause. Same id and schema rules as the original plan.',
    'ORIGINAL PLAN:',
    clip(JSON.stringify({ tasks: input.plan.tasks.map((task) => ({ id: task.id, title: task.title, role: task.role, dependsOn: task.dependsOn })) }, null, 2), 4000),
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export interface WorkerInput {
  readonly goal: string
  readonly task: TaskSpec
  readonly dependencies: ReadonlyArray<{ spec: TaskSpec; output: TaskOutput }>
  readonly dependencyContextChars: number
  readonly attempt: number
  readonly previousFeedback?: string
  readonly structuredOutputSupported: boolean
}

export function workerPrompt(input: WorkerInput): string {
  const { task } = input
  const sections: string[] = [
    `You are a delegated WORKER subagent (role: ${task.role}) inside a DeepSeek Harness orchestration.`,
    'Complete this one task with your tools, then finish. Do not ask the user questions and do not delegate further unless it is essential.',
    '',
    `RUN OBJECTIVE (background only, do not work on it directly):\n${input.goal}`,
    '',
    `YOUR TASK: ${task.title} [${task.id}]`,
    task.prompt,
  ]
  if (input.dependencies.length > 0) {
    sections.push('', 'INPUTS FROM COMPLETED DEPENDENCIES:')
    for (const { spec, output } of input.dependencies) {
      sections.push(`--- ${spec.id}: ${spec.title} ---`)
      if (output.structured !== undefined) {
        sections.push(`structured result:\n${clip(JSON.stringify(output.structured, null, 2), input.dependencyContextChars)}`)
      }
      sections.push(clip(output.text, input.dependencyContextChars))
    }
  }
  if (task.acceptance.length > 0) {
    sections.push('', 'ACCEPTANCE CRITERIA:', ...task.acceptance.map((item) => `- ${item}`))
  }
  if (input.attempt > 1 && input.previousFeedback) {
    sections.push('', `PREVIOUS ATTEMPT ${input.attempt - 1} FAILED. Fix exactly this:`, clip(input.previousFeedback, 2000))
  }
  if (task.outputSchema) {
    sections.push(
      '',
      'OUTPUT CONTRACT:',
      'Your final message must satisfy this JSON Schema:',
      JSON.stringify(task.outputSchema, null, 2),
      input.structuredOutputSupported
        ? 'Emit the structured result through the harness structured-output mechanism.'
        : 'Put the JSON object in a single ```json fenced block as your final message.',
    )
  } else {
    sections.push('', 'Finish with a concise report of what you did, the concrete artifacts (paths, commands, findings), and any caveat.')
  }
  return sections.join('\n')
}

export interface CriticInput {
  readonly goal: string
  readonly task: TaskSpec
  readonly output: TaskOutput
  readonly schemaViolations: readonly string[]
}

export function criticPrompt(input: CriticInput): string {
  return [
    'You are the VERIFICATION stage of an orchestrator. Judge one worker result against its acceptance criteria.',
    'Be strict about the deliverable, not about style. Do not perform the task yourself.',
    '',
    `RUN OBJECTIVE:\n${input.goal}`,
    `TASK: ${input.task.title} [${input.task.id}]`,
    `INSTRUCTION GIVEN TO THE WORKER:\n${clip(input.task.prompt, 3000)}`,
    input.task.acceptance.length > 0
      ? `ACCEPTANCE CRITERIA:\n${input.task.acceptance.map((item) => `- ${item}`).join('\n')}`
      : 'ACCEPTANCE CRITERIA: the deliverable described in the instruction exists and is usable.',
    input.schemaViolations.length > 0
      ? `SCHEMA VIOLATIONS ALREADY DETECTED:\n${input.schemaViolations.map((item) => `- ${item}`).join('\n')}`
      : '',
    '',
    'WORKER RESULT:',
    input.output.structured !== undefined ? `structured:\n${clip(JSON.stringify(input.output.structured, null, 2), 4000)}` : '',
    clip(input.output.text, 6000),
    '',
    'Reply with {"pass": boolean, "reason": string, "fixes": string[]}. When pass is false, fixes must be concrete, actionable instructions for the next attempt.',
  ]
    .filter((line) => line !== '')
    .join('\n')
}

export interface SynthesisInput {
  readonly goal: string
  readonly customPrompt?: string
  readonly results: ReadonlyArray<{ spec: TaskSpec; output?: TaskOutput; status: string; detail?: string }>
  readonly resultChars: number
}

export function synthesisPrompt(input: SynthesisInput): string {
  const sections = [
    'You are the SYNTHESIS stage of an orchestrator. Write the final answer for the user.',
    'Merge the delegated results into one coherent deliverable. Do not invent facts that no task produced; call out gaps and failures explicitly.',
    '',
    `OBJECTIVE:\n${input.goal}`,
    input.customPrompt ? `\nADDITIONAL INSTRUCTION:\n${input.customPrompt}` : '',
    '',
    'TASK RESULTS:',
  ]
  for (const result of input.results) {
    sections.push(`--- ${result.spec.id}: ${result.spec.title} [${result.status}] ---`)
    if (result.detail) sections.push(`failure: ${clip(result.detail, 500)}`)
    if (result.output) {
      if (result.output.structured !== undefined) {
        sections.push(`structured:\n${clip(JSON.stringify(result.output.structured, null, 2), input.resultChars)}`)
      }
      sections.push(clip(result.output.text, input.resultChars))
    }
  }
  sections.push('', 'Answer in the language of the objective. Use Markdown. Start with the deliverable, end with a short "gaps / next steps" list when anything is incomplete.')
  return sections.filter((line) => line !== '').join('\n')
}