/**
 * Tool Definitions Registry
 * Static catalog of all tools available to agents, with metadata for the Tools tab UI.
 */

import type { AgentType } from '../stores/agentsStore';

export interface ToolDef {
  id: string;
  label: string;
  description: string;
  credential?: string;          // service name required (matches /api/credentials entries)
  agentTypes: AgentType[];      // which agent types can use this tool
}

export const TOOL_DEFS: ToolDef[] = [
  // ─── Outreach & Email ──────────────────────────────────────────────────────
  {
    id: 'email_send',
    label: 'Email Sender',
    description: 'Send personalized outreach emails via your connected SMTP/ESP.',
    credential: 'smtp',
    agentTypes: ['outreach', 'followup', 'custom'],
  },
  {
    id: 'email_tracker',
    label: 'Email Open Tracking',
    description: 'Track opens, clicks, and replies on outbound emails.',
    credential: 'smtp',
    agentTypes: ['outreach', 'followup', 'analytics', 'custom'],
  },

  // ─── Research & Analysis ───────────────────────────────────────────────────
  {
    id: 'web_scraper',
    label: 'Web Scraper',
    description: 'Scrape and extract structured data from public web pages.',
    agentTypes: ['lead_hunter', 'market_research', 'content', 'custom'],
  },
  {
    id: 'web_search',
    label: 'Web Search',
    description: 'Search the web for real-time information and news.',
    agentTypes: ['lead_hunter', 'market_research', 'content', 'analytics', 'custom'],
  },
  {
    id: 'competitor_monitor',
    label: 'Competitor Monitor',
    description: 'Track competitor websites, pricing pages, and product changes.',
    agentTypes: ['market_research', 'analytics', 'custom'],
  },

  // ─── CRM & Data ───────────────────────────────────────────────────────────
  {
    id: 'hubspot',
    label: 'HubSpot CRM',
    description: 'Create and update contacts, deals, and notes in HubSpot.',
    credential: 'hubspot',
    agentTypes: ['lead_hunter', 'outreach', 'followup', 'analytics', 'custom'],
  },
  {
    id: 'salesforce',
    label: 'Salesforce CRM',
    description: 'Sync leads, opportunities, and activities with Salesforce.',
    credential: 'salesforce',
    agentTypes: ['lead_hunter', 'outreach', 'followup', 'analytics', 'custom'],
  },
  {
    id: 'google_sheets',
    label: 'Google Sheets',
    description: 'Read from and write to Google Sheets for data tracking.',
    credential: 'google',
    agentTypes: ['lead_hunter', 'market_research', 'analytics', 'content', 'custom'],
  },

  // ─── Content & Writing ─────────────────────────────────────────────────────
  {
    id: 'content_writer',
    label: 'Content Writer',
    description: 'Generate blog posts, social copy, and marketing content.',
    agentTypes: ['content', 'outreach', 'custom'],
  },
  {
    id: 'seo_analyzer',
    label: 'SEO Analyzer',
    description: 'Analyze keyword rankings, on-page SEO, and organic traffic.',
    agentTypes: ['content', 'market_research', 'analytics', 'custom'],
  },

  // ─── Communication ─────────────────────────────────────────────────────────
  {
    id: 'slack_notify',
    label: 'Slack Notifications',
    description: 'Send messages and alerts to Slack channels.',
    credential: 'slack',
    agentTypes: ['lead_hunter', 'outreach', 'followup', 'market_research', 'analytics', 'content', 'custom'],
  },
  {
    id: 'whatsapp_notify',
    label: 'WhatsApp Notifications',
    description: 'Send check-in reports and alerts via WhatsApp.',
    agentTypes: ['lead_hunter', 'outreach', 'followup', 'market_research', 'analytics', 'content', 'custom'],
  },

  // ─── Analytics ─────────────────────────────────────────────────────────────
  {
    id: 'google_analytics',
    label: 'Google Analytics',
    description: 'Pull traffic, conversion, and attribution data from GA4.',
    credential: 'google',
    agentTypes: ['analytics', 'market_research', 'content', 'custom'],
  },
  {
    id: 'data_visualizer',
    label: 'Data Visualizer',
    description: 'Generate charts and dashboards from structured data.',
    agentTypes: ['analytics', 'market_research', 'custom'],
  },

  // ─── Scheduling & Calendar ─────────────────────────────────────────────────
  {
    id: 'calendar_booking',
    label: 'Calendar Booking',
    description: 'Schedule meetings and create calendar events automatically.',
    credential: 'google',
    agentTypes: ['outreach', 'followup', 'custom'],
  },

  // ─── Utility ───────────────────────────────────────────────────────────────
  {
    id: 'file_manager',
    label: 'File Manager',
    description: 'Read, write, and organize files in the agent workspace.',
    agentTypes: ['lead_hunter', 'outreach', 'followup', 'market_research', 'analytics', 'content', 'custom'],
  },
  {
    id: 'code_exec',
    label: 'Code Execution',
    description: 'Execute Python/JS scripts for data processing and automation.',
    agentTypes: ['analytics', 'market_research', 'custom'],
  },
];
