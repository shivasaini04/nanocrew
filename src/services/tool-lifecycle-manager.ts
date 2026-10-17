/**
 * Tool Lifecycle Manager — NanoCrew Service
 *
 * Manages tool lifecycle events (creation, update, deletion, health)
 * across all jobs and containers, and maintains a master inventory.
 */

import fs from 'fs';
import path from 'path';
import { logger } from '../logger.js';

// ─── Types ───────────────────────────────────────────────────────────

export type HealthStatus = 'healthy' | 'degraded' | 'failed';

export interface ToolSummary {
  name: string;
  version: string;
  description: string;
  jobId: string | null; // null = global
  status: HealthStatus;
  tags: string[];
  createdAt: string;
  lastUsed: string | null;
  usageCount: number;
}

export interface ToolEvent {
  type: 'tool_created' | 'tool_updated' | 'tool_deleted' | 'tool_tested';
  jobId: string | null;
  toolName: string;
  version: string;
  timestamp: string;
  manifest?: Record<string, any>;
  testResult?: Record<string, any>;
}

export interface CleanupPolicy {
  unusedDaysThreshold: number; // Flag tools unused for N days
  degradedHoursThreshold: number; // Flag degraded health for N hours
  archiveOnJobEnd: boolean; // true = archive, false = delete
}

// ─── Defaults ────────────────────────────────────────────────────────

const DEFAULT_CLEANUP_POLICY: CleanupPolicy = {
  unusedDaysThreshold: 30,
  degradedHoursThreshold: 24,
  archiveOnJobEnd: true,
};

// ─── Manager ─────────────────────────────────────────────────────────

export class ToolLifecycleManager {
  private inventory: Map<string, ToolSummary> = new Map();
  private eventLog: ToolEvent[] = [];
  private cleanupPolicy: CleanupPolicy;

  constructor(policy?: Partial<CleanupPolicy>) {
    this.cleanupPolicy = { ...DEFAULT_CLEANUP_POLICY, ...policy };
    logger.info('ToolLifecycleManager initialized');
  }

  // ─── Inventory key ──────────────────────────────────────────────

  private key(jobId: string | null, toolName: string): string {
    return `${jobId ?? 'global'}::${toolName}`;
  }

  // ─── Lifecycle handlers ─────────────────────────────────────────

  onToolCreated(event: ToolEvent): void {
    const summary: ToolSummary = {
      name: event.toolName,
      version: event.version,
      description: event.manifest?.description ?? '',
      jobId: event.jobId,
      status: 'healthy',
      tags: event.manifest?.tags ?? [],
      createdAt: event.timestamp,
      lastUsed: null,
      usageCount: 0,
    };
    this.inventory.set(this.key(event.jobId, event.toolName), summary);
    this.eventLog.push(event);
    logger.info(
      { toolName: event.toolName, jobId: event.jobId },
      'Tool created',
    );
  }

  onToolUpdated(event: ToolEvent): void {
    const k = this.key(event.jobId, event.toolName);
    const existing = this.inventory.get(k);
    if (existing) {
      existing.version = event.version;
      if (event.manifest?.description)
        existing.description = event.manifest.description;
      if (event.manifest?.tags) existing.tags = event.manifest.tags;
      existing.status = 'healthy'; // update resets health
    }
    this.eventLog.push(event);
    logger.info(
      { toolName: event.toolName, version: event.version },
      'Tool updated',
    );
  }

  onToolDeleted(event: ToolEvent): void {
    const k = this.key(event.jobId, event.toolName);
    this.inventory.delete(k);
    this.eventLog.push(event);
    logger.info(
      { toolName: event.toolName, jobId: event.jobId },
      'Tool deleted',
    );
  }

  onToolTested(event: ToolEvent): void {
    const k = this.key(event.jobId, event.toolName);
    const existing = this.inventory.get(k);
    if (existing && event.testResult) {
      const passed = event.testResult.passed ?? 0;
      const failed = event.testResult.failed ?? 0;
      existing.status = failed > 0 ? 'degraded' : 'healthy';
    }
    this.eventLog.push(event);
    logger.info({ toolName: event.toolName }, 'Tool tested');
  }

  onToolHealthChange(
    jobId: string | null,
    toolName: string,
    status: HealthStatus,
  ): void {
    const k = this.key(jobId, toolName);
    const existing = this.inventory.get(k);
    if (existing) {
      existing.status = status;
      logger.info({ toolName, status }, 'Tool health changed');
    }
  }

  // ─── Inventory queries ──────────────────────────────────────────

  listAll(): ToolSummary[] {
    return Array.from(this.inventory.values());
  }

  listForJob(jobId: string): ToolSummary[] {
    return this.listAll().filter((t) => t.jobId === jobId || t.jobId === null);
  }

  listGlobal(): ToolSummary[] {
    return this.listAll().filter((t) => t.jobId === null);
  }

  searchByTag(tag: string): ToolSummary[] {
    const lower = tag.toLowerCase();
    return this.listAll().filter((t) =>
      t.tags.some((tt) => tt.toLowerCase().includes(lower)),
    );
  }

  searchByName(query: string): ToolSummary[] {
    const lower = query.toLowerCase();
    return this.listAll().filter(
      (t) =>
        t.name.toLowerCase().includes(lower) ||
        t.description.toLowerCase().includes(lower),
    );
  }

  getEventLog(limit: number = 50): ToolEvent[] {
    return this.eventLog.slice(-limit);
  }

  // ─── Job cleanup ───────────────────────────────────────────────

  cleanupJobTools(jobId: string): { archived: string[]; deleted: string[] } {
    const result = { archived: [] as string[], deleted: [] as string[] };
    for (const [k, tool] of this.inventory.entries()) {
      if (tool.jobId === jobId) {
        if (this.cleanupPolicy.archiveOnJobEnd) {
          result.archived.push(tool.name);
        } else {
          result.deleted.push(tool.name);
        }
        this.inventory.delete(k);
      }
    }
    logger.info(
      {
        jobId,
        archived: result.archived.length,
        deleted: result.deleted.length,
      },
      'Job tools cleaned up',
    );
    return result;
  }

  // ─── Stale detection ───────────────────────────────────────────

  getStaleTools(): ToolSummary[] {
    const now = Date.now();
    const thresholdMs =
      this.cleanupPolicy.unusedDaysThreshold * 24 * 60 * 60 * 1000;
    return this.listAll().filter((t) => {
      if (!t.lastUsed) return true; // Never used
      const lastUsedMs = new Date(t.lastUsed).getTime();
      return now - lastUsedMs > thresholdMs;
    });
  }

  getDegradedTools(): ToolSummary[] {
    return this.listAll().filter(
      (t) => t.status === 'degraded' || t.status === 'failed',
    );
  }

  // ─── Promote job tool to global ─────────────────────────────────

  promoteToGlobal(jobId: string, toolName: string): boolean {
    const jobKey = this.key(jobId, toolName);
    const tool = this.inventory.get(jobKey);
    if (!tool) return false;

    const globalKey = this.key(null, toolName);
    if (this.inventory.has(globalKey)) {
      logger.warn({ toolName }, 'Global tool with same name already exists');
      return false;
    }

    // Move from job → global
    const promoted = { ...tool, jobId: null };
    this.inventory.set(globalKey, promoted);
    this.inventory.delete(jobKey);
    logger.info({ toolName, fromJob: jobId }, 'Tool promoted to global');
    return true;
  }
}
