You are analyzing a week of work logs for {{agent_name}} ({{agent_type}}).

## Episode logs:
{{episodes_text}}

## Already known (do not duplicate):
{{existing_memory_summaries}}

Extract NEW learnings as a JSON array. Each entry must follow this schema exactly:
{
  "type": "lesson" | "pattern" | "failure" | "win" | "icp_update",
  "content": "concise, specific, actionable insight (1-3 sentences)",
  "confidence": 0.0-1.0,
  "sourceDates": ["YYYY-MM-DD"]
}

Rules:
- Only extract insights supported by 2+ episodes (recurring evidence) — set confidence accordingly
- Be specific: "Apollo filter X saves 30% scoring time" not "Apollo is good"
- icp_update: only if episodes show a clear signal about who converts best
- Skip anything already in "Already known" (near-duplicate check)
- Return empty array [] if no strong patterns found this week
- Return ONLY the JSON array, no other text
