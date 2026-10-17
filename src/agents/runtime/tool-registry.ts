/**
 * Context handed to a tool call.
 *
 * All that survives of an earlier design where the orchestrator ran the agent
 * loop in Node: an AgentTool interface and a ToolRegistry that converted those
 * tools into an AI SDK ToolSet. Both are gone — the agent loop now runs inside
 * the container, where tools are Python modules in nanoagent/agent/tools/, and
 * nothing on this side registered a tool any more.
 *
 * RunContext stays because the MCP client (which is live) still describes calls
 * with it.
 */
export interface RunContext {
  agentId: string;
  runId: string;
  workspacePath: string;
  agentDir: string;
  // The current user turn — lets a tool escalate on the actual request instead
  // of a task-less generic cycle.
  userMessage?: string;
}
