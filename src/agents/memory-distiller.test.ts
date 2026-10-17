import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MemoryDistiller } from './memory-distiller.js';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../config.js';

// Mock the db module
vi.mock('../db.js', () => ({
  createAgentMemory: vi.fn((mem) => ({ id: 'mock-id', ...mem })),
  getMemoryByAgent: vi.fn(() => []),
  getWeeklyCycles: vi.fn(() => []),
  syncToMemoryMd: vi.fn(),
  getDistilledEpisodeDates: vi.fn(() => new Set()),
  markEpisodesDistilled: vi.fn(),
  getMemoryWithEmbeddings: vi.fn(() => []),
  demoteMemoryRelevance: vi.fn(),
}));

describe('MemoryDistiller', () => {
  let distiller: MemoryDistiller;

  beforeEach(() => {
    distiller = new MemoryDistiller('mock-agents-dir');
    vi.clearAllMocks();
  });

  it('should correctly save candidates to global knowledge when scope is global and confidence is high', () => {
    const agentId = 'test-agent';
    const candidates = [
      {
        type: 'lesson' as any,
        content: 'Always implement rate limiting for third party APIs',
        confidence: 0.9,
        sourceDates: ['2026-06-01'],
        scope: 'global' as const,
        embedding: null,
      },
      {
        type: 'pattern' as any,
        content: 'Cold Outreach Sequencing cadence is 1, 4, 8, 14',
        confidence: 0.85,
        sourceDates: ['2026-06-01'],
        scope: 'global' as const,
        embedding: null,
      },
      {
        type: 'failure' as any,
        content: 'Hubspot Contact API failed because of duplicates',
        confidence: 0.5, // too low
        sourceDates: ['2026-06-01'],
        scope: 'global' as const,
        embedding: null,
      },
      {
        type: 'win' as any,
        content: 'Personalized outbound email templates got 25% reply rate',
        confidence: 0.95,
        sourceDates: ['2026-06-01'],
        scope: 'agent' as const, // agent-specific, should not save globally
        embedding: null,
      },
    ];

    // Clear global knowledge directories if they exist
    const globalKnowledgeDir = path.join(DATA_DIR, 'knowledge');
    if (fs.existsSync(globalKnowledgeDir)) {
      fs.rmSync(globalKnowledgeDir, { recursive: true, force: true });
    }

    // Run saveMemories
    distiller.saveMemories(agentId, 'cycle-1', candidates);

    // Check that lessons folder has 1 file (confidence 0.9, scope global)
    const lessonsDir = path.join(globalKnowledgeDir, 'lessons');
    expect(fs.existsSync(lessonsDir)).toBe(true);
    const lessonFiles = fs.readdirSync(lessonsDir);
    expect(lessonFiles.length).toBe(1);
    const lessonContent = fs.readFileSync(
      path.join(lessonsDir, lessonFiles[0]),
      'utf-8',
    );
    expect(lessonContent).toContain('Always implement rate limiting');

    // Check that patterns folder has 1 file (confidence 0.85, scope global)
    const patternsDir = path.join(globalKnowledgeDir, 'patterns');
    expect(fs.existsSync(patternsDir)).toBe(true);
    const patternFiles = fs.readdirSync(patternsDir);
    expect(patternFiles.length).toBe(1);
    const patternContent = fs.readFileSync(
      path.join(patternsDir, patternFiles[0]),
      'utf-8',
    );
    expect(patternContent).toContain('Cold Outreach Sequencing cadence');

    // Check that fixes folder does NOT exist or has 0 files (confidence 0.5 is < 0.8)
    const fixesDir = path.join(globalKnowledgeDir, 'fixes');
    if (fs.existsSync(fixesDir)) {
      const fixFiles = fs.readdirSync(fixesDir);
      expect(fixFiles.length).toBe(0);
    }
  });
});
