/**
 * Skill loading for the agent chat endpoint.
 *
 * This file used to also define six orchestrator-side agent tools (search_memory,
 * append_memory, save_skill, delegate_task, run_cycle, get_cycle_history) plus a
 * `chatTools` array. None of it was reachable: nothing imported the array, and a
 * repo-wide search found no consumer anywhere.
 *
 * They were leftovers from an earlier design where the orchestrator ran the agent
 * loop itself in Node. That loop now runs inside the agent container, where the
 * real tools live as ~55 Python modules in nanoagent/agent/tools/ — including its
 * own search_memory, append_memory, save_skill, delegate and filesystem. So the
 * capabilities were never missing; only these duplicate definitions were dead.
 * Removed rather than left to look wired up.
 */
import fs from 'node:fs';
import path from 'node:path';

// ─── Skill loader (used by chat endpoint to inject skills into system prompt) ──
// Reads all SKILL.md files in {agentWorkspace}/skills/*/ and returns a formatted
// block. Honors 'always: true' frontmatter — those are inlined; others are
// presented as a catalog ("here are skills you have; use them when relevant").

export function loadSkillsForChat(workspacePath: string): string {
  const skillsDir = path.join(workspacePath, 'skills');
  if (!fs.existsSync(skillsDir)) return '';

  const dirs = (() => {
    try {
      return fs
        .readdirSync(skillsDir, { withFileTypes: true })
        .filter((d) => d.isDirectory());
    } catch {
      return [];
    }
  })();
  if (dirs.length === 0) return '';

  const alwaysSkills: Array<{ name: string; body: string }> = [];
  const catalogSkills: Array<{ name: string; firstLine: string }> = [];

  for (const d of dirs) {
    const skillFile = path.join(skillsDir, d.name, 'SKILL.md');
    if (!fs.existsSync(skillFile)) continue;
    let raw: string;
    try {
      raw = fs.readFileSync(skillFile, 'utf-8');
    } catch {
      continue;
    }

    const isAlways =
      raw.startsWith('---') && /\nalways:\s*true/i.test(raw.slice(0, 300));
    // strip frontmatter for display
    const body = raw.startsWith('---')
      ? raw.replace(/^---[\s\S]*?\n---\n?/, '')
      : raw;

    if (isAlways) {
      alwaysSkills.push({ name: d.name, body: body.trim() });
    } else {
      const firstLine =
        body
          .split('\n')
          .find((l) => l.trim().length > 0)
          ?.trim()
          .slice(0, 200) ?? '';
      catalogSkills.push({ name: d.name, firstLine });
    }
  }

  const parts: string[] = [];
  if (alwaysSkills.length > 0) {
    parts.push('\n\n## Always-loaded skills');
    for (const s of alwaysSkills) {
      parts.push(`\n### ${s.name}\n${s.body}`);
    }
  }
  if (catalogSkills.length > 0) {
    parts.push('\n\n## Skill catalog (load on demand with read_file)');
    parts.push(
      'You have written these skills previously. Read the SKILL.md when the task fits:',
    );
    for (const s of catalogSkills) {
      parts.push(
        `- **${s.name}** (workspace/skills/${s.name}/SKILL.md) — ${s.firstLine}`,
      );
    }
  }
  return parts.join('\n');
}
