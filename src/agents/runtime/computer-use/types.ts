import { z } from 'zod';

// ─── Step schema ───────────────────────────────────────────────────────────────

export const WaitForSchema = z.object({
  selector: z.string().optional().describe('CSS selector to wait for'),
  state: z
    .enum(['visible', 'hidden', 'attached', 'detached'])
    .optional()
    .default('visible'),
  timeout: z.number().optional().default(10000),
});

export const VerifySchema = z.object({
  urlContains: z
    .string()
    .optional()
    .describe('Assert page URL contains this string'),
  elementVisible: z
    .string()
    .optional()
    .describe('Assert CSS selector is visible'),
  elementAbsent: z
    .string()
    .optional()
    .describe('Assert CSS selector is NOT present'),
  textPresent: z.string().optional().describe('Assert page contains this text'),
});

export const StepSchema = z.object({
  step: z.number().describe('Step number (1-based)'),
  action: z
    .enum([
      'click',
      'right_click',
      'double_click',
      'type',
      'key',
      'scroll',
      'hover',
      'navigate',
      'wait',
      'screenshot',
      'select',
      'clear',
    ])
    .describe('Action to perform'),
  target: z
    .string()
    .optional()
    .describe('CSS selector, a11y label, or "x,y" coordinates'),
  selector: z
    .string()
    .optional()
    .describe('Alias for target — CSS selector or a11y label'),
  text: z.string().optional().describe('Text to type (for type action)'),
  key: z
    .string()
    .optional()
    .describe('Key or keyboard shortcut (e.g. "Enter", "Control+a")'),
  url: z
    .string()
    .optional()
    .describe('URL to navigate to (for navigate action)'),
  value: z.string().optional().describe('Value to select (for select action)'),
  direction: z
    .enum(['up', 'down', 'left', 'right'])
    .optional()
    .describe('Scroll direction'),
  amount: z.number().optional().describe('Scroll amount in pixels'),
  duration: z
    .number()
    .optional()
    .describe('Wait duration in ms (for wait action)'),
  description: z
    .string()
    .optional()
    .describe('Human-readable description of this step'),
  waitFor: WaitForSchema.optional().describe(
    'Wait for element before executing',
  ),
  verify: VerifySchema.optional().describe(
    'Assertions to run after the action',
  ),
  isExternal: z
    .boolean()
    .optional()
    .describe('True if this action affects external systems'),
  isDangerous: z
    .boolean()
    .optional()
    .describe(
      'Explicitly mark this step as dangerous — always triggers the escalation gate',
    ),
  credentialRef: z
    .string()
    .optional()
    .describe(
      'Inject stored credential as text — format "service:field" (e.g. "github:password"). Value is never logged.',
    ),
});

export type Step = z.infer<typeof StepSchema>;
export type WaitForSpec = z.infer<typeof WaitForSchema>;
export type VerifySpec = z.infer<typeof VerifySchema>;

// ─── Tool args ─────────────────────────────────────────────────────────────────

export const ComputerUseArgsSchema = z.object({
  task: z
    .string()
    .describe('Human-readable description of the task to accomplish'),
  url: z
    .string()
    .optional()
    .describe('Initial URL to navigate to before executing steps'),
  steps: z
    .array(StepSchema)
    .describe('Ordered list of browser actions to execute'),
  sessionDomain: z
    .string()
    .optional()
    .describe(
      'Domain key for loading/saving browser session cookies (e.g. "github.com")',
    ),
  maxExternalActions: z
    .number()
    .optional()
    .default(5)
    .describe('Maximum external actions allowed before halting'),
});

export type ComputerUseArgs = z.infer<typeof ComputerUseArgsSchema>;

// ─── Results ───────────────────────────────────────────────────────────────────

export interface VerificationResult {
  passed: boolean;
  reason?: string;
}

export interface StepResult {
  step: number;
  status: 'success' | 'failed' | 'skipped';
  error?: string;
  verificationPassed?: boolean;
  urlAfter?: string;
}

export interface ActionLogEntry {
  runId: string;
  agentId: string;
  step: number;
  timestamp: string;
  action: {
    type: string;
    target?: string;
    text?: string;
    url?: string;
    key?: string;
  };
  classification: 'read' | 'write' | 'external';
  approvalStatus: 'auto-approved' | 'blocked';
  result: { status: string; urlAfter?: string; error?: string };
  operatorVisible: boolean;
}
