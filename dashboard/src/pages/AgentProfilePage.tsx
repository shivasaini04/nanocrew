import {
  type CSSProperties,
  type ReactNode,
  useEffect,
  useState,
  useRef,
  useMemo,
  useCallback,
  memo,
} from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { useAgentsStore } from '../stores/agentsStore';
import { socket } from '../lib/socket';
import { ActivityDock } from '../components/ActivityDock';
import {
  ChatBubble,
  ArtifactCard,
  detectTurnArtifact,
  createProseComponents,
  type ActivityStep,
} from '../components/ChatBubble';
import {
  previewSchedule,
  classifySchedule,
  parseCron,
  parseIntervalToMinutes,
  INTERVAL_PRESETS,
  ZONED_CRON_PRESETS,
  TIMEZONE_CHOICES,
  browserTimeZone,
  fmtInZone,
  CYCLE_TYPE_INFO,
  SCHEDULABLE_TYPES,
} from '../lib/schedule-helpers';
import AgentBrowserPanel from '../components/AgentBrowserPanel';
import {
  useDesktopBrowserPanel,
  inDesktopApp,
} from '../hooks/useDesktopBrowserPanel';
import {
  useLiveBrowsersStore,
  isBrowserLive,
} from '../stores/liveBrowsersStore';
import { CR, withAlpha } from '../lib/cr';
import {
  BrowserLanePicker,
  useBrowserLane,
} from '../components/BrowserLanePicker';
import { QuestionCard } from '../components/QuestionCard';
import {
  AgentConversations,
  type Conversation,
} from '../components/AgentConversations';
import { getAgentStarters } from '../lib/api';
import {
  MODEL_OPTIONS,
  TASK_TYPE_LABELS,
  ACTIVE_TASK_TYPES,
  INACTIVE_TASK_TYPES,
} from '../lib/model-options';
import {
  Square,
  Pause,
  Play,
  Power,
  Settings2,
  Plus,
  ArrowUp,
  ImagePlus,
  FileText,
  FolderPlus,
  Folder,
  Package,
  Monitor,
} from 'lucide-react';
import { shouldSkipUploadPath } from '../lib/uploadFilter';
import UniversalDrawer from '../components/UniversalDrawer';
import { StreamingTurn } from '../components/StreamingTurn';
import { CycleTimeline } from '../components/CycleTimeline';
import { TurnFileChanges } from '../components/TurnFileChanges';
import { JsonViewer } from '../components/JsonViewer';
import HtmlPreview from '../components/HtmlPreview';
import { artifactViewPath } from '../components/ArtifactFrame';
import { useIsMobile } from '../hooks/useIsMobile';
import { useConversationEvents } from '../hooks/useConversationEvents';
import { buildTurns } from '../lib/conversation-turns';
import { ConversationView } from '../components/ConversationView';
import { FLAGS } from '../lib/flags';
import { Light as SyntaxHighlighter } from 'react-syntax-highlighter';
import { atomOneDark } from 'react-syntax-highlighter/dist/esm/styles/hljs';
import python from 'react-syntax-highlighter/dist/esm/languages/hljs/python';
import javascript from 'react-syntax-highlighter/dist/esm/languages/hljs/javascript';
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('javascript', javascript);

/**
 * Icon-only header action button (Stop cycle / Pause / Start / Stop / Manage). No filled
 * background at rest — just the icon, tinted with its semantic color, so meaning still reads
 * without a colored box. Same ghost-button treatment ThemeToggle uses: a neutral border, and
 * a light tint that only appears on hover/active.
 */
function headerIconBtn(color: string, active = false): CSSProperties {
  return {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 30,
    height: 30,
    borderRadius: 8,
    flexShrink: 0,
    cursor: 'pointer',
    background: active ? withAlpha(color, 13) : 'transparent',
    border: `1px solid ${active ? withAlpha(color, 30) : 'var(--cr-border)'}`,
    color,
    transition: 'color 0.15s, border-color 0.15s, background 0.15s',
  };
}
function headerIconBtnHover(
  e: React.MouseEvent<HTMLButtonElement>,
  color: string,
  on: boolean,
): void {
  e.currentTarget.style.background = on ? withAlpha(color, 13) : 'transparent';
  e.currentTarget.style.borderColor = on
    ? withAlpha(color, 30)
    : 'var(--cr-border)';
}

// ─── Local types ──────────────────────────────────────────────────────────────

interface AgentMemory {
  id: string;
  type: string;
  content: string;
  relevance: number;
  used_count: number;
  created_at: string;
}

interface AgentCheckin {
  id: string;
  agent_id: string;
  status: 'pending' | 'delivered' | 'responded';
  report_md?: string;
  user_reply?: string;
  created_at: string;
  responded_at?: string;
}

interface BudgetInfo {
  daily: { used: number; limit: number };
  monthly: { used: number; limit: number };
  onExhaust: string;
}

// ─── Settings Modal ───────────────────────────────────────────────────────────

function SettingsModal({
  agent,
  onClose,
  onSave,
  onDelete,
  inline = false,
}: {
  agent: any;
  onClose: () => void;
  onSave: (updates: any) => Promise<void>;
  onDelete: () => Promise<void>;
  inline?: boolean;
}) {
  const isMobile = useIsMobile();
  const [name, setName] = useState(agent.name);
  const [emoji, setEmoji] = useState(agent.emoji ?? '');
  const [goals, setGoals] = useState(agent.config.goals);
  const [icp, setIcp] = useState(agent.config.icp ?? '');
  const [dailyBudget, setDailyBudget] = useState(
    String(agent.config.budget?.daily ?? 1),
  );
  const [monthlyBudget, setMonthlyBudget] = useState(
    String(agent.config.budget?.monthly ?? 10),
  );
  const [onExhaust, setOnExhaust] = useState<'pause' | 'alert'>(
    agent.config.budget?.onExhaust ?? 'pause',
  );
  const [whatsappJid, setWhatsappJid] = useState(agent.whatsapp_jid ?? '');
  const [useUserBrowser, setUseUserBrowser] = useState(
    (agent.config as any)?.useUserBrowser === true,
  );
  const [requireUserBrowser, setRequireUserBrowser] = useState(
    (agent.config as any)?.requireUserBrowser === true,
  );
  const [saving, setSaving] = useState(false);
  const [deletePhase, setDeletePhase] = useState<'idle' | 'confirm'>('idle');
  const [deleteName, setDeleteName] = useState('');
  const [deleting, setDeleting] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await onSave({
        name,
        emoji: emoji || undefined,
        whatsapp_jid: whatsappJid.trim() || undefined,
        // Only the fields this form owns. The server merges config, and sending
        // the rest back from a copy loaded earlier reverted anything changed since
        // — most visibly a schedule the agent had just set for itself.
        config: {
          goals,
          icp: icp || undefined,
          budget: {
            daily: parseFloat(dailyBudget) || 1,
            monthly: parseFloat(monthlyBudget) || 10,
            onExhaust,
          },
          useUserBrowser,
          requireUserBrowser,
        },
      });
      onClose();
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (deleteName !== agent.name) return;
    setDeleting(true);
    try {
      await onDelete();
    } finally {
      setDeleting(false);
    }
  }

  const inp: CSSProperties = {
    width: '100%',
    background: CR.bgSurf,
    border: `1px solid ${CR.border}`,
    borderRadius: 8,
    padding: '9px 12px',
    color: CR.text,
    fontFamily: CR.sans,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
  };
  const label: CSSProperties = {
    fontFamily: CR.mono,
    fontSize: 9,
    color: CR.mutedBr,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    marginBottom: 6,
    display: 'block',
  };

  // `inline` renders the same form inside the Manage content pane (no modal backdrop);
  // the default keeps the centered-overlay modal for the /settings slash command.
  const wrapStyle: CSSProperties = inline
    ? { overflowY: 'auto', height: '100%', boxSizing: 'border-box' }
    : {
        position: 'fixed',
        inset: 0,
        background: 'var(--cr-scrim)',
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: isMobile ? 16 : 0,
        boxSizing: 'border-box',
      };
  const cardStyle: CSSProperties = inline
    ? { width: '100%', display: 'flex', flexDirection: 'column', gap: 20 }
    : {
        background: CR.bgCard,
        border: `1px solid ${CR.border}`,
        borderRadius: 14,
        width: isMobile ? '100%' : 480,
        maxWidth: '100%',
        maxHeight: '85vh',
        overflowY: 'auto',
        padding: isMobile ? 18 : 28,
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        boxSizing: 'border-box',
      };
  return (
    <div
      style={wrapStyle}
      onClick={
        inline
          ? undefined
          : (e) => {
              if (e.target === e.currentTarget) onClose();
            }
      }
    >
      <div style={cardStyle}>
        {!inline && (
          <div
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginBottom: 4,
            }}
          >
            <div
              style={{ fontFamily: CR.serif, fontSize: 20, color: CR.cream }}
            >
              Agent Settings
            </div>
            <button
              onClick={onClose}
              style={{
                background: 'none',
                border: 'none',
                color: CR.muted,
                cursor: 'pointer',
                fontSize: 18,
              }}
            >
              ✕
            </button>
          </div>
        )}

        <div style={{ display: 'flex', gap: 10 }}>
          <div style={{ flex: '0 0 80px' }}>
            <span style={label}>Emoji</span>
            <input
              value={emoji}
              onChange={(e) => setEmoji(e.target.value)}
              style={{ ...inp, textAlign: 'center', fontSize: 20 }}
              placeholder="🤖"
            />
          </div>
          <div style={{ flex: 1 }}>
            <span style={label}>Name</span>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              style={inp}
            />
          </div>
        </div>

        <div>
          <span style={label}>Mission / Goals</span>
          <textarea
            value={goals}
            onChange={(e) => setGoals(e.target.value)}
            rows={3}
            style={{ ...inp, resize: 'vertical', lineHeight: 1.6 }}
          />
        </div>

        <div>
          <span style={label}>ICP (Ideal Customer Profile)</span>
          <textarea
            value={icp}
            onChange={(e) => setIcp(e.target.value)}
            rows={2}
            style={{ ...inp, resize: 'vertical', lineHeight: 1.6 }}
          />
        </div>

        <div
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}
        >
          <div>
            <span style={label}>Daily Budget ($)</span>
            <input
              type="number"
              value={dailyBudget}
              onChange={(e) => setDailyBudget(e.target.value)}
              style={inp}
              min="0"
              step="0.01"
            />
          </div>
          <div>
            <span style={label}>Monthly Budget ($)</span>
            <input
              type="number"
              value={monthlyBudget}
              onChange={(e) => setMonthlyBudget(e.target.value)}
              style={inp}
              min="0"
              step="0.01"
            />
          </div>
        </div>

        <div>
          <span style={label}>On Budget Exhaust</span>
          <select
            value={onExhaust}
            onChange={(e) => setOnExhaust(e.target.value as 'pause' | 'alert')}
            style={{ ...inp, cursor: 'pointer' }}
          >
            <option value="pause">Pause agent</option>
            <option value="alert">Alert only</option>
          </select>
        </div>

        <div
          style={{
            fontFamily: CR.sans,
            fontSize: 11,
            color: CR.muted,
            padding: '8px 10px',
            borderRadius: 8,
            background: 'var(--cr-bg-surf)',
            border: '1px solid var(--cr-border)',
          }}
        >
          Model, subagent, and task-routing settings moved to the{' '}
          <strong style={{ color: CR.sub }}>Models</strong> tab.
        </div>

        <div>
          <span style={label}>Browser</span>
          <label
            style={{
              display: 'flex',
              gap: 8,
              alignItems: 'flex-start',
              cursor: 'pointer',
            }}
          >
            <input
              type="checkbox"
              checked={useUserBrowser}
              style={{ marginTop: 2 }}
              onChange={(e) => setUseUserBrowser(e.target.checked)}
            />
            <span
              style={{
                fontFamily: CR.sans,
                fontSize: 12,
                color: CR.sub,
                lineHeight: 1.5,
              }}
            >
              Work in <strong>my</strong> browser, in tabs I can see, using the
              sites I am already signed into — instead of the browser inside the
              container.
              <div style={{ color: CR.muted, fontSize: 11, marginTop: 4 }}>
                Needs the NanoCrew Bridge extension, or the companion, connected
                in that browser, and only the sites you allow there can be
                touched. If nothing is connected when a run starts, that run
                uses the container browser as usual.
              </div>
            </span>
          </label>

          {useUserBrowser && (
            <label
              style={{
                display: 'flex',
                gap: 8,
                alignItems: 'flex-start',
                cursor: 'pointer',
                marginTop: 10,
              }}
            >
              <input
                type="checkbox"
                checked={requireUserBrowser}
                style={{ marginTop: 2 }}
                onChange={(e) => setRequireUserBrowser(e.target.checked)}
              />
              <span
                style={{
                  fontFamily: CR.sans,
                  fontSize: 12,
                  color: CR.sub,
                  lineHeight: 1.5,
                }}
              >
                This work is <strong>impossible</strong> without my browser —
                wait rather than run without it.
                <div style={{ color: CR.muted, fontSize: 11, marginTop: 4 }}>
                  For jobs that need a signed-in session, like reading your
                  LinkedIn. Without this, a run with no browser connected falls
                  back to the container, hits a login wall and reports finding
                  nothing. With it, the run waits and starts the moment you
                  connect.
                </div>
              </span>
            </label>
          )}
        </div>

        <div>
          <span style={label}>WhatsApp Group JID</span>
          <input
            value={whatsappJid}
            onChange={(e) => setWhatsappJid(e.target.value)}
            style={inp}
            placeholder="120363298765432@g.us"
          />
          <div
            style={{
              fontFamily: CR.sans,
              fontSize: 11,
              color: CR.muted,
              marginTop: 4,
            }}
          >
            Messages to this WhatsApp group will be routed to this agent.
          </div>
        </div>

        <button
          onClick={handleSave}
          disabled={saving}
          style={{
            padding: '10px',
            borderRadius: 8,
            background: CR.accent,
            border: 'none',
            color: 'var(--cr-on-accent)',
            fontWeight: 700,
            fontSize: 13,
            cursor: 'pointer',
            opacity: saving ? 0.6 : 1,
            fontFamily: CR.sans,
          }}
        >
          {saving ? 'Saving…' : 'Save Changes'}
        </button>

        {/* Danger zone */}
        <div
          style={{
            padding: 14,
            border: '1px solid var(--cr-error-line)',
            borderRadius: 10,
            background: 'var(--cr-error-low)',
          }}
        >
          <div
            style={{
              fontFamily: CR.mono,
              fontSize: 9,
              color: 'var(--cr-error)',
              letterSpacing: '0.1em',
              marginBottom: 10,
            }}
          >
            DANGER ZONE
          </div>
          {(agent.config as any)?.protected ? (
            <div
              style={{
                fontFamily: CR.sans,
                fontSize: 12,
                color: CR.muted,
                lineHeight: 1.5,
              }}
            >
              🔒 {agent.name} is a built-in agent and can’t be fired — it’s how
              you hire every other specialist.
            </div>
          ) : deletePhase === 'idle' ? (
            <button
              onClick={() => setDeletePhase('confirm')}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                background: 'var(--cr-error-low)',
                border: '1px solid var(--cr-error-line)',
                color: 'var(--cr-error)',
                cursor: 'pointer',
                fontSize: 12,
                fontFamily: CR.sans,
              }}
            >
              Fire Agent
            </button>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <p
                style={{
                  fontFamily: CR.sans,
                  fontSize: 12,
                  color: CR.sub,
                  margin: 0,
                }}
              >
                Type <strong style={{ color: CR.cream }}>{agent.name}</strong>{' '}
                to confirm deletion:
              </p>
              <input
                value={deleteName}
                onChange={(e) => setDeleteName(e.target.value)}
                style={inp}
                placeholder={agent.name}
              />
              <div style={{ display: 'flex', gap: 8 }}>
                <button
                  onClick={handleDelete}
                  disabled={deleteName !== agent.name || deleting}
                  style={{
                    flex: 1,
                    padding: 8,
                    borderRadius: 8,
                    background:
                      deleteName === agent.name
                        ? 'var(--cr-error-str)'
                        : 'var(--cr-error-low)',
                    border: 'none',
                    color:
                      deleteName === agent.name
                        ? 'var(--cr-on-accent)'
                        : 'var(--cr-error)',
                    cursor:
                      deleteName === agent.name ? 'pointer' : 'not-allowed',
                    fontSize: 12,
                    fontWeight: 600,
                    fontFamily: CR.sans,
                  }}
                >
                  {deleting ? 'Deleting…' : 'Confirm Delete'}
                </button>
                <button
                  onClick={() => setDeletePhase('idle')}
                  style={{
                    padding: '8px 14px',
                    borderRadius: 8,
                    background: 'none',
                    border: `1px solid ${CR.border}`,
                    color: CR.sub,
                    cursor: 'pointer',
                    fontSize: 12,
                    fontFamily: CR.sans,
                  }}
                >
                  Cancel
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Models Tab ───────────────────────────────────────────────────────────────
// Split out of SettingsModal/General so model, subagent-delegation, and task-routing
// config get their own dedicated space instead of being buried in the general form.

function TaskModelRow({
  taskKey,
  label: taskLabel,
  value,
  onChange,
  muted,
  badge,
}: {
  taskKey: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
  muted?: boolean;
  badge?: string;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '8px 10px',
        borderRadius: 8,
        background: 'var(--cr-bg-surf)',
        border: '1px solid var(--cr-border)',
        opacity: muted ? 0.65 : 1,
      }}
    >
      <span
        style={{
          fontFamily: CR.sans,
          fontSize: 12,
          color: CR.cream,
          flex: 1,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        {taskLabel}
        {badge && (
          <span
            style={{
              fontFamily: CR.mono,
              fontSize: 9,
              letterSpacing: '0.05em',
              color: CR.muted,
              border: '1px solid var(--cr-border)',
              borderRadius: 4,
              padding: '1px 5px',
            }}
          >
            {badge}
          </span>
        )}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        data-task={taskKey}
        style={{
          fontFamily: CR.mono,
          fontSize: 11,
          background: 'var(--cr-bg-card)',
          border: '1px solid var(--cr-border)',
          color: CR.cream,
          borderRadius: 6,
          padding: '4px 8px',
          cursor: 'pointer',
        }}
      >
        <option value="">Inherit platform default</option>
        {MODEL_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label} — {o.price}
          </option>
        ))}
      </select>
    </div>
  );
}

function AgentModelsPanel({
  agent,
  agentId,
  updateAgent,
}: {
  agent: any;
  agentId: string;
  updateAgent: (id: string, patch: any) => Promise<any>;
}) {
  const [model, setModel] = useState(agent.config.model ?? '');
  const [subagentModel, setSubagentModel] = useState(
    agent.config.subagent_model ?? '',
  );
  const [thinkingEnabled, setThinkingEnabled] = useState<boolean | null>(
    agent.config.thinking_enabled ?? null,
  );
  const [taskModels, setTaskModels] = useState<Record<string, string>>(
    agent.config.task_models ?? {},
  );
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  function setTaskModel(task: string, value: string) {
    setTaskModels((t) => {
      const n = { ...t };
      if (value) n[task] = value;
      else delete n[task];
      return n;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      await updateAgent(agentId, {
        config: {
          model: model || undefined,
          subagent_model: subagentModel || undefined,
          thinking_enabled: thinkingEnabled,
          task_models:
            Object.keys(taskModels).length > 0 ? taskModels : undefined,
        },
      });
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } finally {
      setSaving(false);
    }
  }

  const inp: CSSProperties = {
    width: '100%',
    background: CR.bgSurf,
    border: `1px solid ${CR.border}`,
    borderRadius: 8,
    padding: '9px 12px',
    color: CR.text,
    fontFamily: CR.sans,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
  };
  const label: CSSProperties = {
    fontFamily: CR.mono,
    fontSize: 9,
    color: CR.mutedBr,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    marginBottom: 6,
    display: 'block',
  };
  const hint: CSSProperties = {
    fontFamily: CR.sans,
    fontSize: 11,
    color: CR.muted,
    marginTop: 4,
  };
  const sectionLabel: CSSProperties = { ...label, marginBottom: 2 };

  const knownTaskKeys = new Set([...ACTIVE_TASK_TYPES, ...INACTIVE_TASK_TYPES]);
  const otherTaskKeys = Object.keys(taskModels).filter(
    (k) => !knownTaskKeys.has(k),
  );

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 24,
        maxWidth: 640,
      }}
    >
      <div>
        <span style={label}>Primary Model</span>
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          style={{ ...inp, cursor: 'pointer' }}
        >
          <option value="">Inherit platform default</option>
          {MODEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label} — {o.price}
            </option>
          ))}
        </select>
        <div style={hint}>
          Hard override — used for this agent's primary turns. Leave blank to
          follow the platform default.
        </div>
      </div>

      <div>
        <span style={label}>Subagent Model</span>
        <select
          value={subagentModel}
          onChange={(e) => setSubagentModel(e.target.value)}
          style={{ ...inp, cursor: 'pointer' }}
        >
          <option value="">Same as primary model</option>
          {MODEL_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label} — {o.price}
            </option>
          ))}
        </select>
        <div style={hint}>
          Background subagents this agent spawns via the <code>spawn</code> tool
          (senior→junior delegation) run on this model instead of the primary
          one — useful for routing easy, high-volume sub-tasks to something
          cheap. Leave blank to match the primary model, the default for every
          agent.
        </div>
      </div>

      <div>
        <span style={label}>Thinking / Reasoning</span>
        <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
          {[
            { v: null as null, label: 'Inherit platform' },
            { v: true as boolean, label: 'ON' },
            { v: false as boolean, label: 'OFF' },
          ].map((opt) => (
            <button
              key={String(opt.v)}
              type="button"
              onClick={() => setThinkingEnabled(opt.v)}
              style={{
                flex: 1,
                padding: '8px 4px',
                borderRadius: 8,
                border: '1px solid var(--cr-border)',
                background:
                  thinkingEnabled === opt.v
                    ? 'var(--cr-accent-low)'
                    : 'var(--cr-bg-card)',
                color: thinkingEnabled === opt.v ? CR.accent : CR.sub,
                fontFamily: CR.mono,
                fontSize: 11,
                fontWeight: 700,
                cursor: 'pointer',
              }}
            >
              {opt.label}
            </button>
          ))}
        </div>
        <div style={hint}>
          Enables reasoning_content on models that support it. Adds cost &amp;
          latency.
        </div>
      </div>

      <div>
        <span style={sectionLabel}>Auxiliary Roles — Active</span>
        <div style={{ ...hint, marginTop: 0, marginBottom: 8 }}>
          These task types have a real consumer in the agent runtime today.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {ACTIVE_TASK_TYPES.map((task) => (
            <TaskModelRow
              key={task}
              taskKey={task}
              label={TASK_TYPE_LABELS[task] ?? task}
              value={taskModels[task] ?? ''}
              onChange={(v) => setTaskModel(task, v)}
            />
          ))}
        </div>
      </div>

      <div>
        <span style={sectionLabel}>Task Routing — Not Yet Active</span>
        <div style={{ ...hint, marginTop: 0, marginBottom: 8 }}>
          Config-only for now — nothing in the agent runtime reads these yet.
          Set them if you want to pre-configure for when routing is wired for
          these task types.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {INACTIVE_TASK_TYPES.map((task) => (
            <TaskModelRow
              key={task}
              taskKey={task}
              label={TASK_TYPE_LABELS[task] ?? task}
              value={taskModels[task] ?? ''}
              onChange={(v) => setTaskModel(task, v)}
              muted
              badge="Not active"
            />
          ))}
        </div>
      </div>

      {otherTaskKeys.length > 0 && (
        <div>
          <span style={sectionLabel}>Other</span>
          <div style={{ ...hint, marginTop: 0, marginBottom: 8 }}>
            Custom task keys set before this tab existed — not part of the known
            list above.
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {otherTaskKeys.map((task) => (
              <TaskModelRow
                key={task}
                taskKey={task}
                label={task}
                value={taskModels[task] ?? ''}
                onChange={(v) => setTaskModel(task, v)}
              />
            ))}
          </div>
        </div>
      )}

      <button
        onClick={handleSave}
        disabled={saving}
        style={{
          padding: '10px',
          borderRadius: 8,
          background: CR.accent,
          border: 'none',
          color: 'var(--cr-on-accent)',
          fontWeight: 700,
          fontSize: 13,
          cursor: 'pointer',
          opacity: saving ? 0.6 : 1,
          fontFamily: CR.sans,
        }}
      >
        {saving ? 'Saving…' : saved ? 'Saved ✓' : 'Save Changes'}
      </button>
    </div>
  );
}

// ─── Tools Tab ────────────────────────────────────────────────────────────────

interface DynamicTool {
  name: string;
  ext: 'py' | 'js';
  size: number;
  modifiedAt: string;
  code: string;
  label: string;
  description: string;
  status: 'untested' | 'ok' | 'error' | 'needs_credentials';
  complexity: 'simple' | 'complex';
  requiredCredentials: string[];
  generatedAt: string;
  lastTestedAt: string | null;
  lastTestOutput: string | null;
  lastTestError: string | null;
}

const STATUS_BADGE: Record<
  string,
  { bg: string; color: string; border: string; label: string }
> = {
  untested: {
    bg: 'var(--cr-tint-5)',
    color: 'var(--cr-sub)',
    border: 'var(--cr-line-str)',
    label: 'Untested',
  },
  ok: {
    bg: 'var(--cr-green-low)',
    color: 'var(--cr-green)',
    border: 'var(--cr-green-line)',
    label: 'OK',
  },
  error: {
    bg: 'var(--cr-error-low)',
    color: 'var(--cr-error)',
    border: 'var(--cr-error-line)',
    label: 'Error',
  },
  needs_credentials: {
    bg: 'var(--cr-amber-low)',
    color: 'var(--cr-warn)',
    border: 'var(--cr-amber-line)',
    label: 'Needs Creds',
  },
};

// ─── Create Handoff Modal ─────────────────────────────────────────────────────

const HANDOFF_TYPES: Array<{
  value: string;
  label: string;
  description: string;
}> = [
  {
    value: 'task',
    label: 'Task',
    description:
      'Generic work item — recipient does something and acknowledges.',
  },
  {
    value: 'review',
    label: 'Review',
    description:
      'Recipient inspects something the sender produced and reports back.',
  },
  {
    value: 'data',
    label: 'Data',
    description: 'Sender passes a dataset / file for the recipient to process.',
  },
  {
    value: 'approval',
    label: 'Approval',
    description: 'Recipient must approve or reject before sender continues.',
  },
  {
    value: 'request',
    label: 'Request',
    description: 'Sender asks the recipient to provide something.',
  },
];

function CreateHandoffModal({
  fromAgentId,
  fromAgentName,
  allAgents,
  onClose,
  onCreated,
}: {
  fromAgentId: string;
  fromAgentName: string;
  allAgents: Array<{ id: string; name: string; emoji?: string; type?: string }>;
  onClose: () => void;
  onCreated: () => void;
}) {
  const [toAgentId, setToAgentId] = useState('');
  const [type, setType] = useState('task');
  const [customType, setCustomType] = useState('');
  const [useCustomType, setUseCustomType] = useState(false);
  const [summary, setSummary] = useState('');
  const [taskInput, setTaskInput] = useState('');
  const [tasks, setTasks] = useState<string[]>([]);
  const [priority, setPriority] = useState<'low' | 'normal' | 'high'>('normal');
  const [note, setNote] = useState('');
  const [advanced, setAdvanced] = useState(false);
  const [rawPayload, setRawPayload] = useState('{}');
  const [rawError, setRawError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  // Dropdown open states
  const [agentDropdownOpen, setAgentDropdownOpen] = useState(false);
  const [typeDropdownOpen, setTypeDropdownOpen] = useState(false);
  const agentDropdownRef = useRef<HTMLDivElement>(null);
  const typeDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (
        agentDropdownRef.current &&
        !agentDropdownRef.current.contains(e.target as Node)
      )
        setAgentDropdownOpen(false);
      if (
        typeDropdownRef.current &&
        !typeDropdownRef.current.contains(e.target as Node)
      )
        setTypeDropdownOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  function addTask() {
    const t = taskInput.trim();
    if (!t || tasks.includes(t)) return;
    setTasks((prev) => [...prev, t]);
    setTaskInput('');
  }
  function removeTask(t: string) {
    setTasks((prev) => prev.filter((x) => x !== t));
  }

  const finalType = useCustomType ? customType.trim() : type;
  const toAgent = allAgents.find((a) => a.id === toAgentId);
  const canSubmit =
    toAgentId &&
    finalType &&
    (advanced ? rawPayload.trim() && !rawError : summary.trim().length > 0);

  async function handleSubmit() {
    if (!canSubmit || submitting) return;
    setSubmitting(true);
    setError('');

    let payload: unknown;
    if (advanced) {
      try {
        payload = JSON.parse(rawPayload);
      } catch (e: any) {
        setError('Invalid JSON: ' + e.message);
        setSubmitting(false);
        return;
      }
    } else {
      payload = {
        summary: summary.trim(),
        tasks,
        priority,
      };
    }

    try {
      const res = await fetch(`/api/agents/${fromAgentId}/handoffs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toAgentId,
          type: finalType,
          payload,
          note: note.trim() || undefined,
        }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || `HTTP ${res.status}`);
      }
      onCreated();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSubmitting(false);
    }
  }

  // Validate raw payload live
  useEffect(() => {
    if (!advanced) {
      setRawError('');
      return;
    }
    try {
      JSON.parse(rawPayload);
      setRawError('');
    } catch (e: any) {
      setRawError(e.message);
    }
  }, [rawPayload, advanced]);

  const labelStyle: CSSProperties = {
    fontFamily: CR.mono,
    fontSize: 9,
    color: CR.muted,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    fontWeight: 600,
    marginBottom: 6,
    display: 'block',
  };
  const inputStyle: CSSProperties = {
    width: '100%',
    padding: '9px 12px',
    borderRadius: 8,
    boxSizing: 'border-box',
    background: 'var(--cr-well)',
    border: `1px solid ${CR.border}`,
    color: CR.text,
    fontFamily: CR.sans,
    fontSize: 13,
    outline: 'none',
    transition: 'border 0.15s, box-shadow 0.15s',
  };
  const ChipC = 'var(--cr-purple)';

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--cr-scrim)',
        zIndex: 1000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        backdropFilter: 'blur(4px)',
      }}
      onClick={onClose}
    >
      <div
        style={{
          background:
            'linear-gradient(180deg, var(--cr-bg-card-hov) 0%, var(--cr-bg-card-hov) 100%)',
          border: `1px solid ${CR.borderBright}`,
          borderRadius: 16,
          width: '100%',
          maxWidth: 620,
          maxHeight: '90vh',
          boxShadow: `0 24px 64px var(--cr-shade-3), 0 0 0 1px ${withAlpha(ChipC, 8)}`,
          display: 'flex',
          flexDirection: 'column',
          overflow: 'visible',
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 24px 14px',
            borderBottom: `1px solid ${CR.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            background: `linear-gradient(135deg, ${withAlpha(ChipC, 6)}, transparent 60%)`,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: 11,
              background: `${withAlpha(ChipC, 9)}`,
              border: `1px solid ${withAlpha(ChipC, 25)}`,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
            }}
          >
            ↗
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontFamily: CR.mono,
                fontSize: 9,
                color: ChipC,
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                fontWeight: 700,
              }}
            >
              New Handoff
            </div>
            <div
              style={{ fontFamily: CR.serif, fontSize: 18, color: CR.cream }}
            >
              From <strong>{fromAgentName}</strong> to another agent
            </div>
          </div>
          <button
            onClick={onClose}
            style={{
              background: 'var(--cr-tint-3)',
              border: `1px solid ${CR.border}`,
              color: CR.muted,
              cursor: 'pointer',
              width: 28,
              height: 28,
              borderRadius: 8,
              fontSize: 14,
            }}
          >
            ✕
          </button>
        </div>

        {/* Body (scrollable inner area, dropdown popovers can escape) */}
        <div
          style={{
            padding: '18px 24px',
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            overflow: 'visible',
          }}
        >
          {/* To Agent */}
          <div ref={agentDropdownRef} style={{ position: 'relative' }}>
            <label style={labelStyle}>Target agent *</label>
            <button
              onClick={() => setAgentDropdownOpen((o) => !o)}
              style={{
                ...inputStyle,
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                cursor: 'pointer',
                color: toAgent ? CR.cream : CR.muted,
                textAlign: 'left',
              }}
            >
              {toAgent ? (
                <>
                  <span style={{ fontSize: 14 }}>{toAgent.emoji ?? '🤖'}</span>
                  <span style={{ flex: 1 }}>{toAgent.name}</span>
                  {toAgent.type && (
                    <span
                      style={{
                        fontFamily: CR.mono,
                        fontSize: 10,
                        color: CR.muted,
                      }}
                    >
                      {toAgent.type}
                    </span>
                  )}
                </>
              ) : (
                <span style={{ flex: 1 }}>Pick a target agent…</span>
              )}
              <span
                style={{ fontFamily: CR.mono, fontSize: 9, color: CR.muted }}
              >
                ▾
              </span>
            </button>
            {agentDropdownOpen && (
              <div
                style={{
                  position: 'absolute',
                  top: 'calc(100% + 4px)',
                  left: 0,
                  right: 0,
                  zIndex: 50,
                  background: CR.bgCard,
                  border: `1px solid ${CR.borderBright}`,
                  borderRadius: 10,
                  padding: 6,
                  maxHeight: 220,
                  overflowY: 'auto',
                  boxShadow: '0 8px 24px var(--cr-shade-3)',
                }}
              >
                {allAgents.length === 0 ? (
                  <div
                    style={{
                      padding: 10,
                      fontFamily: CR.sans,
                      fontSize: 12,
                      color: CR.muted,
                    }}
                  >
                    No other agents available.
                  </div>
                ) : (
                  allAgents.map((a) => (
                    <button
                      key={a.id}
                      onClick={() => {
                        setToAgentId(a.id);
                        setAgentDropdownOpen(false);
                      }}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        width: '100%',
                        padding: '8px 10px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        background:
                          a.id === toAgentId
                            ? `${withAlpha(ChipC, 8)}`
                            : 'transparent',
                        border: 'none',
                        textAlign: 'left',
                        color: CR.text,
                        fontFamily: CR.sans,
                        fontSize: 12.5,
                      }}
                    >
                      <span style={{ fontSize: 14 }}>{a.emoji ?? '🤖'}</span>
                      <span style={{ flex: 1 }}>{a.name}</span>
                      {a.type && (
                        <span
                          style={{
                            fontFamily: CR.mono,
                            fontSize: 10,
                            color: CR.muted,
                          }}
                        >
                          {a.type}
                        </span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          {/* Handoff Type */}
          <div ref={typeDropdownRef} style={{ position: 'relative' }}>
            <label style={labelStyle}>Handoff type *</label>
            {useCustomType ? (
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  type="text"
                  placeholder="custom-type"
                  value={customType}
                  onChange={(e) => setCustomType(e.target.value)}
                  style={{ ...inputStyle, flex: 1, fontFamily: CR.mono }}
                />
                <button
                  onClick={() => setUseCustomType(false)}
                  style={{
                    padding: '8px 12px',
                    borderRadius: 8,
                    background: 'var(--cr-tint-3)',
                    border: `1px solid ${CR.border}`,
                    color: CR.sub,
                    fontFamily: CR.sans,
                    fontSize: 11,
                    cursor: 'pointer',
                  }}
                >
                  Use preset
                </button>
              </div>
            ) : (
              <>
                <button
                  onClick={() => setTypeDropdownOpen((o) => !o)}
                  style={{
                    ...inputStyle,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    cursor: 'pointer',
                    textAlign: 'left',
                  }}
                >
                  <span
                    style={{
                      fontFamily: CR.mono,
                      fontSize: 11,
                      color: ChipC,
                      background: `${withAlpha(ChipC, 8)}`,
                      padding: '2px 8px',
                      borderRadius: 4,
                    }}
                  >
                    {type}
                  </span>
                  <span style={{ flex: 1, fontSize: 12, color: CR.sub }}>
                    {HANDOFF_TYPES.find((t) => t.value === type)?.description}
                  </span>
                  <span
                    style={{
                      fontFamily: CR.mono,
                      fontSize: 9,
                      color: CR.muted,
                    }}
                  >
                    ▾
                  </span>
                </button>
                {typeDropdownOpen && (
                  <div
                    style={{
                      position: 'absolute',
                      top: 'calc(100% + 4px)',
                      left: 0,
                      right: 0,
                      zIndex: 50,
                      background: CR.bgCard,
                      border: `1px solid ${CR.borderBright}`,
                      borderRadius: 10,
                      padding: 6,
                      maxHeight: 280,
                      overflowY: 'auto',
                      boxShadow: '0 8px 24px var(--cr-shade-3)',
                    }}
                  >
                    {HANDOFF_TYPES.map((opt) => (
                      <button
                        key={opt.value}
                        onClick={() => {
                          setType(opt.value);
                          setTypeDropdownOpen(false);
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          padding: '10px 12px',
                          borderRadius: 6,
                          cursor: 'pointer',
                          background:
                            opt.value === type
                              ? `${withAlpha(ChipC, 8)}`
                              : 'transparent',
                          border: 'none',
                          textAlign: 'left',
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            marginBottom: 3,
                          }}
                        >
                          <span
                            style={{
                              fontFamily: CR.mono,
                              fontSize: 11,
                              color: ChipC,
                            }}
                          >
                            {opt.value}
                          </span>
                          <span
                            style={{
                              fontFamily: CR.sans,
                              fontSize: 13,
                              color: CR.cream,
                            }}
                          >
                            {opt.label}
                          </span>
                        </div>
                        <div
                          style={{
                            fontFamily: CR.sans,
                            fontSize: 11,
                            color: CR.muted,
                            lineHeight: 1.4,
                          }}
                        >
                          {opt.description}
                        </div>
                      </button>
                    ))}
                    <button
                      onClick={() => {
                        setUseCustomType(true);
                        setTypeDropdownOpen(false);
                      }}
                      style={{
                        display: 'block',
                        width: '100%',
                        padding: '10px 12px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        background: 'transparent',
                        border: 'none',
                        textAlign: 'left',
                        borderTop: `1px solid ${CR.border}`,
                        marginTop: 4,
                        fontFamily: CR.mono,
                        fontSize: 11,
                        color: CR.muted,
                      }}
                    >
                      + Custom type…
                    </button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Payload — simple mode (default) */}
          {!advanced && (
            <>
              <div>
                <label style={labelStyle}>Summary *</label>
                <input
                  type="text"
                  value={summary}
                  onChange={(e) => setSummary(e.target.value)}
                  placeholder="One-line description of what you want them to do"
                  style={inputStyle}
                />
              </div>

              <div>
                <label style={labelStyle}>Tasks (optional)</label>
                <div
                  style={{
                    display: 'flex',
                    gap: 8,
                    marginBottom: tasks.length > 0 ? 8 : 0,
                  }}
                >
                  <input
                    type="text"
                    value={taskInput}
                    onChange={(e) => setTaskInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        addTask();
                      }
                    }}
                    placeholder="Add a task and press Enter"
                    style={{ ...inputStyle, flex: 1 }}
                  />
                  <button
                    onClick={addTask}
                    disabled={!taskInput.trim()}
                    style={{
                      padding: '8px 16px',
                      borderRadius: 8,
                      cursor: taskInput.trim() ? 'pointer' : 'default',
                      background: taskInput.trim()
                        ? `${withAlpha(ChipC, 13)}`
                        : 'var(--cr-tint-3)',
                      border: `1px solid ${taskInput.trim() ? `${withAlpha(ChipC, 25)}` : CR.border}`,
                      color: taskInput.trim() ? ChipC : CR.muted,
                      fontFamily: CR.sans,
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    Add
                  </button>
                </div>
                {tasks.length > 0 && (
                  <div
                    style={{ display: 'flex', flexDirection: 'column', gap: 4 }}
                  >
                    {tasks.map((t, i) => (
                      <div
                        key={i}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '6px 10px',
                          background: 'var(--cr-purple-low)',
                          border: `1px solid ${withAlpha(ChipC, 15)}`,
                          borderRadius: 6,
                        }}
                      >
                        <span
                          style={{
                            fontFamily: CR.mono,
                            fontSize: 9,
                            color: ChipC,
                            minWidth: 16,
                          }}
                        >
                          {i + 1}.
                        </span>
                        <span
                          style={{
                            flex: 1,
                            fontFamily: CR.sans,
                            fontSize: 12.5,
                            color: CR.text,
                          }}
                        >
                          {t}
                        </span>
                        <button
                          onClick={() => removeTask(t)}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: CR.muted,
                            cursor: 'pointer',
                            fontSize: 12,
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div>
                <label style={labelStyle}>Priority</label>
                <div style={{ display: 'flex', gap: 6 }}>
                  {(['low', 'normal', 'high'] as const).map((p) => {
                    const c =
                      p === 'high'
                        ? 'var(--cr-error)'
                        : p === 'normal'
                          ? CR.accent
                          : CR.muted;
                    return (
                      <button
                        key={p}
                        onClick={() => setPriority(p)}
                        style={{
                          flex: 1,
                          padding: '7px 12px',
                          borderRadius: 8,
                          background:
                            priority === p
                              ? `${withAlpha(c, 8)}`
                              : 'var(--cr-tint-2)',
                          border: `1px solid ${priority === p ? `${withAlpha(c, 31)}` : CR.border}`,
                          color: priority === p ? c : CR.muted,
                          fontFamily: CR.sans,
                          fontSize: 12,
                          cursor: 'pointer',
                          textTransform: 'capitalize',
                          fontWeight: priority === p ? 600 : 400,
                        }}
                      >
                        {p}
                      </button>
                    );
                  })}
                </div>
              </div>
            </>
          )}

          {/* Payload — advanced mode (raw JSON) */}
          {advanced && (
            <div>
              <label style={labelStyle}>Payload (raw JSON)</label>
              <textarea
                value={rawPayload}
                onChange={(e) => setRawPayload(e.target.value)}
                style={{
                  ...inputStyle,
                  minHeight: 120,
                  fontFamily: CR.mono,
                  fontSize: 12,
                  lineHeight: 1.6,
                  resize: 'vertical',
                }}
              />
              {rawError && (
                <div
                  style={{
                    fontFamily: CR.mono,
                    fontSize: 10,
                    color: 'var(--cr-error)',
                    marginTop: 6,
                  }}
                >
                  ⚠ {rawError}
                </div>
              )}
            </div>
          )}

          {/* Note (always shown, optional) */}
          <div>
            <label style={labelStyle}>Note (optional)</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Short context — shown to the recipient before they accept"
              style={inputStyle}
            />
          </div>

          {/* Mode toggle */}
          <button
            onClick={() => setAdvanced((v) => !v)}
            style={{
              alignSelf: 'flex-start',
              background: 'transparent',
              border: `1px dashed ${CR.border}`,
              color: CR.muted,
              padding: '5px 12px',
              borderRadius: 100,
              cursor: 'pointer',
              fontFamily: CR.mono,
              fontSize: 10,
              letterSpacing: '0.05em',
            }}
          >
            {advanced ? '← Simple form' : 'Advanced: edit raw JSON payload →'}
          </button>

          {error && (
            <div
              style={{
                padding: '8px 12px',
                borderRadius: 6,
                background: 'var(--cr-error-low)',
                border: '1px solid var(--cr-error-line)',
                color: 'var(--cr-error)',
                fontFamily: CR.mono,
                fontSize: 11,
              }}
            >
              ⚠ {error}
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '14px 24px 18px',
            borderTop: `1px solid ${CR.border}`,
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            background: 'var(--cr-well)',
          }}
        >
          <span
            style={{
              flex: 1,
              fontFamily: CR.mono,
              fontSize: 10,
              color: CR.muted,
            }}
          >
            Recipient will see a <strong>pending</strong> handoff and auto-fire
            a cycle to process it.
          </span>
          <button
            onClick={onClose}
            style={{
              padding: '8px 18px',
              borderRadius: 8,
              background: 'var(--cr-tint-3)',
              border: `1px solid ${CR.border}`,
              color: CR.sub,
              fontFamily: CR.sans,
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={!canSubmit || submitting}
            style={{
              padding: '8px 20px',
              borderRadius: 8,
              cursor: canSubmit && !submitting ? 'pointer' : 'default',
              background: canSubmit
                ? `linear-gradient(135deg, ${ChipC}, var(--cr-purple))`
                : 'var(--cr-tint-4)',
              border: 'none',
              color: canSubmit ? 'var(--cr-on-accent)' : CR.muted,
              fontFamily: CR.sans,
              fontSize: 13,
              fontWeight: 600,
              boxShadow: canSubmit
                ? `0 4px 14px ${withAlpha(ChipC, 25)}`
                : 'none',
            }}
          >
            {submitting ? 'Sending…' : '↗ Send handoff'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Schedule Tab ──────────────────────────────────────────────────────────────

// Stage 59 — one policy for what starts an agent outside its own schedule. Mirrors
// WakeSource/DEFAULT_WAKE_POLICY in nanocrew-main/src/types.ts; kept as a plain literal
// here rather than imported since the dashboard doesn't share types with the orchestrator.
const WAKE_SOURCES: { id: string; label: string; desc: string }[] = [
  {
    id: 'handoff',
    label: 'Handoffs',
    desc: 'A request handoff from another agent (e.g. via handoff_to)',
  },
  {
    id: 'ask',
    label: 'Ask / wake',
    desc: 'Another agent calls ask_agent, or wakes this agent directly',
  },
  { id: 'webhook', label: 'Webhooks', desc: 'An inbound webhook event' },
  {
    id: 'pipeline',
    label: 'Pipelines',
    desc: "A pipeline rule chaining off another agent's cycle",
  },
  {
    id: 'swarm',
    label: 'Delegated runs',
    desc: 'A run this agent delegated to its workers has finished',
  },
  {
    id: 'job',
    label: 'Background runs',
    desc: 'A background run started with /job has finished',
  },
  {
    id: 'recovery',
    label: 'Self-healing',
    desc: 'An automatic retry after a failed cycle',
  },
  {
    id: 'followup',
    label: 'Outreach follow-up',
    desc: 'The outreach follow-up timer (relevant to Mailer only)',
  },
];
const DEFAULT_WAKE_POLICY: Record<string, boolean> = Object.fromEntries(
  WAKE_SOURCES.map((s) => [s.id, true]),
);

type SchedEntry = {
  type: string;
  interval: string;
  enabled: boolean;
  project_id?: string;
  id?: string;
  name?: string;
  instruction?: string;
  timezone?: string;
};
type EntryBlock = 'disabled' | 'manual' | 'trigger_mode' | 'agent_not_running';
type TimerLive = SchedEntry & {
  id: string;
  blockedBy: EntryBlock | null;
  nextRunAt: string | null;
  lastRun: {
    at: string;
    status: string;
    cost: number;
    summary?: string;
  } | null;
  failStreak: number;
};
type ScheduleInfo = {
  status?: string;
  triggerMode?: string;
  schedule?: TimerLive[];
  avgRunCost?: number | null;
};

/** Which timer kind an entry is, for the per-entry picker. */
function timerKind(e: SchedEntry): 'interval' | 'cron' | 'none' {
  const k = classifySchedule(e.interval ?? 'manual');
  return k === 'manual' ? 'none' : k;
}

/** Why this draft entry can't be saved, or null. The server re-checks everything. */
function entryError(e: SchedEntry): string | null {
  const kind = timerKind(e);
  if ((e.instruction ?? '').length > 4000)
    return 'The instruction is too long (4000 characters max)';
  if ((e.name ?? '').length > 80)
    return 'The name is too long (80 characters max)';
  if (kind === 'none') return null;
  if (kind === 'cron') {
    const r = parseCron(e.interval);
    return 'error' in r && r.error ? r.error : null;
  }
  const mins = parseIntervalToMinutes(e.interval);
  if (mins === null) return 'Enter a duration like 15m, 1h, 24h or 7d';
  if (mins < 5) return 'The shortest interval is 5m';
  return null;
}

/** Same rule as whyEntryWontFire on the server, minus the status half. */
function suppressedByTriggerMode(e: SchedEntry, triggerMode?: string): boolean {
  const onDemand =
    triggerMode === 'on_demand' || triggerMode === 'event_driven';
  return onDemand && e.type !== 'self_improve' && e.type !== 'checkin';
}

function wouldFire(e: SchedEntry, triggerMode?: string): boolean {
  return (
    e.enabled &&
    timerKind(e) !== 'none' &&
    !suppressedByTriggerMode(e, triggerMode)
  );
}

const TIMER_FIELDS = [
  'type',
  'interval',
  'enabled',
  'name',
  'instruction',
  'timezone',
] as const;
const sameEntry = (a?: SchedEntry, b?: SchedEntry) =>
  !!a &&
  !!b &&
  TIMER_FIELDS.every((k) =>
    k === 'enabled' ? !!a[k] === !!b[k] : (a[k] ?? '') === (b[k] ?? ''),
  );

/**
 * Next fires and runs/month for one timer, computed by the server with the scheduler's own
 * code — so what the page promises is what the scheduler will do, in the timer's zone.
 */
function TimerPreview({
  agentId,
  interval,
  timezone,
  enabled,
  avgRunCost,
  onRuns,
  showFires,
}: {
  agentId: string;
  interval: string;
  timezone: string;
  enabled: boolean;
  avgRunCost: number | null | undefined;
  onRuns: (n: number) => void;
  /** Off for repeat-every timers: they count from their last run, so from-now times would disagree with Next run. */
  showFires: boolean;
}) {
  const [data, setData] = useState<{
    nextFires: string[];
    runsPer30Days: number;
  } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      try {
        const r = await fetch(
          `/api/agents/${agentId}/schedule-preview?interval=${encodeURIComponent(interval)}&tz=${encodeURIComponent(timezone)}`,
        );
        const j = await r.json();
        if (!alive) return;
        if (!r.ok) {
          setErr(j.error ?? 'Preview failed');
          setData(null);
          onRuns(0);
          return;
        }
        setErr(null);
        setData(j);
        onRuns(enabled ? j.runsPer30Days : 0);
      } catch {
        if (alive) setErr('Preview unavailable');
      }
    }, 350);
    return () => {
      alive = false;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, interval, timezone, enabled]);

  if (err)
    return (
      <div
        style={{
          marginTop: 6,
          fontFamily: CR.sans,
          fontSize: 12,
          color: 'var(--cr-error)',
        }}
      >
        ⚠ {err}
      </div>
    );
  if (!data) return null;
  const viewerTz = browserTimeZone();
  const cost = avgRunCost ? data.runsPer30Days * avgRunCost : null;
  return (
    <div style={{ marginTop: 6 }}>
      {showFires && enabled && data.nextFires.length > 0 && (
        <div
          style={{
            fontFamily: CR.mono,
            fontSize: 11,
            color: CR.sub,
            lineHeight: 1.7,
          }}
        >
          {data.nextFires.slice(0, 3).map((iso) => {
            const d = new Date(iso);
            return (
              <div key={iso}>
                {fmtInZone(d, timezone)}
                {timezone !== viewerTz
                  ? `  ·  ${fmtInZone(d, viewerTz)} your time`
                  : ''}
              </div>
            );
          })}
        </div>
      )}
      <div
        style={{
          marginTop: 4,
          fontFamily: CR.sans,
          fontSize: 11,
          color: CR.muted,
        }}
      >
        ≈ {data.runsPer30Days} runs a month
        {cost !== null
          ? ` · about $${cost.toFixed(cost < 1 ? 2 : 0)} at this agent's usual cost per run`
          : ''}
      </div>
    </div>
  );
}

function ScheduleTab({
  agent,
  agentId,
  agColor,
  schedInfo,
  updateAgent,
  fetchAgentSchedule,
  startAgent,
}: {
  agent: any;
  agentId: string;
  agColor: string;
  schedInfo: ScheduleInfo | null;
  updateAgent: (id: string, patch: any) => Promise<any>;
  fetchAgentSchedule: (id: string) => void;
  startAgent: (id: string) => Promise<void>;
}) {
  const isMobile = useIsMobile();
  const CR2 = CR;

  // ── Draft vs saved ──────────────────────────────────────────────────────
  // The draft is the whole list, follows the saved config until you edit it, and says so
  // if the config moves underneath an edit (the agent can change it too).
  const saved: SchedEntry[] = agent.config.schedule ?? [];
  const savedKey = JSON.stringify(saved);
  const [draft, setDraft] = useState<SchedEntry[]>(saved);
  const [baseKey, setBaseKey] = useState(savedKey);
  const dirty = JSON.stringify(draft) !== baseKey;
  const movedUnderneath = dirty && savedKey !== baseKey;

  useEffect(() => {
    if (!dirty) {
      setDraft(saved);
      setBaseKey(savedKey);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedKey]);

  useEffect(() => {
    fetchAgentSchedule(agentId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, savedKey, agent.status, agent.config.triggerMode]);

  const triggerMode: string = agent.config.triggerMode ?? 'scheduled';
  // The settled status from the API, not agent.status: during a chat turn the raw
  // status reads 'running' on an agent that goes back to idle when the turn ends.
  const status: string = schedInfo?.status ?? agent.status;
  const onDemand =
    triggerMode === 'on_demand' || triggerMode === 'event_driven';

  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [savedHint, setSavedHint] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [runNote, setRunNote] = useState<Record<string, string>>({});
  const [runsByIndex, setRunsByIndex] = useState<Record<number, number>>({});

  const errors = draft.map(entryError);
  const invalid = errors.some(Boolean);
  const willSwitchOn =
    status === 'idle' && draft.some((e) => wouldFire(e, triggerMode));
  const monthlyRuns = draft.reduce(
    (sum, e, i) =>
      sum +
      (e.enabled && timerKind(e) !== 'none' && !errors[i]
        ? (runsByIndex[i] ?? 0)
        : 0),
    0,
  );
  const avgRunCost = schedInfo?.avgRunCost ?? null;

  function patchEntry(i: number, p: Partial<SchedEntry>) {
    setDraft((d) => d.map((e, j) => (j === i ? { ...e, ...p } : e)));
  }
  function setKind(i: number, kind: 'interval' | 'cron' | 'none') {
    const e = draft[i];
    if (kind === timerKind(e)) return;
    if (kind === 'none') patchEntry(i, { interval: 'manual', enabled: false });
    else if (kind === 'cron')
      patchEntry(i, {
        interval: '0 9 * * *',
        enabled: true,
        timezone: e.timezone ?? browserTimeZone(),
      });
    else patchEntry(i, { interval: '1h', enabled: true });
  }
  function addEntry() {
    setDraft((d) => [
      ...d,
      {
        type: 'work',
        name: '',
        instruction: '',
        interval: '0 9 * * *',
        timezone: browserTimeZone(),
        enabled: true,
      },
    ]);
  }

  async function handleSave() {
    setSaving(true);
    setSaveError(null);
    try {
      // Only `schedule` — the server merges config, so sending the rest of a
      // possibly-stale config would overwrite whatever changed since page load.
      await updateAgent(agentId, { config: { schedule: draft } });
      if (willSwitchOn) await startAgent(agentId);
      setBaseKey(JSON.stringify(draft));
      fetchAgentSchedule(agentId);
      setSavedHint(willSwitchOn ? 'Saved and switched on' : 'Saved');
      setTimeout(() => setSavedHint(null), 2500);
    } catch (err: any) {
      setSaveError(err?.message ?? 'Save failed');
    } finally {
      setSaving(false);
    }
  }

  async function handleSwitchOn() {
    setSwitching(true);
    try {
      await startAgent(agentId);
      fetchAgentSchedule(agentId);
    } finally {
      setSwitching(false);
    }
  }

  async function handleUseSchedule() {
    setSwitching(true);
    try {
      await updateAgent(agentId, { config: { triggerMode: 'scheduled' } });
      fetchAgentSchedule(agentId);
    } finally {
      setSwitching(false);
    }
  }

  async function handleRunNow(id: string) {
    setRunNote((n) => ({ ...n, [id]: 'Starting…' }));
    try {
      const r = await fetch(
        `/api/agents/${agentId}/schedule/${encodeURIComponent(id)}/run`,
        { method: 'POST' },
      );
      const j = await r.json().catch(() => ({}));
      setRunNote((n) => ({
        ...n,
        [id]: r.ok
          ? 'Started — follow it in the chat'
          : `⚠ ${j.error ?? 'Could not start'}`,
      }));
      setTimeout(() => {
        setRunNote((n) => {
          const { [id]: _drop, ...rest } = n;
          return rest;
        });
        fetchAgentSchedule(agentId);
      }, 6000);
    } catch {
      setRunNote((n) => ({ ...n, [id]: '⚠ Could not reach the server' }));
    }
  }

  // ── Stage 59 — wake policy ──────────────────────────────────────────────
  const savedWakePolicy: Record<string, boolean> = {
    ...DEFAULT_WAKE_POLICY,
    ...(agent.config.wakePolicy ?? {}),
  };
  const [wakePolicy, setWakePolicy] =
    useState<Record<string, boolean>>(savedWakePolicy);
  const [wakeSaving, setWakeSaving] = useState(false);
  const [wakeSavedHint, setWakeSavedHint] = useState(false);
  const wakeDirty = WAKE_SOURCES.some(
    (s) => wakePolicy[s.id] !== savedWakePolicy[s.id],
  );

  async function handleSaveWakePolicy() {
    setWakeSaving(true);
    try {
      // Just the wake policy. This used to send `...agent.config` back whole, which
      // quietly reverted any schedule change the agent had made since page load.
      await updateAgent(agentId, { config: { wakePolicy } });
      setWakeSavedHint(true);
      setTimeout(() => setWakeSavedHint(false), 2000);
    } catch (err) {
      console.error('Wake policy save error:', err);
    } finally {
      setWakeSaving(false);
    }
  }

  // ── Pieces ──────────────────────────────────────────────────────────────
  const inputStyle: CSSProperties = {
    width: '100%',
    background: CR2.bgSurf,
    border: `1px solid ${CR2.border}`,
    borderRadius: 8,
    padding: '8px 11px',
    color: CR2.text,
    fontFamily: CR2.mono,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
  };
  const label: CSSProperties = {
    fontFamily: CR2.mono,
    fontSize: 9,
    color: CR2.mutedBr ?? CR2.muted,
    letterSpacing: '0.1em',
    textTransform: 'uppercase',
    marginBottom: 6,
  };
  const chip = (active: boolean): CSSProperties => ({
    padding: '4px 10px',
    borderRadius: 6,
    fontSize: 11,
    cursor: 'pointer',
    border: `1px solid ${active ? withAlpha(agColor, 31) : CR2.border}`,
    background: active ? withAlpha(agColor, 8) : 'var(--cr-tint-1)',
    color: active ? agColor : CR2.sub,
    fontFamily: CR2.sans,
  });
  const primaryBtn = (enabled: boolean): CSSProperties => ({
    padding: '9px 20px',
    borderRadius: 10,
    fontFamily: CR2.sans,
    fontSize: 13,
    fontWeight: 600,
    background: enabled
      ? `linear-gradient(135deg, ${CR2.accent}, ${CR2.accentWarm})`
      : 'var(--cr-tint-4)',
    border: `1px solid ${enabled ? 'transparent' : CR2.border}`,
    color: enabled ? CR2.onAccent : CR2.muted,
    cursor: enabled ? 'pointer' : 'default',
  });
  const ghostBtn: CSSProperties = {
    padding: '7px 14px',
    borderRadius: 8,
    fontFamily: CR2.sans,
    fontSize: 12,
    fontWeight: 600,
    background: 'transparent',
    border: `1px solid ${CR2.border}`,
    color: CR2.sub,
    cursor: 'pointer',
  };
  const Toggle = ({
    on,
    onClick,
    title,
  }: {
    on: boolean;
    onClick: () => void;
    title: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-pressed={on}
      style={{
        width: 36,
        height: 20,
        borderRadius: 10,
        cursor: 'pointer',
        flexShrink: 0,
        padding: 0,
        background: on ? agColor : CR2.bgMain,
        border: `1px solid ${on ? agColor : CR2.border}`,
        position: 'relative',
        transition: 'all 0.2s',
      }}
    >
      <span
        style={{
          width: 14,
          height: 14,
          borderRadius: '50%',
          background: on ? 'var(--cr-cream)' : CR2.muted,
          position: 'absolute',
          top: 2,
          left: on ? 19 : 3,
          transition: 'left 0.2s',
        }}
      />
    </button>
  );

  const statusBanner = (() => {
    if (status === 'running')
      return {
        tone: 'green' as const,
        title: 'On',
        body: onDemand
          ? 'Switched on, but its trigger mode limits which timers fire — see below.'
          : 'Switched on. Every enabled timer below starts a run by itself.',
      };
    if (status === 'paused')
      return {
        tone: 'amber' as const,
        title: 'Paused',
        body:
          agent._pauseReason === 'budget_exceeded'
            ? 'Paused because it hit its daily budget. No timer fires until it is resumed.'
            : 'Paused. No timer fires until it is resumed.',
        action: 'Resume',
      };
    if (status === 'stopped')
      return {
        tone: 'amber' as const,
        title: 'Stopped',
        body: 'Stopped by you. No timer fires, and the agent cannot switch itself back on.',
        action: 'Start',
      };
    if (status === 'error')
      return {
        tone: 'amber' as const,
        title: 'Error',
        body: 'Its last run failed. Timers are not firing.',
        action: 'Switch on',
      };
    return {
      tone: 'amber' as const,
      title: 'Off',
      body: 'Switched off. Nothing below runs by itself — it only runs when you message it or press Run now.',
      action: 'Switch on',
    };
  })();
  const toneColor =
    statusBanner.tone === 'green' ? 'var(--cr-green)' : 'var(--cr-amber)';

  const liveFor = (e: SchedEntry) =>
    (e.id ? schedInfo?.schedule?.find((s) => s.id === e.id) : undefined) ??
    null;
  const savedFor = (e: SchedEntry) =>
    e.id ? saved.find((s) => s.id === e.id) : undefined;

  function entryStatus(e: SchedEntry): { text: string; color: string } {
    if (!sameEntry(e, savedFor(e)))
      return { text: 'Unsaved change', color: CR2.muted };
    const live = liveFor(e);
    if (!live) return { text: '', color: CR2.muted };
    const tz = e.timezone ?? 'UTC';
    switch (live.blockedBy) {
      case null:
        return live.nextRunAt
          ? {
              text: `Next run: ${fmtInZone(new Date(live.nextRunAt), tz)} (${tz})`,
              color: 'var(--cr-green)',
            }
          : { text: 'Will run', color: 'var(--cr-green)' };
      case 'agent_not_running':
        return {
          text: `Won't run — the agent is ${status === 'idle' ? 'switched off' : status}`,
          color: 'var(--cr-amber)',
        };
      case 'trigger_mode':
        return {
          text: "Won't run — trigger mode is on-demand",
          color: 'var(--cr-amber)',
        };
      case 'disabled':
        return { text: 'Off', color: CR2.muted };
      case 'manual':
        return {
          text: 'No timer — runs only when started by hand',
          color: CR2.muted,
        };
    }
    return { text: '', color: CR2.muted };
  }

  return (
    <div
      style={{
        padding: isMobile ? '18px 16px' : '28px 40px',
        opacity: saving ? 0.75 : 1,
      }}
    >
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginBottom: 16,
          padding: '14px 18px',
          background: CR2.bgSurf,
          border: `1px solid ${CR2.border}`,
          borderRadius: 12,
        }}
      >
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            background: 'var(--cr-blue-low)',
            border: '1px solid var(--cr-blue-line)',
            flexShrink: 0,
          }}
        >
          🕐
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: CR2.serif,
              fontSize: 16,
              color: CR2.cream,
              marginBottom: 2,
            }}
          >
            Schedule
          </div>
          <div
            style={{
              fontFamily: CR2.sans,
              fontSize: 11,
              color: CR2.muted,
              lineHeight: 1.5,
            }}
          >
            Timers that start this agent by themselves. Each timer is one job:
            when it runs, and what to do. For a timer to fire, the agent must be
            switched <b>on</b> and the timer enabled.
          </div>
        </div>
      </div>

      {/* On / off */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          padding: '12px 16px',
          marginBottom: 12,
          borderRadius: 10,
          background:
            statusBanner.tone === 'green'
              ? 'var(--cr-green-low)'
              : 'var(--cr-amber-low)',
          border: `1px solid ${statusBanner.tone === 'green' ? 'var(--cr-green-line)' : 'var(--cr-amber-line)'}`,
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: toneColor,
            flexShrink: 0,
          }}
        />
        <div style={{ flex: 1, minWidth: 200 }}>
          <div
            style={{
              fontFamily: CR2.sans,
              fontSize: 13,
              fontWeight: 700,
              color: toneColor,
            }}
          >
            Agent is {statusBanner.title.toLowerCase()}
          </div>
          <div
            style={{
              fontFamily: CR2.sans,
              fontSize: 12,
              color: CR2.sub,
              marginTop: 2,
            }}
          >
            {statusBanner.body}
          </div>
        </div>
        {'action' in statusBanner && statusBanner.action && (
          <button
            type="button"
            onClick={handleSwitchOn}
            disabled={switching}
            style={primaryBtn(!switching)}
          >
            {switching ? 'Switching on…' : `▶ ${statusBanner.action}`}
          </button>
        )}
      </div>

      {onDemand && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            padding: '12px 16px',
            marginBottom: 12,
            borderRadius: 10,
            background: 'var(--cr-amber-low)',
            border: '1px solid var(--cr-amber-line)',
          }}
        >
          <div
            style={{
              flex: 1,
              minWidth: 200,
              fontFamily: CR2.sans,
              fontSize: 12,
              color: CR2.sub,
            }}
          >
            <b style={{ color: 'var(--cr-amber)' }}>
              Trigger mode is {triggerMode.replace('_', '-')}.
            </b>{' '}
            Only Self-improve and Check-in timers fire; every other timer below
            is ignored.
          </div>
          <button
            type="button"
            onClick={handleUseSchedule}
            disabled={switching}
            style={ghostBtn}
          >
            Let all timers fire
          </button>
        </div>
      )}

      {movedUnderneath && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            flexWrap: 'wrap',
            padding: '12px 16px',
            marginBottom: 12,
            borderRadius: 10,
            background: 'var(--cr-amber-low)',
            border: '1px solid var(--cr-amber-line)',
          }}
        >
          <div
            style={{
              flex: 1,
              minWidth: 200,
              fontFamily: CR2.sans,
              fontSize: 12,
              color: CR2.sub,
            }}
          >
            The schedule was changed somewhere else (by the agent, or in another
            window) while you were editing. Saving now would replace that
            change.
          </div>
          <button
            type="button"
            onClick={() => {
              setDraft(saved);
              setBaseKey(savedKey);
            }}
            style={ghostBtn}
          >
            Load latest
          </button>
        </div>
      )}

      <div style={{ ...label, marginTop: 20, marginBottom: 8 }}>
        Timers · {draft.length}
      </div>

      {draft.length === 0 && (
        <div
          style={{
            padding: '16px 18px',
            borderRadius: 10,
            border: `1px dashed ${CR2.border}`,
            fontFamily: CR2.sans,
            fontSize: 12,
            color: CR2.muted,
            marginBottom: 12,
          }}
        >
          No timers. This agent only runs when you message it. Add one per job —
          e.g. "Hourly log", "9 AM report".
        </div>
      )}

      {draft.map((e, i) => {
        const kind = timerKind(e);
        const err = errors[i];
        const preview =
          kind === 'none' || err ? null : previewSchedule(e.interval, true);
        const st = entryStatus(e);
        const live = liveFor(e);
        const info = CYCLE_TYPE_INFO[e.type];
        const typeOptions = SCHEDULABLE_TYPES.includes(e.type)
          ? SCHEDULABLE_TYPES
          : [e.type, ...SCHEDULABLE_TYPES];
        const suppressed = suppressedByTriggerMode(e, triggerMode);
        const tz = e.timezone ?? 'UTC';
        const zones = TIMEZONE_CHOICES.includes(tz)
          ? TIMEZONE_CHOICES
          : [tz, ...TIMEZONE_CHOICES];
        const browserTz = browserTimeZone();
        const zoneOptions = zones.includes(browserTz)
          ? zones
          : [browserTz, ...zones];
        const isSaved = sameEntry(e, savedFor(e));
        return (
          <div
            key={e.id ?? `new-${i}`}
            style={{
              padding: '14px 16px',
              marginBottom: 10,
              borderRadius: 12,
              background: CR2.bgCard,
              border: `1px solid ${err || (live?.failStreak ?? 0) >= 3 ? 'var(--cr-error-line)' : CR2.border}`,
              opacity: e.enabled && kind !== 'none' ? 1 : 0.85,
            }}
          >
            {/* Row 1: name + on/off + actions */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <input
                type="text"
                value={e.name ?? ''}
                onChange={(ev) => patchEntry(i, { name: ev.target.value })}
                placeholder={
                  info && e.type !== 'work'
                    ? `${info.label} (unnamed)`
                    : 'Name this timer (e.g. "9 AM report")'
                }
                style={{
                  ...inputStyle,
                  flex: 1,
                  minWidth: 180,
                  fontFamily: CR2.sans,
                  fontWeight: 600,
                  padding: '6px 10px',
                }}
              />
              {kind !== 'none' && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span
                    style={{
                      fontFamily: CR2.mono,
                      fontSize: 10,
                      color: e.enabled ? CR2.sub : CR2.muted,
                    }}
                  >
                    {e.enabled ? 'Enabled' : 'Disabled'}
                  </span>
                  <Toggle
                    on={e.enabled}
                    onClick={() => patchEntry(i, { enabled: !e.enabled })}
                    title={
                      e.enabled ? 'Disable this timer' : 'Enable this timer'
                    }
                  />
                </div>
              )}
              {e.id && isSaved && (
                <button
                  type="button"
                  onClick={() => handleRunNow(e.id!)}
                  title="Run this timer's job once, right now"
                  style={{ ...ghostBtn, padding: '4px 9px', fontSize: 11 }}
                >
                  ▶ Run now
                </button>
              )}
              <button
                type="button"
                onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
                title="Remove this timer"
                style={{ ...ghostBtn, padding: '4px 9px', fontSize: 11 }}
              >
                Remove
              </button>
            </div>
            {e.id && runNote[e.id] && (
              <div
                style={{
                  marginTop: 6,
                  fontFamily: CR2.sans,
                  fontSize: 11,
                  color: runNote[e.id].startsWith('⚠')
                    ? 'var(--cr-error)'
                    : 'var(--cr-green)',
                }}
              >
                {runNote[e.id]}
              </div>
            )}

            {/* Row 2: what to do */}
            <div style={{ marginTop: 12 }}>
              <div style={label}>What to do when it fires</div>
              <textarea
                value={e.instruction ?? ''}
                onChange={(ev) =>
                  patchEntry(i, { instruction: ev.target.value })
                }
                rows={2}
                placeholder="e.g. Read the last hour of the log, add the new rows to report.xlsx, then message me the file."
                style={{
                  ...inputStyle,
                  fontFamily: CR2.sans,
                  fontSize: 12.5,
                  resize: 'vertical',
                  lineHeight: 1.5,
                }}
              />
              {!e.instruction?.trim() && kind !== 'none' && (
                <div
                  style={{
                    marginTop: 4,
                    fontFamily: CR2.sans,
                    fontSize: 10.5,
                    color: CR2.muted,
                  }}
                >
                  No instruction: the run is only told to do its general{' '}
                  {info?.label.toLowerCase() ?? e.type} work.
                </div>
              )}
            </div>

            {/* Row 3: when */}
            <div
              style={{
                display: 'flex',
                gap: 6,
                marginTop: 12,
                flexWrap: 'wrap',
                alignItems: 'center',
              }}
            >
              {[
                { id: 'cron' as const, label: 'At set times' },
                { id: 'interval' as const, label: 'Repeat every…' },
                { id: 'none' as const, label: 'No timer' },
              ].map((o) => (
                <button
                  key={o.id}
                  type="button"
                  onClick={() => setKind(i, o.id)}
                  style={chip(kind === o.id)}
                >
                  {o.label}
                </button>
              ))}
            </div>

            {kind === 'cron' && (
              <div style={{ marginTop: 10 }}>
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <div style={{ flex: 2, minWidth: 180 }}>
                    <div style={label}>Cron expression</div>
                    <input
                      type="text"
                      value={e.interval}
                      onChange={(ev) =>
                        patchEntry(i, { interval: ev.target.value })
                      }
                      placeholder="0 9 * * 1-5"
                      style={inputStyle}
                    />
                  </div>
                  <div style={{ flex: 1, minWidth: 160 }}>
                    <div style={label}>Time zone</div>
                    <select
                      value={tz}
                      onChange={(ev) =>
                        patchEntry(i, { timezone: ev.target.value })
                      }
                      style={{ ...inputStyle, fontFamily: CR2.sans }}
                    >
                      {zoneOptions.map((z) => (
                        <option key={z} value={z}>
                          {z}
                          {z === browserTz ? ' (yours)' : ''}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    marginTop: 8,
                  }}
                >
                  {ZONED_CRON_PRESETS.map((p) => (
                    <button
                      key={p.label}
                      type="button"
                      onClick={() =>
                        patchEntry(i, { interval: p.value, enabled: true })
                      }
                      style={chip(e.interval === p.value)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            {kind === 'interval' && (
              <div style={{ marginTop: 10 }}>
                <div style={label}>Every</div>
                <input
                  type="text"
                  value={e.interval}
                  onChange={(ev) =>
                    patchEntry(i, { interval: ev.target.value })
                  }
                  placeholder="15m, 1h, 24h, 7d"
                  style={inputStyle}
                />
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    gap: 6,
                    marginTop: 8,
                  }}
                >
                  {INTERVAL_PRESETS.map((p) => (
                    <button
                      key={p.value}
                      type="button"
                      onClick={() =>
                        patchEntry(i, { interval: p.value, enabled: true })
                      }
                      style={chip(e.interval === p.value)}
                    >
                      {p.label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Row 4: what this means */}
            <div
              style={{
                marginTop: 12,
                paddingTop: 10,
                borderTop: `1px solid ${CR2.border}`,
              }}
            >
              {err ? (
                <div
                  style={{
                    fontFamily: CR2.sans,
                    fontSize: 12,
                    color: 'var(--cr-error)',
                  }}
                >
                  ⚠ {err}
                </div>
              ) : kind === 'none' ? (
                <div
                  style={{
                    fontFamily: CR2.sans,
                    fontSize: 12,
                    color: CR2.muted,
                  }}
                >
                  No timer — this job only runs when started by hand.
                </div>
              ) : preview && 'description' in preview ? (
                <>
                  <div
                    style={{
                      fontFamily: CR2.serif,
                      fontSize: 15,
                      color: e.enabled ? agColor : CR2.muted,
                    }}
                  >
                    {preview.description}
                    {kind === 'cron'
                      ? ` (${tz})`
                      : ', counted from its last run'}
                  </div>
                  <TimerPreview
                    agentId={agentId}
                    interval={e.interval}
                    timezone={tz}
                    enabled={e.enabled}
                    showFires={kind === 'cron'}
                    avgRunCost={avgRunCost}
                    onRuns={(n) =>
                      setRunsByIndex((r) => (r[i] === n ? r : { ...r, [i]: n }))
                    }
                  />
                </>
              ) : null}
              {suppressed && e.enabled && kind !== 'none' && (
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: CR2.sans,
                    fontSize: 11,
                    color: 'var(--cr-amber)',
                  }}
                >
                  Ignored while trigger mode is on-demand.
                </div>
              )}
              {st.text && (
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: CR2.mono,
                    fontSize: 11,
                    color: st.color,
                  }}
                >
                  {st.text}
                </div>
              )}
              {isSaved && live?.lastRun && (
                <div
                  style={{
                    marginTop: 4,
                    fontFamily: CR2.mono,
                    fontSize: 11,
                    color:
                      live.lastRun.status === 'failed'
                        ? 'var(--cr-error)'
                        : CR2.sub,
                  }}
                >
                  Last run: {fmtInZone(new Date(live.lastRun.at), tz)} ·{' '}
                  {live.lastRun.status === 'completed'
                    ? '✓ done'
                    : live.lastRun.status === 'failed'
                      ? '✗ failed'
                      : live.lastRun.status}
                  {live.lastRun.cost
                    ? ` · $${live.lastRun.cost.toFixed(3)}`
                    : ''}
                </div>
              )}
              {isSaved && (live?.failStreak ?? 0) >= 3 && (
                <div
                  style={{
                    marginTop: 6,
                    fontFamily: CR2.sans,
                    fontSize: 11.5,
                    color: 'var(--cr-error)',
                  }}
                >
                  Failed its last {live!.failStreak} runs. It keeps firing (and
                  costing) until fixed or disabled.
                  {live!.lastRun?.summary
                    ? ` Last error: ${live!.lastRun.summary.slice(0, 200)}`
                    : ''}
                </div>
              )}
            </div>

            {/* Advanced: the run kind — only matters for Self-improve and Check-in */}
            <details style={{ marginTop: 10 }}>
              <summary
                style={{
                  cursor: 'pointer',
                  fontFamily: CR2.sans,
                  fontSize: 11,
                  color: CR2.muted,
                }}
              >
                Kind of run: {info?.label ?? e.type}
              </summary>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  marginTop: 8,
                  flexWrap: 'wrap',
                }}
              >
                <select
                  value={e.type}
                  onChange={(ev) => patchEntry(i, { type: ev.target.value })}
                  style={{
                    ...inputStyle,
                    width: 'auto',
                    minWidth: 150,
                    fontFamily: CR2.sans,
                    padding: '6px 10px',
                  }}
                >
                  {typeOptions.map((t) => (
                    <option key={t} value={t}>
                      {CYCLE_TYPE_INFO[t]?.label ?? t}
                    </option>
                  ))}
                </select>
                <span
                  style={{
                    fontFamily: CR2.sans,
                    fontSize: 11,
                    color: CR2.muted,
                    flex: 1,
                    minWidth: 160,
                  }}
                >
                  {info?.desc ?? ''}. Leave it on Work unless this timer is for
                  tidying memory (Self-improve) or a report into Check-ins
                  (Check-in).
                </span>
              </div>
            </details>
          </div>
        );
      })}

      <button
        type="button"
        onClick={addEntry}
        style={{ ...ghostBtn, marginBottom: 18, borderStyle: 'dashed' }}
      >
        + Add a timer
      </button>

      {monthlyRuns > 0 && (
        <div
          style={{
            marginBottom: 14,
            fontFamily: CR2.sans,
            fontSize: 12,
            color: CR2.sub,
          }}
        >
          All enabled timers together: <b>≈ {monthlyRuns} runs a month</b>
          {avgRunCost ? (
            <>
              {' '}
              · about{' '}
              <b>
                $
                {(monthlyRuns * avgRunCost).toFixed(
                  monthlyRuns * avgRunCost < 1 ? 2 : 0,
                )}
              </b>{' '}
              at ${avgRunCost.toFixed(3)} per run (this agent's recent average)
            </>
          ) : (
            ' · no cost history yet to estimate from'
          )}
          . The daily budget still caps real spend.
        </div>
      )}

      {/* Save */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          flexWrap: 'wrap',
          marginTop: 6,
        }}
      >
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || !dirty || invalid}
          style={primaryBtn(!saving && dirty && !invalid)}
        >
          {saving
            ? 'Saving…'
            : !dirty
              ? 'Saved'
              : willSwitchOn
                ? 'Save & switch on'
                : 'Save schedule'}
        </button>
        {dirty && (
          <button
            type="button"
            onClick={() => {
              setDraft(saved);
              setBaseKey(savedKey);
              setSaveError(null);
            }}
            style={ghostBtn}
          >
            Discard changes
          </button>
        )}
        {savedHint && (
          <span
            style={{
              fontFamily: CR2.mono,
              fontSize: 11,
              color: 'var(--cr-green)',
            }}
          >
            ✓ {savedHint}
          </span>
        )}
        {saveError && (
          <span
            style={{
              fontFamily: CR2.sans,
              fontSize: 12,
              color: 'var(--cr-error)',
            }}
          >
            ⚠ {saveError}
          </span>
        )}
      </div>
      {dirty && willSwitchOn && (
        <div
          style={{
            marginTop: 8,
            fontFamily: CR2.sans,
            fontSize: 11,
            color: CR2.muted,
          }}
        >
          The agent is switched off, so saving also switches it on — otherwise
          none of these timers would ever fire.
        </div>
      )}

      {/* Agent-side note */}
      <div
        style={{
          marginTop: 20,
          padding: '10px 14px',
          background: 'var(--cr-tint-1)',
          border: `1px dashed ${CR2.border}`,
          borderRadius: 8,
          fontFamily: CR2.sans,
          fontSize: 11,
          color: CR2.muted,
          lineHeight: 1.6,
        }}
      >
        The agent can change these timers itself — ask it in chat, e.g. "every
        hour update the log, at 9 AM make the xlsx and message me, and on
        weekends email me a summary". Its changes show up here as soon as
        they're saved, and each one is in the Audit tab with a one-click revert.
      </div>

      {/* ─── Wake Policy (stage 59) ─────────────────────────────────────── */}
      <div
        style={{
          marginTop: 32,
          paddingTop: 24,
          borderTop: `1px solid ${CR2.border}`,
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            marginBottom: 18,
            padding: '14px 18px',
            background: CR2.bgSurf,
            border: `1px solid ${CR2.border}`,
            borderRadius: 12,
          }}
        >
          <div
            style={{
              width: 38,
              height: 38,
              borderRadius: 10,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 18,
              background: 'var(--cr-purple-low)',
              border: '1px solid var(--cr-purple-line)',
              flexShrink: 0,
            }}
          >
            🔔
          </div>
          <div style={{ flex: 1 }}>
            <div
              style={{
                fontFamily: CR2.serif,
                fontSize: 16,
                color: CR2.cream,
                marginBottom: 2,
              }}
            >
              Wake policy
            </div>
            <div
              style={{ fontFamily: CR2.sans, fontSize: 11, color: CR2.muted }}
            >
              What, besides the schedule above, is allowed to start a cycle on
              this agent. A stopped agent ignores all of these — only you can
              restart it.
            </div>
          </div>
        </div>

        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            marginBottom: 18,
          }}
        >
          {WAKE_SOURCES.map((src) => {
            const on = wakePolicy[src.id] !== false;
            return (
              <div
                key={src.id}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 12,
                  padding: '10px 14px',
                  background: CR2.bgCard,
                  border: `1px solid ${CR2.border}`,
                  borderRadius: 10,
                }}
              >
                <div
                  onClick={() =>
                    setWakePolicy((p) => ({ ...p, [src.id]: !on }))
                  }
                  style={{
                    width: 34,
                    height: 18,
                    borderRadius: 9,
                    cursor: 'pointer',
                    flexShrink: 0,
                    background: on ? agColor : CR2.bgMain,
                    border: `1px solid ${on ? agColor : CR2.border}`,
                    position: 'relative',
                    transition: 'all 0.2s',
                  }}
                >
                  <div
                    style={{
                      width: 12,
                      height: 12,
                      borderRadius: '50%',
                      background: on ? 'var(--cr-cream)' : CR2.muted,
                      position: 'absolute',
                      top: 2,
                      left: on ? 19 : 3,
                      transition: 'left 0.2s',
                    }}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: CR2.sans,
                      fontSize: 12,
                      color: CR2.cream,
                      fontWeight: 600,
                    }}
                  >
                    {src.label}
                  </div>
                  <div
                    style={{
                      fontFamily: CR2.sans,
                      fontSize: 10.5,
                      color: CR2.muted,
                      marginTop: 1,
                    }}
                  >
                    {src.desc}
                  </div>
                </div>
                <span
                  style={{
                    fontFamily: CR2.mono,
                    fontSize: 9,
                    letterSpacing: '0.06em',
                    textTransform: 'uppercase',
                    color: on ? 'var(--cr-green)' : CR2.muted,
                    flexShrink: 0,
                  }}
                >
                  {on ? 'ON' : 'OFF'}
                </span>
              </div>
            );
          })}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <button
            onClick={handleSaveWakePolicy}
            disabled={wakeSaving || !wakeDirty}
            style={{
              padding: '10px 22px',
              borderRadius: 10,
              background:
                !wakeDirty || wakeSaving
                  ? 'var(--cr-tint-4)'
                  : `linear-gradient(135deg, ${CR2.accent}, ${CR2.accentWarm})`,
              border: `1px solid ${!wakeDirty || wakeSaving ? CR2.border : 'transparent'}`,
              color:
                !wakeDirty || wakeSaving ? CR2.muted : 'var(--cr-on-accent)',
              cursor: !wakeDirty || wakeSaving ? 'default' : 'pointer',
              fontFamily: CR2.sans,
              fontSize: 13,
              fontWeight: 600,
              boxShadow:
                !wakeDirty || wakeSaving
                  ? 'none'
                  : `0 4px 14px ${withAlpha(CR2.accent, 25)}`,
              transition: 'all 0.15s',
            }}
          >
            {wakeSaving ? 'Saving…' : wakeDirty ? 'Save wake policy' : 'Saved'}
          </button>
          {wakeSavedHint && (
            <span
              style={{
                fontFamily: CR2.mono,
                fontSize: 11,
                color: 'var(--cr-green)',
              }}
            >
              ✓ Saved
            </span>
          )}
          {wakeDirty && !wakeSavedHint && (
            <span
              style={{ fontFamily: CR2.mono, fontSize: 10, color: CR2.muted }}
            >
              Unsaved changes
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Approvals — the owner's standing answers to "may I do this without asking?" ──

type ApprovalRuleRow = {
  id: string;
  action: string;
  decision: 'auto' | 'ask';
  match?: { recipient?: string; site?: string };
  note?: string;
  createdBy: 'owner' | 'agent';
  createdAt: string;
};
type ApprovalActionInfo = {
  label: string;
  desc: string;
  scope: 'recipient' | 'site' | null;
};

function ApprovalsTab({
  agentId,
  agColor,
}: {
  agentId: string;
  agColor: string;
}) {
  const isMobile = useIsMobile();
  const [rules, setRules] = useState<ApprovalRuleRow[]>([]);
  const [actions, setActions] = useState<Record<string, ApprovalActionInfo>>(
    {},
  );
  const [recent, setRecent] = useState<
    Array<{
      id: string;
      at: string;
      actionType: string | null;
      rule: string;
      summary: string;
    }>
  >([]);
  const [ownerEmail, setOwnerEmail] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [adding, setAdding] = useState<string | null>(null);
  const [form, setForm] = useState<{
    decision: 'auto' | 'ask';
    scope: 'all' | 'owner' | 'custom';
    value: string;
  }>({ decision: 'auto', scope: 'all', value: '' });

  async function load() {
    try {
      const r = await fetch(`/api/agents/${agentId}/approvals`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Could not load approvals');
      setRules(j.rules ?? []);
      setActions(j.actions ?? {});
      setRecent(j.recentAutoApproved ?? []);
      setOwnerEmail(j.ownerEmail ?? null);
      setError(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void load();
    // The agent can change its own rules from chat; follow it.
    const onUpdated = ({ agentId: id }: { agentId: string }) => {
      if (id === agentId) void load();
    };
    socket.on('agent:updated', onUpdated);
    return () => {
      socket.off('agent:updated', onUpdated);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId]);

  async function save(next: ApprovalRuleRow[]) {
    setSaving(true);
    try {
      const r = await fetch(`/api/agents/${agentId}/approvals`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rules: next }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error ?? 'Save failed');
      setRules(j.rules ?? []);
      setError(null);
      setAdding(null);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  function addRule(action: string) {
    const info = actions[action];
    const match: ApprovalRuleRow['match'] = {};
    if (info?.scope === 'recipient' && form.scope === 'owner')
      match.recipient = 'owner';
    if (
      info?.scope === 'recipient' &&
      form.scope === 'custom' &&
      form.value.trim()
    )
      match.recipient = form.value.trim();
    if (info?.scope === 'site' && form.scope === 'custom' && form.value.trim())
      match.site = form.value.trim();
    const rule = {
      action,
      decision: form.decision,
      ...(Object.keys(match).length ? { match } : {}),
      createdBy: 'owner',
    } as ApprovalRuleRow;
    void save([...rules, rule]);
  }

  const describe = (r: ApprovalRuleRow) => {
    const scope = r.match?.recipient
      ? r.match.recipient === 'owner'
        ? `to you${ownerEmail ? ` (${ownerEmail})` : ''}`
        : `to ${r.match.recipient}`
      : r.match?.site
        ? `on ${r.match.site}`
        : 'always';
    return `${r.decision === 'auto' ? "Don't ask" : 'Always ask'} — ${scope}`;
  };

  const CR2 = CR;
  const card: CSSProperties = {
    padding: '14px 16px',
    marginBottom: 10,
    borderRadius: 12,
    background: CR2.bgCard,
    border: `1px solid ${CR2.border}`,
  };
  const chipBtn = (active: boolean): CSSProperties => ({
    padding: '4px 10px',
    borderRadius: 6,
    fontSize: 11,
    cursor: 'pointer',
    fontFamily: CR2.sans,
    border: `1px solid ${active ? withAlpha(agColor, 31) : CR2.border}`,
    background: active ? withAlpha(agColor, 8) : 'var(--cr-tint-1)',
    color: active ? agColor : CR2.sub,
  });
  const ghost: CSSProperties = {
    padding: '5px 12px',
    borderRadius: 8,
    fontFamily: CR2.sans,
    fontSize: 11.5,
    fontWeight: 600,
    background: 'transparent',
    border: `1px solid ${CR2.border}`,
    color: CR2.sub,
    cursor: 'pointer',
  };

  if (loading)
    return (
      <div style={{ padding: 40, fontFamily: CR2.sans, color: CR2.muted }}>
        Loading…
      </div>
    );

  return (
    <div
      style={{
        padding: isMobile ? '18px 16px' : '28px 40px',
        opacity: saving ? 0.75 : 1,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 14,
          marginBottom: 16,
          padding: '14px 18px',
          background: CR2.bgSurf,
          border: `1px solid ${CR2.border}`,
          borderRadius: 12,
        }}
      >
        <div
          style={{
            width: 38,
            height: 38,
            borderRadius: 10,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 18,
            background: 'var(--cr-purple-low)',
            border: '1px solid var(--cr-purple-line)',
            flexShrink: 0,
          }}
        >
          🛡️
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontFamily: CR2.serif,
              fontSize: 16,
              color: CR2.cream,
              marginBottom: 2,
            }}
          >
            Approval rules
          </div>
          <div
            style={{
              fontFamily: CR2.sans,
              fontSize: 11,
              color: CR2.muted,
              lineHeight: 1.5,
            }}
          >
            This agent asks you before doing anything below. Add a rule to stop
            asking — for all of that kind, or only for certain recipients or
            sites. You can also just tell the agent in chat, e.g. "don't ask me
            before emailing me".
          </div>
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 12,
            padding: '10px 14px',
            borderRadius: 8,
            background: 'var(--cr-error-low)',
            border: '1px solid var(--cr-error-line)',
            fontFamily: CR2.sans,
            fontSize: 12,
            color: 'var(--cr-error)',
          }}
        >
          ⚠ {error}
        </div>
      )}

      {Object.entries(actions).map(([action, info]) => {
        const mine = rules.filter((r) => r.action === action);
        const open = adding === action;
        return (
          <div key={action} style={card}>
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <div style={{ flex: 1, minWidth: 200 }}>
                <div
                  style={{
                    fontFamily: CR2.sans,
                    fontSize: 13,
                    fontWeight: 600,
                    color: CR2.cream,
                  }}
                >
                  {info.label}
                </div>
                <div
                  style={{
                    fontFamily: CR2.sans,
                    fontSize: 11,
                    color: CR2.muted,
                    marginTop: 2,
                  }}
                >
                  {info.desc}
                </div>
              </div>
              {mine.length === 0 && (
                <span
                  style={{
                    fontFamily: CR2.mono,
                    fontSize: 10,
                    color: CR2.muted,
                    alignSelf: 'center',
                  }}
                >
                  ASKS EVERY TIME
                </span>
              )}
              {!open && (
                <button
                  type="button"
                  style={ghost}
                  onClick={() => {
                    setAdding(action);
                    setForm({
                      decision: 'auto',
                      scope: info.scope === 'recipient' ? 'owner' : 'all',
                      value: '',
                    });
                  }}
                >
                  + Rule
                </button>
              )}
            </div>

            {mine.length > 0 && (
              <div
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 6,
                  marginTop: 10,
                }}
              >
                {mine.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      padding: '6px 10px',
                      borderRadius: 8,
                      background:
                        r.decision === 'auto'
                          ? 'var(--cr-green-low)'
                          : 'var(--cr-tint-3)',
                      border: `1px solid ${r.decision === 'auto' ? 'var(--cr-green-line)' : CR2.border}`,
                    }}
                  >
                    <span
                      style={{
                        fontFamily: CR2.sans,
                        fontSize: 12,
                        color:
                          r.decision === 'auto' ? 'var(--cr-green)' : CR2.text,
                        fontWeight: 600,
                      }}
                    >
                      {describe(r)}
                    </span>
                    {r.createdBy === 'agent' && (
                      <span
                        style={{
                          fontFamily: CR2.sans,
                          fontSize: 10.5,
                          color: CR2.muted,
                        }}
                      >
                        set by the agent from your chat
                      </span>
                    )}
                    <span style={{ flex: 1 }} />
                    <button
                      type="button"
                      style={{ ...ghost, padding: '2px 8px' }}
                      onClick={() =>
                        void save(rules.filter((x) => x.id !== r.id))
                      }
                      title="Remove this rule"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>
            )}

            {open && (
              <div
                style={{
                  marginTop: 12,
                  paddingTop: 10,
                  borderTop: `1px solid ${CR2.border}`,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    gap: 6,
                    flexWrap: 'wrap',
                    marginBottom: 8,
                  }}
                >
                  <button
                    type="button"
                    style={chipBtn(form.decision === 'auto')}
                    onClick={() => setForm((f) => ({ ...f, decision: 'auto' }))}
                  >
                    Don't ask
                  </button>
                  <button
                    type="button"
                    style={chipBtn(form.decision === 'ask')}
                    onClick={() => setForm((f) => ({ ...f, decision: 'ask' }))}
                  >
                    Always ask
                  </button>
                </div>
                {info.scope && (
                  <div
                    style={{
                      display: 'flex',
                      gap: 6,
                      flexWrap: 'wrap',
                      alignItems: 'center',
                      marginBottom: 8,
                    }}
                  >
                    <button
                      type="button"
                      style={chipBtn(form.scope === 'all')}
                      onClick={() => setForm((f) => ({ ...f, scope: 'all' }))}
                    >
                      {info.scope === 'recipient' ? 'Anyone' : 'Any site'}
                    </button>
                    {info.scope === 'recipient' && (
                      <button
                        type="button"
                        style={chipBtn(form.scope === 'owner')}
                        onClick={() =>
                          setForm((f) => ({ ...f, scope: 'owner' }))
                        }
                      >
                        Only to me{ownerEmail ? ` (${ownerEmail})` : ''}
                      </button>
                    )}
                    <button
                      type="button"
                      style={chipBtn(form.scope === 'custom')}
                      onClick={() =>
                        setForm((f) => ({ ...f, scope: 'custom' }))
                      }
                    >
                      {info.scope === 'recipient'
                        ? 'Specific address or domain'
                        : 'Only on a site'}
                    </button>
                    {form.scope === 'custom' && (
                      <input
                        value={form.value}
                        onChange={(e) =>
                          setForm((f) => ({ ...f, value: e.target.value }))
                        }
                        placeholder={
                          info.scope === 'recipient'
                            ? 'name@acme.com or @acme.com'
                            : 'linkedin.com'
                        }
                        style={{
                          background: CR2.bgSurf,
                          border: `1px solid ${CR2.border}`,
                          borderRadius: 8,
                          padding: '6px 10px',
                          color: CR2.text,
                          fontFamily: CR2.mono,
                          fontSize: 12,
                          minWidth: 200,
                        }}
                      />
                    )}
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    type="button"
                    disabled={
                      saving || (form.scope === 'custom' && !form.value.trim())
                    }
                    onClick={() => addRule(action)}
                    style={{
                      ...ghost,
                      background: `linear-gradient(135deg, ${CR2.accent}, ${CR2.accentWarm})`,
                      color: CR2.onAccent,
                      border: '1px solid transparent',
                    }}
                  >
                    Add rule
                  </button>
                  <button
                    type="button"
                    style={ghost}
                    onClick={() => setAdding(null)}
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>
        );
      })}

      <div style={{ marginTop: 18, ...card }}>
        <div
          style={{
            fontFamily: CR2.mono,
            fontSize: 9,
            color: CR2.mutedBr ?? CR2.muted,
            letterSpacing: '0.1em',
            textTransform: 'uppercase',
            marginBottom: 8,
          }}
        >
          Done without asking, recently
        </div>
        {recent.length === 0 ? (
          <div style={{ fontFamily: CR2.sans, fontSize: 12, color: CR2.muted }}>
            Nothing yet. Anything a rule lets through shows up here, and stays
            in Check-ins as a record.
          </div>
        ) : (
          recent.map((r) => (
            <div
              key={r.id}
              style={{
                padding: '6px 0',
                borderTop: `1px solid ${CR2.border}`,
                fontFamily: CR2.sans,
                fontSize: 12,
                color: CR2.sub,
              }}
            >
              <span
                style={{
                  fontFamily: CR2.mono,
                  fontSize: 10.5,
                  color: CR2.muted,
                }}
              >
                {new Date(r.at).toLocaleString()}
              </span>{' '}
              · {r.rule}
              {r.summary && (
                <div style={{ fontSize: 11, color: CR2.muted, marginTop: 2 }}>
                  {r.summary.replace(/[#*_]/g, '').slice(0, 160)}
                </div>
              )}
            </div>
          ))
        )}
      </div>

      <div
        style={{
          marginTop: 12,
          padding: '10px 14px',
          background: 'var(--cr-tint-1)',
          border: `1px dashed ${CR2.border}`,
          borderRadius: 8,
          fontFamily: CR2.sans,
          fontSize: 11,
          color: CR2.muted,
          lineHeight: 1.6,
        }}
      >
        The agent can stop asking only when you tell it to in a conversation
        with it — never on its own from a timer — and you get a notification
        each time. Two things always need you, whatever the rules say: giving it
        a secret (API key, password), and raising its own spending ceilings.
      </div>
    </div>
  );
}

interface InventoryTool {
  name: string;
  description: string;
  category: string;
  runtime: 'chat' | 'cycle' | 'both';
  source: 'builtin' | 'dynamic' | 'mcp';
  requiresSidecar?: boolean;
  requiresCredential?: string[];
  // Phase 5b — tool quality.
  tier?: 'sandbox' | 'sidecar';
  testStatus?: 'passed' | 'failed' | 'untested';
  health?: { status: string; successRate: number; totalCalls: number };
}
interface InventoryMcp {
  id: string;
  server: string;
  transport: string;
  enabled: boolean;
  scope: 'global' | 'agent-specific';
}
interface ToolInventory {
  summary: {
    total: number;
    chat: number;
    cycle: number;
    dynamic: number;
    mcpServers: number;
  };
  chat: InventoryTool[];
  cycle: InventoryTool[];
  dynamic: InventoryTool[];
  mcp: InventoryMcp[];
}

// ── Skills + the Stage 42 learning loop ──────────────────────────────────────
function fmtWhen(iso: string | null): string {
  if (!iso) return 'never';
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return '—';
  const delta = Math.floor((Date.now() - t) / 1000);
  if (delta < 60) return 'just now';
  if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
  if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
  return `${Math.floor(delta / 86400)}d ago`;
}

// `dir` is the on-disk name the provenance sidecar is keyed by; `name` is the
// display name from frontmatter. They differ often enough that anything joining
// against telemetry has to use `dir`.
interface SkillTelemetry {
  origin: string;
  agentCreated: boolean;
  createdAt: string | null;
  updatedAt: string | null;
  writeCount: number;
  usageCount: number;
  lastUsedAt: string | null;
  pinned: boolean;
  lifecycle: 'active' | 'stale' | 'archived';
  idleDays: number | null;
}
interface Skill {
  name: string;
  dir: string;
  description: string;
  category: string;
  always: boolean;
  /** Omitted by the list endpoint — fetched per skill when a card is expanded. */
  content?: string;
  updatedAt: string;
  source: 'authored' | 'builtin';
  telemetry?: SkillTelemetry;
}
interface SkillSummary {
  total: number;
  agentCreated: number;
  pinned: number;
  active: number;
  stale: number;
  archivedByLifecycle: number;
  archivedOnDisk: number;
  neverUsed: number;
  totalUses: number;
  ledgerEntries: number;
  lastMutationAt: string | null;
}
interface LedgerEntry {
  id: string;
  ts: string;
  actor: string;
  skill: string;
  path: string;
  action: string;
  before: string | null;
  after: string | null;
}

function ToolsTab({
  agentId,
  agColor,
  onImproveInChat,
}: {
  agentId: string;
  agColor: string;
  onImproveInChat: (toolName: string) => void;
}) {
  const navigate = useNavigate();
  const isMobile = useIsMobile();
  const [dynTools, setDynTools] = useState<DynamicTool[]>([]);
  const [dynLoading, setDynLoading] = useState(false);
  // Tools are authored/tested/fixed in chat via the tool factory (sandbox-verified +
  // versioned). The UI only inspects + hands off to chat — it never edits code directly.
  const [deletingName, setDeletingName] = useState<string | null>(null);

  const [inventory, setInventory] = useState<ToolInventory | null>(null);
  const [view, setView] = useState<
    'all' | 'chat' | 'cycle' | 'dynamic' | 'mcp'
  >('all');
  const [search, setSearch] = useState('');
  const [expandedCats, setExpandedCats] = useState<Record<string, boolean>>({});

  // Top-level sub-tab: tools (the inventory) vs skills (agent-authored SKILL.md docs).
  const [mainTab, setMainTab] = useState<'tools' | 'skills'>('tools');
  const [skills, setSkills] = useState<Skill[]>([]);
  const [skillSearch, setSkillSearch] = useState('');
  const [openSkillCats, setOpenSkillCats] = useState<Record<string, boolean>>(
    {},
  );
  const [skillsLoading, setSkillsLoading] = useState(false);
  const [openSkill, setOpenSkill] = useState<string | null>(null);
  // Stage 42 learning loop: what the agent has written, used and retired.
  const [skillSummary, setSkillSummary] = useState<SkillSummary | null>(null);
  const [skillArchived, setSkillArchived] = useState<string[]>([]);
  const [ledger, setLedger] = useState<LedgerEntry[]>([]);
  const [openLedgerId, setOpenLedgerId] = useState<string | null>(null);
  const [ledgerDetail, setLedgerDetail] = useState<
    Record<
      string,
      { beforeContent: string | null; afterContent: string | null }
    >
  >({});
  const [showHistory, setShowHistory] = useState(false);
  // Skill bodies arrive one at a time on expand. The list endpoint used to ship all
  // 203 built-in markdown files on every visit — 2.4MB to render names.
  const [skillBodies, setSkillBodies] = useState<Record<string, string>>({});

  useEffect(() => {
    fetch(`/api/agents/${agentId}/tools/inventory`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setInventory(d))
      .catch(() => {
        /* silent */
      });
  }, [agentId]);

  useEffect(() => {
    loadDynTools();
  }, [agentId]);
  useEffect(() => {
    if (mainTab === 'skills') loadSkills();
  }, [agentId, mainTab]);

  async function loadSkills() {
    setSkillsLoading(true);
    try {
      const r = await fetch(`/api/agents/${agentId}/skills`);
      if (r.ok) {
        const d = await r.json();
        setSkills(d.skills ?? []);
        setSkillSummary(d.summary ?? null);
        setSkillArchived(d.archived ?? []);
      }
      // The mutation history is a separate read of a separate file — a missing
      // or unreadable ledger must not blank out the skill list.
      const lr = await fetch(`/api/agents/${agentId}/skills/ledger?limit=100`);
      if (lr.ok) setLedger((await lr.json()).entries ?? []);
    } catch {
    } finally {
      setSkillsLoading(false);
    }
  }

  async function toggleSkill(key: string, dir: string) {
    if (openSkill === key) {
      setOpenSkill(null);
      return;
    }
    setOpenSkill(key);
    if (skillBodies[dir] !== undefined) return;
    try {
      const r = await fetch(
        `/api/agents/${agentId}/skills/${encodeURIComponent(dir)}/content`,
      );
      // An unreadable body shows as empty rather than spinning forever.
      const body = r.ok ? ((await r.json()).content ?? '') : '';
      setSkillBodies((p) => ({ ...p, [dir]: body }));
    } catch {
      setSkillBodies((p) => ({ ...p, [dir]: '' }));
    }
  }

  // Bodies are fetched per-entry rather than with the list: a ledger of 100 entries
  // would otherwise pull 200 skill revisions nobody asked to see.
  async function toggleLedgerEntry(id: string) {
    if (openLedgerId === id) {
      setOpenLedgerId(null);
      return;
    }
    setOpenLedgerId(id);
    if (ledgerDetail[id]) return;
    try {
      const r = await fetch(`/api/agents/${agentId}/skills/ledger/${id}`);
      if (r.ok) {
        const d = await r.json();
        setLedgerDetail((p) => ({
          ...p,
          [id]: {
            beforeContent: d.beforeContent,
            afterContent: d.afterContent,
          },
        }));
      }
    } catch {}
  }

  async function loadDynTools() {
    setDynLoading(true);
    try {
      const r = await fetch(`/api/agents/${agentId}/tools/dynamic`);
      if (r.ok) setDynTools((await r.json()).tools ?? []);
    } catch {
    } finally {
      setDynLoading(false);
    }
  }

  async function handleDelete(name: string) {
    setDeletingName(name);
    try {
      await fetch(`/api/agents/${agentId}/tools/dynamic/${name}`, {
        method: 'DELETE',
      });
      setDynTools((prev) => prev.filter((t) => t.name !== name));
    } catch {
    } finally {
      setDeletingName(null);
    }
  }

  const CR2 = CR;
  const inp: CSSProperties = {
    width: '100%',
    background: CR2.bgSurf,
    border: `1px solid ${CR2.border}`,
    borderRadius: 8,
    padding: '9px 12px',
    color: CR2.text,
    fontFamily: CR2.sans,
    fontSize: 13,
    outline: 'none',
    boxSizing: 'border-box',
  };

  // Section accent colors — runtime identity
  const CYCLE_C = 'var(--cr-purple)',
    DYN_C = 'var(--cr-green)',
    MCP_C = 'var(--cr-warn)';

  // Search filter
  const q = search.trim().toLowerCase();
  const matches = (text: string) => !q || text.toLowerCase().includes(q);

  const filteredCycle = (inventory?.cycle ?? []).filter((t) =>
    matches(`${t.name} ${t.description} ${t.category}`),
  );
  const filteredMcp = (inventory?.mcp ?? []).filter((s) =>
    matches(`${s.server} ${s.transport}`),
  );

  // Group cycle tools by category (post-filter)
  const cycleByCategory = filteredCycle.reduce(
    (acc, t) => {
      (acc[t.category] = acc[t.category] || []).push(t);
      return acc;
    },
    {} as Record<string, InventoryTool[]>,
  );
  // When searching, auto-expand all matched categories
  const autoExpand = q.length > 0;

  const showSection = (s: 'chat' | 'cycle' | 'dynamic' | 'mcp') =>
    view === 'all' || view === s;

  // Reusable tab button
  const TabBtn = ({
    id,
    label,
    color,
    count,
  }: {
    id: typeof view;
    label: string;
    color: string;
    count?: number;
  }) => {
    const active = view === id;
    return (
      <button
        onClick={() => setView(id)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 100,
          cursor: 'pointer',
          background: active ? `${withAlpha(color, 8)}` : 'transparent',
          border: `1px solid ${active ? `${withAlpha(color, 31)}` : CR2.border}`,
          color: active ? color : CR2.muted,
          fontFamily: CR2.mono,
          fontSize: 10,
          fontWeight: 700,
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
          transition: 'all 0.15s',
        }}
      >
        {id !== 'all' && (
          <span
            style={{
              width: 6,
              height: 6,
              borderRadius: '50%',
              background: color,
            }}
          />
        )}
        {label}
        {count !== undefined && (
          <span style={{ fontFamily: CR2.mono, fontSize: 10, opacity: 0.7 }}>
            {count}
          </span>
        )}
      </button>
    );
  };

  // Section header with colored left rule + accent badge
  const SectionHeader = ({
    color,
    title,
    badge,
    count,
    action,
  }: {
    color: string;
    title: string;
    badge: string;
    count: number;
    action?: React.ReactNode;
  }) => (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        marginBottom: 10,
        paddingLeft: 12,
        borderLeft: `2px solid ${color}`,
      }}
    >
      <span style={{ fontFamily: CR2.serif, fontSize: 17, color: CR2.cream }}>
        {title}
      </span>
      <span
        style={{ fontFamily: CR2.mono, fontSize: 11, color, fontWeight: 600 }}
      >
        {count}
      </span>
      <span
        style={{
          fontFamily: CR2.mono,
          fontSize: 9,
          color,
          background: `${withAlpha(color, 6)}`,
          border: `1px solid ${withAlpha(color, 15)}`,
          padding: '2px 8px',
          borderRadius: 100,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {badge}
      </span>
      <div style={{ flex: 1 }} />
      {action}
    </div>
  );

  return (
    <div style={{ padding: isMobile ? '18px 16px' : '28px 40px' }}>
      {/* ── Sub-tab: Tools (inventory) vs Skills (authored SKILL.md docs) ── */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 18 }}>
        {(['tools', 'skills'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setMainTab(t)}
            style={{
              padding: '7px 16px',
              borderRadius: 8,
              cursor: 'pointer',
              background:
                mainTab === t ? `${withAlpha(agColor, 9)}` : 'transparent',
              border: `1px solid ${mainTab === t ? withAlpha(agColor, 31) : CR2.border}`,
              color: mainTab === t ? CR2.cream : CR2.muted,
              fontFamily: CR2.sans,
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            {t === 'tools'
              ? '🔧 Tools'
              : `✦ Skills${skills.length ? ` ${skills.length}` : ''}`}
          </button>
        ))}
      </div>

      {mainTab === 'tools' && (
        <>
          {/* ── Sticky control bar: tabs + search ── */}
          <div
            style={{
              position: 'sticky',
              top: 0,
              zIndex: 10,
              background:
                'linear-gradient(180deg, var(--cr-bg-card-hov) 70%, transparent 100%)',
              backdropFilter: 'blur(8px)',
              padding: '10px 16px',
              marginBottom: 20,
              borderBottom: `1px solid ${CR2.border}`,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
                marginBottom: 12,
              }}
            >
              <span
                style={{
                  fontFamily: CR2.serif,
                  fontSize: 18,
                  color: CR2.cream,
                  marginRight: 6,
                }}
              >
                Tool inventory
              </span>
              {inventory && (
                <span
                  style={{ fontFamily: CR2.mono, fontSize: 11, color: CR2.sub }}
                >
                  <span style={{ color: agColor, fontWeight: 600 }}>
                    {inventory.summary.total}
                  </span>{' '}
                  tools across cycle, generated &amp; MCP
                </span>
              )}
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <TabBtn
                id="all"
                label="All"
                color={agColor}
                count={inventory?.summary.total}
              />
              <TabBtn
                id="dynamic"
                label="Generated"
                color={DYN_C}
                count={inventory?.summary.dynamic}
              />
              <TabBtn
                id="cycle"
                label="Cycle"
                color={CYCLE_C}
                count={inventory?.summary.cycle}
              />
              <TabBtn
                id="mcp"
                label="MCP"
                color={MCP_C}
                count={inventory?.summary.mcpServers}
              />
              <div style={{ flex: 1, minWidth: 200 }}>
                <input
                  type="text"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="🔍 Search tools by name, category, or description..."
                  style={{
                    ...inp,
                    padding: '7px 12px',
                    fontSize: 12,
                    background: CR2.bgSurf,
                  }}
                />
              </div>
            </div>
          </div>

          {/* ── Chat tools ── */}
          {/* ── Generated (dynamic) tools — section header shown here; the cards below are existing logic ── */}
          {showSection('dynamic') && (
            <div style={{ marginBottom: 32 }}>
              <SectionHeader
                color={DYN_C}
                title="Generated tools"
                badge="agent-specific"
                count={dynTools.length}
                action={
                  <button
                    onClick={loadDynTools}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: CR2.accent,
                      cursor: 'pointer',
                      fontFamily: CR2.mono,
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    ↻ Refresh
                  </button>
                }
              />
              <div
                style={{
                  fontFamily: CR2.sans,
                  fontSize: 11,
                  color: CR2.muted,
                  marginBottom: 14,
                  paddingLeft: 14,
                }}
              >
                Tools created specifically for this agent — built, tested, and
                fixed in chat via the tool factory.
              </div>
              {dynLoading ? (
                <div
                  style={{
                    color: CR2.muted,
                    fontFamily: CR2.sans,
                    fontSize: 13,
                    marginBottom: 8,
                  }}
                >
                  Loading tools…
                </div>
              ) : dynTools.length === 0 ? (
                <div
                  style={{
                    padding: 28,
                    textAlign: 'center',
                    border: `1px dashed ${CR2.border}`,
                    borderRadius: 10,
                    color: CR2.muted,
                    fontFamily: CR2.sans,
                    fontSize: 12,
                  }}
                >
                  No generated tools yet. Ask the agent in chat to build one —
                  the tool factory creates, tests, and versions it.
                </div>
              ) : (
                (() => {
                  const grouped = new Map<
                    string,
                    { py?: DynamicTool; js?: DynamicTool }
                  >();
                  for (const t of dynTools) {
                    const g = grouped.get(t.name) ?? {};
                    g[t.ext as 'py' | 'js'] = t;
                    grouped.set(t.name, g);
                  }
                  const groups = [...grouped.entries()];
                  return (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 12,
                        maxWidth: 720,
                      }}
                    >
                      {groups.map(([name, group]) => {
                        const tool = group.py ?? group.js!;
                        const badge =
                          STATUS_BADGE[tool.status] ?? STATUS_BADGE.untested;
                        return (
                          <div
                            key={name}
                            style={{
                              background: CR2.bgCard,
                              border: `1px solid ${CR2.border}`,
                              borderRadius: 12,
                              padding: 18,
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 12,
                              }}
                            >
                              <div style={{ flex: 1, minWidth: 0 }}>
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    marginBottom: 4,
                                    flexWrap: 'wrap',
                                  }}
                                >
                                  <span
                                    style={{
                                      fontFamily: CR2.sans,
                                      fontSize: 14,
                                      fontWeight: 600,
                                      color: CR2.cream,
                                    }}
                                  >
                                    {tool.label || tool.name}
                                  </span>
                                  <span
                                    style={{
                                      padding: '2px 8px',
                                      borderRadius: 100,
                                      background: badge.bg,
                                      color: badge.color,
                                      border: `1px solid ${badge.border}`,
                                      fontFamily: CR2.mono,
                                      fontSize: 8,
                                      letterSpacing: '0.06em',
                                    }}
                                  >
                                    {badge.label}
                                  </span>
                                  {tool.requiredCredentials.length > 0 &&
                                    tool.requiredCredentials.map((cred) => (
                                      <span
                                        key={cred}
                                        style={{
                                          padding: '2px 7px',
                                          borderRadius: 100,
                                          background: 'var(--cr-amber-low)',
                                          color: 'var(--cr-warn)',
                                          border:
                                            '1px solid var(--cr-amber-line)',
                                          fontFamily: CR2.mono,
                                          fontSize: 8,
                                          letterSpacing: '0.06em',
                                        }}
                                      >
                                        🔑 {cred}
                                      </span>
                                    ))}
                                </div>
                                {tool.description && (
                                  <div
                                    style={{
                                      fontFamily: CR2.sans,
                                      fontSize: 12,
                                      color: CR2.sub,
                                      lineHeight: 1.5,
                                    }}
                                  >
                                    {tool.description}
                                  </div>
                                )}
                              </div>
                              <div
                                style={{
                                  display: 'flex',
                                  gap: 8,
                                  flexShrink: 0,
                                }}
                              >
                                <button
                                  onClick={() => onImproveInChat(tool.name)}
                                  title="Ask the agent to change this tool — it rebuilds & re-verifies it in chat"
                                  style={{
                                    padding: '5px 12px',
                                    borderRadius: 7,
                                    cursor: 'pointer',
                                    background: 'var(--cr-blue-low)',
                                    border: '1px solid var(--cr-blue-line)',
                                    color: 'var(--cr-blue)',
                                    fontFamily: CR2.sans,
                                    fontSize: 11,
                                    fontWeight: 600,
                                  }}
                                >
                                  ✦ Improve in chat
                                </button>
                                <button
                                  onClick={() => handleDelete(tool.name)}
                                  disabled={deletingName === tool.name}
                                  style={{
                                    padding: '5px 12px',
                                    borderRadius: 7,
                                    cursor: 'pointer',
                                    background: 'var(--cr-error-low)',
                                    border: '1px solid var(--cr-error-line)',
                                    color: 'var(--cr-error)',
                                    fontFamily: CR2.sans,
                                    fontSize: 11,
                                    opacity:
                                      deletingName === tool.name ? 0.5 : 1,
                                  }}
                                >
                                  {deletingName === tool.name
                                    ? 'Deleting…'
                                    : '🗑 Delete'}
                                </button>
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  );
                })()
              )}
            </div>
          )}

          {/* ── Cycle tools (per-category collapsible) ── */}
          {showSection('cycle') && inventory && inventory.cycle.length > 0 && (
            <div style={{ marginBottom: 32 }}>
              <SectionHeader
                color={CYCLE_C}
                title="Cycle tools"
                badge="sidecar · Python"
                count={filteredCycle.length}
                action={
                  <button
                    onClick={() => {
                      const allCats = Object.keys(cycleByCategory);
                      const anyCollapsed = allCats.some(
                        (c) => !expandedCats[c],
                      );
                      setExpandedCats(
                        Object.fromEntries(
                          allCats.map((c) => [c, anyCollapsed]),
                        ),
                      );
                    }}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: CR2.accent,
                      cursor: 'pointer',
                      fontFamily: CR2.mono,
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    {Object.values(expandedCats).every((v) => v)
                      ? '− Collapse all'
                      : '+ Expand all'}
                  </button>
                }
              />
              <div
                style={{
                  fontFamily: CR2.sans,
                  fontSize: 11,
                  color: CR2.muted,
                  marginBottom: 14,
                  paddingLeft: 14,
                }}
              >
                Always-available toolkit during Run Cycle / scheduled cycles.
                Click a category to inspect its tools.
              </div>
              {Object.keys(cycleByCategory).length === 0 ? (
                <div
                  style={{
                    padding: 24,
                    textAlign: 'center',
                    color: CR2.muted,
                    fontSize: 12,
                    background: CR2.bgCard,
                    borderRadius: 10,
                  }}
                >
                  No cycle tools match your search.
                </div>
              ) : (
                <div
                  style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                >
                  {Object.entries(cycleByCategory).map(([cat, tools]) => {
                    const open = autoExpand || expandedCats[cat];
                    return (
                      <div
                        key={cat}
                        style={{
                          background: CR2.bgCard,
                          border: `1px solid ${open ? `${withAlpha(CYCLE_C, 15)}` : CR2.border}`,
                          borderLeft: `3px solid ${open ? CYCLE_C : CR2.border}`,
                          borderRadius: 8,
                          overflow: 'hidden',
                          transition: 'all 0.15s',
                        }}
                      >
                        <div
                          onClick={() =>
                            setExpandedCats((prev) => ({
                              ...prev,
                              [cat]: !prev[cat],
                            }))
                          }
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            padding: '10px 14px',
                            cursor: 'pointer',
                            userSelect: 'none',
                          }}
                        >
                          <span
                            style={{
                              fontFamily: CR2.mono,
                              fontSize: 11,
                              color: open ? CYCLE_C : CR2.muted,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              letterSpacing: '0.08em',
                              minWidth: 18,
                            }}
                          >
                            {open ? '▾' : '▸'}
                          </span>
                          <span
                            style={{
                              fontFamily: CR2.sans,
                              fontSize: 13,
                              color: CR2.cream,
                              fontWeight: 600,
                            }}
                          >
                            {cat}
                          </span>
                          <span
                            style={{
                              fontFamily: CR2.mono,
                              fontSize: 10,
                              color: CYCLE_C,
                              background: `${withAlpha(CYCLE_C, 6)}`,
                              padding: '1px 7px',
                              borderRadius: 100,
                            }}
                          >
                            {tools.length}
                          </span>
                          {!open && (
                            <span
                              style={{
                                fontFamily: CR2.mono,
                                fontSize: 10,
                                color: CR2.sub,
                                flex: 1,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                minWidth: 0,
                              }}
                            >
                              {tools.map((t) => t.name).join(' · ')}
                            </span>
                          )}
                        </div>
                        {open && (
                          <div
                            style={{
                              padding: '4px 14px 14px 40px',
                              display: 'grid',
                              gridTemplateColumns:
                                'repeat(auto-fill, minmax(320px, 1fr))',
                              gap: 6,
                            }}
                          >
                            {tools.map((t) => (
                              <div
                                key={t.name}
                                style={{
                                  padding: '8px 12px',
                                  background: 'var(--cr-purple-low)',
                                  border: '1px solid var(--cr-purple-low)',
                                  borderRadius: 6,
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    marginBottom: 3,
                                  }}
                                >
                                  <code
                                    style={{
                                      fontFamily: CR2.mono,
                                      fontSize: 11,
                                      color: 'var(--cr-purple)',
                                      fontWeight: 600,
                                    }}
                                  >
                                    {t.name}
                                  </code>
                                  {/* Phase 5b — quality badge: runtime health (if the tool has run) else creation test status */}
                                  {t.health && t.health.totalCalls > 0 ? (
                                    <span
                                      title={`${t.health.totalCalls} call(s) · ${t.health.status}`}
                                      style={{
                                        fontFamily: CR2.mono,
                                        fontSize: 9,
                                        padding: '1px 6px',
                                        borderRadius: 4,
                                        border: '1px solid var(--cr-border)',
                                        background: 'var(--cr-tint-3)',
                                        color:
                                          t.health.status === 'healthy'
                                            ? 'var(--cr-green)'
                                            : t.health.status === 'degraded'
                                              ? 'var(--cr-warn)'
                                              : 'var(--cr-error-str)',
                                      }}
                                    >
                                      ● {Math.round(t.health.successRate * 100)}
                                      %
                                    </span>
                                  ) : t.testStatus &&
                                    t.testStatus !== 'untested' ? (
                                    <span
                                      title="creation-time test result"
                                      style={{
                                        fontFamily: CR2.mono,
                                        fontSize: 9,
                                        padding: '1px 6px',
                                        borderRadius: 4,
                                        border: '1px solid var(--cr-border)',
                                        background: 'var(--cr-tint-3)',
                                        color:
                                          t.testStatus === 'passed'
                                            ? 'var(--cr-green)'
                                            : 'var(--cr-error-str)',
                                      }}
                                    >
                                      {t.testStatus === 'passed'
                                        ? '✓ tested'
                                        : '✕ failing'}
                                    </span>
                                  ) : null}
                                  {t.requiresCredential &&
                                    t.requiresCredential.length > 0 && (
                                      <span
                                        title={`Requires: ${t.requiresCredential.join(', ')}`}
                                        style={{
                                          fontFamily: CR2.mono,
                                          fontSize: 9,
                                          color: 'var(--cr-warn)',
                                          background: 'var(--cr-amber-low)',
                                          border:
                                            '1px solid var(--cr-amber-line)',
                                          padding: '1px 6px',
                                          borderRadius: 4,
                                        }}
                                      >
                                        🔑 {t.requiresCredential[0]}
                                      </span>
                                    )}
                                </div>
                                <div
                                  style={{
                                    fontFamily: CR2.sans,
                                    fontSize: 11,
                                    color: CR2.muted,
                                    lineHeight: 1.4,
                                  }}
                                >
                                  {t.description}
                                </div>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* ── MCP servers ── */}
          {showSection('mcp') && (
            <div style={{ marginBottom: 32 }}>
              <SectionHeader
                color={MCP_C}
                title="MCP servers"
                badge="both runtimes"
                count={filteredMcp.length}
              />
              <div
                style={{
                  fontFamily: CR2.sans,
                  fontSize: 11,
                  color: CR2.muted,
                  marginBottom: 14,
                  paddingLeft: 14,
                }}
              >
                External tool servers via Model Context Protocol. Tools are
                discovered when each server connects.
              </div>
              {filteredMcp.length === 0 ? (
                <div
                  style={{
                    padding: 24,
                    textAlign: 'center',
                    background: 'var(--cr-well)',
                    border: `1px dashed ${CR2.border}`,
                    borderRadius: 10,
                    color: CR2.muted,
                    fontFamily: CR2.sans,
                    fontSize: 12,
                  }}
                >
                  {q ? (
                    'No MCP servers match your search.'
                  ) : (
                    <>
                      No MCP servers configured.{' '}
                      <span
                        onClick={() => navigate('/account#mcp-servers')}
                        style={{
                          color: MCP_C,
                          cursor: 'pointer',
                          textDecoration: 'underline',
                        }}
                      >
                        Add one in Account
                      </span>{' '}
                      — it'll be available to all your agents.
                    </>
                  )}
                </div>
              ) : (
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns:
                      'repeat(auto-fill, minmax(320px, 1fr))',
                    gap: 10,
                  }}
                >
                  {filteredMcp.map((s) => (
                    <div
                      key={s.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '12px 14px',
                        background: CR2.bgCard,
                        border: `1px solid ${s.enabled ? `${withAlpha(MCP_C, 15)}` : CR2.border}`,
                        borderLeft: `3px solid ${s.enabled ? MCP_C : CR2.border}`,
                        borderRadius: 10,
                      }}
                    >
                      <div
                        style={{
                          width: 32,
                          height: 32,
                          borderRadius: 8,
                          background: `${withAlpha(MCP_C, 6)}`,
                          border: `1px solid ${withAlpha(MCP_C, 13)}`,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          fontSize: 14,
                          flexShrink: 0,
                        }}
                      >
                        🔌
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            marginBottom: 3,
                          }}
                        >
                          <span
                            style={{
                              fontFamily: CR2.sans,
                              fontSize: 13,
                              fontWeight: 600,
                              color: CR2.cream,
                            }}
                          >
                            {s.server}
                          </span>
                          <span
                            style={{
                              fontFamily: CR2.mono,
                              fontSize: 9,
                              color: CR2.muted,
                              background: 'var(--cr-tint-3)',
                              padding: '1px 6px',
                              borderRadius: 4,
                            }}
                          >
                            {s.transport}
                          </span>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                          }}
                        >
                          <span
                            style={{
                              fontFamily: CR2.mono,
                              fontSize: 9,
                              color: s.enabled ? 'var(--cr-green)' : CR2.muted,
                            }}
                          >
                            {s.enabled ? '● Enabled' : '○ Disabled'}
                          </span>
                          <span
                            style={{
                              fontFamily: CR2.mono,
                              fontSize: 9,
                              color: s.scope === 'global' ? CR2.sub : MCP_C,
                            }}
                          >
                            · {s.scope}
                          </span>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </>
      )}

      {/* ── Skills sub-tab ── */}
      {mainTab === 'skills' && (
        <div style={{ maxWidth: 760 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 8,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
              <span
                style={{
                  fontFamily: CR2.serif,
                  fontSize: 18,
                  color: CR2.cream,
                }}
              >
                Skills
              </span>
              <span
                style={{ fontFamily: CR2.mono, fontSize: 11, color: CR2.sub }}
              >
                {skills.length}
              </span>
            </div>
            <button
              onClick={loadSkills}
              style={{
                background: 'none',
                border: 'none',
                color: CR2.accent,
                cursor: 'pointer',
                fontFamily: CR2.mono,
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.05em',
              }}
            >
              ↻ Refresh
            </button>
          </div>
          <div
            style={{
              fontFamily: CR2.sans,
              fontSize: 11,
              color: CR2.muted,
              marginBottom: 14,
            }}
          >
            Reusable how-to docs loaded as context in chat and cycles.{' '}
            <strong style={{ color: CR2.sub }}>Built-in</strong> ship with the
            runtime; <strong style={{ color: CR2.sub }}>Authored</strong> are
            saved by this agent via{' '}
            <code style={{ fontFamily: CR2.mono, color: CR2.sub }}>
              save_skill
            </code>
            .
          </div>
          {skillsLoading ? (
            <div
              style={{ color: CR2.muted, fontFamily: CR2.sans, fontSize: 13 }}
            >
              Loading skills…
            </div>
          ) : (
            (() => {
              const ql = skillSearch.trim().toLowerCase();
              const m = (s: (typeof skills)[number]) =>
                !ql || `${s.name} ${s.description}`.toLowerCase().includes(ql);
              const authored = skills.filter(
                (s) => s.source === 'authored' && m(s),
              );
              const builtin = skills.filter(
                (s) => s.source === 'builtin' && m(s),
              );
              const card = (s: (typeof skills)[number]) => {
                const key = `${s.source}:${s.name}`;
                const open = openSkill === key;
                const t = s.telemetry;
                // Lifecycle is derived from idle time in the container, so it's
                // shown rather than editable. Pinned outranks it — a pinned skill
                // is always active no matter how long it has sat.
                const life =
                  t && !t.pinned && t.lifecycle !== 'active'
                    ? t.lifecycle === 'stale'
                      ? {
                          label: 'STALE',
                          c: 'var(--cr-amber)',
                          bg: 'var(--cr-amber-low)',
                          line: 'var(--cr-amber-line)',
                        }
                      : {
                          label: 'UNUSED 90d',
                          c: CR2.muted,
                          bg: 'transparent',
                          line: CR2.border,
                        }
                    : null;
                return (
                  <div
                    key={key}
                    style={{
                      background: CR2.bgCard,
                      border: `1px solid ${CR2.border}`,
                      borderRadius: 12,
                      overflow: 'hidden',
                    }}
                  >
                    <div
                      onClick={() => toggleSkill(key, s.dir)}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        padding: '13px 16px',
                        cursor: 'pointer',
                      }}
                    >
                      <span
                        style={{
                          fontFamily: CR2.mono,
                          fontSize: 12,
                          color: CR2.muted,
                          minWidth: 12,
                        }}
                      >
                        {open ? '▾' : '▸'}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            flexWrap: 'wrap',
                          }}
                        >
                          <span
                            style={{
                              fontFamily: CR2.sans,
                              fontSize: 14,
                              fontWeight: 600,
                              color: CR2.cream,
                            }}
                          >
                            {s.name}
                          </span>
                          {s.always && (
                            <span
                              style={{
                                padding: '2px 7px',
                                borderRadius: 100,
                                background: 'var(--cr-green-low)',
                                color: 'var(--cr-green)',
                                border: '1px solid var(--cr-green-line)',
                                fontFamily: CR2.mono,
                                fontSize: 8,
                                letterSpacing: '0.06em',
                              }}
                            >
                              ALWAYS
                            </span>
                          )}
                          {t?.agentCreated && (
                            <span
                              title="Written by the agent itself during background review"
                              style={{
                                padding: '2px 7px',
                                borderRadius: 100,
                                background: 'var(--cr-purple-low)',
                                color: 'var(--cr-purple)',
                                border: '1px solid var(--cr-purple-line)',
                                fontFamily: CR2.mono,
                                fontSize: 8,
                                letterSpacing: '0.06em',
                              }}
                            >
                              SELF-TAUGHT
                            </span>
                          )}
                          {t?.pinned && (
                            <span
                              title="Pinned — never goes stale, never archived"
                              style={{
                                padding: '2px 7px',
                                borderRadius: 100,
                                background: 'var(--cr-blue-low)',
                                color: 'var(--cr-blue)',
                                border: '1px solid var(--cr-blue-line)',
                                fontFamily: CR2.mono,
                                fontSize: 8,
                                letterSpacing: '0.06em',
                              }}
                            >
                              PINNED
                            </span>
                          )}
                          {life && (
                            <span
                              title={
                                t?.lastUsedAt
                                  ? `Last used ${t.idleDays}d ago`
                                  : 'Never used'
                              }
                              style={{
                                padding: '2px 7px',
                                borderRadius: 100,
                                background: life.bg,
                                color: life.c,
                                border: `1px solid ${life.line}`,
                                fontFamily: CR2.mono,
                                fontSize: 8,
                                letterSpacing: '0.06em',
                              }}
                            >
                              {life.label}
                            </span>
                          )}
                        </div>
                        {s.description && (
                          <div
                            style={{
                              fontFamily: CR2.sans,
                              fontSize: 12,
                              color: CR2.sub,
                              marginTop: 3,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: open ? 'normal' : 'nowrap',
                            }}
                          >
                            {s.description}
                          </div>
                        )}
                        {t && (
                          <div
                            style={{
                              fontFamily: CR2.mono,
                              fontSize: 10,
                              color: CR2.muted,
                              marginTop: 5,
                              display: 'flex',
                              gap: 12,
                              flexWrap: 'wrap',
                            }}
                          >
                            {/* Uses is counted only where a skill actually reaches the model,
                                                        so 0 means it has never been loaded into a turn — not that it
                                                        was never read. */}
                            <span>
                              {t.usageCount === 0
                                ? 'never used'
                                : `${t.usageCount} use${t.usageCount === 1 ? '' : 's'}`}
                            </span>
                            {t.writeCount > 1 && (
                              <span>{t.writeCount} revisions</span>
                            )}
                            {t.lastUsedAt && (
                              <span>last used {fmtWhen(t.lastUsedAt)}</span>
                            )}
                            {/* Usage entries are created by record_use, which knows nothing
                                                        about who wrote the skill — so "unknown" is the normal case
                                                        and not worth a line of its own. */}
                            {t.origin !== 'unknown' && (
                              <span>origin: {t.origin}</span>
                            )}
                          </div>
                        )}
                      </div>
                    </div>
                    {open && (
                      <div
                        style={{
                          borderTop: `1px solid ${CR2.border}`,
                          padding: '14px 18px',
                          background: 'var(--cr-well)',
                          fontFamily: CR2.sans,
                          fontSize: 13,
                          color: CR2.sub,
                          lineHeight: 1.7,
                        }}
                        className="prose"
                      >
                        {(s.content ?? skillBodies[s.dir]) === undefined ? (
                          <span
                            style={{
                              fontFamily: CR2.mono,
                              fontSize: 11,
                              color: CR2.muted,
                            }}
                          >
                            Loading…
                          </span>
                        ) : (
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {s.content ?? skillBodies[s.dir]}
                          </ReactMarkdown>
                        )}
                      </div>
                    )}
                  </div>
                );
              };
              const groupHeader = (
                title: string,
                color: string,
                count: number,
              ) => (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    margin: '4px 0 10px',
                    paddingLeft: 12,
                    borderLeft: `2px solid ${color}`,
                  }}
                >
                  <span
                    style={{
                      fontFamily: CR2.serif,
                      fontSize: 16,
                      color: CR2.cream,
                    }}
                  >
                    {title}
                  </span>
                  <span style={{ fontFamily: CR2.mono, fontSize: 11, color }}>
                    {count}
                  </span>
                </div>
              );
              return (
                <>
                  {/* Learning loop. Only rendered once the agent has actually
                                    written or changed something — an all-zero strip on a fresh
                                    agent reads as a broken feature rather than an empty one. */}
                  {skillSummary &&
                    (skillSummary.total > 0 ||
                      skillSummary.ledgerEntries > 0) && (
                      <div
                        style={{
                          background: 'var(--cr-well)',
                          border: `1px solid ${CR2.border}`,
                          borderRadius: 12,
                          padding: '14px 16px',
                          marginBottom: 16,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: CR2.mono,
                            fontSize: 10,
                            color: CR2.muted,
                            textTransform: 'uppercase',
                            letterSpacing: '0.06em',
                            marginBottom: 10,
                          }}
                        >
                          Learning loop
                        </div>
                        <div
                          style={{ display: 'flex', gap: 22, flexWrap: 'wrap' }}
                        >
                          {(
                            [
                              [
                                'self-taught',
                                skillSummary.agentCreated,
                                'var(--cr-purple)',
                                'Written by the agent during background review',
                              ],
                              [
                                'total uses',
                                skillSummary.totalUses,
                                CR2.cream,
                                'Times a skill was loaded into a turn',
                              ],
                              [
                                'never used',
                                skillSummary.neverUsed,
                                skillSummary.neverUsed > 0
                                  ? 'var(--cr-amber)'
                                  : CR2.cream,
                                'Has telemetry but has never reached the model',
                              ],
                              [
                                'stale',
                                skillSummary.stale,
                                skillSummary.stale > 0
                                  ? 'var(--cr-amber)'
                                  : CR2.cream,
                                `Idle 30+ days`,
                              ],
                              [
                                'retired',
                                skillSummary.archivedOnDisk,
                                CR2.cream,
                                'Moved to .archive/ by the curator',
                              ],
                              [
                                'changes',
                                skillSummary.ledgerEntries,
                                CR2.cream,
                                'Entries in the mutation ledger',
                              ],
                            ] as const
                          ).map(([label, value, color, title]) => (
                            <div key={label} title={title}>
                              <div
                                style={{
                                  fontFamily: CR2.mono,
                                  fontSize: 18,
                                  color,
                                }}
                              >
                                {value}
                              </div>
                              <div
                                style={{
                                  fontFamily: CR2.mono,
                                  fontSize: 9,
                                  color: CR2.muted,
                                  textTransform: 'uppercase',
                                  letterSpacing: '0.05em',
                                }}
                              >
                                {label}
                              </div>
                            </div>
                          ))}
                        </div>
                        {skillSummary.lastMutationAt && (
                          <div
                            style={{
                              fontFamily: CR2.mono,
                              fontSize: 10,
                              color: CR2.muted,
                              marginTop: 10,
                            }}
                          >
                            last change {fmtWhen(skillSummary.lastMutationAt)}
                            {' · '}
                            <span
                              onClick={() => setShowHistory((v) => !v)}
                              style={{ color: CR2.accent, cursor: 'pointer' }}
                            >
                              {showHistory
                                ? 'hide history'
                                : `history (${ledger.length})`}
                            </span>
                          </div>
                        )}
                      </div>
                    )}

                  {showHistory && (
                    <div
                      style={{
                        marginBottom: 20,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      {ledger.length === 0 ? (
                        <div
                          style={{
                            fontFamily: CR2.sans,
                            fontSize: 12,
                            color: CR2.muted,
                          }}
                        >
                          No recorded changes.
                        </div>
                      ) : (
                        ledger.map((e) => {
                          const open = openLedgerId === e.id;
                          const detail = ledgerDetail[e.id];
                          return (
                            <div
                              key={e.id}
                              style={{
                                background: CR2.bgCard,
                                border: `1px solid ${CR2.border}`,
                                borderRadius: 8,
                                overflow: 'hidden',
                              }}
                            >
                              <div
                                onClick={() => toggleLedgerEntry(e.id)}
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 10,
                                  padding: '9px 13px',
                                  cursor: 'pointer',
                                  fontFamily: CR2.mono,
                                  fontSize: 11,
                                }}
                              >
                                <span
                                  style={{ color: CR2.muted, minWidth: 12 }}
                                >
                                  {open ? '▾' : '▸'}
                                </span>
                                <span
                                  style={{
                                    color:
                                      e.action === 'delete'
                                        ? 'var(--cr-error)'
                                        : e.action === 'create'
                                          ? 'var(--cr-green)'
                                          : 'var(--cr-blue)',
                                    textTransform: 'uppercase',
                                    fontSize: 9,
                                    minWidth: 52,
                                  }}
                                >
                                  {e.action}
                                </span>
                                <span
                                  style={{
                                    color: CR2.cream,
                                    flex: 1,
                                    minWidth: 0,
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {e.skill}
                                </span>
                                <span style={{ color: CR2.sub }}>
                                  {e.actor}
                                </span>
                                <span style={{ color: CR2.muted }}>
                                  {fmtWhen(e.ts)}
                                </span>
                              </div>
                              {open && (
                                <div
                                  style={{
                                    borderTop: `1px solid ${CR2.border}`,
                                    padding: '10px 14px',
                                    background: 'var(--cr-well)',
                                  }}
                                >
                                  {!detail ? (
                                    <div
                                      style={{
                                        fontFamily: CR2.mono,
                                        fontSize: 11,
                                        color: CR2.muted,
                                      }}
                                    >
                                      Loading…
                                    </div>
                                  ) : (
                                    <div
                                      style={{
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 10,
                                      }}
                                    >
                                      {/* A create has no before body and a delete has no after
                                                                        one; showing the missing side as "—" is clearer than
                                                                        hiding the pane and leaving the reader to guess. */}
                                      {(['before', 'after'] as const).map(
                                        (side) => {
                                          const body =
                                            side === 'before'
                                              ? detail.beforeContent
                                              : detail.afterContent;
                                          return (
                                            <div key={side}>
                                              <div
                                                style={{
                                                  fontFamily: CR2.mono,
                                                  fontSize: 9,
                                                  color: CR2.muted,
                                                  textTransform: 'uppercase',
                                                  letterSpacing: '0.06em',
                                                  marginBottom: 4,
                                                }}
                                              >
                                                {side}
                                              </div>
                                              <pre
                                                style={{
                                                  margin: 0,
                                                  maxHeight: 220,
                                                  overflow: 'auto',
                                                  fontFamily: CR2.mono,
                                                  fontSize: 11,
                                                  color: body
                                                    ? CR2.sub
                                                    : CR2.muted,
                                                  whiteSpace: 'pre-wrap',
                                                  wordBreak: 'break-word',
                                                }}
                                              >
                                                {body ?? '—'}
                                              </pre>
                                            </div>
                                          );
                                        },
                                      )}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}

                  <input
                    value={skillSearch}
                    onChange={(e) => setSkillSearch(e.target.value)}
                    placeholder="Search skills by name or description…"
                    style={{ ...inp, marginBottom: 18 }}
                  />
                  {authored.length > 0 && (
                    <div style={{ marginBottom: 28 }}>
                      {groupHeader(
                        'Authored',
                        'var(--cr-green)',
                        authored.length,
                      )}
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 10,
                        }}
                      >
                        {authored.map(card)}
                      </div>
                    </div>
                  )}
                  {/* Retired skills are only named, not rendered: the curator moved
                                    them out of the loaded set, so showing their bodies here would
                                    imply the agent still reads them. */}
                  {skillArchived.length > 0 && !ql && (
                    <div style={{ marginBottom: 28 }}>
                      {groupHeader('Retired', CR2.border, skillArchived.length)}
                      <div
                        style={{
                          fontFamily: CR2.sans,
                          fontSize: 11,
                          color: CR2.muted,
                          marginBottom: 8,
                        }}
                      >
                        Archived by the curator after going unused. Kept on
                        disk, not loaded into turns.
                      </div>
                      <div
                        style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}
                      >
                        {skillArchived.map((n) => (
                          <span
                            key={n}
                            style={{
                              fontFamily: CR2.mono,
                              fontSize: 11,
                              color: CR2.sub,
                              background: 'var(--cr-well)',
                              border: `1px solid ${CR2.border}`,
                              borderRadius: 100,
                              padding: '3px 10px',
                            }}
                          >
                            {n}
                          </span>
                        ))}
                      </div>
                    </div>
                  )}
                  <div>
                    {groupHeader(
                      'Built-in',
                      'var(--cr-purple)',
                      builtin.length,
                    )}
                    {builtin.length === 0 ? (
                      <div
                        style={{
                          padding: 20,
                          textAlign: 'center',
                          border: `1px dashed ${CR2.border}`,
                          borderRadius: 10,
                          color: CR2.muted,
                          fontFamily: CR2.sans,
                          fontSize: 12,
                        }}
                      >
                        {ql
                          ? 'No built-in skills match your search.'
                          : 'No built-in skills found.'}
                      </div>
                    ) : (
                      (() => {
                        // Group built-in skills by category (like hermes). Searching auto-expands.
                        const byCat = new Map<string, typeof builtin>();
                        for (const s of builtin) {
                          const c = s.category || 'general';
                          (byCat.get(c) ?? byCat.set(c, []).get(c)!).push(s);
                        }
                        const cats = [...byCat.keys()].sort();
                        return (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 6,
                            }}
                          >
                            {cats.map((cat) => {
                              const items = byCat.get(cat)!;
                              const open = !!ql || openSkillCats[cat];
                              return (
                                <div
                                  key={cat}
                                  style={{
                                    background: CR2.bgCard,
                                    border: `1px solid ${open ? 'var(--cr-purple-line)' : CR2.border}`,
                                    borderLeft: `3px solid ${open ? 'var(--cr-purple)' : CR2.border}`,
                                    borderRadius: 8,
                                    overflow: 'hidden',
                                  }}
                                >
                                  <div
                                    onClick={() =>
                                      setOpenSkillCats((p) => ({
                                        ...p,
                                        [cat]: !p[cat],
                                      }))
                                    }
                                    style={{
                                      display: 'flex',
                                      alignItems: 'center',
                                      gap: 10,
                                      padding: '10px 14px',
                                      cursor: 'pointer',
                                      userSelect: 'none',
                                    }}
                                  >
                                    <span
                                      style={{
                                        fontFamily: CR2.mono,
                                        fontSize: 11,
                                        color: open
                                          ? 'var(--cr-purple)'
                                          : CR2.muted,
                                        fontWeight: 700,
                                        minWidth: 14,
                                      }}
                                    >
                                      {open ? '▾' : '▸'}
                                    </span>
                                    <span
                                      style={{
                                        fontFamily: CR2.sans,
                                        fontSize: 13,
                                        color: CR2.cream,
                                        fontWeight: 600,
                                        textTransform: 'capitalize',
                                      }}
                                    >
                                      {cat.replace(/-/g, ' ')}
                                    </span>
                                    <span
                                      style={{
                                        fontFamily: CR2.mono,
                                        fontSize: 10,
                                        color: 'var(--cr-purple)',
                                        background: 'var(--cr-purple-low)',
                                        padding: '1px 7px',
                                        borderRadius: 100,
                                      }}
                                    >
                                      {items.length}
                                    </span>
                                    {!open && (
                                      <span
                                        style={{
                                          fontFamily: CR2.mono,
                                          fontSize: 10,
                                          color: CR2.sub,
                                          flex: 1,
                                          overflow: 'hidden',
                                          textOverflow: 'ellipsis',
                                          whiteSpace: 'nowrap',
                                          minWidth: 0,
                                        }}
                                      >
                                        {items.map((s) => s.name).join(' · ')}
                                      </span>
                                    )}
                                  </div>
                                  {open && (
                                    <div
                                      style={{
                                        padding: '4px 12px 12px 38px',
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 8,
                                      }}
                                    >
                                      {items.map(card)}
                                    </div>
                                  )}
                                </div>
                              );
                            })}
                          </div>
                        );
                      })()
                    )}
                  </div>
                  {authored.length === 0 && !ql && (
                    <div
                      style={{
                        fontFamily: CR2.sans,
                        fontSize: 11,
                        color: CR2.muted,
                        marginTop: 18,
                      }}
                    >
                      This agent hasn't authored any skills yet — ask it in chat
                      to “save a skill for …”.
                    </div>
                  )}
                </>
              );
            })()
          )}
        </div>
      )}
    </div>
  );
}

// Live working-status phrasing + thinking-phrase rotation now live in the shared
// StreamingTurn component (used by both the agent chat and the project chat).

// ─── Workspace file tree ──────────────────────────────────────────────────────
// The files API returns a flat list with relative paths (e.g. "strategy/memo.md").
// Fold that into a real folder tree so the Workspace tab renders folders as folders.
type WsTreeNode =
  | { kind: 'file'; name: string; file: any }
  | { kind: 'dir'; name: string; path: string; children: WsTreeNode[] };

function buildFileTree(files: any[]): WsTreeNode[] {
  const roots: WsTreeNode[] = [];
  for (const f of files) {
    const parts = String(f.path || f.filename || '')
      .split('/')
      .filter(Boolean);
    let level = roots;
    for (let i = 0; i < parts.length - 1; i++) {
      const dirPath = parts.slice(0, i + 1).join('/');
      let dir = level.find((n) => n.kind === 'dir' && n.name === parts[i]) as
        | Extract<WsTreeNode, { kind: 'dir' }>
        | undefined;
      if (!dir) {
        dir = { kind: 'dir', name: parts[i], path: dirPath, children: [] };
        level.push(dir);
      }
      level = dir.children;
    }
    level.push({
      kind: 'file',
      name: parts[parts.length - 1] || String(f.filename),
      file: f,
    });
  }
  const sort = (nodes: WsTreeNode[]) => {
    // Folders first, then files; alphabetical within each group.
    nodes.sort((a, b) =>
      a.kind !== b.kind
        ? a.kind === 'dir'
          ? -1
          : 1
        : a.name.localeCompare(b.name),
    );
    nodes.forEach((n) => {
      if (n.kind === 'dir') sort(n.children);
    });
  };
  sort(roots);
  return roots;
}

function countFilesIn(node: WsTreeNode): number {
  if (node.kind === 'file') return 1;
  return node.children.reduce((sum, c) => sum + countFilesIn(c), 0);
}

// ─── Chat row (memoized) ──────────────────────────────────────────────────────
// One agent message: cycle timeline, plain reply, or user bubble. Pulled out and
// wrapped in memo() so a streaming tick — which gives the whole `toolTraces` object
// a new reference every frame — only re-renders the ONE row whose trace changed,
// not every historical row. The expensive work (JSON.parse of the trace, Markdown
// parsing) lives inside here, so memo skipping it is what keeps long threads smooth
// while a cycle is live. For this to hold, EVERY prop must be referentially stable
// across renders when the row hasn't changed: `msg`/`trace`/`files` come straight
// from state (stable refs per id), and `onHover`/`onCopied`/`onOpenFile` must be
// stable (useState setters / useCallback) — never inline arrows from the parent.
const EMPTY_TRACE: any[] = [];
// Module-level (NOT useRef) — survives AgentProfilePage remounting for any
// reason (route re-key, parent state churn) so a remount can never re-arm an
// already-completed cycle's trace fetch. See the identical fix + rationale in
// TurnFileChanges.tsx, which is where this exact class of bug was first found.
const fetchedTraceMsgIds = new Set<string>();
// Tool names that mutate the agent's workspace tree — see
// nanoagent/agent/tools/filesystem.py (write_file/append_file/edit_file).
// A completed call to any of these means the Files/Workspace tab is now stale.
// stage44 doc 01: the tools that drive a real browser, and so have live frames to
// show. Names must match the Python tool classes' `name` property exactly
// (nanoagent/agent/tools/effector*.py) — a rename there silently blanks this view.
const EFFECTOR_TOOLS = new Set([
  'effector',
  'effector_workflow',
  'effector_swarm',
]);

const FILE_MUTATING_TOOLS = new Set(['write_file', 'append_file', 'edit_file']);

interface AgentChatRowProps {
  msg: any;
  trace?: any[];
  isHovered: boolean;
  isCopied: boolean;
  onHover: (id: string | null) => void;
  onCopied: (id: string | null) => void;
  agColor: string;
  emoji: string;
  agentName: string;
  agentId?: string;
  mdComponents: any;
  /** Fetch a cycle's tool-call trace on demand — older cycles don't hydrate automatically (see loadTraceFor). */
  onLoadTrace?: (agentId: string, msgId: string, cycleId: string) => void;
  /** Whether this message is within the "recent cycles" window that hydrates automatically (see eagerCycleMsgIds). */
  isEager?: boolean;
  /** Stagger delay (ms) for this row's eager fetches — offset from the trace hydration's own stagger so the two don't collide. */
  eagerStaggerMs?: number;
}

/** Tiny green pill marking a chat turn that came in / went out over WhatsApp. */
function WaSourceBadge() {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 3,
        fontFamily: CR.mono,
        fontSize: 8.5,
        fontWeight: 700,
        letterSpacing: 0.4,
        color: 'var(--cr-brand-whatsapp)',
        background: 'rgba(37,211,102,0.10)',
        border: '1px solid rgba(37,211,102,0.30)',
        borderRadius: 4,
        padding: '0 5px',
        lineHeight: '15px',
        textTransform: 'uppercase',
      }}
    >
      <span
        style={{
          width: 6,
          height: 6,
          borderRadius: '50%',
          background: 'var(--cr-brand-whatsapp)',
          display: 'inline-block',
        }}
      />{' '}
      WhatsApp
    </span>
  );
}

const AgentChatRow = memo(function AgentChatRow({
  msg,
  trace,
  isHovered,
  isCopied,
  onHover,
  onCopied,
  agColor,
  emoji,
  agentName,
  agentId,
  mdComponents,
  onLoadTrace,
  isEager = true,
  eagerStaggerMs = 0,
}: AgentChatRowProps) {
  const isUser = msg.role === 'user';
  const cycleTrace = !isUser ? (trace ?? EMPTY_TRACE) : EMPTY_TRACE;
  // A cycle-result message whose trace hasn't been fetched yet (older history —
  // see loadTraceFor's eager-hydration cap). Falls back to the plain bubble
  // below, with a click-to-load link instead of the full step-by-step timeline.
  const untracedCycleId =
    !isUser && cycleTrace.length === 0
      ? (msg.id as string)?.match(/^cyc-(.+)-result-/)?.[1]
      : undefined;
  const trailingThinkingStep =
    cycleTrace.length > 0 &&
    cycleTrace[cycleTrace.length - 1].name === 'thinking'
      ? cycleTrace[cycleTrace.length - 1]
      : null;
  const filteredTrace = trailingThinkingStep
    ? cycleTrace.slice(0, -1)
    : cycleTrace;
  const isCycle = filteredTrace.length > 0;
  const finalAnswerText = (() => {
    if (trailingThinkingStep) {
      const raw = trailingThinkingStep.result || '';
      let resStr = '';
      try {
        const r = JSON.parse(raw);
        resStr = typeof r === 'string' ? r : JSON.stringify(r, null, 2);
      } catch {
        resStr = raw;
      }

      let summary = '';
      const summaryMatch = resStr.match(/<summary>([\s\S]*?)<\/summary>/);
      if (summaryMatch) {
        summary = summaryMatch[1].trim();
      }

      const body = resStr
        .replace(/<cycle_result>[\s\S]*?<\/cycle_result>/g, '')
        .replace(/<summary>[\s\S]*?<\/summary>/g, '')
        .replace(/<tasks_done>[\s\S]*?<\/tasks_done>/g, '')
        .replace(/<\/?cycle_result>/g, '')
        .replace(/<[^>]*>/g, '')
        .trim();

      if (summary) {
        if (body) {
          if (body.endsWith(':')) {
            return `${body}\n${summary}`;
          } else {
            return `${body}\n\n**Accomplished:**\n${summary}`;
          }
        } else {
          return `**Accomplished:**\n${summary}`;
        }
      }
      return body;
    }
    return msg.content;
  })();
  return (
    <div
      data-msgid={msg.id}
      style={{
        display: 'flex',
        gap: 12,
        flexDirection: isUser ? 'row-reverse' : 'row',
        alignItems: 'flex-start',
      }}
      onMouseEnter={() => onHover(msg.id)}
      onMouseLeave={() => onHover(null)}
    >
      {/* Avatar */}
      {!isUser && (
        <div
          style={{
            width: 34,
            height: 34,
            borderRadius: 10,
            flexShrink: 0,
            background: `${withAlpha(agColor, 8)}`,
            border: `1px solid ${withAlpha(agColor, 19)}`,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 16,
            boxShadow: `0 0 12px ${withAlpha(agColor, 6)}`,
          }}
        >
          {emoji}
        </div>
      )}
      <div
        style={{
          maxWidth: isCycle ? '88%' : '76%',
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          alignItems: isUser ? 'flex-end' : 'flex-start',
        }}
      >
        {/* Name */}
        {!isUser && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              paddingLeft: 4,
            }}
          >
            <span
              style={{
                fontFamily: CR.sans,
                fontSize: 11,
                fontWeight: 600,
                color: agColor,
              }}
            >
              {agentName}
            </span>
            {msg.source === 'whatsapp' && <WaSourceBadge />}
          </div>
        )}
        {/* Cycle turn → inline working-timeline (thinking +
                    tool steps + answer as one thread). Plain reply
                    or user message → chat bubble. */}
        {isCycle ? (
          <div style={{ width: '100%', paddingLeft: 4 }}>
            <CycleTimeline
              steps={filteredTrace}
              agentColor={agColor}
              finalAnswerText={finalAnswerText}
              mdComponents={mdComponents}
            />
          </div>
        ) : (
          <div style={{ position: 'relative' }}>
            <div
              style={{
                padding: '12px 16px',
                borderRadius: isUser
                  ? '16px 4px 16px 16px'
                  : '4px 16px 16px 16px',
                background: isUser
                  ? `linear-gradient(135deg, ${CR.accent}, ${CR.accentWarm})`
                  : CR.bgCard,
                border: isUser ? 'none' : `1px solid ${CR.border}`,
                boxShadow: isUser
                  ? `0 4px 16px ${CR.accent30}`
                  : '0 2px 8px var(--cr-shade-1)',
                fontFamily: CR.sans,
                fontSize: 13.5,
                color: isUser ? 'var(--cr-on-accent)' : CR.text,
                lineHeight: 1.7,
              }}
            >
              {isUser ? (
                <div>
                  {msg.images && msg.images.length > 0 && (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 6,
                        marginBottom: msg.content ? 8 : 0,
                      }}
                    >
                      {msg.images.map((im: string, i: number) => (
                        <img
                          key={i}
                          src={im}
                          alt={`attachment ${i + 1}`}
                          style={{
                            maxHeight: 140,
                            maxWidth: '100%',
                            borderRadius: 8,
                            display: 'block',
                          }}
                        />
                      ))}
                    </div>
                  )}
                  {msg.content && <span>{msg.content}</span>}
                </div>
              ) : (
                <div className="agent-md">
                  <ReactMarkdown
                    remarkPlugins={[remarkGfm]}
                    components={mdComponents}
                  >
                    {finalAnswerText}
                  </ReactMarkdown>
                </div>
              )}
            </div>
            {/* Copy button — appears on hover for agent messages */}
            {!isUser && isHovered && finalAnswerText && (
              <button
                onClick={() => {
                  navigator.clipboard.writeText(finalAnswerText);
                  onCopied(msg.id);
                  setTimeout(() => onCopied(null), 1800);
                }}
                style={{
                  position: 'absolute',
                  top: 6,
                  right: -32,
                  background: CR.bgSurf,
                  border: `1px solid ${CR.border}`,
                  borderRadius: 6,
                  padding: '3px 6px',
                  cursor: 'pointer',
                  fontSize: 11,
                  color: isCopied ? 'var(--cr-green)' : CR.muted,
                  transition: 'color 0.2s',
                }}
                title="Copy"
              >
                {isCopied ? '✓' : '⎘'}
              </button>
            )}
            {/* Older cycle — trace wasn't eagerly fetched. Load it on demand. */}
            {untracedCycleId && onLoadTrace && agentId && (
              <button
                onClick={() => onLoadTrace(agentId, msg.id, untracedCycleId)}
                style={{
                  marginTop: 6,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  fontFamily: CR.mono,
                  fontSize: 10.5,
                  color: CR.muted,
                  textDecoration: 'underline',
                  padding: 0,
                }}
              >
                Show tool-call details
              </button>
            )}
          </div>
        )}
        {/* HTML artifact card — shared with the project chat. */}
        {!isUser &&
          (() => {
            const turnArtifact = detectTurnArtifact(msg.content, cycleTrace);
            return turnArtifact ? (
              <ArtifactCard
                artifact={turnArtifact}
                agentId={agentId ?? undefined}
              />
            ) : null;
          })()}
        {/* Files changed this turn — derived from agent_file_events (persisted per
                    cycle, survives reload), not a live-only workspace diff. Cycle id comes
                    from the message's own id (assistant "cycle result" messages are
                    `cyc-<cycleId>-result-…`), same extraction used for tool traces. */}
        {!isUser &&
          agentId &&
          (() => {
            const cid = (msg.id as string)?.match(/^cyc-(.+)-result-/)?.[1];
            return cid ? (
              <TurnFileChanges
                agentId={agentId}
                cycleId={cid}
                accentColor={agColor}
                eager={isEager}
                staggerMs={eagerStaggerMs}
              />
            ) : null;
          })()}
        {/* Timestamp (+ channel badge on the user side, where there's no name row) */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            flexDirection: isUser ? 'row-reverse' : 'row',
            paddingLeft: isUser ? 0 : 4,
            paddingRight: isUser ? 4 : 0,
          }}
        >
          <span style={{ fontFamily: CR.mono, fontSize: 9, color: CR.muted }}>
            {new Date(msg.created_at).toLocaleTimeString([], {
              hour: '2-digit',
              minute: '2-digit',
            })}
          </span>
          {isUser && msg.source === 'whatsapp' && <WaSourceBadge />}
        </div>
      </div>
    </div>
  );
});

// ─── Main Page ────────────────────────────────────────────────────────────────

export default function AgentProfilePage() {
  const { id: agentId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const isManageRoute = location.pathname.endsWith('/manage');
  const {
    agents,
    activityFeed,
    fetchAgents,
    fetchActivityFeed,
    chatHistory,
    fetchAgentChatHistory,
    loadAgentChatFromMessages,
    addChatMessage,
    upsertChatMessage,
    updateLastChatMessage,
    toolTraces: allToolTraces,
    addToolTrace,
    pendingCheckins,
    fetchPendingCheckins,
    agentFiles,
    fetchAgentFiles,
    agentSchedules,
    fetchAgentSchedule,
    updateAgent,
    availableTools,
    fetchAvailableTools,
    toggleAgentTool,
    agentLogs,
    fetchAgentLogs,
    startAgent,
    pauseAgent,
    stopAgent,
    interruptAgent,
    deleteAgent,
    patchAgent,
  } = useAgentsStore();
  const toolTraces = allToolTraces[agentId ?? ''] ?? {};

  // ── State ──────────────────────────────────────────────────────────────────
  const [tab, setTab] = useState<string>(() => {
    // Stage 20 — Chat is the default surface; allow ?tab= deep-link override.
    if (typeof window !== 'undefined') {
      const t = new URLSearchParams(window.location.search).get('tab');
      if (t) return t;
      if (window.location.pathname.endsWith('/manage')) return 'overview';
    }
    return 'chat';
  });
  const [chatInput, setChatInput] = useState('');
  // Stage 60 phase 1: Cloud or This computer, chosen under the message box.
  const [browserLane, setBrowserLane] = useBrowserLane(
    agentId ? `agent:${agentId}` : undefined,
  );
  // Three concrete jobs to open with, fetched once the page has already
  // rendered so the model call behind them is never in the user's way.
  const [starters, setStarters] = useState<string[]>([]);
  // Per-agent, persisted like ws-collapsed-* below — once dismissed, stay gone
  // across reloads instead of just for this render.
  const [startersDismissed, setStartersDismissed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(`starters-dismissed-${agentId}`) === '1';
    } catch {
      return false;
    }
  });
  const [pendingImages, setPendingImages] = useState<string[]>([]); // base64 data URLs for chat image paste/upload (multiple)
  const chatImageInputRef = useRef<HTMLInputElement>(null);
  const [isStreaming, setIsStreaming] = useState(false);
  // Stage 57 phase 5 — messages typed while the agent works. They wait here, in order, and
  // each is sent when the turn in flight ends (the Claude Code pattern). The input used to
  // be disabled while streaming, and the server dropped anything that got through.
  const [queuedSends, setQueuedSends] = useState<
    Array<{ id: string; msg: string; imgs: string[] }>
  >([]);
  const [slashQuery, setSlashQuery] = useState<string | null>(null); // null = closed
  const [slashIndex, setSlashIndex] = useState(0);
  // Stage 20 — @ mention + # file pickers in the agent chat (agent-chat shared logic)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionIndex, setMentionIndex] = useState(0);
  const mentionStartRef = useRef<number>(-1);
  const [fileQuery, setFileQuery] = useState<string | null>(null);
  const [fileIndex, setFileIndex] = useState(0);
  const fileStartRef = useRef<number>(-1);
  const chatInputRef = useRef<HTMLTextAreaElement>(null);
  // Reference-file attach (+ button): hand the agent files/folders it keeps under references/.
  const refFileInputRef = useRef<HTMLInputElement>(null);
  const refFolderInputRef = useRef<HTMLInputElement>(null);
  // Workspace upload (project-folder model): drop files/folders straight into workspace/.
  const wsFileInputRef = useRef<HTMLInputElement>(null);
  const wsFolderInputRef = useRef<HTMLInputElement>(null);
  const [showAttachMenu, setShowAttachMenu] = useState(false);
  const [uploadingRefs, setUploadingRefs] = useState(false);
  const [refToast, setRefToast] = useState<string | null>(null);
  // Files staged for a create-agent approval card (seed-at-birth). Keyed by check-in id.
  const [stagedRefs, setStagedRefs] = useState<
    Record<string, { token: string; files: string[]; uploading?: boolean }>
  >({});
  // Optional free-text note the user adds alongside approve/reject (HITL is conversational).
  const [checkinNotes, setCheckinNotes] = useState<Record<string, string>>({});
  // Batch approval: nothing is selected until the user picks, so a stray click can never
  // dispatch the whole queue.
  const [selectedCheckins, setSelectedCheckins] = useState<
    Record<string, boolean>
  >({});
  const [batchNote, setBatchNote] = useState('');
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchResult, setBatchResult] = useState<{
    succeeded: number;
    failed: { id: string; error: string }[];
  } | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  // Identity version history
  const [identityVersions, setIdentityVersions] = useState<
    { version: number; modified: string }[]
  >([]);
  // Lazily loaded: the full generated IDENTITY.md, which the Mission field is only one part of.
  const [fullIdentity, setFullIdentity] = useState<string | null>(null);
  // Failing audit-check labels, surfaced on Overview. Read-only and cheap; null while
  // loading or if the audit endpoint errors, so a hiccup never renders a false alarm.
  const [auditFail, setAuditFail] = useState<string[] | null>(null);
  const [selectedVersion, setSelectedVersion] = useState<number | null>(null);
  const [versionContent, setVersionContent] = useState<string | null>(null);
  const [versionLoading, setVersionLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [showDiff, setShowDiff] = useState(false);
  const [isCycleRunning, setIsCycleRunning] = useState(false);
  const [missionEdit, setMissionEdit] = useState('');
  const [jobDrawer, setJobDrawer] = useState<{
    jobId: string;
    title: string;
    resultText: string;
    isSuccess: boolean;
    agentId?: string;
    initialFile?: {
      filename: string;
      content: string;
      path?: string;
      context?: string;
      contextId?: string;
    };
  } | null>(null);
  // When a Log row is clicked, switch to chat and scroll to that cycle's messages.
  const [pendingScrollCycle, setPendingScrollCycle] = useState<string | null>(
    null,
  );

  // Memory
  const [agentMemory, setAgentMemory] = useState<AgentMemory[]>([]);
  const [memoryFilter, setMemoryFilter] = useState('');
  const [memoryFile, setMemoryFile] = useState<string | null>(null);
  const [memoryLoading, setMemoryLoading] = useState(false);

  // Checkins
  const [checkins, setCheckins] = useState<AgentCheckin[]>([]);
  const [checkinReplies, setCheckinReplies] = useState<Record<string, string>>(
    {},
  );
  const [checkinSending, setCheckinSending] = useState<Record<string, boolean>>(
    {},
  );

  // Budget
  const [budget, setBudget] = useState<BudgetInfo | null>(null);

  // Handoffs
  const [handoffs, setHandoffs] = useState<any[]>([]);
  const [handoffsLoading, setHandoffsLoading] = useState(false);
  const [convos, setConvos] = useState<Conversation[]>([]);
  const [convosLoading, setConvosLoading] = useState(false);
  const [showHandoffModal, setShowHandoffModal] = useState(false);
  const [allAgents, setAllAgents] = useState<
    Array<{ id: string; name: string; emoji?: string; type?: string }>
  >([]);

  // Inter-agent messages
  // The Messages tab is retired. `agent_messages` was the earlier inter-agent channel —
  // subject and body, no reply, nothing to answer — and it lost to handoffs for exactly
  // that reason: 23 messages, none since 2026-08-31, and the `message` tool is
  // unregistered by the adapter so no agent can send one. Its history now shows as
  // single-turn threads in Conversations. Two screens where one channel is dead is how
  // someone ends up reading the wrong one.

  // Sub-agents
  const [subAgents, setSubAgents] = useState<any[]>([]);
  const [agentProjects, setAgentProjects] = useState<
    Array<{ id: string; name: string; role?: string }>
  >([]);
  const [projectOverflowOpen, setProjectOverflowOpen] = useState(false);

  // Sidecar status
  const [sidecarStatus, setSidecarStatus] = useState<{
    state: string;
    log: string[];
    installingPkg?: string;
    failedReason?: string;
  } | null>(null);
  const [sidecarRestarting, setSidecarRestarting] = useState(false);

  // Outputs (sidecar-produced files)
  const [outputs, setOutputs] = useState<
    Array<{
      name: string;
      size: number;
      mimeType: string;
      createdAt: string;
      url: string;
    }>
  >([]);
  const [outputsLoading, setOutputsLoading] = useState(false);
  const [outputPreview, setOutputPreview] = useState<{
    name: string;
    mimeType: string;
  } | null>(null);

  // Artifacts (typed outputs registered via emit_artifact)
  const [artifacts, setArtifacts] = useState<
    Array<{
      id: string;
      type: string;
      title: string;
      file: string;
      description: string;
      size: number;
      createdAt: string;
      cycleId: string;
      url: string;
    }>
  >([]);
  const [artifactsLoading, setArtifactsLoading] = useState(false);
  // The Manage page's own Artifacts view has no chat-drawer instance of its own to
  // open a file in, so it keeps one small local drawer just for that — same
  // `initialFile` mechanism jobDrawer already uses elsewhere in this file, not a new
  // mechanism. Replaces a standalone modal + its own duplicate copy of this list.
  const [manageFilePreview, setManageFilePreview] = useState<{
    filename: string;
    content: string;
    path?: string;
    context?: string;
    contextId?: string;
  } | null>(null);

  // Project picker removed — agent chat is for direct work; project work goes in the project chat.

  // Live progress feed from running cycle
  const [liveProgress, setLiveProgress] = useState<
    Array<{
      type: string;
      tool?: string;
      args?: any;
      preview?: string;
      message?: string;
      n?: number;
      of?: number;
      total_tokens?: number;
    }>
  >([]);

  // Mid-cycle urgent notifications pushed by the agent
  const [midCycleAlert, setMidCycleAlert] = useState<{
    message: string;
    urgency: string;
    timestamp: string;
  } | null>(null);

  // Live tool activity during agentic chat streaming
  const [liveTools, setLiveTools] = useState<
    Array<{ id: string; name: string; args: string; result?: string }>
  >([]);
  // stage44 doc 01: the newest live browser frame (a base64 JPEG data URL) pushed by
  // an effector run, or null when nothing is driving a browser right now.
  const [liveFrame, setLiveFrame] = useState<string | null>(null);
  // True once the cycle that produced `liveFrame` has finished: the picture is
  // still the last thing the browser showed, but nothing is driving it any more.
  const [liveFrameEnded, setLiveFrameEnded] = useState(false);
  // stage45 item 2: where the browser IS, beside what it looks like. Both are
  // page-controlled strings — rendered as text, never as a link href.
  const [liveFrameUrl, setLiveFrameUrl] = useState<string>('');
  const [liveFrameTitle, setLiveFrameTitle] = useState<string>('');
  // stage45 item 1: archived per-step frames from past effector runs.
  type BrowserFrame = {
    turn: number;
    action: string;
    file: string;
    url: string;
    title: string;
    status: string;
  };
  type BrowserRun = {
    runId: string;
    frames: BrowserFrame[];
    updatedAt: number;
    lastUrl: string;
  };
  const [browserRuns, setBrowserRuns] = useState<BrowserRun[]>([]);
  const [browserRunIdx, setBrowserRunIdx] = useState(0);
  const [browserFrameIdx, setBrowserFrameIdx] = useState(0);
  const [browserLoading, setBrowserLoading] = useState(false);
  // stage45 item 4: the files a browser run pulled off a page. Gap E produces these
  // and, until now, nothing in the run view mentioned them — they existed only under
  // Manage > Files, which is not where anyone looks after watching a run.
  type WsFile = {
    path: string;
    size: number;
    modified: string;
    type: 'file' | 'dir';
  };
  const [browserPane, setBrowserPane] = useState<'browser' | 'files'>(
    'browser',
  );
  const [browserFiles, setBrowserFiles] = useState<WsFile[]>([]);
  // stage45 item 5: a note to a run already in flight. `liveCycleId` comes off the
  // frame payload, which is the only thing that knows which cycle is on screen.
  const [liveCycleId, setLiveCycleId] = useState<string>('');
  const [steerText, setSteerText] = useState('');
  const [steerSent, setSteerSent] = useState(0);
  // Last non-empty live-stream snapshot — seeds a completed message's trace instantly (no blink).
  // Stage 35 Phase 2 — the single read path, behind FLAGS.conversationEvents. The
  // hook is called unconditionally (hook order must stay stable) but does no work
  // when the flag is off, so the legacy path pays nothing for it.
  const {
    events: conversationEvents,
    loading: conversationLoading,
    error: conversationError,
    hasOlder: conversationHasOlder,
    loadingOlder: conversationLoadingOlder,
    loadOlder: conversationLoadOlder,
    reload: reloadConversationEvents,
  } = useConversationEvents(
    agentId ? `agent:${agentId}` : null,
    FLAGS.conversationEvents,
  );

  const liveStepsRef = useRef<
    Array<{ id: string; name: string; args: string; result?: string }>
  >([]);
  useEffect(() => {
    if (liveTools.length > 0) liveStepsRef.current = liveTools;
  }, [liveTools]);
  // Debounce timer for live workspace-tree refreshes triggered mid-turn by
  // write_file/edit_file/append_file completions (see onActivity below) — several
  // file writes in a row within one turn should only trigger one refetch.
  const fileRefreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
    null,
  );
  // Stage 20 — map agent chat activity into the shared ActivityDock shape (agent-chat shared logic).
  // stage44 doc 01, step 4: only show the browser view while an effector tool is
  // actually the one running. liveTools is append-only within a turn, so the LAST
  // entry is the active tool — an effector run that finished mid-turn should not
  // leave a frozen frame on screen while the next tool works.
  const effectorIsActive = useMemo(() => {
    const active = liveTools[liveTools.length - 1];
    return (
      !!active && active.result === undefined && EFFECTOR_TOOLS.has(active.name)
    );
  }, [liveTools]);

  const liveSteps = useMemo<ActivityStep[]>(
    () =>
      liveTools.map((t) => ({
        id: t.id,
        type: 'tool_call' as const,
        tool: t.name,
        input: t.args,
        output: t.result,
        done: t.result !== undefined,
      })),
    [liveTools],
  );
  // The dock's Web / Files / Shell tabs, built from every tool step this session.
  //
  // Under the event stream this MUST come from the log: `toolTraces` is filled by the
  // legacy per-cycle /activity-trace fetches, which are gated off on that path — so
  // reading it here would leave the dock silently empty of history. (toolTraces feeds
  // two consumers, the legacy chat row and this; gating the fetch for the first broke
  // the second.) buildTurns already pairs each call with its result by call_id, so the
  // steps come out of the same tested fold the chat uses.
  const sessionSteps = useMemo<ActivityStep[]>(() => {
    if (FLAGS.conversationEvents) {
      return buildTurns(conversationEvents)
        .flatMap((t) => (t.kind === 'agent' ? t.steps : []))
        .map((s) => ({
          id: s.id ?? '',
          type: 'tool_call' as const,
          tool: s.name,
          input: s.args,
          output: s.result,
          done: s.result !== undefined,
        }));
    }
    return Object.values(allToolTraces[agentId ?? ''] ?? {})
      .flat()
      .map((t: any) => ({
        id: t.id,
        type: 'tool_call' as const,
        tool: t.name,
        input: t.args,
        output: t.result,
        done: t.result !== undefined,
      }));
  }, [conversationEvents, allToolTraces, agentId]);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [hoveredMsgId, setHoveredMsgId] = useState<string | null>(null);
  // Workspace tree: folders are expanded by default; a path here means collapsed.
  const [wsCollapsed, setWsCollapsed] = useState<Set<string>>(() => {
    try {
      const s = localStorage.getItem(`ws-collapsed-${agentId}`);
      return s ? new Set(JSON.parse(s)) : new Set();
    } catch {
      return new Set();
    }
  });
  useEffect(() => {
    localStorage.setItem(
      `ws-collapsed-${agentId}`,
      JSON.stringify([...wsCollapsed]),
    );
  }, [wsCollapsed, agentId]);
  const [wsDrawerOpen, setWsDrawerOpen] = useState(false);
  const [browserDrawerOpen, setBrowserDrawerOpen] = useState(false);
  // Desktop app: opening the browser tab shows the real pane beside the dashboard.
  // Inert on the web.
  useDesktopBrowserPanel(browserDrawerOpen);

  // Marks the drawer's Browser tab while a browser is actually open, so the tab
  // itself says there is something live to look at.
  const browserLiveForThisAgent = useLiveBrowsersStore((s) =>
    isBrowserLive(s.byAgent, agentId),
  );
  // A run that has STOPPED and is waiting on you is not the same as one merely
  // browsing, and the tab has to say which — the whole point of the ask is that
  // somebody notices it.
  const browserWaitingForThisAgent = useLiveBrowsersStore(
    (s) => !!(agentId && s.waiting[agentId]),
  );
  // Bumped alongside fetchAgentFiles() below so the open workspace drawer (if any)
  // refetches too, not just the tab-mounted tree in Manage > Files.
  const [wsRefreshSignal, setWsRefreshSignal] = useState(0);
  const [agentInspectDrawer, setAgentInspectDrawer] = useState<
    'outputs' | 'artifacts' | null
  >(null);

  /**
   * Open one dock drawer, closing whatever else was open. Clicking the open one shuts it.
   *
   * The drawers are four independent booleans, so each chip used to be responsible for
   * clearing the other three — and the moment Browser was added, Workspace and
   * Artifacts still knew nothing about it and would open alongside, squashing the chat
   * between two panels. Making every chip remember every other chip is a rule that
   * breaks again the next time one is added, so the state lives in one place instead.
   */
  const toggleDock = useCallback(
    (which: 'workspace' | 'browser' | 'artifacts' | null) => {
      setJobDrawer(null);
      setWsDrawerOpen(which === 'workspace' ? !wsDrawerOpen : false);
      setBrowserDrawerOpen(which === 'browser' ? !browserDrawerOpen : false);
      setAgentInspectDrawer(
        which === 'artifacts'
          ? agentInspectDrawer === 'artifacts'
            ? null
            : 'artifacts'
          : null,
      );
    },
    [wsDrawerOpen, browserDrawerOpen, agentInspectDrawer],
  );

  // The same rule from the other direction. A job/file drawer is opened from five
  // places — a file in the tree, a reference, a tool result — and none of them knew
  // about the dock drawers, so opening a file while Workspace was open showed both and
  // squeezed the chat between them. Stated once as a fact about the state rather than
  // as a duty of five call sites: if a job drawer is open, nothing else is.
  useEffect(() => {
    if (!jobDrawer) return;
    setWsDrawerOpen(false);
    setBrowserDrawerOpen(false);
    setAgentInspectDrawer(null);
  }, [jobDrawer]);
  // Keep only one push drawer open at a time — opening a job result closes the workspace.
  useEffect(() => {
    if (jobDrawer) setWsDrawerOpen(false);
  }, [jobDrawer]);
  const [manageOpen, setManageOpen] = useState(
    () =>
      typeof window !== 'undefined' &&
      window.location.pathname.endsWith('/manage'),
  );

  // Stage 23 — one home for every non-chat surface. Chat stays the primary view;
  // the Manage panel hosts a grouped sidebar (Inspect / Configure) beside the content.
  // 'general' is the core-settings form, rendered inline in the content pane like any tab.
  const MANAGE_GROUPS: {
    group: string;
    items: { id: string; label: string; icon: string }[];
  }[] = [
    {
      group: 'Inspect',
      items: [
        { id: 'overview', label: 'Overview', icon: '◎' },
        { id: 'audit', label: 'Audit', icon: '🩺' },
        { id: 'memory', label: 'Memory', icon: '🧠' },
        { id: 'outputs', label: 'Outputs', icon: '📤' },
        { id: 'artifacts', label: 'Artifacts', icon: '📦' },
        { id: 'handoffs', label: 'Handoffs', icon: '🔗' },
        { id: 'checkins', label: 'Check-ins', icon: '✅' },
        { id: 'workspace', label: 'Files', icon: '📁' },
        { id: 'browser', label: 'Browser', icon: '🖥️' },
      ],
    },
    {
      group: 'Configure',
      items: [
        { id: 'general', label: 'General', icon: '⚙️' },
        { id: 'models', label: 'Models', icon: '🧬' },
        { id: 'identity', label: 'Identity', icon: '🪪' },
        { id: 'schedule', label: 'Schedule', icon: '🕐' },
        { id: 'approvals', label: 'Approval rules', icon: '🛡️' },
        { id: 'tools', label: 'Tools & Skills', icon: '🔧' },
        { id: 'channels', label: 'Channels', icon: '📡' },
        { id: 'secrets', label: 'Secrets', icon: '🔑' },
        { id: 'webhooks', label: 'Webhooks', icon: '🪝' },
      ],
    },
  ];
  const MANAGE_TAB_IDS = MANAGE_GROUPS.flatMap((g) => g.items.map((i) => i.id));

  // Sync manageOpen with the /manage sub-route (browser back/forward support).
  useEffect(() => {
    if (isManageRoute) {
      setManageOpen(true);
      setTab((t) => (t === 'chat' ? 'overview' : t));
    } else {
      setManageOpen(false);
    }
  }, [isManageRoute]);

  // Open the Manage panel — navigates to /agents/:id/manage (URL-addressable).
  const openManage = (sectionId?: string) => {
    setTab(sectionId ?? (tab === 'chat' ? 'overview' : tab));
    navigate(`/agents/${agentId}/manage`);
  };
  const closeManage = () => {
    setTab('chat');
    navigate(`/agents/${agentId}`);
  };

  const chatBodyRef = useRef<HTMLDivElement>(null);
  const [isAtBottom, setIsAtBottom] = useState(true);
  const isAtBottomRef = useRef(true);
  const prevHistCountRef = useRef(0);
  // The chat body <div> is conditionally rendered on `tab === 'chat'`, so it
  // unmounts/remounts on every Manage round-trip — a fresh DOM node always
  // starts at scrollTop 0. The scroll-to-bottom effect below only re-fires
  // when `history` changes, which it doesn't just from visiting Manage and
  // coming back, so the remount was landing at the top. A callback ref fires
  // on every (re)attach regardless of `history`, so it catches this case too.
  const setChatBodyRef = useCallback((el: HTMLDivElement | null) => {
    chatBodyRef.current = el;
    if (el && isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, []);

  const agent = agents.find((a) => a.id === agentId);

  const history = agentId ? chatHistory[agentId] || [] : [];

  // A thread the user has not spoken in yet. The agent's own welcome line does
  // not count — the blank page problem is about the user having nothing to say,
  // not about the thread being literally empty.
  const awaitingFirstMessage = !history.some((m) => m.role === 'user');

  useEffect(() => {
    if (!agentId || !awaitingFirstMessage || startersDismissed) {
      setStarters([]);
      return;
    }
    let cancelled = false;
    getAgentStarters(agentId)
      .then((r) => {
        if (!cancelled) setStarters(r.starters);
      })
      .catch(() => {
        /* no chips is the pre-existing behaviour, not an error */
      });
    return () => {
      cancelled = true;
    };
  }, [agentId, awaitingFirstMessage, startersDismissed]);

  function dismissStarters() {
    setStarters([]);
    setStartersDismissed(true);
    try {
      localStorage.setItem(`starters-dismissed-${agentId}`, '1');
    } catch {
      /* private mode etc — dismissal just won't persist */
    }
  }

  // ── Hooks ──────────────────────────────────────────────────────────────────

  // Log → chat: after switching to the chat tab, scroll to the clicked cycle's
  // first message (its id is tagged `cyc-<cycleId>-start-…`). Waits for render.
  useEffect(() => {
    if (tab !== 'chat' || !pendingScrollCycle) return;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout>;
    const tryScroll = () => {
      const el =
        document.querySelector(
          `[data-msgid^="cyc-${pendingScrollCycle}-start"]`,
        ) ||
        document.querySelector(`[data-msgid^="cyc-${pendingScrollCycle}-"]`);
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        setPendingScrollCycle(null);
        return;
      }
      if (++tries < 10) timer = setTimeout(tryScroll, 150);
      else setPendingScrollCycle(null);
    };
    timer = setTimeout(tryScroll, 150);
    return () => clearTimeout(timer);
  }, [tab, pendingScrollCycle, history]);

  // Fetch + normalize one cycle's activity trace (thinking + tool calls +
  // outputs) and stash it against the chat message that summarizes it.
  // Deliberately per-cycle, not batched: a batched /cycles/details call
  // (fetching all eager cycles in one request) was tried and reverted — it
  // traded 12 independent, isolated requests for a single point of failure,
  // and when that one big call was slow, NONE of the recent cycles showed
  // detail instead of most of them showing fine. Isolated per-cycle calls
  // degrade better even if they're not maximally efficient.
  const loadTraceFor = useCallback(
    (agentIdArg: string, msgId: string, cid: string, delayMs = 0) => {
      if (fetchedTraceMsgIds.has(msgId)) return;
      fetchedTraceMsgIds.add(msgId);
      (async () => {
        try {
          if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
          const r = await fetch(
            `/api/agents/${agentIdArg}/cycles/${cid}/activity-trace`,
          );
          if (!r.ok) return;
          const d = await r.json();
          const steps: any[] = Array.isArray(d?.steps) ? d.steps : [];
          const trace = steps
            .filter((s) => s.type === 'tool_call' || s.type === 'thinking')
            .map((s, i) =>
              s.type === 'thinking'
                ? {
                    id: `th-${i}`,
                    name: 'thinking',
                    args: '{}',
                    result:
                      typeof s.content === 'string'
                        ? s.content
                        : JSON.stringify(s.content ?? ''),
                  }
                : {
                    id: s.id ?? `tc-${i}`,
                    name: s.tool ?? 'tool',
                    args:
                      typeof s.input === 'string'
                        ? s.input
                        : JSON.stringify(s.input ?? {}),
                    result: s.output ?? undefined,
                  },
            );
          if (trace.length) addToolTrace(agentIdArg, msgId, trace);
        } catch {
          /* trace stays absent — message still shows its text */
        }
      })();
    },
    [addToolTrace],
  );

  // Hydrate cycle-result chat messages with their persisted activity trace —
  // the same data the old drawer Activity tab showed — so the rich trace
  // lives inline in the chat, not just the ephemeral live dock that clears
  // on 'done'. Only the most recent cycles hydrate automatically; older ones
  // show their final answer text immediately and load detail on click
  // (WhatsApp-style "load more as you scroll" instead of eagerly pulling in
  // everything up front). Staggered ~120ms apart — better-sqlite3 is fully
  // synchronous, so N requests landing in the same tick means N synchronous
  // DB reads back-to-back with nothing yielding in between.
  const EAGER_DETAIL_LIMIT = 12;
  const EAGER_TRACE_STAGGER_MS = 120;
  const eagerCycleStagger = useMemo(() => {
    const map = new Map<string, number>();
    let slot = 0;
    for (let i = history.length - 1; i >= 0 && slot < EAGER_DETAIL_LIMIT; i--) {
      const m = history[i];
      const cid = (m.id as string)?.match(/^cyc-(.+)-result-/)?.[1];
      if (!cid) continue;
      map.set(m.id, slot++);
    }
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [history]);

  const eagerCycleMsgIds = eagerCycleStagger;

  // Eagerly hydrate each recent cycle's tool trace — one /activity-trace request per
  // cycle. Legacy path ONLY: these feed `toolTraces`, which only the legacy chat row
  // reads. Under the event stream the trace is already in the log, so leaving this
  // ungated fired N per-cycle requests on every page load that nothing rendered —
  // the exact per-cycle fetching the one-log read path exists to delete. Invisible
  // until they showed up in the console as 502s during a deploy restart.
  useEffect(() => {
    if (!agentId || FLAGS.conversationEvents) return;
    for (const [msgId, slot] of eagerCycleStagger) {
      const cid = (msgId as string).match(/^cyc-(.+)-result-/)?.[1];
      if (!cid || fetchedTraceMsgIds.has(msgId)) continue;
      loadTraceFor(agentId, msgId, cid, slot * EAGER_TRACE_STAGGER_MS);
    }
  }, [agentId, loadTraceFor, eagerCycleStagger]);

  // Subscribe to cycle progress SSE whenever a cycle is running on this agent —
  // tests, manual runs, scheduled runs, and `/run` slash commands all flow through here.
  useEffect(() => {
    const agentRunning = agent?.status === 'running';
    const cycleActive = isCycleRunning || agentRunning;
    if (!cycleActive || !agentId) return;
    setLiveProgress([]);
    setMidCycleAlert(null);
    const es = new EventSource(`/api/agents/${agentId}/cycle/stream`);
    es.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'cycle_progress') {
          setLiveProgress((prev) => [...prev.slice(-49), data.event]);
        } else if (data.type === 'notification') {
          setMidCycleAlert({
            message: data.message,
            urgency: data.urgency,
            timestamp: data.timestamp,
          });
        }
      } catch {
        /* ignore */
      }
    };
    return () => es.close();
  }, [isCycleRunning, agent?.status, agentId]);

  useEffect(() => {
    if (!agents.length) fetchAgents();
    fetchActivityFeed();
  }, [agents.length, fetchAgents, fetchActivityFeed]);

  useEffect(() => {
    if (agentId) {
      fetch(`/api/agents/${agentId}/sub-agents`)
        .then((r) => r.json())
        .then(setSubAgents)
        .catch(() => {});
      fetch(`/api/agents/${agentId}/projects`)
        .then((r) => (r.ok ? r.json() : []))
        .then((d) =>
          setAgentProjects(Array.isArray(d) ? d : (d.projects ?? [])),
        )
        .catch(() => setAgentProjects([]));
    }
  }, [agentId]);

  useEffect(() => {
    if (agent && !missionEdit) setMissionEdit(agent.config.goals || '');
  }, [agent, missionEdit]);

  // Stage 20 — the agent's Chat tab is now a unified `agent:<id>` conversation
  // backed by the real (nanobot) runtime, not the legacy light-runtime endpoint.
  useEffect(() => {
    if (tab === 'chat' && agentId) {
      loadAgentChatFromMessages(agentId);
      fetchAgentFiles(agentId);
      fetchPendingCheckins();
    }
  }, [tab, agentId]);

  // Subscribe to live socket events for this agent's thread while the Chat tab is open.
  useEffect(() => {
    if (tab !== 'chat' || !agentId) return;
    const jid = `agent:${agentId}`;

    const onMsg = (d: {
      id: string;
      chatJid: string;
      text: string;
      timestamp: string;
      sender: string;
      fromUser?: boolean;
      source?: string;
    }) => {
      if (d.chatJid !== jid) return;
      // Seed the trace from the live stream the moment a completed cycle message arrives,
      // so it renders as the thread instantly instead of flashing a plain bubble until the
      // refetch lands. The hydration effect still fetches to reconcile with the DB.
      if (
        !d.fromUser &&
        /^cyc-.+-result-/.test(d.id) &&
        liveStepsRef.current.length > 0
      ) {
        const existing = useAgentsStore.getState().toolTraces[agentId]?.[d.id];
        if (!existing?.length)
          addToolTrace(agentId, d.id, liveStepsRef.current);
      }
      // upsert so a streamed reply (same id, growing text) renders progressively (gap D).
      // fromUser → the human's request (e.g. an API/Start-triggered cycle) so it
      // renders on the user side, not as an agent bubble.
      upsertChatMessage(agentId, {
        id: d.id,
        role: d.fromUser ? 'user' : 'assistant',
        content: d.text,
        created_at: d.timestamp,
        source: d.source,
      });
    };
    const onTyping = (d: { chatJid: string; isTyping: boolean }) => {
      if (d.chatJid !== jid) return;
      setIsStreaming(d.isTyping);
      // Reconcile the Files/Workspace tab once the turn fully ends (the mid-turn
      // debounced refresh above already covers the common case of watching files
      // appear live; this is just a final catch-all).
      if (!d.isTyping && agentId) {
        setTimeout(() => {
          fetchAgentFiles(agentId);
        }, 1500);
      }
    };
    const onActivity = (d: {
      chatJid: string;
      type: string;
      callId?: string;
      tool?: string;
      input?: string;
      output?: string;
      content?: string;
    }) => {
      if (d.chatJid !== jid) return;
      if (d.type === 'start') {
        setLiveTools([]);
        setLiveFrame(null);
        setLiveFrameEnded(false);
      } else if (d.type === 'thinking') {
        setLiveTools((prev) => [
          ...prev,
          {
            id: `th-${Date.now()}`,
            name: 'thinking',
            args: '{}',
            result: d.content || '…',
          },
        ]);
      } else if (d.type === 'tool_call' && d.tool) {
        setLiveTools((prev) => [
          ...prev,
          {
            id: d.callId ?? `${Date.now()}`,
            name: d.tool!,
            args: d.input ?? '{}',
          },
        ]);
      } else if (d.type === 'tool_result' && d.callId) {
        let completedToolName: string | undefined;
        setLiveTools((prev) =>
          prev.map((t) => {
            if (t.id !== d.callId) return t;
            completedToolName = t.name;
            return { ...t, result: d.output };
          }),
        );
        // Live-refresh the Files/Workspace tab the moment a write/edit/append
        // completes, instead of only after the whole turn ends — mirrors the
        // "appears the instant it's written" behavior of a local coding tool.
        // Debounced so a burst of file writes in one turn triggers one refetch.
        if (
          completedToolName &&
          FILE_MUTATING_TOOLS.has(completedToolName) &&
          agentId
        ) {
          if (fileRefreshTimerRef.current)
            clearTimeout(fileRefreshTimerRef.current);
          fileRefreshTimerRef.current = setTimeout(() => {
            fetchAgentFiles(agentId);
            setWsRefreshSignal((n) => n + 1);
          }, 400);
        }
      } else if (d.type === 'done') {
        setLiveTools([]);
        // The browser is gone the moment the cycle ends, and a still image must
        // not look like a live view — but dropping it left nothing at all for
        // anyone who arrived after the run, which is most of the time. Frames
        // are never persisted (cycle-activity-stream.ts: "a live view of a
        // browser that has already moved on"), so this is the only trace of
        // where it ended up. Keep it, and say plainly that it has stopped.
        setLiveFrameEnded(true);
      }
    };

    // stage44 doc 01, step 3: live browser frames. Same jid guard as every other
    // handler here — one socket carries every chat this user can see.
    const onFrame = (d: {
      chatJid: string;
      dataUrl: string;
      url?: string;
      title?: string;
      cycleId?: string;
    }) => {
      if (d.chatJid !== jid) return;
      setLiveFrame(d.dataUrl);
      setLiveFrameEnded(false);
      // Only overwrite with something real: a frame pushed from a dead page has
      // no url, and blanking the bar on the last frame of a run would lose the
      // one label that says where it ended up.
      if (d.url) setLiveFrameUrl(d.url);
      if (d.title) setLiveFrameTitle(d.title);
      if (d.cycleId) setLiveCycleId(d.cycleId);
    };

    const onCheckin = (d: { agentId: string }) => {
      if (d.agentId !== agentId) return;
      fetchPendingCheckins(); // refresh so the inline approval card appears live
    };

    socket.on('chat:message', onMsg);
    socket.on('chat:typing', onTyping);
    socket.on('chat:activity', onActivity);
    socket.on('chat:frame', onFrame);
    socket.on('agent:checkin_created', onCheckin);
    return () => {
      socket.off('chat:message', onMsg);
      socket.off('chat:typing', onTyping);
      socket.off('chat:activity', onActivity);
      socket.off('chat:frame', onFrame);
      socket.off('agent:checkin_created', onCheckin);
    };
  }, [tab, agentId, addChatMessage]);

  // Stage 20 Phase 4 — approve/edit/reject an inline approval card from chat.
  async function respondToCheckin(
    checkinId: string,
    reply: string,
    actionPayloadOverride?: string,
  ) {
    if (!agentId) return;
    const body: Record<string, string> = { reply };
    if (actionPayloadOverride)
      body.action_payload_override = actionPayloadOverride;
    try {
      await fetch(`/api/agents/${agentId}/checkins/${checkinId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      setTimeout(() => fetchPendingCheckins(), 800);
    } catch (err) {
      console.error('checkin respond error:', err);
    }
  }

  /**
   * Decide the selected check-ins in one request.
   *
   * Deliberately selection-driven rather than an "approve all" button. Deciding one at a
   * time was a click tax, not a safety feature — but the tax was doing safety's job, so
   * removing it wholesale would make it trivial to send a dozen cold emails nobody read.
   * Nothing is selected by default and the count is in the button.
   *
   * The batch endpoint exists because the per-item path kicks one agent follow-up cycle
   * each: `runCycle` refuses a concurrent cycle, so approving N drafts sent N emails but
   * silently skipped the bookkeeping turn for all but the first. This sends sequentially
   * and resumes the agent once, for all of them.
   */
  async function respondToCheckinsBatch(ids: string[], reply: string) {
    if (!agentId || ids.length === 0) return;
    setBatchBusy(true);
    setBatchResult(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/checkins/batch-respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids, reply }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || `HTTP ${res.status}`);
      // Surface per-item outcomes. A batch that half-worked must not look like a
      // batch that worked — the failures are the whole reason to read this.
      setBatchResult({
        succeeded: data.succeeded ?? 0,
        failed: (data.results ?? [])
          .filter((r: any) => !r.ok)
          .map((r: any) => ({ id: r.id, error: r.error ?? 'unknown error' })),
      });
      setSelectedCheckins({});
      setTimeout(() => fetchPendingCheckins(), 800);
    } catch (err: any) {
      console.error('checkin batch respond error:', err);
      setBatchResult({
        succeeded: 0,
        failed: [{ id: '—', error: String(err?.message ?? err) }],
      });
    } finally {
      setBatchBusy(false);
    }
  }

  // Jump to the newest message on first load, and stay pinned there while the user is
  // already at the bottom.
  //
  // This must watch whatever is actually RENDERED. Under the event stream the thread
  // comes from `conversationEvents`, and `history` (the legacy store) stays empty — so
  // keying this on `history` alone left the view parked at the very first message and
  // never followed a live turn. Depending on both keeps the legacy path working
  // unchanged; only one of them is ever populated.
  useEffect(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const count = FLAGS.conversationEvents
      ? conversationEvents.length
      : history.length;
    const isFirstLoad = prevHistCountRef.current === 0 && count > 0;
    prevHistCountRef.current = count;
    if (isFirstLoad || isAtBottomRef.current) {
      el.scrollTop = el.scrollHeight;
      isAtBottomRef.current = true;
      setIsAtBottom(true);
    }
  }, [history, conversationEvents]);

  // Follow the live turn: while the user is pinned to the bottom, keep the view stuck
  // to the latest as the streaming turn grows (live tools, tokens, and the in-progress
  // cycle trace). `history` doesn't change during a turn, so the effect above won't fire.
  // Bails out the moment the user scrolls up (isAtBottomRef), so it never hijacks reading.
  useEffect(() => {
    if (!isAtBottomRef.current) return;
    const el = chatBodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [liveTools, liveProgress, isStreaming, toolTraces]);

  const handleChatScroll = useCallback(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    isAtBottomRef.current = nearBottom;
    setIsAtBottom(nearBottom);
  }, []);

  const scrollToBottom = useCallback(() => {
    const el = chatBodyRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    isAtBottomRef.current = true;
    setIsAtBottom(true);
  }, []);

  useEffect(() => {
    if (tab === 'workspace' && agentId) fetchAgentFiles(agentId);
    if (tab === 'browser' && agentId) {
      setBrowserLoading(true);
      fetch(`/api/agents/${agentId}/browser-runs`)
        .then((r) => r.json())
        .then((runs: BrowserRun[]) => {
          setBrowserRuns(Array.isArray(runs) ? runs : []);
          setBrowserRunIdx(0);
          // Open on the LAST frame, not the first: the question this view
          // answers is almost always "where did it end up", and a run that
          // opens on a blank first page reads as broken.
          setBrowserFrameIdx(Math.max(0, (runs?.[0]?.frames?.length ?? 1) - 1));
        })
        .catch(() => setBrowserRuns([]))
        .finally(() => setBrowserLoading(false));
      fetch(`/api/agents/${agentId}/workspace/files?subdir=downloads`)
        .then((r) => r.json())
        .then((f: WsFile[]) =>
          setBrowserFiles(
            Array.isArray(f) ? f.filter((x) => x.type === 'file') : [],
          ),
        )
        .catch(() => setBrowserFiles([]));
    }
  }, [tab, agentId]);

  useEffect(() => {
    if (tab === 'schedule' && agentId) fetchAgentSchedule(agentId);
  }, [tab, agentId]);

  useEffect(() => {
    if (tab === 'tools' && agentId) fetchAvailableTools(agentId);
  }, [tab]);

  useEffect(() => {}, [tab, agentId]);

  useEffect(() => {
    if (tab === 'memory' && agentId) loadMemory();
  }, [tab, agentId]);

  useEffect(() => {
    if (tab === 'checkins' && agentId) loadCheckins();
  }, [tab, agentId]);

  useEffect(() => {
    if (tab === 'handoffs' && agentId) loadHandoffs();
  }, [tab, agentId]);

  useEffect(() => {
    if ((tab === 'outputs' || agentInspectDrawer === 'outputs') && agentId)
      loadOutputs();
  }, [tab, agentInspectDrawer, agentId]);

  useEffect(() => {
    if (tab === 'identity' && agentId) {
      fetch(`/api/agents/${agentId}/audit`)
        .then((r) => (r.ok ? r.json() : null))
        .then((a) => {
          if (!a?.checks) return;
          const f: string[] = [];
          if (a.checks.missingCredentials?.length)
            f.push(
              `Missing credentials: ${a.checks.missingCredentials.join(', ')}`,
            );
          if (a.checks.unknownTools?.length)
            f.push(`Unrecognised tools: ${a.checks.unknownTools.join(', ')}`);
          for (const p of a.checks.pinnedFiles ?? [])
            if (!p.exists)
              f.push(`Pinned file missing: ${p.path ?? p.name ?? 'unknown'}`);
          for (const d of a.checks.workspaceDirs ?? [])
            if (!d.exists)
              f.push(
                `Workspace folder missing: ${d.name ?? d.path ?? 'unknown'}`,
              );
          if (a.checks.scheduleOk === false)
            f.push('Schedule and trigger mode disagree');
          setAuditFail(f);
        })
        .catch(() => {
          /* non-fatal — never show a false alarm */
        });
      fetch(`/api/agents/${agentId}/identity-history`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setIdentityVersions)
        .catch(() => {});
    }
  }, [tab, agentId]);

  useEffect(() => {
    if ((tab === 'artifacts' || agentInspectDrawer === 'artifacts') && agentId)
      loadArtifacts();
  }, [tab, agentInspectDrawer, agentId]);

  // Poll sidecar status when on relevant tabs
  useEffect(() => {
    if (!agentId) return;
    // One-time fetch on mount to get current state
    fetch(`/api/agents/${agentId}/sidecar/status`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d) setSidecarStatus(d);
      })
      .catch(() => {});
    // Live updates via socket — no polling needed
    const handler = (data: any) => {
      if (data.agentId === agentId)
        setSidecarStatus({
          state: data.state,
          log: data.log ?? [],
          failedReason: data.failedReason,
        });
    };
    socket.on('agent:sidecar_status', handler);
    return () => {
      socket.off('agent:sidecar_status', handler);
    };
  }, [agentId]);

  // Load budget on mount
  useEffect(() => {
    if (agentId) {
      fetch(`/api/agents/${agentId}/budget`)
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setBudget(d))
        .catch(() => {});
    }
  }, [agentId]);

  // ── Loaders ────────────────────────────────────────────────────────────────

  async function loadMemory() {
    if (!agentId) return;
    setMemoryLoading(true);
    try {
      const [memRes, fileRes] = await Promise.all([
        fetch(`/api/agents/${agentId}/memory`),
        fetch(`/api/agents/${agentId}/memory/file`),
      ]);
      if (memRes.ok) setAgentMemory(await memRes.json());
      if (fileRes.ok) {
        const d = await fileRes.json();
        setMemoryFile(d.content);
      }
    } catch {
    } finally {
      setMemoryLoading(false);
    }
  }

  async function loadCheckins() {
    if (!agentId) return;
    try {
      const res = await fetch(`/api/agents/${agentId}/checkins`);
      if (res.ok) setCheckins(await res.json());
    } catch {}
  }

  async function loadHandoffs() {
    if (!agentId) return;
    setHandoffsLoading(true);
    setConvosLoading(true);
    try {
      // Both: the flat list still feeds the counts and the New Handoff modal, while
      // the transcript is what a human actually reads.
      const [flat, convo] = await Promise.all([
        fetch(`/api/agents/${agentId}/handoffs`),
        fetch(`/api/agents/conversations?agent=${agentId}&limit=60`),
      ]);
      if (flat.ok) setHandoffs(await flat.json());
      if (convo.ok) setConvos(await convo.json());
    } catch {
    } finally {
      setHandoffsLoading(false);
      setConvosLoading(false);
    }
  }

  const loadOutputs = useCallback(async () => {
    if (!agentId) return;
    setOutputsLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/outputs`);
      if (res.ok) {
        const data = await res.json();
        setOutputs(Array.isArray(data) ? data : (data.files ?? []));
      }
    } catch {
    } finally {
      setOutputsLoading(false);
    }
  }, [agentId]);

  const loadArtifacts = useCallback(async () => {
    if (!agentId) return;
    setArtifactsLoading(true);
    try {
      const res = await fetch(`/api/agents/${agentId}/artifacts`);
      if (res.ok) {
        const data = await res.json();
        setArtifacts(data.artifacts ?? []);
      }
    } catch {
    } finally {
      setArtifactsLoading(false);
    }
  }, [agentId]);

  // ── Handlers ──────────────────────────────────────────────────────────────

  async function handleSlashCommand(input: string): Promise<boolean> {
    if (!agentId) return false;
    const trimmed = input.trim();
    const spaceIdx = trimmed.indexOf(' ');
    const cmd = (
      spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)
    ).toLowerCase();
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    const echoUser = (text: string) => {
      addChatMessage(agentId!, {
        id: `u_${Date.now()}`,
        role: 'user',
        content: text,
        created_at: new Date().toISOString(),
      });
    };
    const sysReply = (text: string) => {
      addChatMessage(agentId!, {
        id: `s_${Date.now()}`,
        role: 'assistant',
        content: text,
        created_at: new Date().toISOString(),
      });
    };

    if (cmd === 'run') {
      setChatInput('');
      patchAgent(agentId, { status: 'running' } as any);
      // Optimistic local echo for instant feedback — backend will persist
      // canonical versions of these and we refresh history when the cycle
      // completes, replacing the optimistic ones.
      echoUser(trimmed);
      sysReply(
        `▸ **Cycle dispatched.** ${args ? `\n\n> ${args}\n\n` : "_(running with the agent's goals — no extra instruction)_\n\n"}Result will appear here when the cycle completes; live trace in the **Overview** tab.`,
      );
      try {
        // Fire-and-stream — fetch returns when SSE closes (i.e. cycle done).
        // persistToChat=true tells the backend to save the user instruction
        // and the cycle summary into agent_chat_messages so they survive refresh.
        const res = await fetch(`/api/agents/${agentId}/cycle`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cycleType: 'custom',
            persistToChat: true,
            ...(args ? { instruction: args } : {}),
          }),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        // Drain the SSE so the server-side runCycle promise resolves and
        // saveAgentChatMessage gets called for the assistant summary.
        if (res.body) {
          const reader = res.body.getReader();
          while (!(await reader.read()).done) {
            /* discard chunks */
          }
        }
        fetchActivityFeed();
        fetchAgentLogs(agentId);
        // Replace the optimistic messages with the persisted canonical pair.
        await loadAgentChatFromMessages(agentId);
      } catch (err: any) {
        patchAgent(agentId, { status: 'idle' } as any);
        sysReply(`⚠  Could not start cycle: ${err?.message ?? err}`);
      }
      return true;
    }

    if (cmd === 'job') {
      echoUser(trimmed);
      setChatInput('');
      sysReply(
        `Background jobs are being rebuilt as agent-led runs (stage 57) and are unavailable for now. Ask the agent directly instead.`,
      );
      return true;
    }

    if (cmd === 'clear') {
      echoUser(trimmed);
      setChatInput('');
      try {
        await fetch(`/api/agents/${agentId}/chat/history`, {
          method: 'DELETE',
        });
        useAgentsStore.setState((state) => ({
          chatHistory: { ...state.chatHistory, [agentId!]: [] },
          toolTraces: { ...state.toolTraces, [agentId!]: {} },
        }));
        // Legacy `messages` clears via the store update above; under the default
        // conversation_events read path the visible transcript needs its own reload.
        if (FLAGS.conversationEvents) await reloadConversationEvents();
      } catch (err: any) {
        sysReply(`⚠  Could not clear chat history: ${err?.message ?? err}`);
      }
      return true;
    }

    if (cmd === 'help') {
      echoUser(trimmed);
      setChatInput('');
      sysReply(
        `**Available slash commands:**\n\n` +
          `**Actions**\n` +
          `- \`/run [instruction]\` — dispatch a cycle immediately.\n` +
          `- \`/clear\` — wipe chat history. Irreversible.\n\n` +
          `**Open a view** (doc-07 quick access)\n` +
          `- \`/files\` · \`/outputs\` · \`/artifacts\` · \`/memory\` · \`/handoffs\` · \`/messages\` · \`/overview\`\n\n` +
          `**Configure**\n` +
          `- \`/settings\` — open the settings panel\n` +
          `- \`/identity\` · \`/schedule\` · \`/tools\` · \`/webhooks\`\n\n` +
          `Tip: slash commands are deterministic — the LLM never sees them.`,
      );
      return true;
    }

    // Stage 20 / doc 07 — view + config navigation via slash.
    const VIEW_CMDS: Record<string, string> = {
      files: 'workspace',
      workspace: 'workspace',
      outputs: 'outputs',
      artifacts: 'artifacts',
      memory: 'memory',
      handoffs: 'handoffs',
      messages: 'messages',
      overview: 'overview',
      checkins: 'checkins',
      approvals: 'checkins',
      identity: 'identity',
      schedule: 'schedule',
      tools: 'tools',
      webhooks: 'webhooks',
    };
    if (cmd === 'settings') {
      setChatInput('');
      openManage('general');
      return true;
    }
    if (VIEW_CMDS[cmd]) {
      setChatInput('');
      openManage(VIEW_CMDS[cmd]);
      return true;
    }

    // Unknown slash command — let it through as a normal message but warn
    sysReply(
      `Unknown command: \`/${cmd}\`. Try \`/help\` to see what's available.`,
    );
    echoUser(trimmed);
    setChatInput('');
    return true;
  }

  // Upload files as the agent's persistent references (the + button). They land in
  // references/, are mounted into its container, and surfaced in its identity every
  // cycle — so you can hand an agent a file mid-conversation and it keeps it.
  // Project-folder model: upload files/folders directly into the agent's workspace
  // (alongside its own output), not into references. Folder structure is preserved.
  async function uploadWorkspaceFiles(files: FileList | null) {
    if (!files || files.length === 0 || !agentId) return;
    const fieldName = 'references';
    const url = `/api/agents/${agentId}/workspace/files`;
    const targetLabel = 'workspace';

    const fd = new FormData();
    const paths: string[] = [];
    for (const f of Array.from(files)) {
      const rel =
        (f as unknown as { webkitRelativePath?: string }).webkitRelativePath ||
        f.name;
      if (shouldSkipUploadPath(rel)) continue;
      paths.push(rel);
      fd.append(fieldName, f, f.name);
    }
    if (paths.length === 0) {
      setRefToast(
        '⚠  Nothing to upload (only generated/vendor files were selected)',
      );
      setTimeout(() => setRefToast(null), 4000);
      return;
    }
    fd.append('paths', JSON.stringify(paths));
    setRefToast(null);
    try {
      const res = await fetch(url, { method: 'POST', body: fd });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const n = (data.added || []).length;
        const sk = (data.skipped || []).length;
        setRefToast(
          `📁 Added ${n} file${n !== 1 ? 's' : ''} to ${targetLabel}${sk ? ` · ${sk} skipped (unsupported)` : ''}`,
        );
        fetchAgentFiles(agentId);
      } else {
        setRefToast(`⚠  ${data.error || 'Upload failed'}`);
      }
      setTimeout(() => setRefToast(null), 4000);
    } catch {
      setRefToast('⚠  Upload failed');
    }
    if (wsFileInputRef.current) wsFileInputRef.current.value = '';
    if (wsFolderInputRef.current) wsFolderInputRef.current.value = '';
  }

  // Pin/unpin a workspace file as must-read (project-folder model).
  async function togglePin(p: string) {
    if (!agentId) return;
    try {
      const res = await fetch(`/api/agents/${agentId}/pins`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      if (res.ok) await fetchAgents();
    } catch {
      /* ignore */
    }
  }

  // Rename doubles as "move" — the prompt is pre-filled with the full relative
  // path, so retyping the directory portion moves the file/folder instead.
  async function renameWorkspaceFile(fromPath: string) {
    if (!agentId) return;
    const to = window.prompt(
      'Rename or move to (full path within the workspace):',
      fromPath,
    );
    if (!to || to === fromPath) return;
    try {
      const res = await fetch(`/api/agents/${agentId}/workspace/file`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromPath, to }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Rename failed');
        return;
      }
      await fetchAgentFiles(agentId);
    } catch {
      alert('Rename failed');
    }
  }

  async function copyWorkspaceFile(fromPath: string) {
    if (!agentId) return;
    const parts = fromPath.split('/');
    const base = parts.pop()!;
    const dot = base.lastIndexOf('.');
    const suggested =
      dot > 0 ? `${base.slice(0, dot)} copy${base.slice(dot)}` : `${base} copy`;
    const to = window.prompt(
      'Copy to (full path within the workspace):',
      [...parts, suggested].join('/'),
    );
    if (!to || to === fromPath) return;
    try {
      const res = await fetch(`/api/agents/${agentId}/workspace/file/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: fromPath, to }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Copy failed');
        return;
      }
      await fetchAgentFiles(agentId);
    } catch {
      alert('Copy failed');
    }
  }

  async function deleteWorkspaceFile(targetPath: string, isDir: boolean) {
    if (!agentId) return;
    if (
      !confirm(
        `Delete ${isDir ? 'folder' : 'file'} "${targetPath}"${isDir ? ' and everything inside it' : ''}?`,
      )
    )
      return;
    try {
      const res = await fetch(
        `/api/agents/${agentId}/workspace/file?path=${encodeURIComponent(targetPath)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        alert(d.error || 'Delete failed');
        return;
      }
      await fetchAgentFiles(agentId);
    } catch {
      alert('Delete failed');
    }
  }

  async function uploadReferences(files: FileList | null) {
    if (!files || files.length === 0 || !agentId) return;
    const fd = new FormData();
    const paths: string[] = [];
    for (const f of Array.from(files)) {
      // Preserve folder structure when a folder is added (webkitRelativePath).
      // Sent as a separate `paths` field — multer strips dirs from the filename.
      const rel =
        (f as unknown as { webkitRelativePath?: string }).webkitRelativePath ||
        f.name;
      if (shouldSkipUploadPath(rel)) continue;
      paths.push(rel);
      fd.append('references', f, f.name);
    }
    if (paths.length === 0) {
      setRefToast(
        '⚠  Nothing to upload (only generated/vendor files were selected)',
      );
      setTimeout(() => setRefToast(null), 4000);
      return;
    }
    fd.append('paths', JSON.stringify(paths));
    setUploadingRefs(true);
    setRefToast(null);
    try {
      const res = await fetch(`/api/agents/${agentId}/references`, {
        method: 'POST',
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        const n = (data.added || []).length;
        const sk = (data.skipped || []).length;
        setRefToast(
          `📎 Added ${n} file${n !== 1 ? 's' : ''} to ${agent?.name ?? 'the agent'}'s references${sk ? ` · ${sk} skipped (unsupported)` : ''}`,
        );
        if (agentId) fetchAgentFiles(agentId);
      } else {
        setRefToast(`⚠  ${data.error || 'Upload failed'}`);
      }
    } catch {
      setRefToast('⚠  Upload failed');
    } finally {
      setUploadingRefs(false);
      if (refFileInputRef.current) refFileInputRef.current.value = '';
      setTimeout(() => setRefToast(null), 5000);
    }
  }

  // Remove a reference file from the agent (✕ in the + menu).
  async function deleteReference(refPath: string) {
    if (!agentId) return;
    try {
      const res = await fetch(`/api/agents/${agentId}/references`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [refPath] }),
      });
      if (res.ok) {
        await fetchAgents();
        setRefToast(`🗑 Removed ${refPath}`);
        setTimeout(() => setRefToast(null), 3500);
      }
    } catch {
      /* ignore */
    }
  }

  // Open a workspace file in the side drawer from any absolute or relative path the
  // agent mentions in chat (e.g. /workspace/group/workspace/foo.md). Mirrors the
  // ActivityDock onOpenFile resolution so clicking a path = clicking it in the dock.
  function openWorkspaceFile(p: string) {
    if (!agentId) return;
    // The agent file-content API resolves paths relative to data/agents/{id}/workspace,
    // which is mounted into the container at /workspace/group/workspace. So strip that
    // full prefix (NOT just /workspace/group/, which leaves a stray "workspace/").
    let rel = p.trim();
    if (rel.includes('/workspace/group/workspace/'))
      rel = rel.split('/workspace/group/workspace/')[1];
    else if (rel.includes('/workspace/group/'))
      rel = rel.split('/workspace/group/')[1];
    else
      rel = rel
        .replace(/^\/workspace\/[^/]+\//, '')
        .replace(/^\/?workspace\//, '')
        .replace(/^\//, '');
    fetch(
      `/api/files/content?context=agent&contextId=${agentId}&path=${encodeURIComponent(rel)}`,
    )
      .then((r) => (r.ok ? r.text() : ''))
      .then((content) => {
        const filename = rel.split('/').pop() || rel;
        setJobDrawer({
          jobId: `file:${rel}`,
          title: filename,
          resultText: '',
          isSuccess: true,
          agentId: agentId ?? undefined,
          initialFile: {
            filename,
            content,
            path: rel,
            context: 'agent',
            contextId: agentId ?? undefined,
          },
        });
      });
  }

  // Shared rich markdown components (same as the project chat) + the agent's
  // clickable-file-path behavior that opens the file in the drawer.
  const mdComponents = useMemo(
    () => createProseComponents(openWorkspaceFile),
    [agentId],
  );

  const agColor = 'var(--cr-accent)';
  const fmtBytes = (b: number) => {
    if (!b) return '0 B';
    const k = 1024,
      s = ['B', 'KB', 'MB', 'GB'],
      i = Math.floor(Math.log(b) / Math.log(k));
    return (b / Math.pow(k, i)).toFixed(1) + ' ' + s[i];
  };
  const fmtRel = (d: string) => {
    const delta = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
    if (delta < 60) return 'just now';
    if (delta < 3600) return `${Math.floor(delta / 60)}m ago`;
    if (delta < 86400) return `${Math.floor(delta / 3600)}h ago`;
    return `${Math.floor(delta / 86400)}d ago`;
  };

  // Extra tabs for the inspect drawer (Outputs + Artifacts as slide-in panel from dock).
  const agentInspectExtraTabs = useMemo(() => {
    if (!agentId) return [];
    return [
      {
        id: 'outputs',
        label: `Outputs${outputs.length ? ` (${outputs.length})` : ''}`,
        // A function, not a plain node — "everything opens in the drawer, not a
        // download link" (2026-09-22). openInDrawer sets the SAME file-preview
        // state UniversalDrawer's own Workspace tab uses, so a video/image/pdf/
        // xlsx output gets a real preview instead of only ever being a `↓`.
        content: (
          openInDrawer: (file: { filename: string; content: string }) => void,
        ) => (
          <div style={{ padding: '24px 28px' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 20,
              }}
            >
              <div>
                <div
                  style={{ fontFamily: CR.serif, fontSize: 16, color: CR.sub }}
                >
                  Output Files
                </div>
                <div
                  style={{
                    fontFamily: CR.sans,
                    fontSize: 12,
                    color: CR.muted,
                    marginTop: 4,
                  }}
                >
                  Files produced by sidecar tools — videos, images, PDFs
                </div>
              </div>
              <button
                onClick={loadOutputs}
                style={{
                  background: 'none',
                  border: 'none',
                  color: CR.accent,
                  cursor: 'pointer',
                  fontFamily: CR.mono,
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                ↻ Refresh
              </button>
            </div>
            {outputsLoading ? (
              <div
                style={{
                  padding: 40,
                  textAlign: 'center',
                  color: CR.muted,
                  fontFamily: CR.sans,
                  fontSize: 13,
                }}
              >
                Loading…
              </div>
            ) : outputs.length === 0 ? (
              <div
                style={{
                  padding: 40,
                  textAlign: 'center',
                  background: 'var(--cr-well)',
                  borderRadius: 12,
                  border: `1px dashed ${CR.border}`,
                }}
              >
                <div style={{ fontSize: 24, marginBottom: 12 }}>🎬</div>
                <p
                  style={{
                    fontFamily: CR.sans,
                    fontSize: 13,
                    color: CR.muted,
                    margin: 0,
                  }}
                >
                  No output files yet.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {outputs.map((f) => {
                  const isVideo = f.mimeType.startsWith('video/');
                  const isImage = f.mimeType.startsWith('image/');
                  const fileUrl = `/api/agents/${agentId}/outputs/${encodeURIComponent(f.name)}`;
                  return (
                    <div
                      key={f.name}
                      onClick={() =>
                        openInDrawer({ filename: f.name, content: fileUrl })
                      }
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 14px',
                        background: 'var(--cr-well)',
                        borderRadius: 10,
                        border: `1px solid ${CR.border}`,
                        cursor: 'pointer',
                      }}
                    >
                      <span style={{ fontSize: 20 }}>
                        {isVideo
                          ? '🎬'
                          : isImage
                            ? '🖼'
                            : f.mimeType === 'application/pdf'
                              ? '📄'
                              : '📁'}
                      </span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div
                          style={{
                            fontFamily: CR.mono,
                            fontSize: 11,
                            color: CR.cream,
                            wordBreak: 'break-all',
                          }}
                        >
                          {f.name}
                        </div>
                        <div
                          style={{
                            fontFamily: CR.mono,
                            fontSize: 9,
                            color: CR.muted,
                            marginTop: 2,
                          }}
                        >
                          {fmtBytes(f.size)} · {fmtRel(f.createdAt)}
                        </div>
                      </div>
                      <a
                        href={fileUrl}
                        download={f.name}
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 6,
                          background: 'var(--cr-tint-3)',
                          border: `1px solid ${CR.border}`,
                          color: CR.sub,
                          fontFamily: CR.sans,
                          fontSize: 11,
                          textDecoration: 'none',
                        }}
                      >
                        ↓
                      </a>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        ),
      },
      {
        id: 'artifacts',
        label: `Artifacts${artifacts.length ? ` (${artifacts.length})` : ''}`,
        // A function, not a plain node — found 2026-09-22: "Open" used to switch
        // the whole PAGE to the Manage route and pop a modal over it, so from the
        // chat drawer it looked like the click did something entirely different
        // from clicking a Workspace file two tabs over. openInDrawer sets this
        // same drawer's own file-preview state instead — one mechanism for
        // "open a file", used by Workspace, Outputs and Artifacts alike. The
        // Manage page's own Artifacts view (below, further down this file) reuses
        // this exact same content function rather than keeping a second,
        // slightly-different copy of this list.
        content: (
          openInDrawer: (file: {
            filename: string;
            content: string;
            path?: string;
            context?: string;
            contextId?: string;
          }) => void,
        ) => (
          <div style={{ padding: '24px 28px' }}>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: 20,
              }}
            >
              <div>
                <div
                  style={{ fontFamily: CR.serif, fontSize: 16, color: CR.sub }}
                >
                  Artifacts
                </div>
                <div
                  style={{
                    fontFamily: CR.sans,
                    fontSize: 12,
                    color: CR.muted,
                    marginTop: 4,
                  }}
                >
                  Deliverables registered via emit_artifact
                </div>
              </div>
              <button
                onClick={loadArtifacts}
                style={{
                  background: 'none',
                  border: 'none',
                  color: CR.accent,
                  cursor: 'pointer',
                  fontFamily: CR.mono,
                  fontSize: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.05em',
                }}
              >
                ↻ Refresh
              </button>
            </div>
            {artifactsLoading ? (
              <div
                style={{
                  padding: 40,
                  textAlign: 'center',
                  color: CR.muted,
                  fontFamily: CR.sans,
                  fontSize: 13,
                }}
              >
                Loading…
              </div>
            ) : artifacts.length === 0 ? (
              <div
                style={{
                  padding: 40,
                  textAlign: 'center',
                  background: 'var(--cr-well)',
                  borderRadius: 12,
                  border: `1px dashed ${CR.border}`,
                }}
              >
                <div style={{ fontSize: 24, marginBottom: 12 }}>📦</div>
                <p
                  style={{
                    fontFamily: CR.sans,
                    fontSize: 13,
                    color: CR.muted,
                    margin: 0,
                  }}
                >
                  No artifacts yet.
                </p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {artifacts.map((a) => (
                  <div
                    key={a.id}
                    onClick={() => {
                      if (agentId && a.file.toLowerCase().endsWith('.html')) {
                        // Kept as its own path, deliberately: this is a bigger view (a whole
                        // page, with the artifact's own saved state) than the drawer offers
                        // for anything else, not a workaround for something the drawer can't do.
                        navigate(artifactViewPath(agentId, a.file));
                      } else {
                        openInDrawer({
                          filename: a.file,
                          content: a.url,
                          path: a.file,
                          context: 'agent',
                          contextId: agentId,
                        });
                      }
                    }}
                    style={{
                      padding: '12px 14px',
                      background: 'var(--cr-well)',
                      borderRadius: 10,
                      border: `1px solid ${CR.border}`,
                      cursor: 'pointer',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        marginBottom: 4,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: CR.mono,
                          fontSize: 9,
                          color: CR.muted,
                          background: `${withAlpha(agColor, 9)}`,
                          border: `1px solid ${withAlpha(agColor, 19)}`,
                          borderRadius: 4,
                          padding: '2px 6px',
                          textTransform: 'uppercase',
                          letterSpacing: '0.06em',
                        }}
                      >
                        {a.type}
                      </span>
                      <span
                        style={{
                          fontFamily: CR.sans,
                          fontSize: 12,
                          color: CR.cream,
                          flex: 1,
                          minWidth: 0,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {a.title}
                      </span>
                      <a
                        href={a.url}
                        download
                        onClick={(e) => e.stopPropagation()}
                        style={{
                          padding: '3px 10px',
                          borderRadius: 6,
                          background: 'var(--cr-tint-3)',
                          border: `1px solid ${CR.border}`,
                          color: CR.sub,
                          fontFamily: CR.sans,
                          fontSize: 11,
                          textDecoration: 'none',
                        }}
                      >
                        ↓
                      </a>
                    </div>
                    {a.description && (
                      <div
                        style={{
                          fontFamily: CR.sans,
                          fontSize: 11,
                          color: CR.muted,
                          lineHeight: 1.5,
                          paddingLeft: 2,
                        }}
                      >
                        {a.description}
                      </div>
                    )}
                    <div
                      style={{
                        fontFamily: CR.mono,
                        fontSize: 9,
                        color: CR.muted,
                        marginTop: 4,
                      }}
                    >
                      {fmtBytes(a.size)} · {fmtRel(a.createdAt)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ),
      },
    ];
  }, [
    agentId,
    outputs,
    artifacts,
    outputsLoading,
    artifactsLoading,
    agColor,
    loadOutputs,
    loadArtifacts,
    fmtBytes,
    fmtRel,
    navigate,
    openManage,
  ]);

  // Stage files for a create-agent approval card → they materialize into the new
  // agent's references/ on approve (durable, atomic, size-safe). Re-attach appends
  // to the same staging token.
  async function stageRefsForCheckin(
    checkinId: string,
    files: FileList | null,
  ) {
    if (!files || files.length === 0) return;
    const fd = new FormData();
    const paths: string[] = [];
    for (const f of Array.from(files)) {
      const rel =
        (f as unknown as { webkitRelativePath?: string }).webkitRelativePath ||
        f.name;
      if (shouldSkipUploadPath(rel)) continue;
      paths.push(rel);
      fd.append('references', f, f.name);
    }
    if (paths.length === 0) return;
    fd.append('paths', JSON.stringify(paths));
    const prev = stagedRefs[checkinId];
    if (prev?.token) fd.append('token', prev.token);
    setStagedRefs((s) => ({
      ...s,
      [checkinId]: {
        token: prev?.token ?? '',
        files: prev?.files ?? [],
        uploading: true,
      },
    }));
    try {
      const res = await fetch('/api/agents/staging', {
        method: 'POST',
        body: fd,
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setStagedRefs((s) => {
          const cur = s[checkinId];
          const names = [
            ...(cur?.files ?? []),
            ...(data.files || []).map((f: { filename: string }) => f.filename),
          ];
          return {
            ...s,
            [checkinId]: { token: data.token, files: names, uploading: false },
          };
        });
      } else {
        setStagedRefs((s) => ({
          ...s,
          [checkinId]: {
            ...(s[checkinId] ?? { token: '', files: [] }),
            uploading: false,
          },
        }));
      }
    } catch {
      setStagedRefs((s) => ({
        ...s,
        [checkinId]: {
          ...(s[checkinId] ?? { token: '', files: [] }),
          uploading: false,
        },
      }));
    }
  }

  // Stage 20 — dispatch the message to the agent's real (nanobot) runtime via the
  // unified agent:<id> conversation. The reply + activity stream back over socket
  // events (handled by the listener effect above), not an HTTP SSE response.
  function loadChatImage(file: File | null | undefined) {
    if (!file || !file.type.startsWith('image/')) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string')
        setPendingImages((prev) => [...prev, reader.result as string]);
    };
    reader.readAsDataURL(file);
  }
  function onChatPaste(e: React.ClipboardEvent) {
    const imgs = Array.from(e.clipboardData?.items ?? []).filter((i) =>
      i.type.startsWith('image/'),
    );
    if (imgs.length) {
      e.preventDefault();
      imgs.forEach((i) => loadChatImage(i.getAsFile()));
    }
  }

  async function sendChat(overrideMsg?: string, overrideImgs?: string[]) {
    const imgs = overrideImgs ?? pendingImages;
    const msg =
      overrideMsg ||
      chatInput.trim() ||
      (imgs.length
        ? `I attached ${imgs.length === 1 ? 'an image' : `${imgs.length} images`} — please look and respond.`
        : '');
    if ((!msg && imgs.length === 0) || !agentId) return;

    // The agent is mid-turn: hold the message and send it when the turn ends.
    if (isStreaming && !msg.startsWith('/')) {
      setQueuedSends((q) => [...q, { id: `q_${Date.now()}`, msg, imgs }]);
      setChatInput('');
      setPendingImages([]);
      if (chatInputRef.current) chatInputRef.current.style.height = 'auto';
      return;
    }

    // Intercept slash commands before they hit the runtime (local actions)
    if (msg.startsWith('/')) {
      await handleSlashCommand(msg);
      if (chatInputRef.current) {
        chatInputRef.current.style.height = 'auto';
      }
      return;
    }

    // Optimistic user bubble — show the original text (not the injected file content)
    addChatMessage(agentId, {
      id: `u_${Date.now()}`,
      role: 'user',
      content: msg,
      created_at: new Date().toISOString(),
      ...(imgs.length ? { images: imgs } : {}),
    });
    setChatInput('');
    setPendingImages([]);
    if (chatInputRef.current) {
      chatInputRef.current.style.height = 'auto';
    }
    setIsStreaming(true);
    setLiveTools([]);

    // # file refs — resolve agent-private files and inject content into the message.
    let finalMsg = msg;
    const refs = [...msg.matchAll(/#([\w\-./]+)/g)]
      .map((m) => m[1])
      .filter((r) => r.includes('.') || r.includes('/'));
    if (refs.length > 0) {
      const agentFileList = (useAgentsStore.getState().agentFiles[agentId] ||
        []) as any[];
      const blocks: string[] = [];
      for (const ref of refs) {
        if (ref.endsWith('/')) {
          const folder = ref.replace(/\/+$/, '');
          const matches = agentFileList.filter((f: any) =>
            String(f.path || '').startsWith(folder + '/'),
          );
          if (matches.length) {
            const listing = matches.map((f: any) => `- ${f.path}`).join('\n');
            blocks.push(
              `### 📁 Folder: ${folder}/ (private workspace)\nFiles in this folder — read any you need with the file tool:\n${listing}`,
            );
          }
          continue;
        }
        try {
          const r = await fetch(
            `/api/files/content?context=agent&contextId=${agentId}&path=${encodeURIComponent(ref)}`,
          );
          if (r.ok) {
            const full = await r.text();
            const shown = full.slice(0, 8000);
            // A silent cap here means the agent (and whoever wrote the message)
            // has no way to know it's looking at a partial file — found 2026-08-17,
            // a 14KB file got cut off mid-docstring with no signal it was incomplete.
            const notice =
              full.length > 8000
                ? `\n_(truncated — showing the first 8000 of ${full.length} characters; use read_file to see the rest)_`
                : '';
            blocks.push(
              `### 📎 File: ${ref}\n\`\`\`\n${shown}\n\`\`\`${notice}`,
            );
          }
        } catch {
          /* skip unresolvable ref */
        }
      }
      if (blocks.length)
        finalMsg = `${msg}\n\n## Referenced Files\n\n${blocks.join('\n\n')}`;
    }

    socket.emit('chat:send', {
      chatJid: `agent:${agentId}`,
      message: finalMsg,
      clientId: `u_${Date.now()}`,
      browser: browserLane,
      ...(imgs.length ? { images: imgs } : {}),
    });
  }

  // The turn in flight ended: send the next queued message, one per turn.
  useEffect(() => {
    if (isStreaming || queuedSends.length === 0) return;
    const [next, ...rest] = queuedSends;
    setQueuedSends(rest);
    void sendChat(next.msg, next.imgs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isStreaming, queuedSends]);
  // A different agent's chat starts with its own queue.
  useEffect(() => {
    setQueuedSends([]);
  }, [agentId]);

  // useCallback so its identity is stable across renders — it's a dependency of the
  // memoized `renderedHistory`, and a fresh closure each render would invalidate that
  // memo on every keystroke (rebuilding every CycleTimeline / Markdown → laggy typing).
  const viewFile = useCallback(
    async (f: any) => {
      if (!agentId) return;
      try {
        const res = await fetch(
          `/api/files/content?context=agent&contextId=${agentId}&path=${encodeURIComponent(f.path)}`,
        );
        if (!res.ok) throw new Error('Failed to read file');
        const content = await res.text();
        setJobDrawer({
          jobId: f.id,
          title: f.filename,
          resultText: '',
          isSuccess: true,
          agentId,
          initialFile: {
            filename: f.filename,
            content,
            path: f.path,
            context: 'agent',
            contextId: agentId,
          },
        });
      } catch (err) {
        console.error('View file error:', err);
      }
    },
    [agentId],
  );

  // References live in the agent's references/ folder (sibling of workspace), served
  // via the agentref context so we don't need them mounted under workspace.
  async function viewRefFile(f: any) {
    if (!agentId) return;
    try {
      const res = await fetch(
        `/api/files/content?context=agentref&contextId=${agentId}&path=${encodeURIComponent(f.path)}`,
      );
      if (!res.ok) throw new Error('Failed to read reference');
      setJobDrawer({
        jobId: 'ref:' + f.path,
        title: f.filename,
        resultText: await res.text(),
        isSuccess: true,
        agentId,
      });
    } catch (err) {
      console.error('View reference error:', err);
    }
  }

  async function handleSelectVersion(version: number) {
    if (!agentId) return;
    setSelectedVersion(version);
    setShowDiff(false);
    setVersionLoading(true);
    try {
      const res = await fetch(
        `/api/agents/${agentId}/identity-history/${version}`,
      );
      if (res.ok) {
        const d = await res.json();
        setVersionContent(d.content);
      }
    } catch {
    } finally {
      setVersionLoading(false);
    }
  }

  async function handleRestoreVersion() {
    if (!agentId || selectedVersion === null) return;
    if (
      !confirm(
        `Restore IDENTITY.md to v${selectedVersion}? Current version will be overwritten.`,
      )
    )
      return;
    setRestoring(true);
    try {
      const res = await fetch(
        `/api/agents/${agentId}/identity-history/${selectedVersion}/restore`,
        { method: 'POST' },
      );
      if (res.ok) {
        setSelectedVersion(null);
        setVersionContent(null);
        // Reload versions list
        const r = await fetch(`/api/agents/${agentId}/identity-history`);
        if (r.ok) setIdentityVersions(await r.json());
      }
    } catch {
    } finally {
      setRestoring(false);
    }
  }

  async function handleSaveIdentity() {
    if (!agentId || !agent) return;
    setIsSaving(true);
    try {
      await updateAgent(agentId, { config: { goals: missionEdit } });
    } catch (err) {
      console.error('Save identity error:', err);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRestartSidecar() {
    if (!agentId || sidecarRestarting) return;
    setSidecarRestarting(true);
    try {
      await fetch(`/api/agents/${agentId}/sidecar/start`, { method: 'POST' });
      setSidecarStatus((s) =>
        s ? { ...s, state: 'starting', log: [] } : null,
      );
    } catch (err) {
      console.error('Sidecar restart error:', err);
    } finally {
      setSidecarRestarting(false);
    }
  }

  async function handleStart() {
    if (!agentId) return;
    await startAgent(agentId);
    fetchActivityFeed();
  }

  async function handlePause() {
    if (!agentId) return;
    await pauseAgent(agentId);
  }

  async function handleStop() {
    if (!agentId) return;
    await stopAgent(agentId);
  }

  async function handleInterrupt() {
    if (!agentId) return;
    await interruptAgent(agentId);
  }

  async function handleSaveSettings(updates: any) {
    if (!agentId) return;
    await updateAgent(agentId, updates);
  }

  async function handleDeleteAgent() {
    if (!agentId) return;
    await deleteAgent(agentId);
    navigate('/agents');
  }

  async function handleToggleTool(toolId: string) {
    if (!agentId) return;
    setIsSaving(true);
    try {
      await toggleAgentTool(agentId, toolId);
    } catch (err) {
      console.error('Toggle tool error:', err);
    } finally {
      setIsSaving(false);
    }
  }

  async function handleCheckinReply(checkinId: string) {
    const reply = checkinReplies[checkinId];
    if (!reply?.trim() || !agentId) return;
    setCheckinSending((s) => ({ ...s, [checkinId]: true }));
    try {
      await fetch(`/api/agents/${agentId}/checkins/${checkinId}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reply }),
      });
      setCheckinReplies((r) => ({ ...r, [checkinId]: '' }));
      await loadCheckins();
    } catch {
    } finally {
      setCheckinSending((s) => ({ ...s, [checkinId]: false }));
    }
  }

  async function handleDeleteMemory(memoryId: string) {
    if (!agentId) return;
    try {
      await fetch(`/api/agents/${agentId}/memory/${memoryId}`, {
        method: 'DELETE',
      });
      setAgentMemory((m) => m.filter((x) => x.id !== memoryId));
    } catch {}
  }

  function renderText(text: string) {
    if (!text) return null;
    return text.split('\n').map((line, i) => {
      const b = line.replace(
        /\*\*(.*?)\*\*/g,
        '<strong style="color:var(--cr-text)">$1</strong>',
      );
      const bullet = b.replace(
        /^•\s/,
        `<span style="color:${CR.accent}">·</span> `,
      );
      return (
        <div
          key={i}
          dangerouslySetInnerHTML={{ __html: bullet || '&nbsp;' }}
          style={{ lineHeight: 1.7 }}
        />
      );
    });
  }

  // Memoized chat history. Typing in the composer re-renders this page, but none of
  // the composer state is a dep here — so the cached element tree is reused and the
  // (memoized) ChatBubbles / CycleTimelines aren't rebuilt. Markdown re-parsing per
  // keystroke is what made long agent threads feel laggy; this decouples typing cost
  // from history length, matching the project chat fix.
  // NOTE: declared ABOVE the `if (!agent)` early return so hook order stays stable.
  const renderedHistory = useMemo(() => {
    if (!agent) return [] as ReactNode[];
    const agColor = 'var(--cr-accent)';
    const emoji = agent.emoji || '🤖';
    return history.map((msg) => {
      const isUser = msg.role === 'user';
      const isHovered = hoveredMsgId === msg.id;
      // Hide transient cycle acks / control markers — the working
      // is shown as the inline timeline, so a separate "On it…"
      // bubble or "⚙️ Running…" marker is just noise.
      if (!isUser) {
        const c = (msg.content || '').replace(/^_+|_+$/g, '').trim();
        const isAck =
          /^On it\b/.test(c) ||
          /^Dispatching to /.test(c) ||
          /^(⚙️|⌛)/.test(c) ||
          /^Running .* cycle…?$/.test(c) ||
          /^Still working on the previous/.test(c);
        const hasTrace = !!(toolTraces[msg.id] && toolTraces[msg.id].length);
        if (isAck && !hasTrace) return null;
      }

      // A reply from the removed job system (stage 57): ChatBubble strips its markers.
      if (
        !isUser &&
        (msg.content.includes('[job-id:') ||
          msg.content.includes('[job-pending:'))
      ) {
        return (
          <ChatBubble
            key={msg.id}
            message={{
              id: msg.id,
              sender: 'Assistant',
              sender_name: agent?.name || 'Assistant',
              content: msg.content,
              timestamp: msg.created_at,
              is_from_me: false,
            }}
          />
        );
      }

      // A cycle turn, plain reply, or user message — rendered by the memoized
      // AgentChatRow so live-streaming ticks don't re-parse Markdown for every row.
      return (
        <AgentChatRow
          key={msg.id}
          msg={msg}
          trace={toolTraces[msg.id]}
          isHovered={isHovered}
          isCopied={copiedId === msg.id}
          onHover={setHoveredMsgId}
          onCopied={setCopiedId}
          agColor={agColor}
          emoji={emoji}
          agentName={agent.name}
          agentId={agentId}
          mdComponents={mdComponents}
          onLoadTrace={loadTraceFor}
          isEager={eagerCycleMsgIds.has(msg.id)}
          eagerStaggerMs={
            (eagerCycleStagger.get(msg.id) ?? 0) * EAGER_TRACE_STAGGER_MS +
            EAGER_TRACE_STAGGER_MS / 2
          }
        />
      );
    });
  }, [
    history,
    hoveredMsgId,
    copiedId,
    toolTraces,
    agent,
    agentId,
    mdComponents,
    loadTraceFor,
    eagerCycleMsgIds,
    eagerCycleStagger,
  ]);

  // ── Early return ──────────────────────────────────────────────────────────

  if (!agent) {
    return (
      <div
        style={{ background: CR.bgMain, flex: 1, color: CR.muted, padding: 40 }}
      >
        Loading agent...
      </div>
    );
  }

  // ── Derived ───────────────────────────────────────────────────────────────

  const agCycles = activityFeed.filter((c) => c.agent_id === agent.id);
  const completedCycles = agCycles.filter((c) => c.status === 'completed');
  const running = agent.status === 'running';
  const paused = agent.status === 'paused';

  // Stage 20 — Chat is the primary surface. Conversation-native + glanceable tabs
  // come first; configuration lives behind the ⚙️ Settings panel.
  const TABS = [
    { id: 'chat', label: 'Chat' },
    { id: 'overview', label: 'Overview' },
    { id: 'audit', label: 'Audit' },
    { id: 'history', label: 'History' },
    { id: 'workspace', label: 'Files' },
    { id: 'browser', label: 'Browser' },
    { id: 'checkins', label: 'Check-ins' },
    { id: 'handoffs', label: 'Handoffs' },
    { id: 'memory', label: 'Memory' },
    { id: 'outputs', label: 'Outputs' },
    { id: 'artifacts', label: 'Artifacts' },
    { id: 'identity', label: 'Identity' },
    { id: 'schedule', label: 'Schedule' },
    { id: 'approvals', label: 'Approval rules' },
    { id: 'tools', label: 'Tools' },
    { id: 'secrets', label: 'Secrets' },
    { id: 'webhooks', label: 'Webhooks' },
    { id: 'tests', label: 'Tests' },
    { id: 'log', label: 'Log' },
  ];

  const emoji = agent.emoji || '🤖';
  const schedInfo = agentId ? (agentSchedules[agentId] ?? null) : null;

  const fmt = (d: string) => new Date(d).toLocaleTimeString();
  const fmtDur = (s: string, e?: string) => {
    if (!e) return '—';
    const ms = new Date(e).getTime() - new Date(s).getTime();
    return ms < 60000
      ? `${Math.floor(ms / 1000)}s`
      : `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  };

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        overflow: 'hidden',
        background: CR.bgMain,
        minWidth: 0,
      }}
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          overflowY: 'auto',
          minWidth: 0,
          overflow: 'hidden auto',
        }}
      >
        {/* ── Manage-page slim breadcrumb (replaces full header on /manage route) ── */}
        {isManageRoute && (
          <div
            style={{
              padding: '14px 28px',
              borderBottom: `1px solid ${CR.border}`,
              flexShrink: 0,
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              background: `linear-gradient(180deg, var(--cr-bg-card-hov) 0%, ${CR.bgMain} 100%)`,
            }}
          >
            {/* The one way back to chat. It used to only navigate, which left
                            `tab` on the manage section — the route closed the panel but the
                            content pane kept rendering Overview. closeManage() does both, and
                            the sidebar's duplicate "✕ Chat" button is gone because of it. */}
            <button
              onClick={closeManage}
              style={{
                fontFamily: CR.sans,
                fontSize: 11,
                color: CR.muted,
                background: 'none',
                border: 'none',
                cursor: 'pointer',
                padding: '4px 0',
                whiteSpace: 'nowrap',
                flexShrink: 0,
              }}
            >
              ← Chat
            </button>
            <span style={{ color: CR.border, fontSize: 12 }}>·</span>
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: 8,
                flexShrink: 0,
                background: `${withAlpha(agColor, 8)}`,
                border: `1.5px solid ${withAlpha(agColor, 19)}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: 14,
              }}
            >
              {emoji}
            </div>
            <span
              style={{
                fontFamily: CR.sans,
                fontSize: 13,
                color: CR.cream,
                fontWeight: 600,
              }}
            >
              {agent.name}
            </span>
            <span
              style={{
                fontFamily: CR.mono,
                fontSize: 10,
                color: CR.muted,
                textTransform: 'uppercase',
                letterSpacing: '0.08em',
              }}
            >
              / Manage
            </span>
          </div>
        )}

        {/* ── Header (chat view only) ── */}
        {!isManageRoute && (
          <div
            style={{
              padding: isMobile ? '14px 14px 0' : '16px 28px 0',
              background: `linear-gradient(180deg, var(--cr-bg-card-hov) 0%, ${CR.bgMain} 100%)`,
              borderBottom: `1px solid ${CR.border}`,
              flexShrink: 0,
            }}
          >
            {/* Row 1: back + avatar + name + status + actions. marginBottom trimmed
                        (desktop) so this header's border-bottom lands at the same height as
                        the sidebar's own logo-row border — they used to be 8px off. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: isMobile ? 8 : 12,
                marginBottom: isMobile ? 10 : 6,
                flexWrap: isMobile ? 'wrap' : 'nowrap',
              }}
            >
              <button
                onClick={() => navigate('/agents')}
                style={{
                  fontFamily: CR.sans,
                  fontSize: 11,
                  color: CR.muted,
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  padding: '4px 0',
                  whiteSpace: 'nowrap',
                  flexShrink: 0,
                }}
              >
                {isMobile ? '←' : '← Back'}
              </button>

              <div
                style={{
                  width: isMobile ? 32 : 40,
                  height: isMobile ? 32 : 40,
                  borderRadius: 12,
                  flexShrink: 0,
                  background: `${withAlpha(agColor, 8)}`,
                  border: `1.5px solid ${withAlpha(agColor, 19)}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  fontSize: isMobile ? 16 : 20,
                  boxShadow: running
                    ? `0 0 18px ${withAlpha(agColor, 19)}`
                    : 'none',
                }}
              >
                {emoji}
              </div>

              {/* Name + status — shrinks with ellipsis */}
              <div
                style={{
                  flex: 1,
                  minWidth: 0,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                }}
              >
                <h1
                  style={{
                    fontFamily: CR.serif,
                    fontSize: isMobile ? 17 : 22,
                    fontWeight: 400,
                    color: CR.cream,
                    margin: 0,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {agent.name}
                </h1>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 5,
                    padding: '2px 8px',
                    borderRadius: 100,
                    flexShrink: 0,
                    background: running
                      ? CR.greenLow
                      : paused
                        ? 'var(--cr-amber-low)'
                        : 'var(--cr-tint-3)',
                    border: `1px solid ${running ? 'var(--cr-green-line)' : paused ? 'var(--cr-amber-line)' : CR.border}`,
                  }}
                >
                  <div
                    style={{
                      width: 5,
                      height: 5,
                      borderRadius: '50%',
                      background: running
                        ? CR.green
                        : paused
                          ? 'var(--cr-amber)'
                          : CR.muted,
                      ...(running
                        ? { animation: 'crewPulse 2s infinite' }
                        : {}),
                    }}
                  />
                  <span
                    style={{
                      fontFamily: CR.mono,
                      fontSize: 8,
                      letterSpacing: '0.08em',
                      textTransform: 'uppercase',
                      color: running
                        ? CR.green
                        : paused
                          ? 'var(--cr-amber)'
                          : CR.muted,
                    }}
                  >
                    {agent.status}
                  </span>
                </div>
                {agent._pauseReason && (
                  <span
                    style={{
                      fontFamily: CR.sans,
                      fontSize: 10,
                      color: 'var(--cr-amber)',
                      flexShrink: 0,
                    }}
                  >
                    {agent._pauseReason}
                  </span>
                )}
                {sidecarStatus &&
                  sidecarStatus.state !== 'stopped' &&
                  (() => {
                    const sc = sidecarStatus.state;
                    const scColor =
                      sc === 'ready'
                        ? 'var(--cr-green)'
                        : sc === 'failed'
                          ? 'var(--cr-error)'
                          : 'var(--cr-warn)';
                    const scBg =
                      sc === 'ready'
                        ? 'var(--cr-green-low)'
                        : sc === 'failed'
                          ? 'var(--cr-error-low)'
                          : 'var(--cr-amber-low)';
                    const scLabel =
                      sc === 'ready'
                        ? 'sidecar ready'
                        : sc === 'failed'
                          ? 'sidecar failed'
                          : sc === 'installing'
                            ? `installing ${sidecarStatus.installingPkg ?? '…'}`
                            : 'sidecar starting';
                    return (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 5,
                          flexShrink: 0,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 5,
                            padding: '2px 8px',
                            borderRadius: 100,
                            background: scBg,
                            border: `1px solid ${withAlpha(scColor, 19)}`,
                          }}
                        >
                          <div
                            style={{
                              width: 5,
                              height: 5,
                              borderRadius: '50%',
                              background: scColor,
                              ...(sc !== 'ready' && sc !== 'failed'
                                ? { animation: 'crewPulse 2s infinite' }
                                : {}),
                            }}
                          />
                          <span
                            style={{
                              fontFamily: CR.mono,
                              fontSize: 8,
                              letterSpacing: '0.08em',
                              textTransform: 'uppercase',
                              color: scColor,
                            }}
                          >
                            {scLabel}
                          </span>
                        </div>
                        {(sc === 'failed' || sc === 'stopped') && (
                          <button
                            onClick={handleRestartSidecar}
                            disabled={sidecarRestarting}
                            title="Restart sidecar"
                            style={{
                              padding: '2px 8px',
                              borderRadius: 100,
                              cursor: sidecarRestarting ? 'default' : 'pointer',
                              background: 'var(--cr-amber-low)',
                              border: '1px solid var(--cr-amber-line)',
                              color: 'var(--cr-warn)',
                              fontFamily: CR.mono,
                              fontSize: 8,
                              letterSpacing: '0.08em',
                              textTransform: 'uppercase',
                              opacity: sidecarRestarting ? 0.5 : 1,
                            }}
                          >
                            {sidecarRestarting ? '…' : '↺ start'}
                          </button>
                        )}
                      </div>
                    );
                  })()}
              </div>

              {/* Action buttons — compact, fixed right. Stage 20 gap I: the old
                            "Run Cycle" button was removed — just type a task in the chat
                            (or use /run) to dispatch work. Lifecycle controls remain. On mobile
                            the row above wraps, so force this onto its own full-width line
                            instead of squeezing beside the flex:1 name block. */}
              <div
                style={{
                  display: 'flex',
                  gap: 6,
                  flexShrink: 0,
                  alignItems: 'center',
                  ...(isMobile
                    ? { width: '100%', justifyContent: 'flex-end' }
                    : {}),
                }}
              >
                {running ? (
                  <>
                    <button
                      onClick={handleInterrupt}
                      title="Stop cycle — agent summarises progress and stops cleanly"
                      style={headerIconBtn('var(--cr-error)')}
                      onMouseEnter={(e) =>
                        headerIconBtnHover(e, 'var(--cr-error)', true)
                      }
                      onMouseLeave={(e) =>
                        headerIconBtnHover(e, 'var(--cr-error)', false)
                      }
                    >
                      <Square size={14} />
                    </button>
                    <button
                      onClick={handlePause}
                      title="Pause"
                      style={headerIconBtn('var(--cr-amber)')}
                      onMouseEnter={(e) =>
                        headerIconBtnHover(e, 'var(--cr-amber)', true)
                      }
                      onMouseLeave={(e) =>
                        headerIconBtnHover(e, 'var(--cr-amber)', false)
                      }
                    >
                      <Pause size={14} />
                    </button>
                  </>
                ) : (
                  <button
                    onClick={handleStart}
                    title={paused ? 'Resume' : 'Start'}
                    style={headerIconBtn(CR.green)}
                    onMouseEnter={(e) => headerIconBtnHover(e, CR.green, true)}
                    onMouseLeave={(e) => headerIconBtnHover(e, CR.green, false)}
                  >
                    <Play size={14} />
                  </button>
                )}

                {(running || paused) && (
                  <button
                    onClick={handleStop}
                    title="Stop"
                    style={headerIconBtn('var(--cr-error)')}
                    onMouseEnter={(e) =>
                      headerIconBtnHover(e, 'var(--cr-error)', true)
                    }
                    onMouseLeave={(e) =>
                      headerIconBtnHover(e, 'var(--cr-error)', false)
                    }
                  >
                    <Power size={14} />
                  </button>
                )}

                {/* Manage — Stage 23: single entry replacing the Views ▾ / Settings ▾
                                dropdowns. Opens the grouped sidebar panel beside the content. */}
                <button
                  onClick={() => (manageOpen ? closeManage() : openManage())}
                  title="Manage"
                  style={headerIconBtn(
                    CR.accent,
                    manageOpen || MANAGE_TAB_IDS.includes(tab),
                  )}
                  onMouseEnter={(e) => headerIconBtnHover(e, CR.accent, true)}
                  onMouseLeave={(e) =>
                    headerIconBtnHover(
                      e,
                      CR.accent,
                      manageOpen || MANAGE_TAB_IDS.includes(tab),
                    )
                  }
                >
                  <Settings2 size={14} />
                </button>
              </div>
            </div>

            {/* Row 1.5: project memberships — clickable chips, overflow popover when >3 */}
            {agentProjects.length > 0 &&
              (() => {
                const VISIBLE = 3;
                const inline = agentProjects.slice(0, VISIBLE);
                const extra = agentProjects.slice(VISIBLE);
                const ChipColor = 'var(--cr-purple)'; // purple to match project styling elsewhere
                return (
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      paddingLeft: isMobile ? 0 : 52,
                      margin: '0 0 10px',
                      flexWrap: 'wrap',
                      position: 'relative',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: CR.mono,
                        fontSize: 9,
                        color: CR.muted,
                        letterSpacing: '0.08em',
                        textTransform: 'uppercase',
                        flexShrink: 0,
                      }}
                    >
                      Member of
                    </span>
                    {inline.map((p) => (
                      <button
                        key={p.id}
                        onClick={() => navigate(`/projects/${p.id}`)}
                        title={p.role ? `${p.name} (role: ${p.role})` : p.name}
                        style={{
                          display: 'inline-flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 10px',
                          borderRadius: 100,
                          cursor: 'pointer',
                          background: `${withAlpha(ChipColor, 6)}`,
                          border: `1px solid ${withAlpha(ChipColor, 19)}`,
                          color: ChipColor,
                          fontFamily: CR.sans,
                          fontSize: 11,
                          fontWeight: 500,
                          transition: 'all 0.15s',
                          whiteSpace: 'nowrap',
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.background = `${withAlpha(ChipColor, 13)}`;
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.background = `${withAlpha(ChipColor, 6)}`;
                        }}
                      >
                        <span
                          style={{
                            width: 5,
                            height: 5,
                            borderRadius: '50%',
                            background: ChipColor,
                          }}
                        />
                        {p.name}
                      </button>
                    ))}
                    {extra.length > 0 && (
                      <div style={{ position: 'relative' }}>
                        <button
                          onClick={() => setProjectOverflowOpen((v) => !v)}
                          style={{
                            padding: '3px 10px',
                            borderRadius: 100,
                            cursor: 'pointer',
                            background: 'var(--cr-tint-3)',
                            border: `1px solid ${CR.border}`,
                            color: CR.muted,
                            fontFamily: CR.mono,
                            fontSize: 10,
                            fontWeight: 600,
                          }}
                        >
                          +{extra.length} more
                        </button>
                        {projectOverflowOpen && (
                          <>
                            <div
                              onClick={() => setProjectOverflowOpen(false)}
                              style={{
                                position: 'fixed',
                                inset: 0,
                                zIndex: 100,
                              }}
                            />
                            <div
                              style={{
                                position: 'absolute',
                                top: 'calc(100% + 6px)',
                                left: 0,
                                zIndex: 101,
                                minWidth: 220,
                                background: CR.bgCard,
                                border: `1px solid ${CR.border}`,
                                borderRadius: 10,
                                padding: 6,
                                boxShadow: '0 8px 24px var(--cr-shade-2)',
                              }}
                            >
                              {extra.map((p) => (
                                <button
                                  key={p.id}
                                  onClick={() => {
                                    setProjectOverflowOpen(false);
                                    navigate(`/projects/${p.id}`);
                                  }}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                    width: '100%',
                                    padding: '6px 10px',
                                    borderRadius: 6,
                                    cursor: 'pointer',
                                    background: 'transparent',
                                    border: 'none',
                                    color: CR.text,
                                    fontFamily: CR.sans,
                                    fontSize: 12,
                                    textAlign: 'left',
                                  }}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.background = `${withAlpha(ChipColor, 6)}`;
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.background =
                                      'transparent';
                                  }}
                                >
                                  <span
                                    style={{
                                      width: 5,
                                      height: 5,
                                      borderRadius: '50%',
                                      background: ChipColor,
                                      flexShrink: 0,
                                    }}
                                  />
                                  <span
                                    style={{
                                      flex: 1,
                                      overflow: 'hidden',
                                      textOverflow: 'ellipsis',
                                      whiteSpace: 'nowrap',
                                    }}
                                  >
                                    {p.name}
                                  </span>
                                  {p.role && (
                                    <span
                                      style={{
                                        fontFamily: CR.mono,
                                        fontSize: 9,
                                        color: CR.muted,
                                      }}
                                    >
                                      {p.role}
                                    </span>
                                  )}
                                </button>
                              ))}
                            </div>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })()}

            {/* Tabs — Stage 20: chat-first. The "Chat" label itself was removed
                        (2026-08-15): when tab === 'chat' there is nothing else on this row,
                        and being in the chat is already obvious from the rest of the page —
                        the label just cost vertical space. Returning to chat from another
                        view or from Manage still works via the fallback below and the
                        Manage sidebar's own close control. */}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {/* When a non-chat view is opened WITHOUT the Manage panel (dock pill or
                            slash command), show its name + a quick return. The Manage sidebar
                            provides its own return, so suppress this while it's open. */}
              {tab !== 'chat' && !manageOpen && (
                <>
                  <span style={{ color: CR.muted, fontSize: 12 }}>/</span>
                  <span
                    style={{
                      padding: '10px 4px',
                      fontFamily: CR.sans,
                      fontSize: 13,
                      color: CR.cream,
                      fontWeight: 500,
                      borderBottom: `2px solid ${CR.accent}`,
                    }}
                  >
                    {TABS.find((t) => t.id === tab)?.label ?? tab}
                  </span>
                  <button
                    onClick={() => setTab('chat')}
                    style={{
                      marginLeft: 8,
                      padding: '4px 10px',
                      fontFamily: CR.sans,
                      fontSize: 11,
                      color: CR.sub,
                      background: 'var(--cr-tint-2)',
                      border: `1px solid ${CR.border}`,
                      borderRadius: 7,
                      cursor: 'pointer',
                    }}
                  >
                    ← Back to chat
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {/* ── Tab content (Stage 23: optional Manage sidebar + content pane) ── */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: isMobile ? 'column' : 'row',
            overflow: 'hidden',
          }}
        >
          {/* Manage sidebar — grouped Inspect / Configure navigator. On mobile there's
                        no room for a 234px push column beside content, so it collapses into a
                        horizontal scrolling chip strip above the content pane instead. */}
          {manageOpen && !isMobile && (
            <div
              style={{
                width: 234,
                flexShrink: 0,
                borderRight: `1px solid ${CR.border}`,
                background: CR.bgSurf,
                overflowY: 'auto',
                padding: '12px 10px',
                display: 'flex',
                flexDirection: 'column',
                gap: 4,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  padding: '2px 8px 8px',
                }}
              >
                <span
                  style={{
                    fontFamily: CR.sans,
                    fontSize: 13,
                    fontWeight: 700,
                    color: CR.cream,
                  }}
                >
                  Manage
                </span>
              </div>
              {MANAGE_GROUPS.map((grp) => (
                <div key={grp.group} style={{ marginTop: 6 }}>
                  <div
                    style={{
                      fontFamily: CR.mono,
                      fontSize: 8,
                      color: CR.muted,
                      letterSpacing: '0.12em',
                      textTransform: 'uppercase',
                      padding: '4px 10px 6px',
                    }}
                  >
                    {grp.group}
                  </div>
                  {grp.items.map((it) => {
                    const active = tab === it.id;
                    return (
                      <button
                        key={it.id}
                        onClick={() => openManage(it.id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 9,
                          width: '100%',
                          textAlign: 'left',
                          padding: '8px 10px',
                          fontFamily: CR.sans,
                          fontSize: 12.5,
                          color: active ? CR.cream : CR.sub,
                          background: active ? CR.accentLow : 'transparent',
                          border: 'none',
                          borderRadius: 7,
                          cursor: 'pointer',
                        }}
                        onMouseEnter={(e) => {
                          if (!active)
                            e.currentTarget.style.background =
                              'var(--cr-tint-2)';
                        }}
                        onMouseLeave={(e) => {
                          if (!active)
                            e.currentTarget.style.background = 'transparent';
                        }}
                      >
                        <span
                          style={{
                            fontSize: 13,
                            width: 16,
                            textAlign: 'center',
                            opacity: 0.9,
                          }}
                        >
                          {it.icon}
                        </span>
                        {it.label}
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}

          {manageOpen && isMobile && (
            <div
              style={{
                flexShrink: 0,
                borderBottom: `1px solid ${CR.border}`,
                background: CR.bgSurf,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '8px 10px',
                overflowX: 'auto',
                WebkitOverflowScrolling: 'touch',
              }}
            >
              {MANAGE_GROUPS.flatMap((g) => g.items).map((it) => {
                const active = tab === it.id;
                return (
                  <button
                    key={it.id}
                    onClick={() => openManage(it.id)}
                    style={{
                      flexShrink: 0,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      whiteSpace: 'nowrap',
                      padding: '6px 12px',
                      fontFamily: CR.sans,
                      fontSize: 12,
                      color: active ? CR.cream : CR.sub,
                      background: active ? CR.accentLow : 'transparent',
                      border: `1px solid ${active ? CR.borderBright : 'transparent'}`,
                      borderRadius: 100,
                      cursor: 'pointer',
                    }}
                  >
                    <span style={{ fontSize: 12 }}>{it.icon}</span>
                    {it.label}
                  </button>
                );
              })}
            </div>
          )}

          {/* Content pane */}
          <div style={{ flex: 1, overflowY: 'auto', minWidth: 0 }}>
            {/* GENERAL — core agent settings, rendered inline (Stage 23) */}
            {tab === 'general' && (
              <div style={{ padding: isMobile ? '18px 16px' : '28px 40px' }}>
                <SettingsModal
                  inline
                  agent={agent}
                  onClose={() => {}}
                  onSave={handleSaveSettings}
                  onDelete={handleDeleteAgent}
                />
              </div>
            )}

            {/* MODELS — primary/subagent model, thinking, task routing (Stage: Models tab) */}
            {tab === 'models' && agentId && (
              <div style={{ padding: isMobile ? '18px 16px' : '28px 40px' }}>
                <AgentModelsPanel
                  agent={agent}
                  agentId={agentId}
                  updateAgent={updateAgent}
                />
              </div>
            )}

            {/* OVERVIEW */}
            {tab === 'overview' && (
              <div
                style={{
                  padding: isMobile ? '18px 16px' : '28px 40px',
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 28,
                }}
              >
                {/* A failing audit surfaces here, not only on the Audit tab. For a
                                scheduled agent the tab is the wrong place for it: an expired
                                credential or a missing pinned file would sit unnoticed until
                                someone remembered to go and look, while cycles kept running and
                                quietly producing nothing. Silent when everything passes. */}
                {auditFail && auditFail.length > 0 && (
                  <div
                    style={{
                      padding: '12px 16px',
                      borderRadius: 10,
                      background: 'var(--cr-amber-low)',
                      border: '1px solid var(--cr-amber-line)',
                    }}
                  >
                    <div
                      style={{
                        fontFamily: CR.mono,
                        fontSize: 12,
                        color: 'var(--cr-warn)',
                        fontWeight: 700,
                        marginBottom: 6,
                      }}
                    >
                      ⚠ This agent has {auditFail.length} failing check
                      {auditFail.length > 1 ? 's' : ''}
                    </div>
                    <div
                      style={{
                        fontFamily: CR.sans,
                        fontSize: 12,
                        color: CR.sub,
                        lineHeight: 1.6,
                      }}
                    >
                      {auditFail.join(' · ')}
                    </div>
                    <button
                      onClick={() => setTab('audit')}
                      style={{
                        marginTop: 8,
                        padding: '5px 11px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        border: `1px solid ${CR.border}`,
                        background: 'transparent',
                        color: CR.sub,
                        fontFamily: CR.mono,
                        fontSize: 11,
                      }}
                    >
                      Open Audit →
                    </button>
                  </div>
                )}

                {/* Stats */}
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: 'repeat(4, 1fr)',
                    gap: 2,
                  }}
                >
                  {[
                    ['Total Cycles', completedCycles.length],
                    [
                      'Cost Today',
                      budget ? `$${budget.daily.used.toFixed(4)}` : '—',
                    ],
                    ['Daily Limit', budget ? `$${budget.daily.limit}` : '—'],
                    [
                      'Monthly Budget',
                      budget ? `$${budget.monthly.limit}` : '—',
                    ],
                  ].map(([k, v]) => (
                    <div
                      key={k as string}
                      style={{
                        background: CR.bgSurf,
                        border: `1px solid ${CR.border}`,
                        padding: '18px 20px',
                        borderRadius: 2,
                      }}
                    >
                      <div
                        style={{
                          fontFamily: CR.mono,
                          fontSize: 9,
                          color: CR.mutedBr,
                          letterSpacing: '0.1em',
                          textTransform: 'uppercase',
                          marginBottom: 8,
                        }}
                      >
                        {k}
                      </div>
                      <div
                        style={{
                          fontFamily: CR.serif,
                          fontSize: 24,
                          color: CR.cream,
                        }}
                      >
                        {v}
                      </div>
                    </div>
                  ))}
                </div>

                {/* Budget bar */}
                {budget && budget.daily.limit > 0 && (
                  <div
                    style={{
                      background: CR.bgCard,
                      border: `1px solid ${CR.border}`,
                      borderRadius: 10,
                      padding: '16px 20px',
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        marginBottom: 8,
                      }}
                    >
                      <span
                        style={{
                          fontFamily: CR.mono,
                          fontSize: 9,
                          color: CR.mutedBr,
                          letterSpacing: '0.1em',
                          textTransform: 'uppercase',
                        }}
                      >
                        Daily Budget
                      </span>
                      <span
                        style={{
                          fontFamily: CR.mono,
                          fontSize: 10,
                          color: CR.sub,
                        }}
                      >
                        ${budget.daily.used.toFixed(4)} / ${budget.daily.limit}
                      </span>
                    </div>
                    <div
                      style={{
                        height: 4,
                        background: CR.bgSurf,
                        borderRadius: 2,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          borderRadius: 2,
                          width: `${Math.min(100, (budget.daily.used / budget.daily.limit) * 100)}%`,
                          background:
                            budget.daily.used / budget.daily.limit > 0.9
                              ? 'var(--cr-error)'
                              : CR.accent,
                          transition: 'width 0.3s',
                        }}
                      />
                    </div>
                  </div>
                )}

                {/* Live cycle feed — appears whenever any cycle is running on this agent */}
                {(running || isCycleRunning) &&
                  (() => {
                    // Find the latest iteration counter if the backend emitted one
                    const lastIter = [...liveProgress]
                      .reverse()
                      .find((ev) => ev.n !== undefined && ev.of !== undefined);
                    // Tool-call events for the timeline
                    const toolEvents = liveProgress.filter(
                      (ev) => ev.type === 'tool_call' || ev.tool,
                    );
                    const thinkingEvents = liveProgress.filter(
                      (ev) => ev.type === 'thinking',
                    );
                    const lastThinking =
                      thinkingEvents[thinkingEvents.length - 1];
                    return (
                      <div
                        style={{
                          background: CR.bgCard,
                          border: `1px solid var(--cr-green-line)`,
                          borderLeft: `3px solid ${CR.green}`,
                          borderRadius: 4,
                          padding: '18px 20px',
                        }}
                      >
                        {/* Header row */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                            marginBottom: 14,
                          }}
                        >
                          <div
                            style={{
                              width: 7,
                              height: 7,
                              borderRadius: '50%',
                              background: CR.green,
                              animation: 'crewPulse 2s infinite',
                            }}
                          />
                          <span
                            style={{
                              fontFamily: CR.mono,
                              fontSize: 10,
                              color: CR.green,
                              letterSpacing: '0.06em',
                            }}
                          >
                            CYCLE #{completedCycles.length + 1} · RUNNING
                          </span>
                          {lastIter && (
                            <span
                              style={{
                                fontFamily: CR.mono,
                                fontSize: 10,
                                color: CR.sub,
                                marginLeft: 8,
                              }}
                            >
                              iteration{' '}
                              <span
                                style={{ color: CR.cream, fontWeight: 700 }}
                              >
                                {lastIter.n}
                              </span>{' '}
                              / {lastIter.of}
                            </span>
                          )}
                          <span
                            style={{
                              fontFamily: CR.mono,
                              fontSize: 10,
                              color: CR.muted,
                              marginLeft: 'auto',
                            }}
                          >
                            {toolEvents.length} tool call
                            {toolEvents.length === 1 ? '' : 's'}
                          </span>
                        </div>

                        {/* Latest thinking line (italic, ephemeral) */}
                        {lastThinking && (
                          <div
                            style={{
                              fontFamily: CR.sans,
                              fontSize: 12,
                              color: CR.muted,
                              fontStyle: 'italic',
                              marginBottom: 12,
                              paddingLeft: 4,
                            }}
                          >
                            💭 {(lastThinking.message ?? '').slice(0, 220)}
                            <span
                              style={{
                                color: CR.accent,
                                animation: 'crewBlink 1.1s step-end infinite',
                              }}
                            >
                              {' '}
                              ▋
                            </span>
                          </div>
                        )}

                        {/* Tool call timeline */}
                        {toolEvents.length === 0 ? (
                          <div
                            style={{
                              fontFamily: CR.sans,
                              fontSize: 12,
                              color: CR.muted,
                              padding: '12px 0',
                              textAlign: 'center',
                            }}
                          >
                            Waiting for first tool call…
                          </div>
                        ) : (
                          <div
                            style={{
                              display: 'flex',
                              flexDirection: 'column',
                              gap: 6,
                              maxHeight: 320,
                              overflowY: 'auto',
                            }}
                          >
                            {toolEvents.slice(-15).map((ev, i) => {
                              const toolName = ev.tool ?? 'unknown';
                              const preview =
                                ev.preview ??
                                (ev.args
                                  ? typeof ev.args === 'string'
                                    ? ev.args
                                    : JSON.stringify(ev.args)
                                  : '');
                              const TOOL_ICONS: Record<string, string> = {
                                read_file: '📄',
                                write_file: '✏️',
                                edit_file: '✂️',
                                list_dir: '📂',
                                list_files: '📂',
                                search_files: '🔍',
                                glob_search: '🔍',
                                grep_search: '🔍',
                                exec: '⚡',
                                python_repl: '🐍',
                                web_search: '🌐',
                                web_fetch: '🌐',
                                browser: '🌐',
                                emit_artifact: '🎁',
                                message: '📩',
                                notify: '🔔',
                                spawn: '🤖',
                                delegate_task: '➡️',
                                search_memory: '🧠',
                                append_memory: '💾',
                                run_cycle: '▶',
                                get_cycle_history: '📊',
                                git: '🌿',
                                sql_query: '🗄️',
                              };
                              const icon = TOOL_ICONS[toolName] ?? '⚙️';
                              return (
                                <div
                                  key={i}
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 10,
                                    background: 'var(--cr-tint-1)',
                                    border: `1px solid ${CR.border}`,
                                    borderRadius: 6,
                                    padding: '6px 10px',
                                  }}
                                >
                                  <span style={{ fontSize: 13, flexShrink: 0 }}>
                                    {icon}
                                  </span>
                                  <div style={{ flex: 1, minWidth: 0 }}>
                                    <div
                                      style={{
                                        fontFamily: CR.mono,
                                        fontSize: 10,
                                        fontWeight: 700,
                                        color: agColor,
                                        textTransform: 'uppercase',
                                        letterSpacing: '0.05em',
                                      }}
                                    >
                                      {toolName.replace(/_/g, ' ')}
                                    </div>
                                    {preview && (
                                      <div
                                        style={{
                                          fontFamily: CR.mono,
                                          fontSize: 10,
                                          color: CR.muted,
                                          marginTop: 1,
                                          overflow: 'hidden',
                                          textOverflow: 'ellipsis',
                                          whiteSpace: 'nowrap',
                                        }}
                                      >
                                        {String(preview).slice(0, 200)}
                                      </div>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}

                        {/* Mid-cycle alert (escalations, errors) */}
                        {midCycleAlert && (
                          <div
                            style={{
                              marginTop: 12,
                              padding: '10px 12px',
                              borderRadius: 8,
                              background:
                                midCycleAlert.urgency === 'high'
                                  ? 'var(--cr-error-low)'
                                  : 'var(--cr-amber-low)',
                              border: `1px solid ${midCycleAlert.urgency === 'high' ? 'var(--cr-error-line)' : 'var(--cr-amber-line)'}`,
                              fontFamily: CR.sans,
                              fontSize: 12,
                              color:
                                midCycleAlert.urgency === 'high'
                                  ? 'var(--cr-error)'
                                  : 'var(--cr-warn)',
                            }}
                          >
                            ⚠ {midCycleAlert.message}
                          </div>
                        )}
                      </div>
                    );
                  })()}

                {/* Cycle history — includes failed/stopped cycles so the user can debug them */}
                <div>
                  <div
                    style={{
                      fontFamily: CR.serif,
                      fontSize: 18,
                      color: CR.sub,
                      marginBottom: 14,
                    }}
                  >
                    Cycle history
                  </div>
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                    }}
                  >
                    {(() => {
                      const finishedCycles = agCycles.filter(
                        (c) => c.status !== 'running',
                      );
                      if (finishedCycles.length === 0) {
                        return (
                          <div
                            style={{
                              padding: 24,
                              textAlign: 'center',
                              color: CR.muted,
                              fontFamily: CR.sans,
                              fontSize: 13,
                            }}
                          >
                            No cycles yet. Click "Run Cycle" to start.
                          </div>
                        );
                      }
                      return finishedCycles.map((c) => {
                        const isOk = c.status === 'completed';
                        const statusStr = String(c.status);
                        const statusMeta = isOk
                          ? { label: '✓ completed', color: CR.green }
                          : statusStr === 'failed'
                            ? { label: '✕ failed', color: 'var(--cr-error)' }
                            : statusStr === 'stopped'
                              ? {
                                  label: '■  stopped',
                                  color: 'var(--cr-orange)',
                                }
                              : { label: statusStr, color: CR.muted };
                        return (
                          <div
                            key={c.id}
                            title="Open this cycle in chat"
                            onClick={() => {
                              setPendingScrollCycle(c.id);
                              setTab('chat');
                            }}
                            style={{
                              background: CR.bgCard,
                              border: `1px solid ${CR.border}`,
                              borderLeft: `3px solid ${statusMeta.color}`,
                              borderRadius: 10,
                              padding: '16px 20px',
                              cursor: 'pointer',
                              transition: 'border-color 0.15s',
                            }}
                            onMouseEnter={(e) =>
                              (e.currentTarget.style.borderColor =
                                CR.borderBright)
                            }
                            onMouseLeave={(e) =>
                              (e.currentTarget.style.borderColor = CR.border)
                            }
                          >
                            <div
                              style={{
                                display: 'flex',
                                justifyContent: 'space-between',
                                marginBottom: 8,
                                alignItems: 'center',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  gap: 10,
                                  alignItems: 'center',
                                }}
                              >
                                <span
                                  style={{
                                    fontFamily: CR.mono,
                                    fontSize: 10,
                                    color: statusMeta.color,
                                  }}
                                >
                                  {statusMeta.label}
                                </span>
                                <span
                                  style={{
                                    fontFamily: CR.mono,
                                    fontSize: 10,
                                    color: CR.muted,
                                  }}
                                >
                                  {fmt(c.started_at)}
                                </span>
                                {/* Where it ran. Only shown for the user's browser, because that is the
                                                                claim worth being able to check — a summary reads identically from
                                                                either machine, so "did that use my browser?" had no answer once the
                                                                panel had moved on. The container is the default and needs no badge.

                                                                This badge is earned, not permitted: the row starts at 'container'
                                                                and browser-control-dispatch.ts promotes it the first time a command
                                                                really arrives at that browser. It used to be written from the
                                                                routing decision, which stopped meaning the same thing once
                                                                `identity` made the lane a per-tool-call choice — an opted-in cycle
                                                                that sweeps public pages anonymously touches this browser never. */}
                                {(c as { lane?: string }).lane ===
                                  'user-browser' && (
                                  <span
                                    title="This cycle drove the browser on your machine"
                                    style={{
                                      fontFamily: CR.mono,
                                      fontSize: 9,
                                      letterSpacing: '0.06em',
                                      color: CR.blue,
                                      border: `1px solid ${CR.blue}44`,
                                      borderRadius: 4,
                                      padding: '1px 5px',
                                    }}
                                  >
                                    YOUR BROWSER
                                  </span>
                                )}
                              </div>
                              <div style={{ display: 'flex', gap: 14 }}>
                                <span
                                  style={{
                                    fontFamily: CR.mono,
                                    fontSize: 10,
                                    color: CR.sub,
                                  }}
                                >
                                  {fmtDur(c.started_at, c.ended_at)}
                                </span>
                                <span
                                  style={{
                                    fontFamily: CR.mono,
                                    fontSize: 10,
                                    color: CR.accentWarm,
                                  }}
                                >
                                  ${(c.cost || 0).toFixed(4)}
                                </span>
                              </div>
                            </div>
                            <p
                              style={{
                                fontFamily: CR.sans,
                                fontSize: 12,
                                color: CR.sub,
                                margin: 0,
                                lineHeight: 1.55,
                              }}
                            >
                              {c.summary ||
                                (isOk
                                  ? 'Task executed.'
                                  : '(no summary recorded)')}
                            </p>
                          </div>
                        );
                      });
                    })()}
                  </div>
                </div>

                {/* Sub-agents */}
                {subAgents.length > 0 && (
                  <div>
                    <div
                      style={{
                        fontFamily: CR.mono,
                        fontSize: 9,
                        color: CR.mutedBr,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        marginBottom: 12,
                      }}
                    >
                      Spawned Sub-Agents ({subAgents.length})
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 8,
                      }}
                    >
                      {subAgents.map((sa: any) => {
                        const isRunning = sa.status === 'running';
                        return (
                          <div
                            key={sa.id}
                            style={{
                              padding: '14px 18px',
                              borderRadius: 10,
                              background: CR.bgSurf,
                              border: `1px solid ${CR.border}`,
                              borderLeft: `3px solid ${isRunning ? CR.green : CR.border}`,
                              display: 'flex',
                              alignItems: 'center',
                              gap: 14,
                            }}
                          >
                            <span style={{ fontSize: 20 }}>
                              {sa.emoji || '🔀'}
                            </span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  marginBottom: 3,
                                }}
                              >
                                <span
                                  style={{
                                    fontFamily: CR.sans,
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: CR.cream,
                                  }}
                                >
                                  {sa.name.replace('[sub] ', '')}
                                </span>
                                <span
                                  style={{
                                    fontSize: 8,
                                    fontFamily: CR.mono,
                                    padding: '1px 6px',
                                    borderRadius: 4,
                                    background: isRunning
                                      ? 'var(--cr-green-low)'
                                      : 'var(--cr-tint-3)',
                                    border: `1px solid ${isRunning ? 'var(--cr-green-line)' : CR.border}`,
                                    color: isRunning ? CR.green : CR.muted,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.05em',
                                  }}
                                >
                                  {sa.status}
                                </span>
                              </div>
                              <div
                                style={{
                                  fontFamily: CR.sans,
                                  fontSize: 11.5,
                                  color: CR.muted,
                                }}
                              >
                                Spawned{' '}
                                {new Date(sa.created_at).toLocaleString()}
                              </div>
                            </div>
                            <button
                              onClick={() => navigate(`/agents/${sa.id}`)}
                              style={{
                                flexShrink: 0,
                                padding: '5px 12px',
                                borderRadius: 7,
                                cursor: 'pointer',
                                fontFamily: CR.mono,
                                fontSize: 9,
                                textTransform: 'uppercase',
                                letterSpacing: '0.05em',
                                background: 'transparent',
                                border: `1px solid ${CR.border}`,
                                color: CR.muted,
                                transition: 'all 0.15s',
                              }}
                              onMouseEnter={(e) => {
                                e.currentTarget.style.borderColor = CR.accent;
                                e.currentTarget.style.color = CR.accent;
                              }}
                              onMouseLeave={(e) => {
                                e.currentTarget.style.borderColor = CR.border;
                                e.currentTarget.style.color = CR.muted;
                              }}
                            >
                              View →
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* HANDOFFS */}
            {tab === 'handoffs' &&
              (() => {
                // Stage 56 vocabulary. This list and the one in HandoffsInboxPage
                // drifted for a day: that page was updated and this one was not, so a
                // `cannot` or `expired` handoff fell through to the amber "pending"
                // style and read as still-waiting. Same two-places disease as the
                // handoff routes — keep them in step.

                const doStatusUpdate = async (
                  handoffId: string,
                  status: string,
                  note?: string,
                ) => {
                  await fetch(`/api/agents/${agentId}/handoffs/${handoffId}`, {
                    method: 'PATCH',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ status, note }),
                  });
                  loadHandoffs();
                };

                return (
                  <div
                    style={{
                      padding: isMobile ? '18px 16px' : '28px 40px',
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 20,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 4,
                      }}
                    >
                      <div>
                        <div
                          style={{
                            fontFamily: CR.serif,
                            fontSize: 20,
                            color: CR.cream,
                          }}
                        >
                          Task Handoffs
                        </div>
                        <div
                          style={{
                            fontFamily: CR.sans,
                            fontSize: 11,
                            color: CR.muted,
                            marginTop: 4,
                          }}
                        >
                          Delegate a specific task to another agent. Auto-fires
                          their cycle on receipt.
                        </div>
                      </div>
                      <div
                        style={{
                          display: 'flex',
                          gap: 8,
                          alignItems: 'center',
                        }}
                      >
                        <button
                          onClick={() => {
                            fetch('/api/agents')
                              .then((r) => r.json())
                              .then(setAllAgents)
                              .catch(() => {});
                            setShowHandoffModal(true);
                          }}
                          style={{
                            padding: '7px 14px',
                            borderRadius: 8,
                            cursor: 'pointer',
                            background: `linear-gradient(135deg, ${CR.accent}, ${CR.accentWarm})`,
                            border: 'none',
                            color: 'var(--cr-on-accent)',
                            fontFamily: CR.sans,
                            fontSize: 12,
                            fontWeight: 600,
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            boxShadow: `0 3px 10px ${CR.accent40}`,
                          }}
                        >
                          <span style={{ fontSize: 11 }}>+</span> New Handoff
                        </button>
                        <button
                          onClick={loadHandoffs}
                          style={{
                            background: 'none',
                            border: 'none',
                            color: CR.accent,
                            cursor: 'pointer',
                            fontFamily: CR.mono,
                            fontSize: 10,
                            letterSpacing: '0.05em',
                          }}
                        >
                          ↻ REFRESH
                        </button>
                      </div>
                    </div>

                    {/* One renderer, shared with the Handoffs page. The
                                    hand-rolled cards that used to live here showed the raw
                                    payload JSON, a formatted copy of the same text AND the
                                    note — the same reply three times on one screen — under
                                    pre-stage-56 status names that no longer exist. */}
                    <AgentConversations
                      threads={convos}
                      loading={convosLoading}
                      emoji={(id) =>
                        agents.find((a) => a.id === id)?.emoji ?? '🤖'
                      }
                      onOpenAgent={(id) => navigate(`/agents/${id}`)}
                      dense
                    />
                  </div>
                );
              })()}

            {/* CHAT */}
            {tab === 'chat' &&
              (() => {
                const agentCheckins = (pendingCheckins || []).filter(
                  (c: any) => c.agent_id === agentId,
                );
                // Stage 60 phase 2: a question is answered, not approved — it gets its own
                // card and stays out of the batch-approve queue.
                const questionCheckins = agentCheckins.filter(
                  (c: any) => c.action_type === 'clarify_live',
                );
                const dockCheckins = agentCheckins.filter(
                  (c: any) => c.action_type !== 'clarify_live',
                );
                return (
                  <div
                    style={{
                      height: '100%',
                      display: 'flex',
                      flexDirection: 'column',
                    }}
                  >
                    {/* Message list */}
                    <div
                      style={{
                        flex: 1,
                        position: 'relative',
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        ref={setChatBodyRef}
                        onScroll={handleChatScroll}
                        style={{
                          height: '100%',
                          overflowY: 'auto',
                          overflowX: 'hidden',
                          padding: isMobile ? '16px 14px' : '24px 40px',
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: 'center',
                        }}
                      >
                        {/* Centered column, capped at the composer's own width (760px, set where the
                                    input box is built below) — so the thread and the box you type into read as
                                    one aligned column instead of the thread stretching edge to edge while the
                                    input sits centered underneath it. */}
                        <div
                          style={{
                            width: '100%',
                            maxWidth: isMobile ? undefined : 760,
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 20,
                          }}
                        >
                          {/* Stage 35 Phase 2 — the conversation_events read path, behind ?conv=1.
                                        One fetch, one socket event, one renderer, and errors as a distinct
                                        state. The legacy branch below stays until Phase 4 so the two can be
                                        compared against the same live conversation. */}
                          {FLAGS.conversationEvents ? (
                            <ConversationView
                              events={conversationEvents}
                              loading={conversationLoading}
                              error={conversationError}
                              agentColor="var(--cr-accent)"
                              agentName={agent.name}
                              agentId={agentId}
                              agentEmoji={agent.emoji || '🤖'}
                              mdComponents={mdComponents}
                              liveTokenCount={
                                [...liveProgress]
                                  .reverse()
                                  .find(
                                    (ev) => typeof ev.total_tokens === 'number',
                                  )?.total_tokens
                              }
                              hasOlder={conversationHasOlder}
                              loadingOlder={conversationLoadingOlder}
                              onLoadOlder={conversationLoadOlder}
                            />
                          ) : (
                            renderedHistory
                          )}

                          {/* Streaming indicator — show while streaming and before a real response is output.
                                        Legacy path only: under the event stream the running turn is ALREADY in the
                                        log (its thinking/tool events arrive as conversation:event and render inside
                                        ConversationView), so leaving this on renders the same turn twice — once from
                                        the log and once from liveTools. Same suppression as the project chat. */}
                          {!FLAGS.conversationEvents &&
                            (() => {
                              const lastNonAckMsg = [...history]
                                .reverse()
                                .find((msg) => {
                                  if (msg.role === 'user') return true;
                                  const c = (msg.content || '')
                                    .replace(/^_+|_+$/g, '')
                                    .trim();
                                  const isAck =
                                    /^On it\b/.test(c) ||
                                    /^Dispatching to /.test(c) ||
                                    /^(⚙️|⌛)/.test(c) ||
                                    /^Running .* cycle…?$/.test(c) ||
                                    /^Still working on the previous/.test(c);
                                  return !isAck;
                                });
                              // Show "working" whenever a cycle is live for this agent — not just
                              // when chat:typing fired. A cycle can start from anywhere (chat box,
                              // API, scheduler, handoff); the agent's running status is the source
                              // of truth, so the thread reflects work no matter how it was triggered.
                              const agentRunning = agent?.status === 'running';
                              const showIndicator =
                                (isStreaming || agentRunning) &&
                                (!lastNonAckMsg ||
                                  lastNonAckMsg.role === 'user' ||
                                  liveTools.length > 0);
                              if (!showIndicator) return null;

                              // Live cumulative token count (Claude-style "· N tokens"),
                              // streamed from nanobot's per-call usage via cycle_progress.
                              const liveTokens = [...liveProgress]
                                .reverse()
                                .find(
                                  (ev) => typeof ev.total_tokens === 'number',
                                )?.total_tokens;

                              return (
                                <>
                                  {/* stage44 doc 01, step 4 — the live browser view.
                                                    Only while an effector tool is the active one AND a
                                                    frame has actually arrived: no placeholder, no empty
                                                    box, nothing at all when there's nothing to show. */}
                                  {liveFrame &&
                                    (effectorIsActive || liveFrameEnded) && (
                                      <div
                                        style={{
                                          margin: '0 0 10px',
                                          borderRadius: 10,
                                          overflow: 'hidden',
                                          border: `1px solid ${CR.border}`,
                                          background: CR.bgElevated,
                                        }}
                                      >
                                        {/* stage45 item 2: a tab and a URL bar, built from state we
                                                            already had and used to discard. `title` and `url` are
                                                            page-controlled, so both render as plain text — no anchor,
                                                            no href — and the URL is truncated from the LEFT so the
                                                            host stays visible on a long path. */}
                                        <div
                                          style={{
                                            borderBottom: `1px solid ${CR.border}`,
                                          }}
                                        >
                                          <div
                                            style={{
                                              display: 'flex',
                                              alignItems: 'center',
                                              gap: 6,
                                              padding: '6px 10px 0',
                                            }}
                                          >
                                            <span
                                              style={{
                                                width: 6,
                                                height: 6,
                                                borderRadius: '50%',
                                                background: liveFrameEnded
                                                  ? CR.muted
                                                  : agColor,
                                                flexShrink: 0,
                                              }}
                                            />
                                            <span
                                              style={{
                                                fontSize: 11,
                                                color: CR.muted,
                                                flexShrink: 0,
                                              }}
                                            >
                                              {/* Never let a still image pass for a live one. The picture is
                                                                        kept after the run so arriving late shows where the browser
                                                                        got to rather than an empty box, and the label is what makes
                                                                        that honest. */}
                                              {liveFrameEnded
                                                ? 'Browser closed — last view'
                                                : 'Live browser'}
                                            </span>
                                            {liveFrameTitle && (
                                              <span
                                                title={liveFrameTitle}
                                                style={{
                                                  fontSize: 11,
                                                  color: CR.cream,
                                                  marginLeft: 4,
                                                  overflow: 'hidden',
                                                  textOverflow: 'ellipsis',
                                                  whiteSpace: 'nowrap',
                                                }}
                                              >
                                                {liveFrameTitle}
                                              </span>
                                            )}
                                          </div>
                                          {liveFrameUrl && (
                                            <div
                                              title={liveFrameUrl}
                                              style={{
                                                margin: '6px 10px 8px',
                                                padding: '3px 8px',
                                                borderRadius: 6,
                                                background: CR.bgMain,
                                                border: `1px solid ${CR.border}`,
                                                fontSize: 11,
                                                color: CR.muted,
                                                fontFamily:
                                                  'ui-monospace, monospace',
                                                overflow: 'hidden',
                                                textOverflow: 'ellipsis',
                                                whiteSpace: 'nowrap',
                                                direction: 'rtl',
                                                textAlign: 'left',
                                              }}
                                            >
                                              <span
                                                style={{
                                                  direction: 'ltr',
                                                  unicodeBidi: 'bidi-override',
                                                }}
                                              >
                                                {liveFrameUrl}
                                              </span>
                                            </div>
                                          )}
                                        </div>
                                        <img
                                          src={liveFrame}
                                          alt="Live view of the browser the agent is driving"
                                          style={{
                                            display: 'block',
                                            width: '100%',
                                            maxHeight: 420,
                                            objectFit: 'contain',
                                            background: '#000',
                                          }}
                                        />
                                        {/* stage45 item 5 — steer the run without stopping it.
                                                            Everything else a human could say to a running agent
                                                            was a decision on an action it chose to ask about;
                                                            this is for a run that is going wrong and not asking. */}
                                        {liveCycleId && (
                                          <form
                                            onSubmit={async (e) => {
                                              e.preventDefault();
                                              const text = steerText.trim();
                                              if (!text) return;
                                              setSteerText('');
                                              try {
                                                await fetch(
                                                  `/api/agents/${agentId}/cycles/${liveCycleId}/steer`,
                                                  {
                                                    method: 'POST',
                                                    headers: {
                                                      'Content-Type':
                                                        'application/json',
                                                    },
                                                    body: JSON.stringify({
                                                      text,
                                                    }),
                                                  },
                                                );
                                                setSteerSent((n) => n + 1);
                                              } catch {
                                                /* the run is unaffected either way */
                                              }
                                            }}
                                            style={{
                                              display: 'flex',
                                              gap: 8,
                                              padding: 8,
                                              borderTop: `1px solid ${CR.border}`,
                                            }}
                                          >
                                            <input
                                              value={steerText}
                                              onChange={(e) =>
                                                setSteerText(e.target.value)
                                              }
                                              placeholder="Tell the run something - it picks this up on its next step"
                                              style={{
                                                flex: 1,
                                                background: CR.bgMain,
                                                border: `1px solid ${CR.border}`,
                                                borderRadius: 6,
                                                color: CR.cream,
                                                fontSize: 12,
                                                padding: '6px 10px',
                                                fontFamily: CR.sans,
                                              }}
                                            />
                                            <button
                                              type="submit"
                                              disabled={!steerText.trim()}
                                              style={{
                                                background: 'none',
                                                border: `1px solid ${steerText.trim() ? CR.accent : CR.border}`,
                                                borderRadius: 6,
                                                color: steerText.trim()
                                                  ? CR.cream
                                                  : CR.muted,
                                                fontSize: 11,
                                                fontFamily: CR.mono,
                                                padding: '5px 12px',
                                                cursor: steerText.trim()
                                                  ? 'pointer'
                                                  : 'default',
                                              }}
                                            >
                                              send
                                            </button>
                                          </form>
                                        )}
                                        {steerSent > 0 && (
                                          <div
                                            style={{
                                              padding: '0 10px 8px',
                                              fontSize: 11,
                                              color: CR.muted,
                                            }}
                                          >
                                            {steerSent} note
                                            {steerSent === 1 ? '' : 's'} sent -
                                            the agent reads them at its next
                                            step.
                                          </div>
                                        )}
                                      </div>
                                    )}
                                  <StreamingTurn
                                    agentName={agent.name}
                                    agentEmoji={emoji}
                                    agentColor={agColor}
                                    liveTools={liveTools}
                                    tokenCount={liveTokens}
                                  />
                                </>
                              );
                            })()}
                        </div>
                      </div>
                      {!isAtBottom && (
                        <button
                          onClick={scrollToBottom}
                          title="Scroll to bottom"
                          style={{
                            position: 'absolute',
                            bottom: 16,
                            right: 20,
                            width: 34,
                            height: 34,
                            borderRadius: '50%',
                            background: CR.bgElevated,
                            border: `1px solid ${CR.border}`,
                            color: CR.cream,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            fontSize: 15,
                            boxShadow: '0 4px 16px var(--cr-shade-3)',
                            zIndex: 10,
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.borderColor = agColor;
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.borderColor = CR.border;
                          }}
                        >
                          ↓
                        </button>
                      )}
                    </div>

                    {questionCheckins.length > 0 && (
                      <div
                        style={{
                          flexShrink: 0,
                          padding: '12px 40px 0',
                          width: '100%',
                          maxWidth: isMobile ? undefined : 840,
                          margin: '0 auto',
                          boxSizing: 'border-box',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 10,
                        }}
                      >
                        {questionCheckins.map((c: any) => (
                          <QuestionCard
                            key={c.id}
                            checkin={c}
                            agentName={agent.name}
                            accent={agColor}
                            mdComponents={mdComponents}
                            onAnswer={(reply) => respondToCheckin(c.id, reply)}
                          />
                        ))}
                      </div>
                    )}

                    {/* Stage 20 Phase 4 — inline approval cards: act on agent
                                    actions (send email, create agent…) right in the chat. */}
                    {dockCheckins.length > 0 && (
                      <div
                        style={{
                          flexShrink: 0,
                          padding: '12px 40px 0',
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 10,
                        }}
                      >
                        {/* Batch bar — only worth the space once there is a queue to clear. */}
                        {dockCheckins.length > 1 &&
                          (() => {
                            const selectedIds = dockCheckins
                              .filter((c: any) => selectedCheckins[c.id])
                              .map((c: any) => c.id);
                            const n = selectedIds.length;
                            const allSelected = n === dockCheckins.length;
                            return (
                              <div
                                style={{
                                  background: CR.bgSurf,
                                  border: `1px solid ${CR.border}`,
                                  borderRadius: 10,
                                  padding: '10px 12px',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 8,
                                }}
                              >
                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 10,
                                    flexWrap: 'wrap',
                                  }}
                                >
                                  <button
                                    onClick={() =>
                                      setSelectedCheckins(
                                        allSelected
                                          ? {}
                                          : Object.fromEntries(
                                              dockCheckins.map((c: any) => [
                                                c.id,
                                                true,
                                              ]),
                                            ),
                                      )
                                    }
                                    style={{
                                      padding: '5px 10px',
                                      borderRadius: 7,
                                      cursor: 'pointer',
                                      background: 'transparent',
                                      border: `1px solid ${CR.border}`,
                                      color: CR.sub,
                                      fontFamily: CR.sans,
                                      fontSize: 11,
                                    }}
                                  >
                                    {allSelected
                                      ? 'Clear selection'
                                      : `Select all ${dockCheckins.length}`}
                                  </button>
                                  <span
                                    style={{
                                      fontFamily: CR.sans,
                                      fontSize: 11,
                                      color: n ? CR.cream : CR.muted,
                                    }}
                                  >
                                    {n
                                      ? `${n} of ${dockCheckins.length} selected`
                                      : 'Nothing selected — tick the ones you have read'}
                                  </span>
                                </div>
                                {n > 0 && (
                                  <>
                                    <textarea
                                      value={batchNote}
                                      onChange={(e) =>
                                        setBatchNote(e.target.value)
                                      }
                                      onInput={(e) => {
                                        const t = e.currentTarget;
                                        t.style.height = 'auto';
                                        t.style.height = `${Math.min(t.scrollHeight, 200)}px`;
                                      }}
                                      rows={2}
                                      placeholder={`Optional note — applied to all ${n} (the batch takes one reply, not one per item)`}
                                      style={{
                                        width: '100%',
                                        boxSizing: 'border-box',
                                        background: CR.bgCard,
                                        border: `1px solid ${CR.border}`,
                                        borderRadius: 8,
                                        padding: '7px 12px',
                                        color: CR.text,
                                        fontFamily: CR.sans,
                                        fontSize: 12,
                                        lineHeight: 1.5,
                                        outline: 'none',
                                        resize: 'vertical',
                                        minHeight: 52,
                                        maxHeight: 200,
                                      }}
                                    />
                                    <div
                                      style={{
                                        display: 'flex',
                                        gap: 8,
                                        flexWrap: 'wrap',
                                      }}
                                    >
                                      <button
                                        disabled={batchBusy}
                                        onClick={() =>
                                          respondToCheckinsBatch(
                                            selectedIds,
                                            batchNote.trim()
                                              ? `approve — ${batchNote.trim()}`
                                              : 'approve',
                                          )
                                        }
                                        style={{
                                          padding: '7px 16px',
                                          borderRadius: 8,
                                          cursor: batchBusy
                                            ? 'default'
                                            : 'pointer',
                                          background: 'var(--cr-green-low)',
                                          border:
                                            '1px solid var(--cr-green-line)',
                                          color: CR.green,
                                          fontFamily: CR.sans,
                                          fontSize: 12,
                                          fontWeight: 600,
                                          opacity: batchBusy ? 0.6 : 1,
                                        }}
                                      >
                                        {batchBusy
                                          ? 'Working…'
                                          : `✓ Approve${dockCheckins.some((c: any) => selectedCheckins[c.id] && (c.action_type === 'send_email' || c.action_type === 'smtp_send')) ? ' & Send' : ''} (${n} selected)`}
                                      </button>
                                      <button
                                        disabled={batchBusy}
                                        onClick={() =>
                                          respondToCheckinsBatch(
                                            selectedIds,
                                            batchNote.trim()
                                              ? `reject — ${batchNote.trim()}`
                                              : 'reject',
                                          )
                                        }
                                        style={{
                                          padding: '7px 14px',
                                          borderRadius: 8,
                                          cursor: batchBusy
                                            ? 'default'
                                            : 'pointer',
                                          background: 'transparent',
                                          border:
                                            '1px solid var(--cr-error-line)',
                                          color: 'var(--cr-error)',
                                          fontFamily: CR.sans,
                                          fontSize: 12,
                                          opacity: batchBusy ? 0.6 : 1,
                                        }}
                                      >
                                        ✕ Reject ({n})
                                      </button>
                                    </div>
                                  </>
                                )}
                                {batchResult && (
                                  <div
                                    style={{
                                      fontFamily: CR.sans,
                                      fontSize: 11,
                                      color: batchResult.failed.length
                                        ? 'var(--cr-error)'
                                        : CR.green,
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: 3,
                                    }}
                                  >
                                    <span>
                                      {batchResult.succeeded} succeeded
                                      {batchResult.failed.length
                                        ? `, ${batchResult.failed.length} failed`
                                        : ''}
                                    </span>
                                    {batchResult.failed.map((f) => (
                                      <span
                                        key={f.id}
                                        style={{
                                          fontFamily: CR.mono,
                                          fontSize: 10,
                                        }}
                                      >
                                        {f.id.slice(0, 8)} — {f.error}
                                      </span>
                                    ))}
                                  </div>
                                )}
                              </div>
                            );
                          })()}
                        {dockCheckins.map((c: any) => {
                          const payload = (() => {
                            try {
                              return JSON.parse(c.action_payload || '{}');
                            } catch {
                              return {};
                            }
                          })();
                          const title =
                            c.action_type === 'batch_send_live'
                              ? `Send ${Array.isArray(payload.items) ? payload.items.length : ''} × ${payload.action ?? 'message'} on ${payload.site ?? 'a site'} from your browser`
                              : c.action_type === 'create_agent'
                                ? `Create agent: ${payload.name ?? 'new agent'}`
                                : c.action_type === 'run_plan'
                                  ? `Start a run: ${payload.goal ?? 'delegated work'} (up to $${Number(payload.budget_usd ?? 0).toFixed(2)})`
                                  : c.action_type === 'send_email' ||
                                      c.action_type === 'smtp_send'
                                    ? `Send email${payload.to ? ` → ${payload.to}` : ''}`
                                    : 'Approval needed';
                          return (
                            <div
                              key={c.id}
                              style={{
                                background: CR.bgCard,
                                border: `1px solid ${selectedCheckins[c.id] ? 'var(--cr-green-line)' : 'var(--cr-purple-line)'}`,
                                borderRadius: 12,
                                padding: '14px 16px',
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 8,
                                  marginBottom: 8,
                                }}
                              >
                                {dockCheckins.length > 1 && (
                                  <input
                                    type="checkbox"
                                    checked={!!selectedCheckins[c.id]}
                                    onChange={(e) =>
                                      setSelectedCheckins((s) => ({
                                        ...s,
                                        [c.id]: e.target.checked,
                                      }))
                                    }
                                    title="Include in batch decision"
                                    style={{
                                      width: 14,
                                      height: 14,
                                      cursor: 'pointer',
                                      accentColor: 'var(--cr-green)',
                                      flexShrink: 0,
                                    }}
                                  />
                                )}
                                <span
                                  style={{
                                    fontFamily: CR.mono,
                                    fontSize: 9,
                                    padding: '2px 8px',
                                    borderRadius: 100,
                                    background: 'var(--cr-purple-low)',
                                    border: '1px solid var(--cr-purple-line)',
                                    color: 'var(--cr-purple)',
                                    textTransform: 'uppercase',
                                  }}
                                >
                                  Approval needed
                                </span>
                                <span
                                  style={{
                                    fontFamily: CR.sans,
                                    fontSize: 13,
                                    fontWeight: 600,
                                    color: CR.cream,
                                  }}
                                >
                                  {title}
                                </span>
                              </div>
                              {c.report_md && (
                                <div
                                  className="agent-md"
                                  style={{
                                    fontSize: 12,
                                    color: CR.sub,
                                    lineHeight: 1.6,
                                    maxHeight: 180,
                                    overflowY: 'auto',
                                    marginBottom: 10,
                                    background: CR.bgSurf,
                                    border: `1px solid ${CR.border}`,
                                    borderRadius: 8,
                                    padding: '10px 12px',
                                  }}
                                >
                                  <ReactMarkdown
                                    remarkPlugins={[remarkGfm]}
                                    components={mdComponents}
                                  >
                                    {c.report_md}
                                  </ReactMarkdown>
                                </div>
                              )}
                              {/* Seed-at-birth: attach reference files to the new agent */}
                              {c.action_type === 'create_agent' &&
                                (() => {
                                  const staged = stagedRefs[c.id];
                                  return (
                                    <div style={{ marginBottom: 10 }}>
                                      <input
                                        id={`stage-${c.id}`}
                                        type="file"
                                        multiple
                                        style={{ display: 'none' }}
                                        onChange={(e) =>
                                          stageRefsForCheckin(
                                            c.id,
                                            e.target.files,
                                          )
                                        }
                                      />
                                      <button
                                        onClick={() =>
                                          document
                                            .getElementById(`stage-${c.id}`)
                                            ?.click()
                                        }
                                        style={{
                                          display: 'inline-flex',
                                          alignItems: 'center',
                                          gap: 6,
                                          padding: '5px 12px',
                                          borderRadius: 8,
                                          background: 'var(--cr-tint-3)',
                                          border: `1px dashed ${CR.border}`,
                                          color: CR.sub,
                                          fontFamily: CR.sans,
                                          fontSize: 11.5,
                                          cursor: 'pointer',
                                        }}
                                        onMouseEnter={(e) => {
                                          e.currentTarget.style.borderColor =
                                            withAlpha(agColor, 38);
                                          e.currentTarget.style.color =
                                            CR.cream;
                                        }}
                                        onMouseLeave={(e) => {
                                          e.currentTarget.style.borderColor =
                                            CR.border;
                                          e.currentTarget.style.color = CR.sub;
                                        }}
                                      >
                                        {staged?.uploading
                                          ? '⏳ Uploading…'
                                          : '📎 Attach reference files'}
                                      </button>
                                      {staged?.files?.length ? (
                                        <div
                                          style={{
                                            marginTop: 6,
                                            display: 'flex',
                                            flexWrap: 'wrap',
                                            gap: 6,
                                          }}
                                        >
                                          {staged.files.map((fn) => (
                                            <span
                                              key={fn}
                                              style={{
                                                fontFamily: CR.mono,
                                                fontSize: 10,
                                                color: CR.sub,
                                                background: CR.bgSurf,
                                                border: `1px solid ${CR.border}`,
                                                borderRadius: 6,
                                                padding: '2px 8px',
                                              }}
                                            >
                                              📄 {fn}
                                            </span>
                                          ))}
                                        </div>
                                      ) : null}
                                      <div
                                        style={{
                                          marginTop: 5,
                                          fontFamily: CR.sans,
                                          fontSize: 10,
                                          color: CR.muted,
                                        }}
                                      >
                                        Seeded into the new agent's references
                                        on approve.
                                      </div>
                                    </div>
                                  );
                                })()}
                              {/* Preview files this agent authored and is proposing to seed into the new
                                                        agent (payload.seed_files) — the real content, not just this agent's own
                                                        summary of it, since that summary is exactly what went wrong for KAIROS
                                                        Research Agent: files described as "created" that were never attached. */}
                              {c.action_type === 'create_agent' &&
                                Array.isArray(payload.seed_files) &&
                                payload.seed_files.length > 0 &&
                                agentId && (
                                  <SeedFilesPreview
                                    agentId={agentId}
                                    seedFiles={payload.seed_files}
                                  />
                                )}
                              {/* A textarea, not an input: a useful note is a sentence or three of
                                                        steering — on a check-in it is summarised into IDENTITY.md, so it is
                                                        the longest text in this page, not the shortest. A single-line input
                                                        scrolled it sideways and hid everything but the tail. */}
                              <textarea
                                value={checkinNotes[c.id] ?? ''}
                                onChange={(e) =>
                                  setCheckinNotes((n) => ({
                                    ...n,
                                    [c.id]: e.target.value,
                                  }))
                                }
                                onInput={(e) => {
                                  const t = e.currentTarget;
                                  t.style.height = 'auto';
                                  t.style.height = `${Math.min(t.scrollHeight, 260)}px`;
                                }}
                                rows={2}
                                placeholder="Add a note (optional) — e.g. 'approve, but also add web_fetch' or 'reject — mission's too narrow'"
                                style={{
                                  width: '100%',
                                  boxSizing: 'border-box',
                                  marginBottom: 8,
                                  background: CR.bgSurf,
                                  border: `1px solid ${CR.border}`,
                                  borderRadius: 8,
                                  padding: '7px 12px',
                                  color: CR.text,
                                  fontFamily: CR.sans,
                                  fontSize: 12,
                                  lineHeight: 1.5,
                                  outline: 'none',
                                  resize: 'vertical',
                                  minHeight: 56,
                                  maxHeight: 260,
                                  overflowY: 'auto',
                                }}
                                onFocus={(e) => {
                                  e.currentTarget.style.borderColor = withAlpha(
                                    agColor,
                                    38,
                                  );
                                }}
                                onBlur={(e) => {
                                  e.currentTarget.style.borderColor = CR.border;
                                }}
                              />
                              <div style={{ display: 'flex', gap: 8 }}>
                                <button
                                  onClick={() => {
                                    const staged = stagedRefs[c.id];
                                    const override =
                                      c.action_type === 'create_agent' &&
                                      staged?.token
                                        ? JSON.stringify({
                                            ...payload,
                                            references_staging_token:
                                              staged.token,
                                          })
                                        : undefined;
                                    const note = (
                                      checkinNotes[c.id] ?? ''
                                    ).trim();
                                    respondToCheckin(
                                      c.id,
                                      note ? `approve — ${note}` : 'approve',
                                      override,
                                    );
                                  }}
                                  style={{
                                    padding: '7px 16px',
                                    borderRadius: 8,
                                    cursor: 'pointer',
                                    background: 'var(--cr-green-low)',
                                    border: '1px solid var(--cr-green-line)',
                                    color: CR.green,
                                    fontFamily: CR.sans,
                                    fontSize: 12,
                                    fontWeight: 600,
                                  }}
                                >
                                  ✓ Approve
                                  {c.action_type === 'send_email' ||
                                  c.action_type === 'smtp_send' ||
                                  c.action_type === 'batch_send_live'
                                    ? ' & Send'
                                    : c.action_type === 'create_agent'
                                      ? ' & Create'
                                      : c.action_type === 'run_plan'
                                        ? ' & Start'
                                        : ''}
                                </button>
                                <button
                                  onClick={() => {
                                    const note = (
                                      checkinNotes[c.id] ?? ''
                                    ).trim();
                                    respondToCheckin(
                                      c.id,
                                      note ? `reject — ${note}` : 'reject',
                                    );
                                  }}
                                  style={{
                                    padding: '7px 14px',
                                    borderRadius: 8,
                                    cursor: 'pointer',
                                    background: 'transparent',
                                    border: '1px solid var(--cr-error-line)',
                                    color: 'var(--cr-error)',
                                    fontFamily: CR.sans,
                                    fontSize: 12,
                                  }}
                                >
                                  ✕ Reject
                                </button>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}

                    {/* Stage 20 — ActivityDock (agent-chat shared logic): sits BELOW the
                                    inline approval cards, directly above the input. */}
                    <ActivityDock
                      sessionSteps={sessionSteps}
                      liveSteps={liveSteps}
                      isTyping={isStreaming}
                      onOpenFile={openWorkspaceFile}
                      maxWidth={isMobile ? undefined : 760}
                      extraItems={[
                        {
                          id: 'workspace',
                          label: 'Workspace',
                          icon: <Folder size={12} />,
                          count: agentId
                            ? (agentFiles[agentId] || []).length
                            : 0,
                          color: CR.amber,
                          active: wsDrawerOpen,
                          onClick: () => toggleDock('workspace'),
                        },
                        {
                          // Browser, where Outputs used to be. Outputs are
                          // already reachable inside Artifacts, so the dock
                          // was spending a slot on a second door to the same
                          // room — while the browser had no door of its own,
                          // only a tab inside the Workspace drawer, which is
                          // the wrong place to look for the thing the agent
                          // is doing right now.
                          id: 'browser',
                          label: browserWaitingForThisAgent
                            ? 'Needs you'
                            : 'Browser',
                          icon: <Monitor size={12} />,
                          // No count: a browser is open or it is not, and a
                          // "1" would read as one of several.
                          count: 0,
                          color: browserWaitingForThisAgent
                            ? CR.amber
                            : CR.blue,
                          active: browserDrawerOpen,
                          onClick: () => toggleDock('browser'),
                        },
                        {
                          id: 'artifacts',
                          label: 'Artifacts',
                          icon: <Package size={12} />,
                          count: artifacts.length,
                          color: CR.purple,
                          active: agentInspectDrawer === 'artifacts',
                          onClick: () => toggleDock('artifacts'),
                        },
                      ]}
                    />

                    {/* Input area */}
                    <div style={{ flexShrink: 0, background: CR.bgMain }}>
                      {/* Opening suggestions — the fix for the blank page.
                                        A new hire lands here and has to invent both what to
                                        ask and how to phrase it, which is the moment the
                                        product looks like every other chat box. Choosing is
                                        far easier than inventing. Generated from the owner's
                                        own business, so they stay specific without anyone
                                        writing example copy per template. Vanish for good
                                        once the user has said anything. */}
                      {awaitingFirstMessage &&
                        starters.length > 0 &&
                        !isStreaming && (
                          <div
                            style={{
                              padding: isMobile ? '0 14px 10px' : '0 40px 12px',
                            }}
                          >
                            <div
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                marginBottom: 8,
                              }}
                            >
                              <div
                                style={{
                                  fontFamily: CR.mono,
                                  fontSize: 9,
                                  color: CR.muted,
                                  letterSpacing: '0.1em',
                                  textTransform: 'uppercase',
                                }}
                              >
                                Give {agent.name} something to do
                              </div>
                              <button
                                onClick={dismissStarters}
                                title="Hide suggestions"
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  color: CR.muted,
                                  cursor: 'pointer',
                                  fontSize: 12,
                                  lineHeight: 1,
                                  padding: 4,
                                }}
                              >
                                ✕
                              </button>
                            </div>
                            <div
                              style={{
                                display: 'flex',
                                flexWrap: 'wrap',
                                gap: 8,
                              }}
                            >
                              {starters.map((s, i) => (
                                <button
                                  key={i}
                                  onClick={() => {
                                    setStarters([]);
                                    void sendChat(s);
                                  }}
                                  style={{
                                    textAlign: 'left',
                                    padding: '9px 14px',
                                    borderRadius: 10,
                                    border: `1px solid ${CR.border}`,
                                    background: 'var(--cr-tint-2)',
                                    color: CR.text,
                                    fontFamily: CR.sans,
                                    fontSize: 12.5,
                                    cursor: 'pointer',
                                    transition: 'all 0.15s',
                                    maxWidth: '100%',
                                  }}
                                  onMouseEnter={(e) => {
                                    e.currentTarget.style.borderColor =
                                      withAlpha(agColor, 38);
                                    e.currentTarget.style.background =
                                      withAlpha(agColor, 8);
                                    e.currentTarget.style.color = CR.cream;
                                  }}
                                  onMouseLeave={(e) => {
                                    e.currentTarget.style.borderColor =
                                      CR.border;
                                    e.currentTarget.style.background =
                                      'var(--cr-tint-2)';
                                    e.currentTarget.style.color = CR.text;
                                  }}
                                >
                                  {s}
                                </button>
                              ))}
                            </div>
                          </div>
                        )}

                      {/* Slash commands available in agent chat */}
                      {(() => {
                        const SLASH_COMMANDS: Array<{
                          cmd: string;
                          label: string;
                          description: string;
                          category: string;
                          icon: string;
                          action: 'execute' | 'fill';
                          fillText?: string;
                        }> = [
                          // Actions — note: just type a task to run work; no /run needed (chat dispatches a cycle).
                          {
                            cmd: 'clear',
                            label: 'Clear Chat',
                            description:
                              "Wipe this conversation's history. Irreversible.",
                            category: 'Actions',
                            icon: '🧹',
                            action: 'execute',
                          },
                          // Views (open in place)
                          {
                            cmd: 'files',
                            label: 'Workspace Files',
                            description: "Open the agent's workspace files.",
                            category: 'Views',
                            icon: '📁',
                            action: 'execute',
                          },
                          {
                            cmd: 'outputs',
                            label: 'Outputs',
                            description: 'Open the outputs view.',
                            category: 'Views',
                            icon: '📤',
                            action: 'execute',
                          },
                          {
                            cmd: 'artifacts',
                            label: 'Artifacts',
                            description: 'Open the artifacts view.',
                            category: 'Views',
                            icon: '📦',
                            action: 'execute',
                          },
                          {
                            cmd: 'memory',
                            label: 'Memory',
                            description: "Open the agent's memory.",
                            category: 'Views',
                            icon: '🧠',
                            action: 'execute',
                          },
                          {
                            cmd: 'handoffs',
                            label: 'Handoffs',
                            description: 'Open handoffs between agents.',
                            category: 'Views',
                            icon: '🔗',
                            action: 'execute',
                          },
                          {
                            cmd: 'log',
                            label: 'Activity Log',
                            description: 'Open the activity log.',
                            category: 'Views',
                            icon: '📊',
                            action: 'execute',
                          },
                          // Configure
                          {
                            cmd: 'settings',
                            label: 'Settings',
                            description: 'Open the settings panel.',
                            category: 'Configure',
                            icon: '⚙️',
                            action: 'execute',
                          },
                          {
                            cmd: 'schedule',
                            label: 'Schedule',
                            description: 'Edit the run schedule.',
                            category: 'Configure',
                            icon: '🕐',
                            action: 'execute',
                          },
                          {
                            cmd: 'tools',
                            label: 'Tools',
                            description: "Manage the agent's tools.",
                            category: 'Configure',
                            icon: '🔧',
                            action: 'execute',
                          },
                          {
                            cmd: 'identity',
                            label: 'Identity',
                            description: 'View / edit identity.',
                            category: 'Configure',
                            icon: '🪪',
                            action: 'execute',
                          },
                          // Info
                          {
                            cmd: 'help',
                            label: 'Help',
                            description: 'Show available slash commands.',
                            category: 'Info',
                            icon: '❓',
                            action: 'execute',
                          },
                        ];
                        const q = (slashQuery ?? '').toLowerCase();
                        const slashFiltered =
                          slashQuery === null
                            ? []
                            : SLASH_COMMANDS.filter(
                                (c) =>
                                  q === '' ||
                                  c.cmd.includes(q) ||
                                  c.label.toLowerCase().includes(q) ||
                                  c.description.toLowerCase().includes(q),
                              );
                        const categories = [
                          ...new Set(slashFiltered.map((c) => c.category)),
                        ];

                        // @ mention + # file picker data (agent-chat shared logic)
                        const agFiles = agentId
                          ? agentFiles[agentId] || []
                          : [];
                        const mentionAgents =
                          mentionQuery === null
                            ? []
                            : agents
                                .filter(
                                  (a) =>
                                    a.id !== agentId &&
                                    a.status !== 'paused' &&
                                    (mentionQuery === '' ||
                                      a.name
                                        .toLowerCase()
                                        .includes(mentionQuery.toLowerCase())),
                                )
                                .slice(0, 8);
                        // # picker — agent private files only (project work goes in project chat).
                        const taggedAgent = agFiles.map((f: any) => ({
                          ...f,
                          __src: 'agent' as const,
                          __label: 'private',
                        }));
                        const deriveFolders = (files: any[]) => {
                          const counts = new Map<string, number>();
                          for (const f of files) {
                            const parts = String(f.path || f.filename || '')
                              .split('/')
                              .filter(Boolean);
                            for (let i = 1; i < parts.length; i++) {
                              const dir = parts.slice(0, i).join('/');
                              counts.set(dir, (counts.get(dir) || 0) + 1);
                            }
                          }
                          return [...counts.entries()].map(([path, count]) => ({
                            path,
                            count,
                            __isFolder: true as const,
                            __src: 'agent' as const,
                            __label: 'private',
                          }));
                        };
                        const agentFolders = deriveFolders(agFiles);
                        const fq = (fileQuery ?? '').toLowerCase();
                        const matchQ = (f: any) =>
                          fq === '' ||
                          (f.filename || '').toLowerCase().includes(fq) ||
                          (f.path || '').toLowerCase().includes(fq);
                        const agentEntries = [
                          ...agentFolders,
                          ...taggedAgent,
                        ].filter(matchQ);
                        const fileResults =
                          fileQuery === null ? [] : agentEntries.slice(0, 16);

                        const insertMention = (name: string) => {
                          const cursor =
                            chatInputRef.current?.selectionStart ??
                            chatInput.length;
                          const before = chatInput.slice(
                            0,
                            mentionStartRef.current,
                          );
                          const after = chatInput.slice(cursor);
                          setChatInput(`${before}@${name} ${after}`);
                          setMentionQuery(null);
                          setTimeout(() => {
                            const pos = before.length + name.length + 2;
                            if (chatInputRef.current) {
                              chatInputRef.current.focus();
                              chatInputRef.current.setSelectionRange(pos, pos);
                              chatInputRef.current.style.height = 'auto';
                              chatInputRef.current.style.height =
                                Math.min(
                                  chatInputRef.current.scrollHeight,
                                  120,
                                ) + 'px';
                            }
                          }, 0);
                        };
                        const insertFileRef = (p: string, isFolder = false) => {
                          const token = isFolder ? `${p}/` : p;
                          const cursor =
                            chatInputRef.current?.selectionStart ??
                            chatInput.length;
                          const before = chatInput.slice(
                            0,
                            fileStartRef.current,
                          );
                          const after = chatInput.slice(cursor);
                          setChatInput(`${before}#${token} ${after}`);
                          setFileQuery(null);
                          setTimeout(() => {
                            const pos = before.length + token.length + 2;
                            if (chatInputRef.current) {
                              chatInputRef.current.focus();
                              chatInputRef.current.setSelectionRange(pos, pos);
                              chatInputRef.current.style.height = 'auto';
                              chatInputRef.current.style.height =
                                Math.min(
                                  chatInputRef.current.scrollHeight,
                                  120,
                                ) + 'px';
                            }
                          }, 0);
                        };

                        const onInputChange = (v: string) => {
                          setChatInput(v);
                          if (chatInputRef.current) {
                            chatInputRef.current.style.height = 'auto';
                            chatInputRef.current.style.height =
                              Math.min(chatInputRef.current.scrollHeight, 120) +
                              'px';
                          }
                          const cursor =
                            chatInputRef.current?.selectionStart ?? v.length;
                          const before = v.slice(0, cursor);
                          // @mention — last @ before cursor with no whitespace after
                          const atMatch = before.match(/@([\w\-]*)$/);
                          if (atMatch) {
                            mentionStartRef.current = before.lastIndexOf('@');
                            setMentionQuery(atMatch[1] ?? '');
                            setMentionIndex(0);
                            setSlashQuery(null);
                            setFileQuery(null);
                            return;
                          }
                          setMentionQuery(null);
                          // /command — only at very start
                          const m = v.match(/^\/([a-z0-9_-]*)$/i);
                          if (m) {
                            setSlashQuery(m[1] ?? '');
                            setSlashIndex(0);
                            setFileQuery(null);
                            return;
                          }
                          setSlashQuery(null);
                          // #file — last # before cursor with no whitespace after
                          const hashMatch = before.match(/#([\w\-./]*)$/);
                          if (hashMatch) {
                            fileStartRef.current = before.lastIndexOf('#');
                            setFileQuery(hashMatch[1] ?? '');
                            setFileIndex(0);
                            return;
                          }
                          setFileQuery(null);
                        };

                        const executeSlashFromPicker = (
                          cmd: (typeof SLASH_COMMANDS)[number],
                        ) => {
                          setSlashQuery(null);
                          if (cmd.action === 'fill' && cmd.fillText) {
                            setChatInput(cmd.fillText);
                            setTimeout(() => {
                              if (chatInputRef.current) {
                                chatInputRef.current.focus();
                                const pos = cmd.fillText!.length;
                                chatInputRef.current.setSelectionRange(
                                  pos,
                                  pos,
                                );
                                chatInputRef.current.style.height = 'auto';
                                chatInputRef.current.style.height =
                                  Math.min(
                                    chatInputRef.current.scrollHeight,
                                    120,
                                  ) + 'px';
                              }
                            }, 0);
                            return;
                          }
                          sendChat(`/${cmd.cmd}`);
                          if (chatInputRef.current)
                            chatInputRef.current.style.height = 'auto';
                        };

                        const onKeyDown = (
                          e: React.KeyboardEvent<HTMLTextAreaElement>,
                        ) => {
                          if (
                            mentionQuery !== null &&
                            mentionAgents.length > 0
                          ) {
                            if (e.key === 'ArrowDown') {
                              e.preventDefault();
                              setMentionIndex(
                                (i) => (i + 1) % mentionAgents.length,
                              );
                              return;
                            }
                            if (e.key === 'ArrowUp') {
                              e.preventDefault();
                              setMentionIndex(
                                (i) =>
                                  (i - 1 + mentionAgents.length) %
                                  mentionAgents.length,
                              );
                              return;
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setMentionQuery(null);
                              return;
                            }
                            if (
                              e.key === 'Tab' ||
                              (e.key === 'Enter' && !e.shiftKey)
                            ) {
                              e.preventDefault();
                              insertMention(mentionAgents[mentionIndex].name);
                              return;
                            }
                          }
                          if (fileQuery !== null && fileResults.length > 0) {
                            if (e.key === 'ArrowDown') {
                              e.preventDefault();
                              setFileIndex((i) => (i + 1) % fileResults.length);
                              return;
                            }
                            if (e.key === 'ArrowUp') {
                              e.preventDefault();
                              setFileIndex(
                                (i) =>
                                  (i - 1 + fileResults.length) %
                                  fileResults.length,
                              );
                              return;
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setFileQuery(null);
                              return;
                            }
                            if (
                              e.key === 'Tab' ||
                              (e.key === 'Enter' && !e.shiftKey)
                            ) {
                              e.preventDefault();
                              const sel = fileResults[fileIndex] as any;
                              insertFileRef(sel.path, !!sel.__isFolder);
                              return;
                            }
                          }
                          if (slashQuery !== null && slashFiltered.length > 0) {
                            if (e.key === 'ArrowDown') {
                              e.preventDefault();
                              setSlashIndex((i) =>
                                Math.min(i + 1, slashFiltered.length - 1),
                              );
                              return;
                            }
                            if (e.key === 'ArrowUp') {
                              e.preventDefault();
                              setSlashIndex((i) => Math.max(i - 1, 0));
                              return;
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              setSlashQuery(null);
                              return;
                            }
                            if (
                              e.key === 'Tab' ||
                              (e.key === 'Enter' && !e.shiftKey)
                            ) {
                              e.preventDefault();
                              const chosen = slashFiltered[slashIndex];
                              if (chosen) executeSlashFromPicker(chosen);
                              return;
                            }
                          }
                          if (e.key === 'Enter' && !e.shiftKey) {
                            e.preventDefault();
                            sendChat();
                            if (chatInputRef.current)
                              chatInputRef.current.style.height = 'auto';
                          }
                        };

                        return (
                          <div
                            style={{
                              padding: isMobile
                                ? '10px 14px 14px'
                                : '14px 40px 18px',
                              display: 'flex',
                              justifyContent: 'center',
                            }}
                          >
                            <div
                              style={{
                                position: 'relative',
                                width: '100%',
                                maxWidth: isMobile ? undefined : 760,
                              }}
                            >
                              {/* / Slash Command Palette — anchored above the input */}
                              {slashQuery !== null &&
                                slashFiltered.length > 0 && (
                                  <div
                                    style={{
                                      position: 'absolute',
                                      bottom: 'calc(100% + 8px)',
                                      left: 0,
                                      right: 0,
                                      background: CR.bgCard,
                                      border: `1px solid ${CR.border}`,
                                      borderRadius: 14,
                                      maxHeight: 360,
                                      overflowY: 'auto',
                                      overflowX: 'hidden',
                                      boxShadow:
                                        '0 -8px 32px var(--cr-shade-2)',
                                      zIndex: 200,
                                      animation: 'crewFadeUp 0.15s ease-out',
                                    }}
                                  >
                                    <div
                                      style={{
                                        padding: '8px 14px',
                                        borderBottom: `1px solid ${CR.border}`,
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        background: 'var(--cr-tint-1)',
                                      }}
                                    >
                                      <span
                                        style={{
                                          fontFamily: CR.mono,
                                          fontSize: 12,
                                          color: CR.mutedBr ?? CR.muted,
                                        }}
                                      >
                                        /
                                      </span>
                                      <span
                                        style={{
                                          fontFamily: CR.mono,
                                          fontSize: 9,
                                          color: CR.mutedBr ?? CR.muted,
                                          letterSpacing: '0.08em',
                                        }}
                                      >
                                        COMMANDS
                                      </span>
                                      <span
                                        style={{
                                          fontFamily: CR.mono,
                                          fontSize: 8,
                                          color: CR.muted,
                                          marginLeft: 'auto',
                                        }}
                                      >
                                        ↑↓ navigate · Enter run · Esc close
                                      </span>
                                    </div>
                                    {categories.map((cat) => {
                                      const cmds = slashFiltered.filter(
                                        (c) => c.category === cat,
                                      );
                                      return (
                                        <div key={cat}>
                                          <div
                                            style={{
                                              padding: '6px 14px 4px',
                                              fontFamily: CR.mono,
                                              fontSize: 8,
                                              color: CR.muted,
                                              letterSpacing: '0.1em',
                                              textTransform: 'uppercase',
                                              background: 'var(--cr-tint-1)',
                                              borderTop:
                                                cat !== categories[0]
                                                  ? `1px solid ${CR.border}`
                                                  : 'none',
                                            }}
                                          >
                                            {cat}
                                          </div>
                                          {cmds.map((cmd) => {
                                            const globalIdx =
                                              slashFiltered.indexOf(cmd);
                                            const active =
                                              globalIdx === slashIndex;
                                            return (
                                              <div
                                                key={cmd.cmd}
                                                onMouseDown={(e) => {
                                                  e.preventDefault();
                                                  executeSlashFromPicker(cmd);
                                                }}
                                                onMouseEnter={() =>
                                                  setSlashIndex(globalIdx)
                                                }
                                                style={{
                                                  display: 'flex',
                                                  alignItems: 'center',
                                                  gap: 12,
                                                  padding: '9px 14px',
                                                  cursor: 'pointer',
                                                  background: active
                                                    ? `${withAlpha(agColor, 8)}`
                                                    : 'transparent',
                                                  borderLeft: `2px solid ${active ? agColor : 'transparent'}`,
                                                  transition: 'all 0.1s',
                                                }}
                                              >
                                                <div
                                                  style={{
                                                    width: 30,
                                                    height: 30,
                                                    borderRadius: 8,
                                                    flexShrink: 0,
                                                    background: active
                                                      ? `${withAlpha(agColor, 15)}`
                                                      : 'var(--cr-tint-3)',
                                                    border: `1px solid ${active ? `${withAlpha(agColor, 25)}` : CR.border}`,
                                                    display: 'flex',
                                                    alignItems: 'center',
                                                    justifyContent: 'center',
                                                    fontSize: 14,
                                                  }}
                                                >
                                                  {cmd.icon}
                                                </div>
                                                <div
                                                  style={{
                                                    flex: 1,
                                                    minWidth: 0,
                                                  }}
                                                >
                                                  <div
                                                    style={{
                                                      display: 'flex',
                                                      alignItems: 'baseline',
                                                      gap: 8,
                                                    }}
                                                  >
                                                    <span
                                                      style={{
                                                        fontFamily: CR.sans,
                                                        fontSize: 13,
                                                        fontWeight: active
                                                          ? 600
                                                          : 400,
                                                        color: active
                                                          ? CR.cream
                                                          : CR.sub,
                                                      }}
                                                    >
                                                      {cmd.label}
                                                    </span>
                                                    <span
                                                      style={{
                                                        fontFamily: CR.mono,
                                                        fontSize: 9,
                                                        color: active
                                                          ? agColor
                                                          : CR.muted,
                                                      }}
                                                    >
                                                      /{cmd.cmd}
                                                    </span>
                                                  </div>
                                                  <div
                                                    style={{
                                                      fontFamily: CR.sans,
                                                      fontSize: 11,
                                                      color: CR.muted,
                                                      marginTop: 1,
                                                      overflow: 'hidden',
                                                      textOverflow: 'ellipsis',
                                                      whiteSpace: 'nowrap',
                                                    }}
                                                  >
                                                    {cmd.description}
                                                  </div>
                                                </div>
                                                <div
                                                  style={{
                                                    flexShrink: 0,
                                                    fontFamily: CR.mono,
                                                    fontSize: 8,
                                                    color:
                                                      cmd.action === 'execute'
                                                        ? 'var(--cr-green)'
                                                        : 'var(--cr-amber)',
                                                    background:
                                                      cmd.action === 'execute'
                                                        ? 'var(--cr-green-low)'
                                                        : 'var(--cr-amber-low)',
                                                    border: `1px solid ${cmd.action === 'execute' ? 'var(--cr-green-line)' : 'var(--cr-amber-line)'}`,
                                                    padding: '2px 7px',
                                                    borderRadius: 10,
                                                    letterSpacing: '0.05em',
                                                  }}
                                                >
                                                  {cmd.action === 'execute'
                                                    ? 'RUN'
                                                    : 'FILL'}
                                                </div>
                                              </div>
                                            );
                                          })}
                                        </div>
                                      );
                                    })}
                                  </div>
                                )}
                              {/* @ Mention picker — hand off to another agent */}
                              {mentionQuery !== null &&
                                mentionAgents.length > 0 && (
                                  <div
                                    style={{
                                      position: 'absolute',
                                      bottom: 'calc(100% + 8px)',
                                      left: 0,
                                      right: 0,
                                      maxHeight: 320,
                                      overflowY: 'auto',
                                      overflowX: 'hidden',
                                      background: CR.bgCard,
                                      border: `1px solid ${CR.border}`,
                                      borderRadius: 14,
                                      boxShadow:
                                        '0 -8px 32px var(--cr-shade-2)',
                                      zIndex: 200,
                                    }}
                                  >
                                    <div
                                      style={{
                                        padding: '8px 14px',
                                        borderBottom: `1px solid ${CR.border}`,
                                        fontFamily: CR.mono,
                                        fontSize: 9,
                                        color: CR.muted,
                                        letterSpacing: '0.08em',
                                      }}
                                    >
                                      @ HAND OFF TO AGENT · ↑↓ · Enter select
                                    </div>
                                    {mentionAgents.map((a, i) => (
                                      <div
                                        key={a.id}
                                        onMouseDown={(e) => {
                                          e.preventDefault();
                                          insertMention(a.name);
                                        }}
                                        onMouseEnter={() => setMentionIndex(i)}
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 10,
                                          padding: '9px 14px',
                                          cursor: 'pointer',
                                          background:
                                            i === mentionIndex
                                              ? `${withAlpha(agColor, 8)}`
                                              : 'transparent',
                                          borderLeft: `2px solid ${i === mentionIndex ? agColor : 'transparent'}`,
                                        }}
                                      >
                                        <span style={{ fontSize: 16 }}>
                                          {a.emoji ?? '🤖'}
                                        </span>
                                        <span
                                          style={{
                                            fontFamily: CR.sans,
                                            fontSize: 13,
                                            color:
                                              i === mentionIndex
                                                ? CR.cream
                                                : CR.sub,
                                          }}
                                        >
                                          {a.name}
                                        </span>
                                        <span
                                          style={{
                                            marginLeft: 'auto',
                                            fontFamily: CR.mono,
                                            fontSize: 9,
                                            color: CR.muted,
                                          }}
                                        >
                                          {a.type}
                                        </span>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              {/* # File picker — reference a workspace file */}
                              {fileQuery !== null && fileResults.length > 0 && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    bottom: 'calc(100% + 8px)',
                                    left: 0,
                                    right: 0,
                                    maxHeight: 320,
                                    overflowY: 'auto',
                                    overflowX: 'hidden',
                                    background: CR.bgCard,
                                    border: `1px solid ${CR.border}`,
                                    borderRadius: 14,
                                    boxShadow: '0 -8px 32px var(--cr-shade-2)',
                                    zIndex: 200,
                                  }}
                                >
                                  <div
                                    style={{
                                      padding: '8px 14px',
                                      borderBottom: `1px solid ${CR.border}`,
                                      fontFamily: CR.mono,
                                      fontSize: 9,
                                      color: CR.muted,
                                      letterSpacing: '0.08em',
                                    }}
                                  >
                                    # ATTACH FILE · content injected into the
                                    agent · ↑↓ · Enter attach
                                  </div>
                                  {fileResults.map((f: any, i) => {
                                    const isProj = f.__src === 'project';
                                    const isFolder = !!f.__isFolder;
                                    return (
                                      <div
                                        key={
                                          (f.__src || 'a') +
                                          ':' +
                                          (isFolder ? 'd:' : '') +
                                          (f.id || f.path)
                                        }
                                        onMouseDown={(e) => {
                                          e.preventDefault();
                                          insertFileRef(f.path, isFolder);
                                        }}
                                        onMouseEnter={() => setFileIndex(i)}
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 10,
                                          padding: '9px 14px',
                                          cursor: 'pointer',
                                          background:
                                            i === fileIndex
                                              ? `${withAlpha(agColor, 8)}`
                                              : 'transparent',
                                          borderLeft: `2px solid ${i === fileIndex ? agColor : 'transparent'}`,
                                        }}
                                      >
                                        <span style={{ fontSize: 13 }}>
                                          {isFolder ? '📁' : '📄'}
                                        </span>
                                        <span
                                          style={{
                                            fontFamily: CR.mono,
                                            fontSize: 12,
                                            color:
                                              i === fileIndex
                                                ? CR.cream
                                                : CR.sub,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                          }}
                                        >
                                          {isFolder
                                            ? `${f.path}/`
                                            : f.path || f.filename}
                                          {isFolder && (
                                            <span style={{ color: CR.muted }}>
                                              {' '}
                                              ({f.count} file
                                              {f.count !== 1 ? 's' : ''})
                                            </span>
                                          )}
                                        </span>
                                        <span
                                          title={
                                            isProj
                                              ? `Project: ${f.__label}`
                                              : 'Agent private workspace'
                                          }
                                          style={{
                                            marginLeft: 'auto',
                                            flexShrink: 0,
                                            fontFamily: CR.mono,
                                            fontSize: 8,
                                            fontWeight: 700,
                                            letterSpacing: '0.04em',
                                            padding: '2px 6px',
                                            borderRadius: 4,
                                            textTransform: 'uppercase',
                                            color: isProj ? CR.amber : CR.muted,
                                            background: isProj
                                              ? 'var(--cr-amber-low)'
                                              : 'var(--cr-tint-3)',
                                            border: `1px solid ${isProj ? 'var(--cr-amber-line)' : CR.border}`,
                                          }}
                                        >
                                          {isProj
                                            ? `📁 ${f.__label}`
                                            : '🔒 private'}
                                        </span>
                                        {!isFolder && f.sizeBytes ? (
                                          <span
                                            style={{
                                              fontFamily: CR.mono,
                                              fontSize: 9,
                                              color: CR.muted,
                                            }}
                                          >
                                            {(f.sizeBytes / 1024).toFixed(1)}kb
                                          </span>
                                        ) : null}
                                      </div>
                                    );
                                  })}
                                </div>
                              )}
                              {/* Attach-reference feedback toast */}
                              {refToast && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    bottom: 'calc(100% + 8px)',
                                    left: 0,
                                    right: 0,
                                    background: CR.bgCard,
                                    border: `1px solid ${withAlpha(agColor, 25)}`,
                                    borderRadius: 10,
                                    padding: '8px 14px',
                                    fontFamily: CR.sans,
                                    fontSize: 12,
                                    color: CR.cream,
                                    zIndex: 200,
                                    boxShadow: '0 -4px 16px var(--cr-shade-2)',
                                  }}
                                >
                                  {refToast}
                                </div>
                              )}
                              {/* + button — hand the agent files OR a folder it keeps under references/ */}
                              <input
                                ref={refFileInputRef}
                                type="file"
                                multiple
                                style={{ display: 'none' }}
                                onChange={(e) => {
                                  uploadReferences(e.target.files);
                                  setShowAttachMenu(false);
                                }}
                              />
                              <input
                                ref={refFolderInputRef}
                                type="file"
                                multiple
                                style={{ display: 'none' }}
                                {...({
                                  webkitdirectory: '',
                                  directory: '',
                                } as Record<string, string>)}
                                onChange={(e) => {
                                  uploadReferences(e.target.files);
                                  setShowAttachMenu(false);
                                }}
                              />
                              {/* Image paste/upload (multiple) — agent sees them via read_image (vision).
                                                    Paste still works directly into the textarea (onPaste); the button that
                                                    triggers the same file picker now lives in the attach menu below instead
                                                    of as its own permanently-visible box. */}
                              <input
                                ref={chatImageInputRef}
                                type="file"
                                accept="image/*"
                                multiple
                                style={{ display: 'none' }}
                                onChange={(e) => {
                                  Array.from(e.target.files ?? []).forEach(
                                    (f) => loadChatImage(f),
                                  );
                                  e.currentTarget.value = '';
                                }}
                              />
                              {pendingImages.length > 0 && (
                                <div
                                  style={{
                                    position: 'absolute',
                                    bottom: 'calc(100% + 8px)',
                                    left: 0,
                                    right: 0,
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    alignItems: 'center',
                                    gap: 8,
                                    background: CR.bgCard,
                                    border: `1px solid ${CR.border}`,
                                    borderRadius: 10,
                                    padding: 6,
                                    zIndex: 200,
                                  }}
                                >
                                  {pendingImages.map((im, i) => (
                                    <div
                                      key={i}
                                      style={{ position: 'relative' }}
                                    >
                                      <img
                                        src={im}
                                        alt={`attachment ${i + 1}`}
                                        style={{
                                          height: 48,
                                          borderRadius: 6,
                                          display: 'block',
                                        }}
                                      />
                                      <button
                                        onClick={() =>
                                          setPendingImages((prev) =>
                                            prev.filter((_, j) => j !== i),
                                          )
                                        }
                                        title="Remove"
                                        style={{
                                          position: 'absolute',
                                          top: -6,
                                          right: -6,
                                          width: 18,
                                          height: 18,
                                          borderRadius: '50%',
                                          background: CR.bgCard,
                                          border: `1px solid ${CR.border}`,
                                          color: CR.muted,
                                          cursor: 'pointer',
                                          fontSize: 12,
                                          lineHeight: 1,
                                          padding: 0,
                                        }}
                                      >
                                        ×
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}

                              {queuedSends.length > 0 &&
                                pendingImages.length === 0 && (
                                  <div
                                    style={{
                                      position: 'absolute',
                                      bottom: 'calc(100% + 8px)',
                                      left: 0,
                                      right: 0,
                                      display: 'flex',
                                      flexDirection: 'column',
                                      gap: 4,
                                      background: CR.bgCard,
                                      border: `1px solid ${CR.border}`,
                                      borderRadius: 10,
                                      padding: '6px 8px',
                                      zIndex: 150,
                                    }}
                                  >
                                    <div
                                      style={{
                                        fontFamily: CR.mono,
                                        fontSize: 9,
                                        color: CR.muted,
                                        letterSpacing: '0.06em',
                                      }}
                                    >
                                      QUEUED · SENT WHEN{' '}
                                      {agent.name.toUpperCase()} FINISHES
                                    </div>
                                    {queuedSends.map((q) => (
                                      <div
                                        key={q.id}
                                        style={{
                                          display: 'flex',
                                          alignItems: 'center',
                                          gap: 8,
                                        }}
                                      >
                                        <span
                                          style={{
                                            flex: 1,
                                            fontSize: 12,
                                            color: CR.sub,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                          }}
                                        >
                                          ⏳ {q.msg}
                                          {q.imgs.length
                                            ? ` (+${q.imgs.length} image${q.imgs.length > 1 ? 's' : ''})`
                                            : ''}
                                        </span>
                                        <button
                                          onClick={() =>
                                            setQueuedSends((prev) =>
                                              prev.filter((x) => x.id !== q.id),
                                            )
                                          }
                                          title="Remove from queue"
                                          style={{
                                            background: 'none',
                                            border: 'none',
                                            color: CR.muted,
                                            cursor: 'pointer',
                                            fontSize: 13,
                                            padding: 0,
                                            lineHeight: 1,
                                          }}
                                        >
                                          ✕
                                        </button>
                                      </div>
                                    ))}
                                  </div>
                                )}

                              {/* The merged input pill — textarea on top, controls (attach / send) in a
                                                    row inside the same border, Claude-desktop-style. Used to be four
                                                    separately bordered 44px boxes side by side; that's the "spacy and
                                                    cluttered" feeling this replaces. */}
                              <div
                                style={{
                                  border: `1px solid ${CR.border}`,
                                  borderRadius: 18,
                                  background: CR.bgCard,
                                  padding: '10px 10px 8px',
                                  display: 'flex',
                                  flexDirection: 'column',
                                  gap: 4,
                                  transition:
                                    'border-color 0.15s, box-shadow 0.15s',
                                }}
                              >
                                <textarea
                                  ref={chatInputRef}
                                  value={chatInput}
                                  onChange={(e) =>
                                    onInputChange(e.target.value)
                                  }
                                  onKeyDown={onKeyDown}
                                  onPaste={onChatPaste}
                                  rows={1}
                                  placeholder={
                                    isStreaming
                                      ? `${agent.name} is working — type your next message, it waits its turn`
                                      : `Ask ${agent.name} — / commands · # files · @ hand off · paste an image`
                                  }
                                  style={{
                                    background: 'transparent',
                                    border: 'none',
                                    outline: 'none',
                                    padding: '4px 6px',
                                    color: CR.text,
                                    fontFamily: CR.sans,
                                    fontSize: 13,
                                    resize: 'none',
                                    height: 'auto',
                                    maxHeight: 120,
                                    lineHeight: 1.5,
                                  }}
                                  onFocus={(e) => {
                                    const p = e.currentTarget.parentElement;
                                    if (p) {
                                      p.style.borderColor = agColor;
                                      p.style.boxShadow = `0 0 0 3px ${withAlpha(agColor, 8)}`;
                                    }
                                  }}
                                  onBlur={(e) => {
                                    const p = e.currentTarget.parentElement;
                                    if (p) {
                                      p.style.borderColor = CR.border;
                                      p.style.boxShadow = 'none';
                                    }
                                  }}
                                />

                                <div
                                  style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 8,
                                  }}
                                >
                                  <div
                                    style={{
                                      position: 'relative',
                                      flexShrink: 0,
                                    }}
                                  >
                                    {showAttachMenu && !uploadingRefs && (
                                      <>
                                        <div
                                          onClick={() =>
                                            setShowAttachMenu(false)
                                          }
                                          style={{
                                            position: 'fixed',
                                            inset: 0,
                                            zIndex: 199,
                                          }}
                                        />
                                        <div
                                          style={{
                                            position: 'absolute',
                                            bottom: 'calc(100% + 8px)',
                                            left: 0,
                                            background: CR.bgCard,
                                            border: `1px solid ${CR.border}`,
                                            borderRadius: 10,
                                            boxShadow:
                                              '0 -6px 24px var(--cr-shade-2)',
                                            zIndex: 200,
                                            overflow: 'hidden',
                                            minWidth: 230,
                                            maxWidth: 340,
                                          }}
                                        >
                                          {(agent.config.pins?.length ?? 0) >
                                            0 && (
                                            <div
                                              style={{
                                                borderBottom: `1px solid ${CR.border}`,
                                                maxHeight: 170,
                                                overflowY: 'auto',
                                              }}
                                            >
                                              <div
                                                style={{
                                                  padding: '8px 14px 4px',
                                                  fontFamily: CR.mono,
                                                  fontSize: 8.5,
                                                  color: CR.muted,
                                                  letterSpacing: '0.08em',
                                                }}
                                              >
                                                PINNED · {agent.name} reads
                                                these first every cycle
                                              </div>
                                              {(agent.config.pins ?? []).map(
                                                (p) => (
                                                  <div
                                                    key={p}
                                                    style={{
                                                      display: 'flex',
                                                      alignItems: 'center',
                                                      gap: 8,
                                                      padding: '5px 14px',
                                                    }}
                                                  >
                                                    <span
                                                      title={p}
                                                      style={{
                                                        flex: 1,
                                                        fontFamily: CR.mono,
                                                        fontSize: 11,
                                                        color: CR.sub,
                                                        overflow: 'hidden',
                                                        textOverflow:
                                                          'ellipsis',
                                                        whiteSpace: 'nowrap',
                                                      }}
                                                    >
                                                      📌 {p}
                                                    </span>
                                                    <button
                                                      onClick={() =>
                                                        togglePin(p)
                                                      }
                                                      title="Unpin"
                                                      style={{
                                                        background: 'none',
                                                        border: 'none',
                                                        color: CR.muted,
                                                        cursor: 'pointer',
                                                        fontSize: 13,
                                                        padding: 0,
                                                        lineHeight: 1,
                                                        flexShrink: 0,
                                                      }}
                                                      onMouseEnter={(e) =>
                                                        (e.currentTarget.style.color =
                                                          'var(--cr-error)')
                                                      }
                                                      onMouseLeave={(e) =>
                                                        (e.currentTarget.style.color =
                                                          CR.muted)
                                                      }
                                                    >
                                                      ✕
                                                    </button>
                                                  </div>
                                                ),
                                              )}
                                            </div>
                                          )}
                                          {[
                                            {
                                              icon: <FileText size={14} />,
                                              label: 'Add files to workspace',
                                              onClick: () =>
                                                wsFileInputRef.current?.click(),
                                            },
                                            {
                                              icon: <FolderPlus size={14} />,
                                              label: 'Add folder to workspace',
                                              onClick: () =>
                                                wsFolderInputRef.current?.click(),
                                            },
                                            {
                                              icon: <ImagePlus size={14} />,
                                              label:
                                                'Attach image(s) to this message',
                                              onClick: () => {
                                                chatImageInputRef.current?.click();
                                                setShowAttachMenu(false);
                                              },
                                            },
                                          ].map((it, i) => (
                                            <button
                                              key={it.label}
                                              onClick={it.onClick}
                                              style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: 8,
                                                width: '100%',
                                                textAlign: 'left',
                                                padding: '10px 14px',
                                                background: 'transparent',
                                                border: 'none',
                                                borderTop:
                                                  i > 0
                                                    ? `1px solid ${CR.border}`
                                                    : 'none',
                                                color: CR.sub,
                                                fontFamily: CR.sans,
                                                fontSize: 12.5,
                                                cursor: 'pointer',
                                              }}
                                              onMouseEnter={(e) => {
                                                e.currentTarget.style.background = `${withAlpha(agColor, 7)}`;
                                                e.currentTarget.style.color =
                                                  CR.cream;
                                              }}
                                              onMouseLeave={(e) => {
                                                e.currentTarget.style.background =
                                                  'transparent';
                                                e.currentTarget.style.color =
                                                  CR.sub;
                                              }}
                                            >
                                              <span style={{ display: 'flex' }}>
                                                {it.icon}
                                              </span>
                                              <span>{it.label}</span>
                                            </button>
                                          ))}
                                        </div>
                                      </>
                                    )}
                                    <button
                                      onClick={() => {
                                        if (!uploadingRefs && !isStreaming)
                                          setShowAttachMenu((v) => !v);
                                      }}
                                      disabled={uploadingRefs || isStreaming}
                                      title="Attach files, a folder, or an image"
                                      style={{
                                        width: 32,
                                        height: 32,
                                        borderRadius: 9,
                                        background: showAttachMenu
                                          ? `${withAlpha(agColor, 8)}`
                                          : 'transparent',
                                        border: `1px solid ${showAttachMenu ? withAlpha(agColor, 38) : CR.border}`,
                                        color: uploadingRefs
                                          ? CR.muted
                                          : showAttachMenu
                                            ? CR.cream
                                            : CR.sub,
                                        cursor:
                                          uploadingRefs || isStreaming
                                            ? 'default'
                                            : 'pointer',
                                        display: 'flex',
                                        alignItems: 'center',
                                        justifyContent: 'center',
                                        transition: 'all 0.15s',
                                      }}
                                      onMouseEnter={(e) => {
                                        if (!uploadingRefs && !isStreaming) {
                                          e.currentTarget.style.borderColor =
                                            withAlpha(agColor, 38);
                                          e.currentTarget.style.color =
                                            CR.cream;
                                        }
                                      }}
                                      onMouseLeave={(e) => {
                                        if (!showAttachMenu) {
                                          e.currentTarget.style.borderColor =
                                            CR.border;
                                          e.currentTarget.style.color = CR.sub;
                                        }
                                      }}
                                    >
                                      {uploadingRefs ? (
                                        '⏳'
                                      ) : (
                                        <Plus size={16} />
                                      )}
                                    </button>
                                  </div>

                                  <BrowserLanePicker
                                    lane={browserLane}
                                    onChange={setBrowserLane}
                                    disabled={isStreaming}
                                    accent={agColor}
                                  />

                                  {pendingImages.length > 0 && (
                                    <span
                                      style={{
                                        fontFamily: CR.mono,
                                        fontSize: 10,
                                        color: agColor,
                                        flexShrink: 0,
                                      }}
                                    >
                                      {pendingImages.length} image
                                      {pendingImages.length > 1 ? 's' : ''}{' '}
                                      attached
                                    </span>
                                  )}

                                  <div style={{ flex: 1 }} />

                                  {(() => {
                                    const blocked =
                                      !chatInput.trim() &&
                                      pendingImages.length === 0;
                                    return (
                                      <button
                                        onClick={() => {
                                          sendChat();
                                          if (chatInputRef.current)
                                            chatInputRef.current.style.height =
                                              'auto';
                                        }}
                                        disabled={blocked}
                                        title={
                                          isStreaming
                                            ? 'Queue — sent when this turn ends'
                                            : 'Send'
                                        }
                                        style={{
                                          width: 30,
                                          height: 30,
                                          borderRadius: '50%',
                                          flexShrink: 0,
                                          background: blocked
                                            ? 'var(--cr-tint-4)'
                                            : `linear-gradient(135deg, ${CR.accent}, ${CR.accentWarm})`,
                                          border: `1px solid ${blocked ? CR.border : 'transparent'}`,
                                          color: blocked
                                            ? CR.muted
                                            : 'var(--cr-on-accent)',
                                          cursor: blocked
                                            ? 'default'
                                            : 'pointer',
                                          display: 'flex',
                                          alignItems: 'center',
                                          justifyContent: 'center',
                                          transition: 'all 0.15s',
                                          boxShadow: blocked
                                            ? 'none'
                                            : `0 2px 8px ${CR.accent40}`,
                                        }}
                                      >
                                        <ArrowUp size={16} />
                                      </button>
                                    );
                                  })()}
                                </div>
                              </div>
                            </div>
                          </div>
                        );
                      })()}
                    </div>
                  </div>
                );
              })()}

            {/* WORKSPACE */}
            {tab === 'workspace' &&
              (() => {
                const all = agentId ? agentFiles[agentId] || [] : [];
                // Skills live under workspace/skills/ — pull them into their own section
                // (re-rooted so the tree shows skill names directly, not under a "skills" folder).
                const skillFiles = all
                  .filter((f) => String(f.path || '').startsWith('skills/'))
                  .map((f) => ({
                    ...f,
                    path: String(f.path).replace(/^skills\//, ''),
                  }));
                const wsFiles = all.filter(
                  (f) => !String(f.path || '').startsWith('skills/'),
                );

                // Shared recursive tree renderer — keyPrefix keeps collapse state per-section.
                // pinControl (optional) adds a must-read star toggle to file rows.
                // Small hover-visible action buttons — rename doubles as move (the
                // prompt is pre-filled with the full path), copy duplicates in place.
                const ManageActions = ({
                  path: p,
                  isDir,
                }: {
                  path: string;
                  isDir: boolean;
                }) => (
                  <div
                    style={{ display: 'flex', gap: 2, flexShrink: 0 }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    <button
                      onClick={() => renameWorkspaceFile(p)}
                      title="Rename / move"
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: '3px 4px',
                        borderRadius: 4,
                        color: CR.muted,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = CR.cream;
                        e.currentTarget.style.background = 'var(--cr-tint-4)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = CR.muted;
                        e.currentTarget.style.background = 'none';
                      }}
                    >
                      ✎
                    </button>
                    <button
                      onClick={() => copyWorkspaceFile(p)}
                      title="Duplicate"
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: '3px 4px',
                        borderRadius: 4,
                        color: CR.muted,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = CR.cream;
                        e.currentTarget.style.background = 'var(--cr-tint-4)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = CR.muted;
                        e.currentTarget.style.background = 'none';
                      }}
                    >
                      ⧉
                    </button>
                    <button
                      onClick={() => deleteWorkspaceFile(p, isDir)}
                      title="Delete"
                      style={{
                        background: 'none',
                        border: 'none',
                        cursor: 'pointer',
                        fontSize: 12,
                        padding: '3px 4px',
                        borderRadius: 4,
                        color: CR.muted,
                      }}
                      onMouseEnter={(e) => {
                        e.currentTarget.style.color = 'var(--cr-error-str)';
                        e.currentTarget.style.background =
                          'var(--cr-error-low)';
                      }}
                      onMouseLeave={(e) => {
                        e.currentTarget.style.color = CR.muted;
                        e.currentTarget.style.background = 'none';
                      }}
                    >
                      🗑
                    </button>
                  </div>
                );

                const renderFileTree = (
                  files: any[],
                  keyPrefix: string,
                  onFileClick: (f: any) => void,
                  pinControl?: {
                    pinned: Set<string>;
                    toggle: (p: string) => void;
                  },
                  manage?: boolean,
                ) => {
                  const renderNodes = (
                    nodes: WsTreeNode[],
                    depth: number,
                  ): any =>
                    nodes.map((node) => {
                      const indent = 18 + depth * 20;
                      if (node.kind === 'dir') {
                        const ck = keyPrefix + ':' + node.path;
                        const open = !wsCollapsed.has(ck);
                        return (
                          <div key={'d:' + ck}>
                            <div
                              onClick={() =>
                                setWsCollapsed((prev) => {
                                  const n = new Set(prev);
                                  if (open) n.add(ck);
                                  else n.delete(ck);
                                  return n;
                                })
                              }
                              style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '9px 18px',
                                paddingLeft: indent,
                                cursor: 'pointer',
                                background: CR.bgSurf,
                                border: `1px solid ${CR.border}`,
                                transition: 'background 0.15s',
                              }}
                              onMouseEnter={(e) =>
                                (e.currentTarget.style.background = CR.bgCard)
                              }
                              onMouseLeave={(e) =>
                                (e.currentTarget.style.background = CR.bgSurf)
                              }
                            >
                              <span
                                style={{
                                  fontFamily: CR.mono,
                                  fontSize: 9,
                                  color: CR.muted,
                                  width: 10,
                                  flexShrink: 0,
                                }}
                              >
                                {open ? '▾' : '▸'}
                              </span>
                              <span style={{ fontSize: 13, flexShrink: 0 }}>
                                {open ? '📂' : '📁'}
                              </span>
                              <span
                                style={{
                                  flex: 1,
                                  fontFamily: CR.mono,
                                  fontSize: 12,
                                  color: CR.cream,
                                }}
                              >
                                {node.name}
                              </span>
                              <span
                                style={{
                                  fontFamily: CR.mono,
                                  fontSize: 10,
                                  color: CR.muted,
                                }}
                              >
                                {countFilesIn(node)}
                              </span>
                              {manage && (
                                <ManageActions path={node.path} isDir />
                              )}
                            </div>
                            {open && renderNodes(node.children, depth + 1)}
                          </div>
                        );
                      }
                      const f = node.file;
                      return (
                        <div
                          key={'f:' + keyPrefix + ':' + (f.id || f.path)}
                          onClick={() => onFileClick(f)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 14,
                            padding: '12px 18px',
                            paddingLeft: indent,
                            background: CR.bgSurf,
                            border: `1px solid ${CR.border}`,
                            transition: 'background 0.15s',
                            cursor: 'pointer',
                          }}
                          onMouseEnter={(e) =>
                            (e.currentTarget.style.background = CR.bgCard)
                          }
                          onMouseLeave={(e) =>
                            (e.currentTarget.style.background = CR.bgSurf)
                          }
                        >
                          <div
                            style={{
                              width: 36,
                              height: 36,
                              borderRadius: 8,
                              flexShrink: 0,
                              background: `${withAlpha(agColor, 8)}`,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              fontFamily: CR.mono,
                              fontSize: 9,
                              color: agColor,
                              fontWeight: 700,
                              textTransform: 'uppercase',
                              border: `1px solid ${withAlpha(agColor, 13)}`,
                            }}
                          >
                            {f.extension || '??'}
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <div
                              style={{
                                fontFamily: CR.mono,
                                fontSize: 12,
                                color: CR.cream,
                                marginBottom: 2,
                              }}
                            >
                              {node.name}
                            </div>
                            <div
                              style={{
                                fontFamily: CR.mono,
                                fontSize: 10,
                                color: CR.muted,
                              }}
                            >
                              {fmtBytes(f.sizeBytes)} · {fmtRel(f.modifiedAt)}
                            </div>
                          </div>
                          {pinControl && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation();
                                pinControl.toggle(f.path);
                              }}
                              title={
                                pinControl.pinned.has(f.path)
                                  ? 'Unpin (remove must-read)'
                                  : 'Pin as must-read'
                              }
                              style={{
                                background: 'none',
                                border: 'none',
                                cursor: 'pointer',
                                fontSize: 15,
                                lineHeight: 1,
                                padding: 0,
                                flexShrink: 0,
                                color: pinControl.pinned.has(f.path)
                                  ? CR.amber
                                  : CR.muted,
                              }}
                            >
                              {pinControl.pinned.has(f.path) ? '★' : '☆'}
                            </button>
                          )}
                          {manage && (
                            <ManageActions path={f.path} isDir={false} />
                          )}
                          <span
                            style={{
                              fontFamily: CR.sans,
                              fontSize: 11,
                              color: CR.sub,
                            }}
                          >
                            View →
                          </span>
                        </div>
                      );
                    });
                  return renderNodes(buildFileTree(files), 0);
                };

                const Section = ({
                  title,
                  hint,
                  files,
                  keyPrefix,
                  onFileClick,
                  emptyText,
                  headerExtra,
                  pinControl,
                  manage,
                }: any) => (
                  <div style={{ marginBottom: 26 }}>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 10,
                        marginBottom: 10,
                      }}
                    >
                      <div
                        style={{
                          fontFamily: CR.mono,
                          fontSize: 10,
                          fontWeight: 700,
                          color: CR.mutedBr || CR.muted,
                          letterSpacing: '0.1em',
                          textTransform: 'uppercase',
                        }}
                      >
                        {title}
                      </div>
                      <div
                        style={{
                          fontFamily: CR.mono,
                          fontSize: 10,
                          color: CR.muted,
                        }}
                      >
                        {files.length}
                      </div>
                      {hint && (
                        <div
                          style={{
                            flex: 1,
                            fontFamily: CR.sans,
                            fontSize: 11,
                            color: CR.muted,
                          }}
                        >
                          {hint}
                        </div>
                      )}
                      {headerExtra}
                    </div>
                    {files.length === 0 ? (
                      <div
                        style={{
                          padding: '18px',
                          textAlign: 'center',
                          background: 'var(--cr-well)',
                          borderRadius: 10,
                          border: `1px dashed ${CR.border}`,
                          fontFamily: CR.sans,
                          fontSize: 12,
                          color: CR.muted,
                        }}
                      >
                        {emptyText}
                      </div>
                    ) : (
                      <div
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 2,
                        }}
                      >
                        {renderFileTree(
                          files,
                          keyPrefix,
                          onFileClick,
                          pinControl,
                          manage,
                        )}
                      </div>
                    )}
                  </div>
                );

                const pinned = new Set<string>(
                  (agent?.config?.pins as string[] | undefined) || [],
                );

                return (
                  <div
                    style={{ padding: isMobile ? '18px 16px' : '28px 40px' }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: 22,
                      }}
                    >
                      <div
                        style={{
                          fontFamily: CR.serif,
                          fontSize: 18,
                          color: CR.sub,
                        }}
                      >
                        Files
                      </div>
                      <button
                        onClick={() => agentId && fetchAgentFiles(agentId)}
                        style={{
                          background: 'none',
                          border: 'none',
                          color: CR.accent,
                          cursor: 'pointer',
                          fontFamily: CR.mono,
                          fontSize: 10,
                          textTransform: 'uppercase',
                          letterSpacing: '0.05em',
                        }}
                      >
                        Refresh
                      </button>
                    </div>

                    <Section
                      title="Workspace"
                      keyPrefix="ws"
                      files={wsFiles}
                      onFileClick={viewFile}
                      pinControl={{ pinned, toggle: togglePin }}
                      manage
                      hint="Your project folder — files you add + what the agent produces. ★ = must-read."
                      emptyText="No files yet. Add files here, or run a cycle to generate output."
                      headerExtra={
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            onClick={() => wsFileInputRef.current?.click()}
                            style={{
                              background: 'none',
                              border: `1px solid ${CR.border}`,
                              color: CR.sub,
                              cursor: 'pointer',
                              fontFamily: CR.mono,
                              fontSize: 10,
                              padding: '3px 9px',
                              borderRadius: 6,
                            }}
                          >
                            + Add
                          </button>
                          <button
                            onClick={() => wsFolderInputRef.current?.click()}
                            style={{
                              background: 'none',
                              border: `1px solid ${CR.border}`,
                              color: CR.sub,
                              cursor: 'pointer',
                              fontFamily: CR.mono,
                              fontSize: 10,
                              padding: '3px 9px',
                              borderRadius: 6,
                            }}
                          >
                            + Folder
                          </button>
                        </div>
                      }
                    />
                    <Section
                      title="Skills"
                      keyPrefix="sk"
                      files={skillFiles}
                      onFileClick={viewFile}
                      hint="Reusable patterns the agent has saved"
                      emptyText="No skills learned yet. The agent saves them via save_skill."
                    />
                  </div>
                );
              })()}

            {/* MEMORY */}
            {tab === 'memory' && (
              <div style={{ padding: isMobile ? '18px 16px' : '28px 40px' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 24,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontFamily: CR.serif,
                        fontSize: 18,
                        color: CR.sub,
                      }}
                    >
                      Agent Memory
                    </div>
                    <div
                      style={{
                        fontFamily: CR.sans,
                        fontSize: 12,
                        color: CR.muted,
                        marginTop: 4,
                      }}
                    >
                      Two memory stores work together — both shown below
                    </div>
                  </div>
                  <button
                    onClick={loadMemory}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: CR.accent,
                      cursor: 'pointer',
                      fontFamily: CR.mono,
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    Refresh
                  </button>
                </div>

                {memoryLoading ? (
                  <div
                    style={{
                      padding: 40,
                      textAlign: 'center',
                      color: CR.muted,
                      fontFamily: CR.sans,
                      fontSize: 13,
                    }}
                  >
                    Loading memory…
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 28,
                    }}
                  >
                    {/* ── Section 1: MEMORY.md (append_memory) ── */}
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          marginBottom: 12,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: CR.sans,
                            fontSize: 13,
                            fontWeight: 600,
                            color: CR.cream,
                          }}
                        >
                          MEMORY.md
                        </div>
                        <div
                          style={{
                            fontFamily: CR.mono,
                            fontSize: 9,
                            padding: '2px 8px',
                            borderRadius: 4,
                            background: 'var(--cr-amber-low)',
                            border: '1px solid var(--cr-amber-line)',
                            color: 'var(--cr-warn)',
                            textTransform: 'uppercase',
                          }}
                        >
                          written by agent via append_memory
                        </div>
                      </div>
                      <div
                        style={{
                          fontFamily: CR.sans,
                          fontSize: 12,
                          color: CR.muted,
                          marginBottom: 12,
                        }}
                      >
                        Free-form notes the agent writes itself during cycles.
                        This is what it reads at the start of every
                        conversation.
                      </div>
                      {!memoryFile || memoryFile.trim() === '' ? (
                        <div
                          style={{
                            padding: '20px 24px',
                            background: 'var(--cr-well)',
                            borderRadius: 10,
                            border: `1px dashed ${CR.border}`,
                            textAlign: 'center',
                          }}
                        >
                          <div
                            style={{
                              fontFamily: CR.sans,
                              fontSize: 13,
                              color: CR.muted,
                            }}
                          >
                            MEMORY.md is empty — the agent hasn't used{' '}
                            <code style={{ color: CR.cream }}>
                              append_memory
                            </code>{' '}
                            yet
                          </div>
                        </div>
                      ) : (
                        <div
                          style={{
                            background: CR.bgCard,
                            border: `1px solid ${CR.border}`,
                            borderRadius: 10,
                            padding: '16px 20px',
                            fontFamily: CR.mono,
                            fontSize: 12,
                            color: CR.text,
                            lineHeight: 1.7,
                            whiteSpace: 'pre-wrap',
                            maxHeight: 360,
                            overflow: 'auto',
                          }}
                        >
                          {memoryFile}
                        </div>
                      )}
                    </div>

                    {/* ── Divider ── */}
                    <div style={{ borderTop: `1px solid ${CR.border}` }} />

                    {/* ── Section 2: Structured memories (self_improve) ── */}
                    <div>
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 10,
                          marginBottom: 12,
                        }}
                      >
                        <div
                          style={{
                            fontFamily: CR.sans,
                            fontSize: 13,
                            fontWeight: 600,
                            color: CR.cream,
                          }}
                        >
                          Structured Memories
                        </div>
                        <div
                          style={{
                            fontFamily: CR.mono,
                            fontSize: 9,
                            padding: '2px 8px',
                            borderRadius: 4,
                            background: 'var(--cr-green-low)',
                            border: '1px solid var(--cr-green-line)',
                            color: CR.green,
                            textTransform: 'uppercase',
                          }}
                        >
                          {agentMemory.length}{' '}
                          {agentMemory.length === 1 ? 'entry' : 'entries'} —
                          distilled by self_improve
                        </div>
                      </div>
                      <div
                        style={{
                          fontFamily: CR.sans,
                          fontSize: 12,
                          color: CR.muted,
                          marginBottom: 12,
                        }}
                      >
                        Lessons extracted and scored from past cycle outcomes.
                        Populated when you run a{' '}
                        <strong style={{ color: CR.sub }}>self_improve</strong>{' '}
                        cycle.
                      </div>
                      {agentMemory.length === 0 ? (
                        <div
                          style={{
                            padding: '20px 24px',
                            background: 'var(--cr-well)',
                            borderRadius: 10,
                            border: `1px dashed ${CR.border}`,
                            textAlign: 'center',
                          }}
                        >
                          <div
                            style={{
                              fontFamily: CR.sans,
                              fontSize: 13,
                              color: CR.muted,
                            }}
                          >
                            No structured memories yet — run a{' '}
                            <strong style={{ color: CR.sub }}>
                              self_improve
                            </strong>{' '}
                            cycle to generate them
                          </div>
                        </div>
                      ) : (
                        (() => {
                          const q = memoryFilter.trim().toLowerCase();
                          const filtered = q
                            ? agentMemory.filter(
                                (m) =>
                                  (m.content || '').toLowerCase().includes(q) ||
                                  (m.type || '').toLowerCase().includes(q),
                              )
                            : agentMemory;
                          return (
                            <div
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                gap: 10,
                              }}
                            >
                              <div
                                style={{
                                  display: 'flex',
                                  alignItems: 'center',
                                  gap: 10,
                                }}
                              >
                                <input
                                  type="text"
                                  value={memoryFilter}
                                  onChange={(e) =>
                                    setMemoryFilter(e.target.value)
                                  }
                                  placeholder="Filter by content or type…"
                                  style={{
                                    flex: 1,
                                    padding: '10px 14px',
                                    borderRadius: 8,
                                    background: CR.bgCard,
                                    border: `1px solid ${CR.border}`,
                                    color: CR.cream,
                                    fontFamily: CR.sans,
                                    fontSize: 12,
                                    outline: 'none',
                                  }}
                                  onFocus={(e) => {
                                    e.currentTarget.style.borderColor = agColor;
                                  }}
                                  onBlur={(e) => {
                                    e.currentTarget.style.borderColor =
                                      CR.border;
                                  }}
                                />
                                {q && (
                                  <div
                                    style={{
                                      fontFamily: CR.mono,
                                      fontSize: 10,
                                      color: CR.muted,
                                    }}
                                  >
                                    {filtered.length} / {agentMemory.length}
                                  </div>
                                )}
                              </div>
                              {filtered.length === 0 ? (
                                <div
                                  style={{
                                    padding: '14px',
                                    textAlign: 'center',
                                    color: CR.muted,
                                    fontSize: 12,
                                    fontStyle: 'italic',
                                    border: `1px dashed ${CR.border}`,
                                    borderRadius: 8,
                                  }}
                                >
                                  No memories match "{memoryFilter}".
                                </div>
                              ) : (
                                filtered.map((m) => (
                                  <div
                                    key={m.id}
                                    style={{
                                      background: CR.bgCard,
                                      border: `1px solid ${CR.border}`,
                                      borderRadius: 10,
                                      padding: '14px 18px',
                                      display: 'flex',
                                      gap: 14,
                                      alignItems: 'flex-start',
                                    }}
                                  >
                                    <div
                                      style={{
                                        flexShrink: 0,
                                        padding: '2px 8px',
                                        borderRadius: 4,
                                        background: `${withAlpha(agColor, 6)}`,
                                        border: `1px solid ${withAlpha(agColor, 13)}`,
                                        fontFamily: CR.mono,
                                        fontSize: 9,
                                        color: agColor,
                                        fontWeight: 700,
                                        textTransform: 'uppercase',
                                        marginTop: 2,
                                      }}
                                    >
                                      {m.type}
                                    </div>
                                    <div style={{ flex: 1, minWidth: 0 }}>
                                      <p
                                        style={{
                                          fontFamily: CR.sans,
                                          fontSize: 13,
                                          color: CR.text,
                                          lineHeight: 1.6,
                                          margin: '0 0 8px',
                                        }}
                                      >
                                        {m.content}
                                      </p>
                                      <div style={{ display: 'flex', gap: 14 }}>
                                        <span
                                          style={{
                                            fontFamily: CR.mono,
                                            fontSize: 9,
                                            color: CR.muted,
                                          }}
                                        >
                                          relevance: {m.relevance.toFixed(2)}
                                        </span>
                                        <span
                                          style={{
                                            fontFamily: CR.mono,
                                            fontSize: 9,
                                            color: CR.muted,
                                          }}
                                        >
                                          used: {m.used_count}×
                                        </span>
                                        <span
                                          style={{
                                            fontFamily: CR.mono,
                                            fontSize: 9,
                                            color: CR.muted,
                                          }}
                                        >
                                          {fmtRel(m.created_at)}
                                        </span>
                                      </div>
                                    </div>
                                    <button
                                      onClick={() => handleDeleteMemory(m.id)}
                                      style={{
                                        background: 'none',
                                        border: 'none',
                                        color: CR.muted,
                                        cursor: 'pointer',
                                        fontSize: 14,
                                        padding: '2px 6px',
                                        borderRadius: 4,
                                        flexShrink: 0,
                                        transition: 'color 0.15s',
                                      }}
                                      onMouseEnter={(e) =>
                                        (e.currentTarget.style.color =
                                          'var(--cr-error)')
                                      }
                                      onMouseLeave={(e) =>
                                        (e.currentTarget.style.color = CR.muted)
                                      }
                                    >
                                      ✕
                                    </button>
                                  </div>
                                ))
                              )}
                            </div>
                          );
                        })()
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* CHECK-INS */}
            {tab === 'checkins' && (
              <div style={{ padding: isMobile ? '18px 16px' : '28px 40px' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 20,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontFamily: CR.serif,
                        fontSize: 18,
                        color: CR.sub,
                      }}
                    >
                      Check-in Reports
                    </div>
                    <div
                      style={{
                        fontFamily: CR.sans,
                        fontSize: 12,
                        color: CR.muted,
                        marginTop: 4,
                      }}
                    >
                      Periodic reports the agent generates about its progress
                    </div>
                  </div>
                  <button
                    onClick={loadCheckins}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: CR.accent,
                      cursor: 'pointer',
                      fontFamily: CR.mono,
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    Refresh
                  </button>
                </div>
                {checkins.length === 0 ? (
                  <div
                    style={{
                      padding: 40,
                      textAlign: 'center',
                      background: 'var(--cr-well)',
                      borderRadius: 12,
                      border: `1px dashed ${CR.border}`,
                    }}
                  >
                    <div style={{ fontSize: 24, marginBottom: 12 }}>📋</div>
                    <p
                      style={{
                        fontFamily: CR.sans,
                        fontSize: 13,
                        color: CR.muted,
                        margin: 0,
                      }}
                    >
                      No check-ins yet. Run a{' '}
                      <strong style={{ color: CR.sub }}>checkin</strong> cycle
                      to generate a report.
                    </p>
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 16,
                    }}
                  >
                    {checkins.map((ci) => (
                      <div
                        key={ci.id}
                        style={{
                          background: CR.bgCard,
                          border: `1px solid ${CR.border}`,
                          borderRadius: 12,
                          overflow: 'hidden',
                        }}
                      >
                        <div
                          style={{
                            padding: '14px 20px',
                            borderBottom: `1px solid ${CR.border}`,
                            display: 'flex',
                            justifyContent: 'space-between',
                            alignItems: 'center',
                          }}
                        >
                          <div
                            style={{
                              display: 'flex',
                              gap: 10,
                              alignItems: 'center',
                            }}
                          >
                            <span
                              style={{
                                fontFamily: CR.mono,
                                fontSize: 9,
                                padding: '2px 7px',
                                borderRadius: 4,
                                fontWeight: 700,
                                background:
                                  ci.status === 'responded'
                                    ? 'var(--cr-green-low)'
                                    : 'var(--cr-amber-low)',
                                color:
                                  ci.status === 'responded'
                                    ? CR.green
                                    : 'var(--cr-amber)',
                              }}
                            >
                              {ci.status.toUpperCase()}
                            </span>
                            <span
                              style={{
                                fontFamily: CR.mono,
                                fontSize: 10,
                                color: CR.muted,
                              }}
                            >
                              {fmtRel(ci.created_at)}
                            </span>
                          </div>
                          <button
                            onClick={() =>
                              setJobDrawer({
                                jobId: ci.id,
                                title: 'Check-in Report',
                                resultText: ci.report_md || '',
                                isSuccess: true,
                                agentId: agentId ?? undefined,
                              })
                            }
                            style={{
                              background: 'none',
                              border: `1px solid ${CR.border}`,
                              color: CR.sub,
                              cursor: 'pointer',
                              padding: '4px 10px',
                              borderRadius: 6,
                              fontFamily: CR.sans,
                              fontSize: 11,
                            }}
                          >
                            View Full Report
                          </button>
                        </div>
                        <div style={{ padding: '16px 20px' }}>
                          <pre
                            style={{
                              fontFamily: CR.sans,
                              fontSize: 13,
                              color: CR.text,
                              lineHeight: 1.65,
                              whiteSpace: 'pre-wrap',
                              margin: '0 0 16px',
                              maxHeight: 200,
                              overflow: 'hidden',
                            }}
                          >
                            {(ci.report_md || '').slice(0, 400)}
                            {(ci.report_md || '').length > 400 ? '…' : ''}
                          </pre>
                          {ci.user_reply && (
                            <div
                              style={{
                                padding: '10px 14px',
                                background: CR.accentLow,
                                borderRadius: 8,
                                borderLeft: `3px solid ${CR.accent}`,
                                marginBottom: 12,
                              }}
                            >
                              <div
                                style={{
                                  fontFamily: CR.mono,
                                  fontSize: 9,
                                  color: CR.accent,
                                  marginBottom: 4,
                                }}
                              >
                                YOUR REPLY
                              </div>
                              <p
                                style={{
                                  fontFamily: CR.sans,
                                  fontSize: 12,
                                  color: CR.text,
                                  margin: 0,
                                }}
                              >
                                {ci.user_reply}
                              </p>
                            </div>
                          )}
                          {ci.status !== 'responded' && (
                            <div
                              style={{
                                display: 'flex',
                                gap: 8,
                                alignItems: 'flex-start',
                              }}
                            >
                              {/* Enter used to submit, which made a multi-line reply impossible to
                                                                type here at all. Newline is the default now; Cmd/Ctrl+Enter sends. */}
                              <textarea
                                value={checkinReplies[ci.id] || ''}
                                onChange={(e) =>
                                  setCheckinReplies((r) => ({
                                    ...r,
                                    [ci.id]: e.target.value,
                                  }))
                                }
                                onInput={(e) => {
                                  const t = e.currentTarget;
                                  t.style.height = 'auto';
                                  t.style.height = `${Math.min(t.scrollHeight, 260)}px`;
                                }}
                                rows={2}
                                placeholder="Reply to this check-in…  (⌘/Ctrl + Enter to send)"
                                style={{
                                  flex: 1,
                                  boxSizing: 'border-box',
                                  background: CR.bgSurf,
                                  border: `1px solid ${CR.border}`,
                                  borderRadius: 8,
                                  padding: '9px 12px',
                                  color: CR.text,
                                  fontFamily: CR.sans,
                                  fontSize: 13,
                                  lineHeight: 1.5,
                                  outline: 'none',
                                  resize: 'vertical',
                                  minHeight: 60,
                                  maxHeight: 260,
                                  overflowY: 'auto',
                                }}
                                onKeyDown={(e) => {
                                  if (
                                    e.key === 'Enter' &&
                                    (e.metaKey || e.ctrlKey)
                                  ) {
                                    e.preventDefault();
                                    handleCheckinReply(ci.id);
                                  }
                                }}
                              />
                              <button
                                onClick={() => handleCheckinReply(ci.id)}
                                disabled={
                                  checkinSending[ci.id] ||
                                  !checkinReplies[ci.id]?.trim()
                                }
                                style={{
                                  padding: '9px 16px',
                                  borderRadius: 8,
                                  cursor: 'pointer',
                                  background: `${CR.accent15}`,
                                  border: `1px solid ${CR.accent30}`,
                                  color: CR.accent,
                                  fontFamily: CR.sans,
                                  fontSize: 12,
                                  fontWeight: 600,
                                  opacity: checkinSending[ci.id] ? 0.6 : 1,
                                }}
                              >
                                {checkinSending[ci.id] ? 'Sending…' : 'Reply →'}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* IDENTITY */}
            {tab === 'identity' && (
              <div
                style={{
                  padding: isMobile ? '18px 16px' : '28px 40px',
                  opacity: isSaving ? 0.7 : 1,
                }}
              >
                {/* Header card */}
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 16,
                    marginBottom: 24,
                    padding: '16px 20px',
                    background: CR.bgSurf,
                    border: `1px solid ${CR.border}`,
                    borderRadius: 12,
                    borderLeft: `3px solid ${agColor}`,
                  }}
                >
                  <div
                    style={{
                      width: 44,
                      height: 44,
                      borderRadius: 12,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      fontSize: 22,
                      background: `${withAlpha(agColor, 9)}`,
                      border: `1px solid ${withAlpha(agColor, 19)}`,
                      flexShrink: 0,
                    }}
                  >
                    {agent.emoji || '🤖'}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div
                      style={{
                        fontFamily: CR.serif,
                        fontSize: 18,
                        color: CR.cream,
                        marginBottom: 3,
                      }}
                    >
                      {agent.name}
                    </div>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 8 }}
                    >
                      <span
                        style={{
                          fontFamily: CR.mono,
                          fontSize: 10,
                          color: CR.muted,
                        }}
                      >
                        {agent.type}
                      </span>
                      <span
                        style={{
                          width: 3,
                          height: 3,
                          borderRadius: '50%',
                          background: CR.border,
                        }}
                      />
                      <span
                        style={{
                          fontFamily: CR.mono,
                          fontSize: 10,
                          color: CR.muted,
                        }}
                      >
                        IDENTITY.md
                      </span>
                    </div>
                  </div>
                  <span
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      background: `${withAlpha(agColor, 7)}`,
                      border: `1px solid ${withAlpha(agColor, 19)}`,
                      fontFamily: CR.mono,
                      fontSize: 11,
                      color: agColor,
                      flexShrink: 0,
                    }}
                  >
                    v{agent.identity_version ?? 1}
                  </span>
                </div>

                {/* Mission — editable with inline save */}
                <div style={{ marginBottom: 24 }}>
                  <div
                    style={{
                      fontFamily: CR.mono,
                      fontSize: 9,
                      color: CR.mutedBr,
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      marginBottom: 8,
                    }}
                  >
                    Mission / Goals
                  </div>
                  <textarea
                    value={missionEdit}
                    onChange={(e) => setMissionEdit(e.target.value)}
                    rows={6}
                    disabled={isSaving}
                    style={{
                      width: '100%',
                      background: CR.bgCard,
                      border: `1px solid ${CR.border}`,
                      borderRadius: 10,
                      padding: '12px 14px',
                      color: CR.text,
                      fontFamily: CR.sans,
                      fontSize: 13,
                      lineHeight: 1.6,
                      resize: 'vertical',
                      outline: 'none',
                      transition: 'border-color 0.15s',
                      boxSizing: 'border-box',
                    }}
                    onFocus={(e) => (e.target.style.borderColor = agColor)}
                    onBlur={(e) => (e.target.style.borderColor = CR.border)}
                  />
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      marginTop: 10,
                    }}
                  >
                    <button
                      onClick={handleSaveIdentity}
                      disabled={isSaving || missionEdit === agent.config.goals}
                      style={{
                        padding: '9px 20px',
                        borderRadius: 9,
                        cursor:
                          isSaving || missionEdit === agent.config.goals
                            ? 'default'
                            : 'pointer',
                        background:
                          isSaving || missionEdit === agent.config.goals
                            ? 'var(--cr-tint-3)'
                            : `linear-gradient(135deg, ${agColor}, ${withAlpha(agColor, 80)})`,
                        border: `1px solid ${isSaving || missionEdit === agent.config.goals ? CR.border : withAlpha(agColor, 31)}`,
                        color:
                          isSaving || missionEdit === agent.config.goals
                            ? CR.muted
                            : 'var(--cr-on-accent)',
                        fontFamily: CR.sans,
                        fontSize: 13,
                        fontWeight: 600,
                        transition: 'all 0.15s',
                        boxShadow:
                          isSaving || missionEdit === agent.config.goals
                            ? 'none'
                            : `0 3px 12px ${withAlpha(agColor, 19)}`,
                      }}
                    >
                      {isSaving ? 'Saving…' : 'Save Mission'}
                    </button>
                    {missionEdit !== agent.config.goals && !isSaving && (
                      <span
                        style={{
                          fontFamily: CR.mono,
                          fontSize: 10,
                          color: CR.muted,
                        }}
                      >
                        Unsaved changes
                      </span>
                    )}
                  </div>
                  <div
                    style={{
                      marginTop: 12,
                      padding: '9px 12px',
                      background: 'var(--cr-tint-1)',
                      border: `1px dashed ${CR.border}`,
                      borderRadius: 8,
                      fontFamily: CR.sans,
                      fontSize: 11,
                      color: CR.muted,
                    }}
                  >
                    Run a{' '}
                    <strong style={{ color: CR.sub }}>self_improve</strong>{' '}
                    cycle to let the agent evolve its IDENTITY.md to the next
                    version.
                  </div>

                  {/* The live IDENTITY.md. The Mission field above is one small part
                                    of it — an agent's real operating rules can run to thousands of
                                    words and were previously not visible anywhere in the product,
                                    on a tab already labelled IDENTITY.md. Read-only because the file
                                    is regenerated from config; edits here would be overwritten. */}
                  <div style={{ marginTop: 16 }}>
                    <button
                      onClick={async () => {
                        if (fullIdentity) {
                          setFullIdentity(null);
                          return;
                        }
                        try {
                          const r = await fetch(
                            `/api/agents/${agentId}/identity`,
                          );
                          const d = await r.json();
                          setFullIdentity(
                            d.content ?? 'Could not load IDENTITY.md.',
                          );
                        } catch {
                          setFullIdentity('Could not load IDENTITY.md.');
                        }
                      }}
                      style={{
                        padding: '6px 12px',
                        borderRadius: 6,
                        cursor: 'pointer',
                        border: `1px solid ${CR.border}`,
                        background: 'transparent',
                        color: CR.sub,
                        fontFamily: CR.mono,
                        fontSize: 11,
                      }}
                    >
                      {fullIdentity
                        ? '▾ Hide full IDENTITY.md'
                        : '▸ View full IDENTITY.md'}
                    </button>
                    {fullIdentity && (
                      <>
                        <div
                          style={{
                            marginTop: 8,
                            fontFamily: CR.sans,
                            fontSize: 11,
                            color: CR.muted,
                          }}
                        >
                          Read-only — this file is generated from the mission,
                          operating rules and the agent's own{' '}
                          <strong style={{ color: CR.sub }}>LEARNED</strong>{' '}
                          section. Edit the Mission above to change it.
                        </div>
                        <pre
                          style={{
                            marginTop: 8,
                            padding: 14,
                            maxHeight: 460,
                            overflow: 'auto',
                            background: 'var(--cr-tint-1)',
                            border: `1px solid ${CR.border}`,
                            borderRadius: 8,
                            fontFamily: CR.mono,
                            fontSize: 11,
                            lineHeight: 1.6,
                            color: CR.sub,
                            whiteSpace: 'pre-wrap',
                          }}
                        >
                          {fullIdentity}
                        </pre>
                      </>
                    )}
                  </div>
                </div>

                {/* Version history */}
                {identityVersions.length > 0 && (
                  <div style={{ marginBottom: 32 }}>
                    <div
                      style={{
                        fontFamily: CR.mono,
                        fontSize: 9,
                        color: CR.mutedBr,
                        letterSpacing: '0.1em',
                        textTransform: 'uppercase',
                        marginBottom: 12,
                      }}
                    >
                      Version History
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 6,
                        marginBottom: selectedVersion !== null ? 16 : 0,
                      }}
                    >
                      {identityVersions.map((v) => (
                        <button
                          key={v.version}
                          onClick={() => handleSelectVersion(v.version)}
                          style={{
                            padding: '5px 12px',
                            borderRadius: 6,
                            cursor: 'pointer',
                            fontFamily: CR.mono,
                            fontSize: 11,
                            background:
                              selectedVersion === v.version
                                ? `${withAlpha(agColor, 9)}`
                                : 'var(--cr-tint-3)',
                            border: `1px solid ${selectedVersion === v.version ? withAlpha(agColor, 25) : CR.border}`,
                            color:
                              selectedVersion === v.version
                                ? agColor
                                : CR.muted,
                          }}
                          title={new Date(v.modified).toLocaleString()}
                        >
                          v{v.version}
                        </button>
                      ))}
                    </div>

                    {selectedVersion !== null && (
                      <div style={{ marginTop: 4 }}>
                        {/* Toolbar */}
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                            marginBottom: 10,
                          }}
                        >
                          <span
                            style={{
                              fontFamily: CR.sans,
                              fontSize: 12,
                              color: CR.muted,
                            }}
                          >
                            v{selectedVersion} —{' '}
                            {identityVersions.find(
                              (v) => v.version === selectedVersion,
                            )
                              ? new Date(
                                  identityVersions.find(
                                    (v) => v.version === selectedVersion,
                                  )!.modified,
                                ).toLocaleString()
                              : ''}
                          </span>
                          <button
                            onClick={() => setShowDiff((d) => !d)}
                            style={{
                              padding: '3px 10px',
                              borderRadius: 5,
                              cursor: 'pointer',
                              background: showDiff
                                ? 'var(--cr-blue-low)'
                                : 'transparent',
                              border: `1px solid ${showDiff ? 'var(--cr-blue-line)' : CR.border}`,
                              color: showDiff ? 'var(--cr-blue)' : CR.muted,
                              fontFamily: CR.sans,
                              fontSize: 11,
                            }}
                          >
                            {showDiff ? 'Hide diff' : 'Show diff'}
                          </button>
                          <button
                            onClick={handleRestoreVersion}
                            disabled={restoring}
                            style={{
                              padding: '3px 10px',
                              borderRadius: 5,
                              cursor: restoring ? 'default' : 'pointer',
                              background: 'var(--cr-amber-low)',
                              border: '1px solid var(--cr-amber-line)',
                              color: 'var(--cr-warn)',
                              fontFamily: CR.sans,
                              fontSize: 11,
                              opacity: restoring ? 0.6 : 1,
                            }}
                          >
                            {restoring
                              ? 'Restoring…'
                              : '↺ Restore this version'}
                          </button>
                          <button
                            onClick={() => {
                              setSelectedVersion(null);
                              setVersionContent(null);
                              setShowDiff(false);
                            }}
                            style={{
                              padding: '3px 10px',
                              borderRadius: 5,
                              cursor: 'pointer',
                              background: 'transparent',
                              border: `1px solid ${CR.border}`,
                              color: CR.muted,
                              fontFamily: CR.sans,
                              fontSize: 11,
                            }}
                          >
                            ✕
                          </button>
                        </div>

                        {versionLoading ? (
                          <div style={{ color: CR.muted, fontSize: 13 }}>
                            Loading…
                          </div>
                        ) : showDiff ? (
                          /* Side-by-side diff */
                          <div
                            style={{
                              display: 'grid',
                              gridTemplateColumns: '1fr 1fr',
                              gap: 10,
                            }}
                          >
                            {[
                              {
                                label: `v${selectedVersion} (archived)`,
                                content: versionContent ?? '',
                                color: 'var(--cr-blue)',
                              },
                              {
                                label: 'Current IDENTITY.md',
                                content: agent.config?.goals ?? '',
                                color: CR.green,
                              },
                            ].map(({ label, content, color }) => (
                              <div key={label}>
                                <div
                                  style={{
                                    fontFamily: CR.mono,
                                    fontSize: 9,
                                    color,
                                    textTransform: 'uppercase',
                                    letterSpacing: '0.06em',
                                    marginBottom: 6,
                                  }}
                                >
                                  {label}
                                </div>
                                <pre
                                  style={{
                                    background: 'var(--cr-well)',
                                    border: `1px solid ${CR.border}`,
                                    borderRadius: 8,
                                    padding: '12px 14px',
                                    fontFamily: CR.mono,
                                    fontSize: 11,
                                    color: CR.text,
                                    margin: 0,
                                    whiteSpace: 'pre-wrap',
                                    wordBreak: 'break-word',
                                    maxHeight: 320,
                                    overflow: 'auto',
                                  }}
                                >
                                  {content}
                                </pre>
                              </div>
                            ))}
                          </div>
                        ) : (
                          /* Full version view */
                          <pre
                            style={{
                              background: 'var(--cr-well)',
                              border: `1px solid ${CR.border}`,
                              borderRadius: 8,
                              padding: '14px 16px',
                              fontFamily: CR.mono,
                              fontSize: 11,
                              color: CR.text,
                              margin: 0,
                              whiteSpace: 'pre-wrap',
                              wordBreak: 'break-word',
                              maxHeight: 400,
                              overflow: 'auto',
                            }}
                          >
                            {versionContent}
                          </pre>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}

            {/* SCHEDULE */}
            {tab === 'schedule' &&
              (() => {
                return (
                  <ScheduleTab
                    agent={agent}
                    agentId={agentId!}
                    agColor={agColor}
                    schedInfo={schedInfo}
                    updateAgent={updateAgent}
                    fetchAgentSchedule={fetchAgentSchedule}
                    startAgent={startAgent}
                  />
                );
              })()}

            {/* APPROVALS */}
            {tab === 'approvals' && (
              <ApprovalsTab agentId={agentId!} agColor={agColor} />
            )}

            {/* TOOLS */}
            {tab === 'tools' &&
              (() => {
                return (
                  <ToolsTab
                    agentId={agentId!}
                    agColor={agColor}
                    onImproveInChat={(toolName) => {
                      closeManage();
                      setChatInput(`Improve the "${toolName}" tool: `);
                      setTimeout(() => {
                        const el = chatInputRef.current;
                        if (el) {
                          el.focus();
                          const n = el.value.length;
                          el.setSelectionRange(n, n);
                          el.style.height = 'auto';
                          el.style.height =
                            Math.min(el.scrollHeight, 120) + 'px';
                        }
                      }, 60);
                    }}
                  />
                );
              })()}

            {/* OUTPUTS */}
            {tab === 'outputs' && (
              <div style={{ padding: isMobile ? '18px 16px' : '28px 40px' }}>
                <div
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    marginBottom: 20,
                  }}
                >
                  <div>
                    <div
                      style={{
                        fontFamily: CR.serif,
                        fontSize: 18,
                        color: CR.sub,
                      }}
                    >
                      Output Files
                    </div>
                    <div
                      style={{
                        fontFamily: CR.sans,
                        fontSize: 12,
                        color: CR.muted,
                        marginTop: 4,
                      }}
                    >
                      Files produced by sidecar tools — videos, images, PDFs,
                      and more
                    </div>
                  </div>
                  <button
                    onClick={loadOutputs}
                    style={{
                      background: 'none',
                      border: 'none',
                      color: CR.accent,
                      cursor: 'pointer',
                      fontFamily: CR.mono,
                      fontSize: 10,
                      textTransform: 'uppercase',
                      letterSpacing: '0.05em',
                    }}
                  >
                    ↻ Refresh
                  </button>
                </div>

                {/* Preview modal */}
                {outputPreview &&
                  (() => {
                    const url = `/api/agents/${agentId}/outputs/${encodeURIComponent(outputPreview.name)}`;
                    const isVideo = outputPreview.mimeType.startsWith('video/');
                    const isImage = outputPreview.mimeType.startsWith('image/');
                    const isPdf = outputPreview.mimeType === 'application/pdf';
                    return (
                      <div
                        style={{
                          position: 'fixed',
                          inset: 0,
                          background: 'var(--cr-scrim)',
                          zIndex: 9200,
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                        }}
                        onClick={() => setOutputPreview(null)}
                      >
                        <div
                          style={{
                            background: CR.bgCard,
                            border: `1px solid ${CR.border}`,
                            borderRadius: 14,
                            padding: 20,
                            maxWidth: '90vw',
                            maxHeight: '90vh',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: 12,
                          }}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <div
                            style={{
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                            }}
                          >
                            <span
                              style={{
                                fontFamily: CR.mono,
                                fontSize: 12,
                                color: CR.cream,
                              }}
                            >
                              {outputPreview.name}
                            </span>
                            <div style={{ display: 'flex', gap: 10 }}>
                              <a
                                href={url}
                                download={outputPreview.name}
                                style={{
                                  padding: '5px 14px',
                                  borderRadius: 7,
                                  background: `${CR.accent15}`,
                                  border: `1px solid ${CR.accent40}`,
                                  color: CR.accent,
                                  fontFamily: CR.sans,
                                  fontSize: 11,
                                  textDecoration: 'none',
                                  fontWeight: 600,
                                }}
                              >
                                ↓ Download
                              </a>
                              <button
                                onClick={() => setOutputPreview(null)}
                                style={{
                                  background: 'none',
                                  border: 'none',
                                  color: CR.muted,
                                  cursor: 'pointer',
                                  fontSize: 18,
                                }}
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                          {isVideo && (
                            <video
                              controls
                              style={{
                                maxWidth: '80vw',
                                maxHeight: '70vh',
                                borderRadius: 8,
                              }}
                              src={url}
                            />
                          )}
                          {isImage && (
                            <img
                              src={url}
                              alt={outputPreview.name}
                              style={{
                                maxWidth: '80vw',
                                maxHeight: '70vh',
                                borderRadius: 8,
                                objectFit: 'contain',
                              }}
                            />
                          )}
                          {isPdf && (
                            <iframe
                              src={url}
                              style={{
                                width: '80vw',
                                height: '70vh',
                                border: 'none',
                                borderRadius: 8,
                              }}
                            />
                          )}
                          {!isVideo && !isImage && !isPdf && (
                            <div
                              style={{
                                padding: 40,
                                textAlign: 'center',
                                color: CR.muted,
                                fontFamily: CR.sans,
                                fontSize: 13,
                              }}
                            >
                              Preview not available for this file type.
                            </div>
                          )}
                        </div>
                      </div>
                    );
                  })()}

                {outputsLoading ? (
                  <div
                    style={{
                      padding: 40,
                      textAlign: 'center',
                      color: CR.muted,
                      fontFamily: CR.sans,
                      fontSize: 13,
                    }}
                  >
                    Loading outputs…
                  </div>
                ) : outputs.length === 0 ? (
                  <div
                    style={{
                      padding: 40,
                      textAlign: 'center',
                      background: 'var(--cr-well)',
                      borderRadius: 12,
                      border: `1px dashed ${CR.border}`,
                    }}
                  >
                    <div style={{ fontSize: 24, marginBottom: 12 }}>🎬</div>
                    <p
                      style={{
                        fontFamily: CR.sans,
                        fontSize: 13,
                        color: CR.muted,
                        margin: 0,
                      }}
                    >
                      No output files yet. Run a cycle where the agent uses a
                      sidecar tool that produces output files.
                    </p>
                  </div>
                ) : (
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns:
                        'repeat(auto-fill, minmax(220px, 1fr))',
                      gap: 14,
                    }}
                  >
                    {outputs.map((f) => {
                      const isVideo = f.mimeType.startsWith('video/');
                      const isImage = f.mimeType.startsWith('image/');
                      const ext = f.name.split('.').pop()?.toUpperCase() ?? '?';
                      const fileUrl = `/api/agents/${agentId}/outputs/${encodeURIComponent(f.name)}`;
                      const canPreview =
                        isVideo || isImage || f.mimeType === 'application/pdf';
                      return (
                        <div
                          key={f.name}
                          style={{
                            background: CR.bgCard,
                            border: `1px solid ${CR.border}`,
                            borderRadius: 12,
                            overflow: 'hidden',
                            display: 'flex',
                            flexDirection: 'column',
                          }}
                        >
                          {/* Thumbnail */}
                          <div
                            style={{
                              height: 120,
                              background: CR.bgSurf,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              cursor: canPreview ? 'pointer' : 'default',
                              position: 'relative',
                            }}
                            onClick={() =>
                              canPreview &&
                              setOutputPreview({
                                name: f.name,
                                mimeType: f.mimeType,
                              })
                            }
                          >
                            {isImage ? (
                              <img
                                src={fileUrl}
                                alt={f.name}
                                style={{
                                  width: '100%',
                                  height: '100%',
                                  objectFit: 'cover',
                                }}
                              />
                            ) : (
                              <div style={{ textAlign: 'center' }}>
                                <div style={{ fontSize: 32 }}>
                                  {isVideo
                                    ? '🎬'
                                    : f.mimeType === 'application/pdf'
                                      ? '📄'
                                      : '📁'}
                                </div>
                                <div
                                  style={{
                                    fontFamily: CR.mono,
                                    fontSize: 9,
                                    color: CR.muted,
                                    marginTop: 4,
                                  }}
                                >
                                  {ext}
                                </div>
                              </div>
                            )}
                            {canPreview && (
                              <div
                                style={{
                                  position: 'absolute',
                                  inset: 0,
                                  background: 'transparent',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                  transition: 'background 0.15s',
                                }}
                                onMouseEnter={(e) =>
                                  (e.currentTarget.style.background =
                                    'var(--cr-well-str)')
                                }
                                onMouseLeave={(e) =>
                                  (e.currentTarget.style.background =
                                    'var(--cr-well)')
                                }
                              >
                                <span
                                  style={{
                                    color: 'var(--cr-on-accent)',
                                    fontSize: 22,
                                    opacity: 0,
                                    transition: 'opacity 0.15s',
                                  }}
                                  ref={(el) => {
                                    if (el)
                                      el.parentElement!.onmouseenter = () => {
                                        el.style.opacity = '1';
                                      };
                                    el &&
                                      (el.parentElement!.onmouseleave = () => {
                                        el.style.opacity = '0';
                                      });
                                  }}
                                >
                                  {isVideo ? '▶' : '🔍'}
                                </span>
                              </div>
                            )}
                          </div>
                          {/* Info + actions */}
                          <div style={{ padding: '10px 14px' }}>
                            <div
                              style={{
                                fontFamily: CR.mono,
                                fontSize: 11,
                                color: CR.cream,
                                marginBottom: 2,
                                wordBreak: 'break-all',
                              }}
                            >
                              {f.name}
                            </div>
                            <div
                              style={{
                                fontFamily: CR.mono,
                                fontSize: 9,
                                color: CR.muted,
                                marginBottom: 10,
                              }}
                            >
                              {fmtBytes(f.size)} · {fmtRel(f.createdAt)}
                            </div>
                            <div style={{ display: 'flex', gap: 8 }}>
                              {canPreview && (
                                <button
                                  onClick={() =>
                                    setOutputPreview({
                                      name: f.name,
                                      mimeType: f.mimeType,
                                    })
                                  }
                                  style={{
                                    flex: 1,
                                    padding: '5px 0',
                                    borderRadius: 6,
                                    cursor: 'pointer',
                                    background: `${withAlpha(agColor, 7)}`,
                                    border: `1px solid ${withAlpha(agColor, 15)}`,
                                    color: agColor,
                                    fontFamily: CR.sans,
                                    fontSize: 11,
                                    fontWeight: 600,
                                  }}
                                >
                                  Preview
                                </button>
                              )}
                              <a
                                href={fileUrl}
                                download={f.name}
                                style={{
                                  flex: 1,
                                  padding: '5px 0',
                                  borderRadius: 6,
                                  cursor: 'pointer',
                                  background: 'var(--cr-tint-3)',
                                  border: `1px solid ${CR.border}`,
                                  color: CR.sub,
                                  fontFamily: CR.sans,
                                  fontSize: 11,
                                  textAlign: 'center',
                                  textDecoration: 'none',
                                  display: 'flex',
                                  alignItems: 'center',
                                  justifyContent: 'center',
                                }}
                              >
                                ↓ Download
                              </a>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* ARTIFACTS */}
            {/* stage45 item 1 — browser replay. One frame per step was kept
                        beside each run; this is where you look at them afterwards.
                        The JPEGs come from the existing workspace/file raw endpoint,
                        so there is exactly one file-serving path and one traversal
                        check in the product. */}
            {tab === 'browser' &&
              (() => {
                const run = browserRuns[browserRunIdx];
                const frames = run?.frames ?? [];
                const safeIdx = Math.min(
                  browserFrameIdx,
                  Math.max(0, frames.length - 1),
                );
                const frame = frames[safeIdx];
                return (
                  <div
                    style={{ padding: isMobile ? '18px 16px' : '28px 40px' }}
                  >
                    <div style={{ marginBottom: 20 }}>
                      <div
                        style={{
                          fontFamily: CR.serif,
                          fontSize: 18,
                          color: CR.sub,
                        }}
                      >
                        Browser
                      </div>
                      <div
                        style={{
                          fontFamily: CR.sans,
                          fontSize: 12,
                          color: CR.muted,
                          marginTop: 4,
                        }}
                      >
                        What the page looked like at each step of a past browser
                        run
                      </div>
                    </div>

                    {/* Browser | Files, the two things a finished run leaves
                                    behind: what it saw, and what it took. */}
                    <div style={{ display: 'flex', gap: 4, marginBottom: 16 }}>
                      {(['browser', 'files'] as const).map((pane) => (
                        <button
                          key={pane}
                          onClick={() => setBrowserPane(pane)}
                          style={{
                            padding: '5px 12px',
                            borderRadius: 6,
                            cursor: 'pointer',
                            fontSize: 12,
                            fontFamily: CR.sans,
                            textTransform: 'capitalize',
                            background:
                              browserPane === pane
                                ? CR.bgElevated
                                : 'transparent',
                            border:
                              '1px solid ' +
                              (browserPane === pane ? CR.accent : CR.border),
                            color: browserPane === pane ? CR.cream : CR.muted,
                          }}
                        >
                          {pane}
                          {pane === 'files' && browserFiles.length
                            ? ` (${browserFiles.length})`
                            : ''}
                        </button>
                      ))}
                    </div>

                    {browserPane === 'files' && (
                      <div>
                        {!browserFiles.length && (
                          <div style={{ color: CR.muted, fontSize: 13 }}>
                            Nothing downloaded yet. Files an agent saves off a
                            page with the download action appear here.
                          </div>
                        )}
                        {browserFiles.map((f) => (
                          <div
                            key={f.path}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 12,
                              padding: '9px 12px',
                              border: '1px solid ' + CR.border,
                              borderRadius: 8,
                              marginBottom: 8,
                              background: CR.bgElevated,
                            }}
                          >
                            <span style={{ fontSize: 15 }}>📄</span>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div
                                style={{
                                  fontSize: 13,
                                  color: CR.cream,
                                  overflow: 'hidden',
                                  textOverflow: 'ellipsis',
                                  whiteSpace: 'nowrap',
                                }}
                              >
                                {f.path}
                              </div>
                              <div
                                style={{
                                  fontSize: 11,
                                  color: CR.muted,
                                  fontFamily: CR.mono,
                                }}
                              >
                                {f.size.toLocaleString()} bytes ·{' '}
                                {new Date(f.modified).toLocaleString()}
                              </div>
                            </div>
                            {/* The same workspace/file route the replay frames use. Opens in a
                                                    new tab; the route decides inline-vs-attachment by type. */}
                            <a
                              href={
                                '/api/agents/' +
                                agentId +
                                '/workspace/file?raw=1&path=' +
                                encodeURIComponent('downloads/' + f.path)
                              }
                              target="_blank"
                              rel="noreferrer"
                              style={{
                                fontSize: 11,
                                fontFamily: CR.mono,
                                color: CR.accent,
                                textDecoration: 'none',
                                border: '1px solid ' + CR.border,
                                borderRadius: 6,
                                padding: '4px 10px',
                                flexShrink: 0,
                              }}
                            >
                              open
                            </a>
                          </div>
                        ))}
                      </div>
                    )}

                    {browserPane === 'browser' && browserLoading && (
                      <div style={{ color: CR.muted, fontSize: 13 }}>
                        Loading...
                      </div>
                    )}

                    {browserPane === 'browser' &&
                      !browserLoading &&
                      !browserRuns.length && (
                        <div style={{ color: CR.muted, fontSize: 13 }}>
                          No browser runs recorded yet. They appear here after
                          this agent uses the effector tool to drive a browser.
                        </div>
                      )}

                    {browserPane === 'browser' && !!run && (
                      <>
                        <div
                          style={{
                            display: 'flex',
                            gap: 8,
                            flexWrap: 'wrap',
                            marginBottom: 14,
                          }}
                        >
                          {browserRuns.map((r, i) => (
                            <button
                              key={r.runId}
                              onClick={() => {
                                setBrowserRunIdx(i);
                                setBrowserFrameIdx(
                                  Math.max(0, r.frames.length - 1),
                                );
                              }}
                              style={{
                                padding: '5px 10px',
                                borderRadius: 6,
                                cursor: 'pointer',
                                fontSize: 11,
                                fontFamily: CR.mono,
                                background:
                                  i === browserRunIdx
                                    ? CR.bgElevated
                                    : 'transparent',
                                border:
                                  '1px solid ' +
                                  (i === browserRunIdx ? CR.accent : CR.border),
                                color:
                                  i === browserRunIdx ? CR.cream : CR.muted,
                              }}
                            >
                              {new Date(r.updatedAt).toLocaleString()} -{' '}
                              {r.frames.length} steps
                            </button>
                          ))}
                        </div>

                        <div
                          style={{
                            border: '1px solid ' + CR.border,
                            borderRadius: 10,
                            overflow: 'hidden',
                            background: CR.bgElevated,
                          }}
                        >
                          <div
                            style={{
                              padding: '8px 10px 0',
                              display: 'flex',
                              alignItems: 'center',
                              gap: 8,
                            }}
                          >
                            <span
                              style={{
                                fontSize: 11,
                                color: CR.muted,
                                fontFamily: CR.mono,
                                flexShrink: 0,
                              }}
                            >
                              step {safeIdx + 1}/{frames.length}
                            </span>
                            <span
                              style={{
                                fontSize: 11,
                                color: CR.cream,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                              }}
                            >
                              {frame?.title || ''}
                            </span>
                            {frame?.action && (
                              <span
                                style={{
                                  fontSize: 10,
                                  fontFamily: CR.mono,
                                  color:
                                    frame.status === 'failed'
                                      ? '#e06c75'
                                      : CR.muted,
                                  border: '1px solid ' + CR.border,
                                  borderRadius: 4,
                                  padding: '1px 6px',
                                  flexShrink: 0,
                                }}
                              >
                                {frame.action}
                                {frame.status ? ' - ' + frame.status : ''}
                              </span>
                            )}
                          </div>
                          {/* Page-controlled text, so it renders as text - never an anchor. */}
                          <div
                            title={frame?.url || ''}
                            style={{
                              margin: '6px 10px 8px',
                              padding: '3px 8px',
                              borderRadius: 6,
                              background: CR.bgMain,
                              border: '1px solid ' + CR.border,
                              fontSize: 11,
                              color: CR.muted,
                              fontFamily: 'ui-monospace, monospace',
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                            }}
                          >
                            {frame?.url || '-'}
                          </div>
                          {frame && (
                            <img
                              src={
                                '/api/agents/' +
                                agentId +
                                '/workspace/file?raw=1&path=' +
                                encodeURIComponent(frame.file)
                              }
                              alt={
                                'Step ' + (safeIdx + 1) + ' of this browser run'
                              }
                              style={{
                                display: 'block',
                                width: '100%',
                                maxHeight: 520,
                                objectFit: 'contain',
                                background: '#000',
                              }}
                            />
                          )}
                          <div
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: 10,
                              padding: '10px',
                            }}
                          >
                            <button
                              onClick={() =>
                                setBrowserFrameIdx((i) => Math.max(0, i - 1))
                              }
                              disabled={safeIdx <= 0}
                              style={{
                                background: 'none',
                                border: '1px solid ' + CR.border,
                                borderRadius: 6,
                                color: CR.cream,
                                cursor: safeIdx <= 0 ? 'default' : 'pointer',
                                padding: '2px 9px',
                                opacity: safeIdx <= 0 ? 0.4 : 1,
                              }}
                            >
                              &larr;
                            </button>
                            <input
                              type="range"
                              min={0}
                              max={Math.max(0, frames.length - 1)}
                              value={safeIdx}
                              onChange={(e) =>
                                setBrowserFrameIdx(Number(e.target.value))
                              }
                              style={{ flex: 1, accentColor: agColor }}
                            />
                            <button
                              onClick={() =>
                                setBrowserFrameIdx((i) =>
                                  Math.min(frames.length - 1, i + 1),
                                )
                              }
                              disabled={safeIdx >= frames.length - 1}
                              style={{
                                background: 'none',
                                border: '1px solid ' + CR.border,
                                borderRadius: 6,
                                color: CR.cream,
                                cursor:
                                  safeIdx >= frames.length - 1
                                    ? 'default'
                                    : 'pointer',
                                padding: '2px 9px',
                                opacity: safeIdx >= frames.length - 1 ? 0.4 : 1,
                              }}
                            >
                              &rarr;
                            </button>
                          </div>
                        </div>
                      </>
                    )}
                  </div>
                );
              })()}

            {tab === 'artifacts' && agentId && (
              <>
                {/* Reuses the exact same content this drawer tab already renders in
                                chat (agentInspectExtraTabs) rather than keeping a second, slightly
                                different copy of this list — found 2026-09-22 as two near-duplicate
                                Artifacts UIs, one of which still used a standalone modal. */}
                {(
                  agentInspectExtraTabs.find((t) => t.id === 'artifacts')
                    ?.content as
                    | ((
                        openInDrawer: (file: {
                          filename: string;
                          content: string;
                          path?: string;
                          context?: string;
                          contextId?: string;
                        }) => void,
                      ) => React.ReactNode)
                    | undefined
                )?.((file) => setManageFilePreview(file))}
                {manageFilePreview && (
                  <UniversalDrawer
                    initialFile={manageFilePreview}
                    tabs={[]}
                    onClose={() => setManageFilePreview(null)}
                  />
                )}
              </>
            )}

            {/* SECRETS */}
            {tab === 'secrets' && agentId && (
              <AgentSecretsTab agentId={agentId} />
            )}

            {tab === 'channels' && agentId && (
              <AgentChannelsTab
                agentId={agentId}
                agentName={agent?.name || 'agent'}
              />
            )}

            {tab === 'webhooks' && agentId && (
              <AgentWebhooksTab agentId={agentId} />
            )}

            {tab === 'audit' && agentId && <AgentAuditTab agentId={agentId} />}

            {tab === 'history' && agentId && (
              <AgentHistoryTab agentId={agentId} />
            )}
          </div>
          {/* content pane */}
        </div>
        {/* flex row: Manage sidebar + content */}
      </div>

      {/* Create Handoff modal */}
      {showHandoffModal && agentId && agent && (
        <CreateHandoffModal
          fromAgentId={agentId}
          fromAgentName={agent.name}
          allAgents={allAgents.filter((a) => a.id !== agentId)}
          onClose={() => setShowHandoffModal(false)}
          onCreated={() => {
            setShowHandoffModal(false);
            loadHandoffs();
          }}
        />
      )}

      {/* Workspace upload inputs — top-level so they're mounted on any tab
                (the Files-tab + Add/+ Folder buttons trigger these). */}
      <input
        ref={wsFileInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        onChange={(e) => {
          uploadWorkspaceFiles(e.target.files);
          setShowAttachMenu(false);
        }}
      />
      <input
        ref={wsFolderInputRef}
        type="file"
        multiple
        style={{ display: 'none' }}
        {...({ webkitdirectory: '', directory: '' } as Record<string, string>)}
        onChange={(e) => {
          uploadWorkspaceFiles(e.target.files);
          setShowAttachMenu(false);
        }}
      />

      {/* Side drawer */}
      {jobDrawer && (
        <UniversalDrawer
          jobId={jobDrawer.jobId}
          title={jobDrawer.title}
          resultText={jobDrawer.resultText}
          isSuccess={jobDrawer.isSuccess}
          agentId={jobDrawer.agentId}
          initialFile={jobDrawer.initialFile}
          tabs={
            jobDrawer.agentId && !jobDrawer.initialFile
              ? ['output', 'files']
              : undefined
          }
          onClose={() => setJobDrawer(null)}
        />
      )}
      {wsDrawerOpen && agentId && (
        <UniversalDrawer
          agentId={agentId}
          tabs={['files']}
          /* phase 5.1: the agent's browser gets a home beside the workspace
                       files, so it can be opened on purpose rather than only caught in
                       passing while a run happens to be on screen. */
          refreshSignal={wsRefreshSignal}
          onClose={() => setWsDrawerOpen(false)}
        />
      )}
      {/* In the desktop app the browser is a real pane beside the dashboard, so
                opening this tab shows THAT rather than a drawer describing it. The hook
                does the showing; rendering the drawer as well would be two pictures of
                one browser. On the web nothing changes. */}
      {/* In the app the browser is a real pane, so the drawer is normally redundant
                — EXCEPT when the run is parked waiting for a human. Then the drawer is
                the only place the "I'm done" control lives, and hiding it left the agent
                waiting for a signal the user had no way to send (2026-09-06). So: no
                drawer in the app unless there is an ask. */}
      {(browserDrawerOpen || (inDesktopApp() && browserWaitingForThisAgent)) &&
        agentId &&
        (!inDesktopApp() || browserWaitingForThisAgent) && (
          <UniversalDrawer
            agentId={agentId}
            tabs={[]}
            extraTabs={[
              {
                id: 'browser',
                label: browserLiveForThisAgent ? 'Browser ●' : 'Browser',
                content: <AgentBrowserPanel agentId={agentId} />,
              },
            ]}
            initialTab="browser"
            onClose={() => setBrowserDrawerOpen(false)}
          />
        )}
      {agentInspectDrawer && agentId && (
        <UniversalDrawer
          key={`inspect-${agentInspectDrawer}`}
          tabs={[]}
          initialTab={agentInspectDrawer}
          extraTabs={agentInspectExtraTabs}
          onClose={() => setAgentInspectDrawer(null)}
        />
      )}
    </div>
  );
}

// ─── Agent Secrets Tab ────────────────────────────────────────────────────────

interface SecretSummary {
  name: string;
  masked: string;
  createdAt: string;
}

// ─── Channels tab (Stage 30 Phase 2) — per-agent WhatsApp reachability ─────────

interface AgentChannelsInfo {
  state: string;
  connected: boolean;
  number: string | null;
  dmEnabled: boolean;
}

interface BoundGroup {
  id: string;
  jid: string;
  name: string;
  enabled: boolean;
  triggerMode: 'mention' | 'all';
}

interface AgentChannelsInfo {
  state: string;
  connected: boolean;
  number: string | null;
  dmEnabled: boolean;
  dmTriggerMode: 'mention' | 'all';
  groups?: BoundGroup[];
}

function AgentChannelsTab({
  agentId,
  agentName,
}: {
  agentId: string;
  agentName: string;
}) {
  const isMobile = useIsMobile();
  const [wa, setWa] = useState<AgentChannelsInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');

  const [groupsList, setGroupsList] = useState<
    Array<{ jid: string; name: string }>
  >([]);
  const [fetchingGroups, setFetchingGroups] = useState(false);
  const [selectedGroupJid, setSelectedGroupJid] = useState('');

  const load = () =>
    fetch(`/api/agents/${agentId}/channels`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setWa(d?.whatsapp ?? null))
      .catch(() => {})
      .finally(() => setLoading(false));
  useEffect(() => {
    setLoading(true);
    load();
  }, [agentId]);

  const connected = !!wa?.connected;
  const on = !!wa?.dmEnabled;

  useEffect(() => {
    if (connected) {
      setFetchingGroups(true);
      fetch(`/api/agents/${agentId}/channels/whatsapp/groups`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setGroupsList)
        .catch(() => {})
        .finally(() => setFetchingGroups(false));
    } else {
      setGroupsList([]);
    }
  }, [agentId, connected]);

  async function toggleWa(
    enabled: boolean,
    triggerMode: 'mention' | 'all' = 'mention',
  ) {
    setSaving(true);
    setErr('');
    setWa((w) =>
      w ? { ...w, dmEnabled: enabled, dmTriggerMode: triggerMode } : w,
    ); // optimistic
    try {
      const res = await fetch(`/api/agents/${agentId}/channels/whatsapp`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled, triggerMode }),
      });
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Failed to save');
      }
    } catch (e: any) {
      setErr(e.message);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function addGroup() {
    if (!selectedGroupJid) return;
    setSaving(true);
    setErr('');
    try {
      const res = await fetch(
        `/api/agents/${agentId}/channels/whatsapp/groups`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ groupJid: selectedGroupJid }),
        },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Failed to add group');
      }
      setSelectedGroupJid('');
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggleGroup(
    groupJid: string,
    enabled: boolean,
    triggerMode?: 'mention' | 'all',
  ) {
    setSaving(true);
    setErr('');
    setWa((w) => {
      if (!w) return w;
      return {
        ...w,
        groups: (w.groups || []).map((g) =>
          g.jid === groupJid
            ? { ...g, enabled, triggerMode: triggerMode || g.triggerMode }
            : g,
        ),
      };
    });
    try {
      const res = await fetch(
        `/api/agents/${agentId}/channels/whatsapp/groups/${groupJid}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled, triggerMode }),
        },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Failed to toggle group');
      }
    } catch (e: any) {
      setErr(e.message);
      await load();
    } finally {
      setSaving(false);
    }
  }

  async function removeGroup(groupJid: string) {
    if (!confirm('Are you sure you want to remove this group binding?')) return;
    setSaving(true);
    setErr('');
    try {
      const res = await fetch(
        `/api/agents/${agentId}/channels/whatsapp/groups/${groupJid}`,
        {
          method: 'DELETE',
        },
      );
      if (!res.ok) {
        const d = await res.json().catch(() => ({}));
        throw new Error(d.error || 'Failed to remove group');
      }
      await load();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: isMobile ? '18px 16px' : '28px 40px' }}>
      <div style={{ marginBottom: 24 }}>
        <div
          style={{
            fontFamily: CR.serif,
            fontSize: 20,
            color: CR.cream,
            marginBottom: 6,
          }}
        >
          Channels
        </div>
        <div style={{ fontSize: 13, color: CR.sub, maxWidth: 560 }}>
          Where this agent is reachable outside the dashboard. Tag it with{' '}
          <code
            style={{
              background: 'var(--cr-tint-4)',
              padding: '1px 5px',
              borderRadius: 3,
              fontFamily: CR.mono,
              fontSize: 11,
            }}
          >
            @{agentName}
          </code>{' '}
          in a connected chat and it replies there.
        </div>
      </div>

      {loading ? (
        <div style={{ fontSize: 13, color: CR.muted }}>Loading…</div>
      ) : (
        <>
          {/* WhatsApp */}
          <div
            style={{
              borderRadius: 12,
              background: CR.bgSurf,
              border: `1px solid ${CR.border}`,
              padding: 20,
              marginBottom: 14,
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 16,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                <span
                  style={{
                    width: 38,
                    height: 38,
                    borderRadius: 10,
                    background: 'rgba(37,211,102,0.12)',
                    border: '1px solid rgba(37,211,102,0.30)',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 18,
                  }}
                >
                  💬
                </span>
                <div>
                  <div
                    style={{ fontSize: 14, fontWeight: 600, color: CR.cream }}
                  >
                    WhatsApp
                  </div>
                  <div
                    style={{
                      fontSize: 11.5,
                      color: connected ? 'var(--cr-brand-whatsapp)' : CR.muted,
                    }}
                  >
                    {connected
                      ? `Connected — ${wa?.number ?? ''}`
                      : 'Not connected'}
                  </div>
                </div>
              </div>
              {connected && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                  {on && (
                    <select
                      value={wa?.dmTriggerMode || 'mention'}
                      onChange={(e) =>
                        toggleWa(true, e.target.value as 'mention' | 'all')
                      }
                      disabled={saving}
                      style={{
                        height: 24,
                        borderRadius: 4,
                        background: CR.bgCard,
                        border: `1px solid ${CR.border}`,
                        color: CR.cream,
                        fontSize: 11.5,
                        padding: '0 4px',
                        outline: 'none',
                        cursor: 'pointer',
                      }}
                    >
                      <option value="mention">Mentions Only</option>
                      <option value="all">All Messages</option>
                    </select>
                  )}
                  <button
                    onClick={() =>
                      toggleWa(!on, wa?.dmTriggerMode || 'mention')
                    }
                    disabled={saving}
                    aria-label="Toggle WhatsApp"
                    style={{
                      width: 44,
                      height: 24,
                      borderRadius: 12,
                      border: 'none',
                      cursor: saving ? 'default' : 'pointer',
                      background: on ? 'var(--cr-brand-whatsapp)' : CR.border,
                      position: 'relative',
                      transition: 'background 0.18s',
                      flexShrink: 0,
                      opacity: saving ? 0.6 : 1,
                    }}
                  >
                    <span
                      style={{
                        position: 'absolute',
                        top: 3,
                        left: on ? 23 : 3,
                        width: 18,
                        height: 18,
                        borderRadius: '50%',
                        background: 'var(--cr-cream)',
                        transition: 'left 0.18s',
                      }}
                    />
                  </button>
                </div>
              )}
            </div>
            <div
              style={{
                marginTop: 14,
                fontSize: 12,
                color: CR.sub,
                lineHeight: 1.6,
              }}
            >
              {!connected ? (
                <>
                  Link your WhatsApp once in{' '}
                  <strong style={{ color: CR.cream }}>
                    Account → WhatsApp
                  </strong>
                  , then turn it on here for the agents you want reachable.
                </>
              ) : on ? (
                <>
                  Reachable in your personal WhatsApp chats — send{' '}
                  <code
                    style={{
                      background: 'var(--cr-tint-4)',
                      padding: '1px 5px',
                      borderRadius: 3,
                      fontFamily: CR.mono,
                      fontSize: 11,
                    }}
                  >
                    @{agentName} …
                  </code>{' '}
                  in a chat with yourself (or any 1:1) and this agent answers.
                  Group access is set per group below.
                </>
              ) : (
                <>Off — this agent won't respond to your WhatsApp messages.</>
              )}
            </div>

            {/* Groups Section */}
            {connected && (
              <div
                style={{
                  marginTop: 20,
                  paddingTop: 20,
                  borderTop: `1px solid ${CR.border}`,
                }}
              >
                <div
                  style={{
                    fontSize: 13,
                    fontWeight: 600,
                    color: CR.cream,
                    marginBottom: 12,
                  }}
                >
                  Group Bindings
                </div>

                {wa?.groups && wa.groups.length > 0 ? (
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 10,
                      marginBottom: 16,
                    }}
                  >
                    {wa.groups.map((g) => (
                      <div
                        key={g.jid}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'space-between',
                          padding: '10px 14px',
                          borderRadius: 8,
                          background: CR.bgCard,
                          border: `1px solid ${CR.border}`,
                        }}
                      >
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 10,
                          }}
                        >
                          <span style={{ fontSize: 16 }}>👥</span>
                          <div>
                            <div
                              style={{
                                fontSize: 12.5,
                                fontWeight: 600,
                                color: CR.cream,
                              }}
                            >
                              {g.name}
                            </div>
                            <div
                              style={{
                                fontSize: 10.5,
                                color: CR.muted,
                                fontFamily: CR.mono,
                              }}
                            >
                              {g.jid}
                            </div>
                          </div>
                        </div>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 12,
                          }}
                        >
                          {g.enabled && (
                            <select
                              value={g.triggerMode || 'mention'}
                              onChange={(e) =>
                                toggleGroup(
                                  g.jid,
                                  true,
                                  e.target.value as 'mention' | 'all',
                                )
                              }
                              disabled={saving}
                              style={{
                                height: 24,
                                borderRadius: 4,
                                background: CR.bgCard,
                                border: `1px solid ${CR.border}`,
                                color: CR.cream,
                                fontSize: 11.5,
                                padding: '0 4px',
                                outline: 'none',
                                cursor: 'pointer',
                              }}
                            >
                              <option value="mention">Mentions Only</option>
                              <option value="all">All Messages</option>
                            </select>
                          )}
                          <button
                            onClick={() => toggleGroup(g.jid, !g.enabled)}
                            disabled={saving}
                            aria-label={`Toggle group ${g.name}`}
                            style={{
                              width: 36,
                              height: 20,
                              borderRadius: 10,
                              border: 'none',
                              cursor: saving ? 'default' : 'pointer',
                              background: g.enabled
                                ? 'var(--cr-brand-whatsapp)'
                                : CR.border,
                              position: 'relative',
                              transition: 'background 0.18s',
                              opacity: saving ? 0.6 : 1,
                            }}
                          >
                            <span
                              style={{
                                position: 'absolute',
                                top: 2,
                                left: g.enabled ? 18 : 2,
                                width: 16,
                                height: 16,
                                borderRadius: '50%',
                                background: 'var(--cr-cream)',
                                transition: 'left 0.18s',
                              }}
                            />
                          </button>
                          <button
                            onClick={() => removeGroup(g.jid)}
                            disabled={saving}
                            aria-label={`Remove group ${g.name}`}
                            style={{
                              background: 'none',
                              border: 'none',
                              cursor: 'pointer',
                              fontSize: 14,
                              color: 'var(--cr-error-str)',
                              padding: 4,
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              opacity: saving ? 0.5 : 0.8,
                            }}
                          >
                            🗑️
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div
                    style={{ fontSize: 12, color: CR.muted, marginBottom: 16 }}
                  >
                    This agent is not bound to any WhatsApp groups.
                  </div>
                )}

                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                  {fetchingGroups ? (
                    <div style={{ fontSize: 12, color: CR.muted }}>
                      Fetching WhatsApp groups…
                    </div>
                  ) : groupsList.length > 0 ? (
                    <>
                      <select
                        value={selectedGroupJid}
                        onChange={(e) => setSelectedGroupJid(e.target.value)}
                        style={{
                          flex: 1,
                          height: 32,
                          borderRadius: 6,
                          background: CR.bgCard,
                          border: `1px solid ${CR.border}`,
                          color: CR.cream,
                          fontSize: 12.5,
                          padding: '0 8px',
                          outline: 'none',
                          cursor: 'pointer',
                        }}
                      >
                        <option value="">-- Select a group to add --</option>
                        {groupsList
                          .filter(
                            (g) =>
                              !(wa?.groups || []).some(
                                (bg) => bg.jid === g.jid,
                              ),
                          )
                          .map((g) => (
                            <option key={g.jid} value={g.jid}>
                              {g.name}
                            </option>
                          ))}
                      </select>
                      <button
                        onClick={addGroup}
                        disabled={saving || !selectedGroupJid}
                        style={{
                          height: 32,
                          padding: '0 14px',
                          borderRadius: 6,
                          background: selectedGroupJid
                            ? 'var(--cr-brand-whatsapp)'
                            : CR.border,
                          color: selectedGroupJid ? '#000' : CR.muted,
                          fontSize: 12.5,
                          fontWeight: 600,
                          border: 'none',
                          cursor:
                            saving || !selectedGroupJid ? 'default' : 'pointer',
                          opacity: saving || !selectedGroupJid ? 0.6 : 1,
                        }}
                      >
                        Add
                      </button>
                    </>
                  ) : (
                    <div style={{ fontSize: 12, color: CR.muted }}>
                      No WhatsApp groups found to bind.
                    </div>
                  )}
                </div>
              </div>
            )}

            {err && (
              <div
                style={{
                  marginTop: 10,
                  fontSize: 11.5,
                  color: 'var(--cr-error-str)',
                }}
              >
                {err}
              </div>
            )}
          </div>

          {/* Future channels */}
          <div style={{ display: 'flex', gap: 10 }}>
            {['Slack', 'Telegram', 'Email'].map((c) => (
              <div
                key={c}
                style={{
                  flex: 1,
                  borderRadius: 10,
                  background: CR.bgCard,
                  border: `1px dashed ${CR.border}`,
                  padding: '14px 10px',
                  opacity: 0.5,
                  fontSize: 12.5,
                  color: CR.muted,
                  textAlign: 'center',
                }}
              >
                {c}
                <div style={{ fontSize: 10, marginTop: 2 }}>coming soon</div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function AgentSecretsTab({ agentId }: { agentId: string }) {
  const isMobile = useIsMobile();
  const [secrets, setSecrets] = useState<SecretSummary[]>([]);
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState('');

  const load = () =>
    fetch(`/api/agents/${agentId}/secrets`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setSecrets)
      .catch(() => {});

  useEffect(() => {
    load();
  }, [agentId]);

  async function handleAdd() {
    setError('');
    if (!newName || !newValue) {
      setError('Both name and value are required.');
      return;
    }
    try {
      const res = await fetch(`/api/agents/${agentId}/secrets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: newName.toUpperCase().replace(/\s+/g, '_'),
          value: newValue,
        }),
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error);
      }
      setNewName('');
      setNewValue('');
      setAdding(false);
      load();
    } catch (e: any) {
      setError(e.message);
    }
  }

  async function handleDelete(name: string) {
    await fetch(`/api/agents/${agentId}/secrets/${name}`, { method: 'DELETE' });
    load();
  }

  return (
    <div style={{ padding: isMobile ? '18px 16px' : '28px 40px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          marginBottom: '24px',
          gap: '16px',
        }}
      >
        <div>
          <div
            style={{
              fontFamily: CR.serif,
              fontSize: 20,
              color: CR.cream,
              marginBottom: '6px',
            }}
          >
            Agent Secrets
          </div>
          <div style={{ fontSize: 13, color: CR.sub, maxWidth: 500 }}>
            API keys injected only into this agent's tools. Global secrets (from
            Settings → Key Vault) are also available. Values are encrypted at
            rest and never shown after saving.
          </div>
        </div>
        <button
          onClick={() => {
            setAdding((a) => !a);
            setError('');
          }}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '7px',
            padding: '9px 16px',
            borderRadius: '9px',
            background: CR.bgSurf,
            border: `1px solid ${CR.border}`,
            color: CR.sub,
            cursor: 'pointer',
            fontSize: '12px',
            fontWeight: 600,
            flexShrink: 0,
          }}
        >
          + Add
        </button>
      </div>

      {adding && (
        <div
          style={{
            padding: '18px',
            borderRadius: '10px',
            background: CR.bgSurf,
            border: `1px solid ${CR.border}`,
            marginBottom: '18px',
            display: 'flex',
            flexDirection: 'column',
            gap: '14px',
          }}
        >
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: '14px',
            }}
          >
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}
            >
              <label
                style={{ fontSize: '11px', fontWeight: 600, color: CR.muted }}
              >
                NAME
              </label>
              <input
                placeholder="MY_API_KEY"
                value={newName}
                onChange={(e) =>
                  setNewName(
                    e.target.value.toUpperCase().replace(/[^A-Z0-9_]/g, '_'),
                  )
                }
                style={{
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: CR.bgCard,
                  border: `1px solid ${CR.border}`,
                  color: CR.cream,
                  fontFamily: CR.mono,
                  fontSize: '13px',
                }}
              />
            </div>
            <div
              style={{ display: 'flex', flexDirection: 'column', gap: '7px' }}
            >
              <label
                style={{ fontSize: '11px', fontWeight: 600, color: CR.muted }}
              >
                VALUE
              </label>
              <input
                type="password"
                placeholder="sk-..."
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
                autoComplete="new-password"
                style={{
                  padding: '9px 12px',
                  borderRadius: '8px',
                  background: CR.bgCard,
                  border: `1px solid ${CR.border}`,
                  color: CR.cream,
                  fontFamily: CR.mono,
                  fontSize: '13px',
                }}
              />
            </div>
          </div>
          {error && (
            <div
              style={{
                fontSize: '12px',
                color: 'var(--cr-error-str)',
                fontFamily: CR.mono,
              }}
            >
              {error}
            </div>
          )}
          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={handleAdd}
              style={{
                padding: '8px 20px',
                borderRadius: '8px',
                background: CR.accent,
                color: 'white',
                border: 'none',
                cursor: 'pointer',
                fontSize: '12px',
                fontWeight: 600,
              }}
            >
              Save
            </button>
            <button
              onClick={() => {
                setAdding(false);
                setError('');
                setNewName('');
                setNewValue('');
              }}
              style={{
                padding: '8px 14px',
                borderRadius: '8px',
                background: 'none',
                border: `1px solid ${CR.border}`,
                color: CR.muted,
                cursor: 'pointer',
                fontSize: '12px',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {secrets.length === 0 ? (
        <div
          style={{
            padding: '28px',
            textAlign: 'center',
            border: `1px dashed ${CR.border}`,
            borderRadius: '10px',
            color: CR.muted,
            fontSize: '13px',
          }}
        >
          No agent-specific secrets. Add one above, or use global secrets from
          Settings.
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: '1px',
            background: CR.border,
            borderRadius: '10px',
            overflow: 'hidden',
            border: `1px solid ${CR.border}`,
          }}
        >
          {secrets.map((s) => (
            <div
              key={s.name}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '14px',
                padding: '12px 18px',
                background: CR.bgCard,
              }}
            >
              <span style={{ fontSize: '14px' }}>🔑</span>
              <span
                style={{
                  fontFamily: CR.mono,
                  fontSize: '13px',
                  color: CR.cream,
                  flex: 1,
                }}
              >
                {s.name}
              </span>
              <span
                style={{
                  fontFamily: CR.mono,
                  fontSize: '12px',
                  color: CR.muted,
                }}
              >
                {s.masked}
              </span>
              <span
                style={{ fontSize: '11px', color: CR.muted, flexShrink: 0 }}
              >
                {new Date(s.createdAt).toLocaleDateString()}
              </span>
              <button
                onClick={() => handleDelete(s.name)}
                style={{
                  padding: '4px 8px',
                  borderRadius: '6px',
                  background: 'transparent',
                  border: `1px solid ${CR.border}`,
                  color: 'var(--cr-error-str)',
                  cursor: 'pointer',
                  fontSize: '11px',
                }}
              >
                Delete
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Agent Webhooks Tab ─────────────────────────────────────────────────────
// Inbound-only: an external service (GitHub, Stripe, a form, ...) POSTs to this
// agent's webhook URL and it wakes up and runs a cycle on that payload. There is
// no outbound firing — nothing here calls out when the agent does something.

interface WebhookInfo {
  token: string | null;
  baseUrl: string | null;
  authModes: {
    query_param: string;
    hmac_header: string;
    stripe_header: string;
  } | null;
  examples: { generic: string; github: string; stripe: string } | null;
}

interface WebhookDelivery {
  id: string;
  agent_id: string;
  event: string;
  received_at: string;
  payload_preview: string;
  cycle_status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped';
}

const DELIVERY_STATUS_COLOR: Record<WebhookDelivery['cycle_status'], string> = {
  pending: 'var(--cr-amber)',
  running: 'var(--cr-blue)',
  completed: 'var(--cr-green)',
  failed: 'var(--cr-error-str)',
  skipped: 'var(--cr-muted)',
};

function AgentWebhooksTab({ agentId }: { agentId: string }) {
  const isMobile = useIsMobile();
  const [info, setInfo] = useState<WebhookInfo | null>(null);
  const [deliveries, setDeliveries] = useState<WebhookDelivery[]>([]);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = () => {
    fetch(`/api/webhooks/${agentId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then(setInfo)
      .catch(() => {});
    fetch(`/api/webhooks/${agentId}/deliveries`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setDeliveries)
      .catch(() => {});
  };
  useEffect(() => {
    load();
  }, [agentId]);

  // Auto-refresh the delivery log while any delivery is still in flight, so a
  // webhook fired from outside shows up here without the user re-opening the tab.
  useEffect(() => {
    if (
      !deliveries.some(
        (d) => d.cycle_status === 'pending' || d.cycle_status === 'running',
      )
    )
      return;
    const t = setInterval(() => {
      fetch(`/api/webhooks/${agentId}/deliveries`)
        .then((r) => (r.ok ? r.json() : []))
        .then(setDeliveries)
        .catch(() => {});
    }, 4000);
    return () => clearInterval(t);
  }, [agentId, deliveries]);

  async function generateToken() {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/webhooks/${agentId}/token`, {
        method: 'POST',
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error);
      }
      load();
    } catch (e: any) {
      setError(e.message ?? 'Failed to generate token');
    } finally {
      setBusy(false);
    }
  }

  async function revokeToken() {
    if (
      !confirm(
        'Revoke this webhook token? Any service still configured with it will stop working until you generate a new one.',
      )
    )
      return;
    setBusy(true);
    setError('');
    try {
      const res = await fetch(`/api/webhooks/${agentId}/token`, {
        method: 'DELETE',
      });
      if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error);
      }
      load();
    } catch (e: any) {
      setError(e.message ?? 'Failed to revoke token');
    } finally {
      setBusy(false);
    }
  }

  function copy(label: string, text: string) {
    navigator.clipboard.writeText(text);
    setCopied(label);
    setTimeout(() => setCopied(null), 1500);
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : '';
  const fullUrl = info?.baseUrl ? `${origin}${info.baseUrl}` : null;

  const row: React.CSSProperties = {
    padding: '18px',
    borderRadius: '10px',
    background: CR.bgSurf,
    border: `1px solid ${CR.border}`,
  };
  const mono: React.CSSProperties = {
    fontFamily: CR.mono,
    fontSize: 12,
    color: CR.cream,
    wordBreak: 'break-all',
  };
  const copyBtn = (label: string): React.CSSProperties => ({
    padding: '4px 10px',
    borderRadius: '6px',
    fontSize: 11,
    fontWeight: 600,
    cursor: 'pointer',
    flexShrink: 0,
    background: copied === label ? CR.greenLow : 'var(--cr-tint-3)',
    border: `1px solid ${copied === label ? 'var(--cr-green-line)' : CR.border}`,
    color: copied === label ? CR.green : CR.sub,
  });

  return (
    <div style={{ padding: isMobile ? '18px 16px' : '28px 40px' }}>
      <div style={{ marginBottom: '24px' }}>
        <div
          style={{
            fontFamily: CR.serif,
            fontSize: 20,
            color: CR.cream,
            marginBottom: '6px',
          }}
        >
          Webhooks
        </div>
        <div
          style={{
            fontSize: 13,
            color: CR.sub,
            maxWidth: 560,
            lineHeight: 1.6,
          }}
        >
          Inbound only — an external service (GitHub, Stripe, a form, Zapier,
          ...) POSTs to the URL below and this agent wakes up and runs a cycle
          on that payload. There's no outbound firing: nothing here calls out
          when the agent does something on its own.
        </div>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            fontSize: 12,
            color: 'var(--cr-error-str)',
            fontFamily: CR.mono,
          }}
        >
          {error}
        </div>
      )}

      {!info?.token ? (
        <div style={{ ...row, textAlign: 'center', padding: '32px 20px' }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>🪝</div>
          <div style={{ fontSize: 13, color: CR.sub, marginBottom: 16 }}>
            No webhook token yet — generate one to get a URL you can hand to
            GitHub, Stripe, or any other service.
          </div>
          <button
            onClick={generateToken}
            disabled={busy}
            style={{
              padding: '9px 20px',
              borderRadius: '8px',
              background: CR.accent,
              color: 'white',
              border: 'none',
              cursor: busy ? 'default' : 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              opacity: busy ? 0.6 : 1,
            }}
          >
            {busy ? 'Generating…' : '+ Generate webhook token'}
          </button>
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            gap: 14,
            marginBottom: 28,
          }}
        >
          <div style={row}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: CR.muted,
                marginBottom: 8,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Webhook URL
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ ...mono, flex: 1, minWidth: 0 }}>
                {fullUrl}/&lt;event_name&gt;
              </span>
              <button
                onClick={() => copy('url', `${fullUrl}/event_name`)}
                style={copyBtn('url')}
              >
                {copied === 'url' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            <div style={{ fontSize: 11, color: CR.muted, marginTop: 8 }}>
              Replace <code style={mono}>event_name</code> with whatever label
              you want in the delivery log (e.g.{' '}
              <code style={mono}>github_push</code>).
            </div>
          </div>

          <div style={row}>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: CR.muted,
                marginBottom: 8,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Token
            </div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 10,
                flexWrap: 'wrap',
              }}
            >
              <span style={{ ...mono, flex: 1, minWidth: 0 }}>
                {info.token}
              </span>
              <button
                onClick={() => copy('token', info.token!)}
                style={copyBtn('token')}
              >
                {copied === 'token' ? '✓ Copied' : 'Copy'}
              </button>
            </div>
            <div
              style={{
                fontSize: 11,
                color: CR.muted,
                marginTop: 8,
                lineHeight: 1.6,
              }}
            >
              Use as <code style={mono}>?token=</code> on the URL, or as the
              HMAC secret for a <code style={mono}>X-Hub-Signature-256</code>{' '}
              (GitHub) or <code style={mono}>Stripe-Signature</code> header.
            </div>
          </div>

          {info.examples && (
            <div style={row}>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: CR.muted,
                  marginBottom: 10,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Examples
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {Object.entries(info.examples).map(([k, v]) => (
                  <div key={k} style={{ fontSize: 11, color: CR.muted }}>
                    <span
                      style={{
                        textTransform: 'uppercase',
                        fontWeight: 700,
                        marginRight: 8,
                      }}
                    >
                      {k}
                    </span>
                    <span
                      style={{
                        fontFamily: CR.mono,
                        color: CR.sub,
                        wordBreak: 'break-all',
                      }}
                    >
                      {(v.startsWith('/') ? origin + v : v).replace(
                        info.token ?? '',
                        '••••',
                      )}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={generateToken}
              disabled={busy}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                background: 'var(--cr-tint-3)',
                border: `1px solid ${CR.border}`,
                color: CR.sub,
                cursor: busy ? 'default' : 'pointer',
                fontSize: '12px',
                fontWeight: 600,
                opacity: busy ? 0.6 : 1,
              }}
            >
              ↺ Rotate token
            </button>
            <button
              onClick={revokeToken}
              disabled={busy}
              style={{
                padding: '8px 16px',
                borderRadius: '8px',
                background: 'transparent',
                border: `1px solid ${CR.border}`,
                color: 'var(--cr-error-str)',
                cursor: busy ? 'default' : 'pointer',
                fontSize: '12px',
                fontWeight: 600,
                opacity: busy ? 0.6 : 1,
              }}
            >
              Revoke
            </button>
          </div>
        </div>
      )}

      <div>
        <div
          style={{
            fontFamily: CR.serif,
            fontSize: 16,
            color: CR.cream,
            marginBottom: 12,
          }}
        >
          Delivery log
        </div>
        {deliveries.length === 0 ? (
          <div
            style={{
              padding: '24px',
              textAlign: 'center',
              border: `1px dashed ${CR.border}`,
              borderRadius: '10px',
              color: CR.muted,
              fontSize: '13px',
            }}
          >
            No deliveries yet — once something POSTs to the webhook URL above,
            it'll show up here.
          </div>
        ) : (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: '1px',
              background: CR.border,
              borderRadius: '10px',
              overflow: 'hidden',
              border: `1px solid ${CR.border}`,
            }}
          >
            {deliveries.map((d) => (
              <div
                key={d.id}
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  padding: '12px 16px',
                  background: CR.bgCard,
                  flexWrap: isMobile ? 'wrap' : 'nowrap',
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    marginTop: 5,
                    flexShrink: 0,
                    background: DELIVERY_STATUS_COLOR[d.cycle_status],
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      marginBottom: 3,
                      flexWrap: 'wrap',
                    }}
                  >
                    <span
                      style={{
                        fontFamily: CR.mono,
                        fontSize: 12,
                        color: CR.cream,
                        fontWeight: 600,
                      }}
                    >
                      {d.event}
                    </span>
                    <span
                      style={{
                        fontFamily: CR.mono,
                        fontSize: 9,
                        textTransform: 'uppercase',
                        color: DELIVERY_STATUS_COLOR[d.cycle_status],
                        padding: '1px 6px',
                        borderRadius: 4,
                        background: `${withAlpha(DELIVERY_STATUS_COLOR[d.cycle_status], 9)}`,
                      }}
                    >
                      {d.cycle_status}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: CR.muted,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                    }}
                  >
                    {d.payload_preview}
                  </div>
                </div>
                <span
                  style={{
                    fontSize: 11,
                    color: CR.muted,
                    flexShrink: 0,
                    whiteSpace: 'nowrap',
                  }}
                >
                  {new Date(d.received_at).toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        )}
      </div>

      <div style={{ height: 1, background: CR.border, margin: '32px 0' }} />

      <OutboundWebhooksSection agentId={agentId} />
    </div>
  );
}

// ─── Outbound webhooks — subscribe an external URL to this agent's own events ─

interface OutboundWebhook {
  id: string;
  agent_id: string;
  url: string;
  secret: string; // masked except in the create response
  events: string[];
  enabled: boolean;
  created_at: string;
}

interface OutboundDelivery {
  id: string;
  webhook_id: string;
  event: string;
  sent_at: string;
  status: 'success' | 'failed';
  status_code: number | null;
  error: string | null;
}

const OUTBOUND_EVENTS = [
  'cycle_completed',
  'cycle_failed',
  'pipeline_fired',
  'agent_error',
  'budget_warning',
  'webhook_received',
  'subagent_done',
  'message_received',
  'agent_alert',
  'handoff_completed',
  'handoff_rejected',
  'handoff_updated',
  'usage_alert',
];

function OutboundWebhooksSection({ agentId }: { agentId: string }) {
  const isMobile = useIsMobile();
  const [hooks, setHooks] = useState<OutboundWebhook[]>([]);
  const [adding, setAdding] = useState(false);
  const [newUrl, setNewUrl] = useState('');
  const [newEvents, setNewEvents] = useState<string[]>(['*']);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [justCreatedSecret, setJustCreatedSecret] = useState<{
    id: string;
    secret: string;
  } | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [deliveries, setDeliveries] = useState<
    Record<string, OutboundDelivery[]>
  >({});
  const [copied, setCopied] = useState<string | null>(null);

  const load = () =>
    fetch(`/api/webhooks/${agentId}/outbound`)
      .then((r) => (r.ok ? r.json() : []))
      .then(setHooks)
      .catch(() => {});
  useEffect(() => {
    load();
  }, [agentId]);

  function toggleEvent(ev: string) {
    setNewEvents((prev) => {
      if (ev === '*') return prev.includes('*') ? [] : ['*'];
      const withoutAll = prev.filter((e) => e !== '*');
      return withoutAll.includes(ev)
        ? withoutAll.filter((e) => e !== ev)
        : [...withoutAll, ev];
    });
  }

  async function create() {
    setError('');
    setSaving(true);
    try {
      const res = await fetch(`/api/webhooks/${agentId}/outbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: newUrl.trim(),
          events: newEvents.length ? newEvents : ['*'],
        }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || 'Failed to create');
      setJustCreatedSecret({ id: d.id, secret: d.secret });
      setNewUrl('');
      setNewEvents(['*']);
      setAdding(false);
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  }

  async function toggle(h: OutboundWebhook) {
    await fetch(`/api/webhooks/${agentId}/outbound/${h.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !h.enabled }),
    });
    load();
  }

  async function remove(id: string) {
    if (
      !confirm(
        'Delete this outbound webhook? It will stop receiving events immediately.',
      )
    )
      return;
    await fetch(`/api/webhooks/${agentId}/outbound/${id}`, {
      method: 'DELETE',
    });
    load();
  }

  async function toggleExpand(id: string) {
    if (expanded === id) {
      setExpanded(null);
      return;
    }
    setExpanded(id);
    if (!deliveries[id]) {
      const res = await fetch(
        `/api/webhooks/${agentId}/outbound/${id}/deliveries?limit=10`,
      );
      const d = await res.json().catch(() => []);
      setDeliveries((prev) => ({ ...prev, [id]: d }));
    }
  }

  function copy(text: string) {
    navigator.clipboard.writeText(text);
    setCopied(text);
    setTimeout(() => setCopied(null), 1500);
  }

  const row: React.CSSProperties = {
    padding: '14px 16px',
    borderRadius: '10px',
    background: CR.bgSurf,
    border: `1px solid ${CR.border}`,
  };

  return (
    <div>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 16,
          flexWrap: isMobile ? 'wrap' : 'nowrap',
        }}
      >
        <div>
          <div
            style={{
              fontFamily: CR.serif,
              fontSize: 20,
              color: CR.cream,
              marginBottom: 6,
            }}
          >
            Outbound webhooks
          </div>
          <div
            style={{
              fontSize: 13,
              color: CR.sub,
              maxWidth: 560,
              lineHeight: 1.6,
            }}
          >
            The other direction — subscribe a URL to this agent's own events (a
            cycle finishing, failing, a sub-agent completing, ...) and it gets a
            signed POST every time one fires.
          </div>
        </div>
        <button
          onClick={() => {
            setAdding((a) => !a);
            setError('');
          }}
          style={{
            flexShrink: 0,
            padding: '9px 16px',
            borderRadius: 9,
            background: CR.bgSurf,
            border: `1px solid ${CR.border}`,
            color: CR.sub,
            cursor: 'pointer',
            fontSize: 12,
            fontWeight: 600,
          }}
        >
          + Add
        </button>
      </div>

      {justCreatedSecret && (
        <div
          style={{
            ...row,
            marginBottom: 14,
            borderColor: 'var(--cr-green-line)',
            background: CR.greenLow,
          }}
        >
          <div
            style={{
              fontSize: 12,
              color: CR.green,
              fontWeight: 600,
              marginBottom: 6,
            }}
          >
            ✓ Created — copy the signing secret now, it won't be shown again
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              flexWrap: 'wrap',
            }}
          >
            <span
              style={{
                fontFamily: CR.mono,
                fontSize: 12,
                color: CR.cream,
                flex: 1,
                minWidth: 0,
                wordBreak: 'break-all',
              }}
            >
              {justCreatedSecret.secret}
            </span>
            <button
              onClick={() => copy(justCreatedSecret.secret)}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                fontSize: 11,
                fontWeight: 600,
                cursor: 'pointer',
                background: 'var(--cr-tint-4)',
                border: `1px solid ${CR.border}`,
                color: CR.sub,
              }}
            >
              {copied === justCreatedSecret.secret ? '✓ Copied' : 'Copy'}
            </button>
            <button
              onClick={() => setJustCreatedSecret(null)}
              style={{
                padding: '4px 10px',
                borderRadius: 6,
                fontSize: 11,
                cursor: 'pointer',
                background: 'transparent',
                border: `1px solid ${CR.border}`,
                color: CR.muted,
              }}
            >
              Dismiss
            </button>
          </div>
          <div
            style={{
              fontSize: 11,
              color: CR.muted,
              marginTop: 8,
              lineHeight: 1.6,
            }}
          >
            Verify deliveries with the{' '}
            <code style={{ fontFamily: CR.mono }}>
              X-NanoCrew-Signature-256
            </code>{' '}
            header — same HMAC-SHA256-of-body scheme as GitHub's{' '}
            <code style={{ fontFamily: CR.mono }}>X-Hub-Signature-256</code>.
          </div>
        </div>
      )}

      {adding && (
        <div
          style={{
            ...row,
            marginBottom: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
          }}
        >
          <div>
            <label
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: CR.muted,
                display: 'block',
                marginBottom: 6,
              }}
            >
              URL
            </label>
            <input
              value={newUrl}
              onChange={(e) => setNewUrl(e.target.value)}
              placeholder="https://your-service.example.com/hooks/nanocrew"
              style={{
                width: '100%',
                padding: '9px 12px',
                borderRadius: 8,
                background: CR.bgCard,
                border: `1px solid ${CR.border}`,
                color: CR.cream,
                fontFamily: CR.mono,
                fontSize: 12.5,
                boxSizing: 'border-box',
              }}
            />
          </div>
          <div>
            <label
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: CR.muted,
                display: 'block',
                marginBottom: 8,
              }}
            >
              Events
            </label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              <button
                onClick={() => toggleEvent('*')}
                style={{
                  padding: '4px 12px',
                  borderRadius: 100,
                  fontSize: 11,
                  fontWeight: 600,
                  cursor: 'pointer',
                  background: newEvents.includes('*')
                    ? CR.accentLow
                    : 'transparent',
                  border: `1px solid ${newEvents.includes('*') ? CR.borderBright : CR.border}`,
                  color: newEvents.includes('*') ? CR.cream : CR.muted,
                }}
              >
                All events
              </button>
              {OUTBOUND_EVENTS.map((ev) => (
                <button
                  key={ev}
                  onClick={() => toggleEvent(ev)}
                  disabled={newEvents.includes('*')}
                  style={{
                    padding: '4px 12px',
                    borderRadius: 100,
                    fontSize: 11,
                    cursor: newEvents.includes('*') ? 'default' : 'pointer',
                    opacity: newEvents.includes('*') ? 0.4 : 1,
                    background: newEvents.includes(ev)
                      ? CR.accentLow
                      : 'transparent',
                    border: `1px solid ${newEvents.includes(ev) ? CR.borderBright : CR.border}`,
                    color: newEvents.includes(ev) ? CR.cream : CR.muted,
                  }}
                >
                  {ev}
                </button>
              ))}
            </div>
          </div>
          {error && (
            <div
              style={{
                fontSize: 12,
                color: 'var(--cr-error-str)',
                fontFamily: CR.mono,
              }}
            >
              {error}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10 }}>
            <button
              onClick={create}
              disabled={saving || !newUrl.trim()}
              style={{
                padding: '8px 18px',
                borderRadius: 8,
                background: CR.accent,
                color: 'white',
                border: 'none',
                cursor: saving ? 'default' : 'pointer',
                fontSize: 12,
                fontWeight: 600,
                opacity: saving || !newUrl.trim() ? 0.6 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button
              onClick={() => {
                setAdding(false);
                setError('');
              }}
              style={{
                padding: '8px 14px',
                borderRadius: 8,
                background: 'none',
                border: `1px solid ${CR.border}`,
                color: CR.muted,
                cursor: 'pointer',
                fontSize: 12,
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {hooks.length === 0 ? (
        <div
          style={{
            padding: '24px',
            textAlign: 'center',
            border: `1px dashed ${CR.border}`,
            borderRadius: 10,
            color: CR.muted,
            fontSize: 13,
          }}
        >
          No outbound webhooks yet — add one to have external services get
          notified when this agent does something.
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {hooks.map((h) => (
            <div key={h.id} style={row}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'flex-start',
                  gap: 12,
                  flexWrap: isMobile ? 'wrap' : 'nowrap',
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: '50%',
                    marginTop: 6,
                    flexShrink: 0,
                    background: h.enabled ? CR.green : CR.muted,
                  }}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div
                    style={{
                      fontFamily: CR.mono,
                      fontSize: 12.5,
                      color: CR.cream,
                      wordBreak: 'break-all',
                      marginBottom: 4,
                    }}
                  >
                    {h.url}
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5 }}>
                    {h.events.map((ev) => (
                      <span
                        key={ev}
                        style={{
                          fontFamily: CR.mono,
                          fontSize: 9,
                          padding: '1px 7px',
                          borderRadius: 4,
                          background: 'var(--cr-tint-3)',
                          color: CR.muted,
                        }}
                      >
                        {ev === '*' ? 'all events' : ev}
                      </span>
                    ))}
                  </div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button
                    onClick={() => toggleExpand(h.id)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      fontSize: 11,
                      cursor: 'pointer',
                      background:
                        expanded === h.id ? CR.accentLow : 'transparent',
                      border: `1px solid ${CR.border}`,
                      color: CR.sub,
                    }}
                  >
                    {expanded === h.id ? 'Hide log' : 'Log'}
                  </button>
                  <button
                    onClick={() => toggle(h)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      fontSize: 11,
                      cursor: 'pointer',
                      background: 'transparent',
                      border: `1px solid ${CR.border}`,
                      color: h.enabled ? 'var(--cr-amber)' : CR.green,
                    }}
                  >
                    {h.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    onClick={() => remove(h.id)}
                    style={{
                      padding: '4px 10px',
                      borderRadius: 6,
                      fontSize: 11,
                      cursor: 'pointer',
                      background: 'transparent',
                      border: `1px solid ${CR.border}`,
                      color: 'var(--cr-error-str)',
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
              {expanded === h.id && (
                <div
                  style={{
                    marginTop: 12,
                    paddingTop: 12,
                    borderTop: `1px solid ${CR.border}`,
                  }}
                >
                  {!deliveries[h.id] ? (
                    <div style={{ fontSize: 11, color: CR.muted }}>
                      Loading…
                    </div>
                  ) : deliveries[h.id].length === 0 ? (
                    <div style={{ fontSize: 11, color: CR.muted }}>
                      No deliveries yet.
                    </div>
                  ) : (
                    <div
                      style={{
                        display: 'flex',
                        flexDirection: 'column',
                        gap: 6,
                      }}
                    >
                      {deliveries[h.id].map((d) => (
                        <div
                          key={d.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            fontSize: 11,
                            flexWrap: 'wrap',
                          }}
                        >
                          <span
                            style={{
                              width: 6,
                              height: 6,
                              borderRadius: '50%',
                              flexShrink: 0,
                              background:
                                d.status === 'success'
                                  ? CR.green
                                  : 'var(--cr-error-str)',
                            }}
                          />
                          <span
                            style={{ fontFamily: CR.mono, color: CR.cream }}
                          >
                            {d.event}
                          </span>
                          <span style={{ color: CR.muted }}>
                            {d.status === 'success'
                              ? `HTTP ${d.status_code}`
                              : d.error}
                          </span>
                          <span
                            style={{
                              marginLeft: 'auto',
                              color: CR.muted,
                              flexShrink: 0,
                            }}
                          >
                            {new Date(d.sent_at).toLocaleString()}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Agent Audit Tab ────────────────────────────────────────────────────────
// "Does this agent actually have what it was promised?" — surfaces AgentService
// .auditAgent() so a user can self-check without needing to spelunk through raw
// APIs (which is exactly what it took to find the KAIROS Research Agent bug).

interface AgentAuditResult {
  agentId: string;
  agentName: string;
  checkedAt: string;
  passed: boolean;
  checks: {
    pinnedFiles: Array<{ path: string; exists: boolean }>;
    workspaceDirs: Array<{ name: string; exists: boolean }>;
    missingCredentials: string[];
    unknownTools: string[];
    scheduleOk: boolean;
  };
}

/**
 * AgentHistoryTab — everything that has changed about this agent, and a way to put it back.
 *
 * The surface for stage 54 phase 1. Distinct from the "Audit" tab next to it, which is a
 * readiness check (do the pins resolve, are the credentials present); this one is the
 * record of what moved, who moved it, and why.
 *
 * The design goal is that a total loss is obvious WITHOUT opening anything — the row for
 * the 2026-08-28 prompt deletion should read "identity · −4,731 bytes" in red and stop the
 * eye. That failure went unnoticed for eleven days because nothing rendered it.
 */
interface ConfigHistoryEntry {
  id: string;
  capability: string;
  actor: 'agent' | 'owner' | 'admin' | 'system';
  cycleId: string | null;
  reason: string | null;
  before: unknown;
  after: unknown;
  revertedBy: string | null;
  createdAt: string;
}

const CAP_COLOUR: Record<string, string> = {
  identity: CR.purple,
  status: CR.amber,
  budget: CR.green,
  model: CR.blue,
  schedule: CR.accent,
  one_off: CR.sub,
};

const ACTOR_LABEL: Record<string, string> = {
  agent: 'the agent itself',
  owner: 'you',
  admin: 'an admin',
  system: 'the platform',
};

/** Bytes of JSON either side, so a shrink is visible without opening the diff. */
function sizeDelta(before: unknown, after: unknown): number {
  return (
    JSON.stringify(after ?? null).length - JSON.stringify(before ?? null).length
  );
}

function AgentHistoryTab({ agentId }: { agentId: string }) {
  const [entries, setEntries] = useState<ConfigHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [reverting, setReverting] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    setError('');
    fetch(`/api/agents/${agentId}/config-history`)
      .then((r) =>
        r.ok
          ? r.json()
          : r
              .json()
              .then((d) =>
                Promise.reject(new Error(d.error || 'Failed to load history')),
              ),
      )
      .then((d) => setEntries(d.entries || []))
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    load();
  }, [agentId]);

  async function revert(entry: ConfigHistoryEntry) {
    const what = `${entry.capability} change from ${new Date(entry.createdAt).toLocaleString()}`;
    if (
      !confirm(
        `Put back the state from before this ${what}?\n\nThe current values are kept in the history, so this is reversible too.`,
      )
    )
      return;
    setReverting(entry.id);
    try {
      const r = await fetch(
        `/api/agents/${agentId}/config-history/${entry.id}/revert`,
        { method: 'POST' },
      );
      if (!r.ok) throw new Error((await r.json()).error || 'Revert failed');
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setReverting(null);
    }
  }

  if (loading)
    return (
      <div
        style={{
          padding: 20,
          color: CR.sub,
          fontFamily: CR.mono,
          fontSize: 13,
        }}
      >
        Loading history…
      </div>
    );

  return (
    <div style={{ padding: '4px 0' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 10,
          marginBottom: 12,
        }}
      >
        <h3
          style={{
            margin: 0,
            fontSize: 14,
            color: CR.cream,
            fontFamily: CR.mono,
          }}
        >
          Change history
        </h3>
        <span style={{ fontSize: 11, color: CR.muted, fontFamily: CR.mono }}>
          {entries.length} recorded change{entries.length === 1 ? '' : 's'}
        </span>
        <button
          onClick={load}
          style={{
            marginLeft: 'auto',
            padding: '4px 10px',
            borderRadius: 6,
            cursor: 'pointer',
            border: `1px solid ${CR.border}`,
            background: 'transparent',
            color: CR.sub,
            fontFamily: CR.mono,
            fontSize: 11,
          }}
        >
          Refresh
        </button>
      </div>

      {error && (
        <div
          style={{
            padding: '8px 12px',
            marginBottom: 10,
            borderRadius: 6,
            background: CR.redLow,
            border: `1px solid ${CR.redLine}`,
            color: CR.red,
            fontFamily: CR.mono,
            fontSize: 12,
          }}
        >
          {error}
        </div>
      )}

      {entries.length === 0 && (
        <div
          style={{
            padding: 20,
            color: CR.muted,
            fontFamily: CR.mono,
            fontSize: 12,
            lineHeight: 1.6,
          }}
        >
          Nothing recorded yet. Every change to this agent's schedule, model,
          budget, status or identity will appear here — whether the agent made
          it or you did.
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
        {entries.map((e) => {
          const delta = sizeDelta(e.before, e.after);
          const shrank = delta < -200;
          const colour = CAP_COLOUR[e.capability] || CR.sub;
          const isOpen = open === e.id;
          return (
            <div
              key={e.id}
              style={{
                borderRadius: 8,
                background: CR.bgCard,
                border: `1px solid ${e.revertedBy ? CR.border : CR.borderSub}`,
                opacity: e.revertedBy ? 0.6 : 1,
              }}
            >
              <div
                onClick={() => setOpen(isOpen ? null : e.id)}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 12px',
                  cursor: 'pointer',
                  flexWrap: 'wrap',
                }}
              >
                <span
                  style={{
                    fontFamily: CR.mono,
                    fontSize: 11,
                    fontWeight: 600,
                    color: colour,
                    minWidth: 74,
                  }}
                >
                  {e.capability}
                </span>
                <span
                  style={{ fontFamily: CR.mono, fontSize: 11, color: CR.muted }}
                >
                  {ACTOR_LABEL[e.actor] || e.actor}
                </span>
                {shrank && (
                  <span
                    title="This change removed a lot of content"
                    style={{
                      fontFamily: CR.mono,
                      fontSize: 11,
                      color: CR.red,
                      fontWeight: 600,
                    }}
                  >
                    −{Math.abs(delta).toLocaleString()} bytes
                  </span>
                )}
                <span
                  style={{
                    flex: 1,
                    minWidth: 120,
                    fontFamily: CR.mono,
                    fontSize: 11,
                    color: CR.sub,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {e.reason || (
                    <em style={{ color: CR.muted }}>no reason given</em>
                  )}
                </span>
                {e.revertedBy && (
                  <span
                    style={{
                      fontFamily: CR.mono,
                      fontSize: 10,
                      color: CR.muted,
                      border: `1px solid ${CR.border}`,
                      borderRadius: 4,
                      padding: '1px 5px',
                    }}
                  >
                    reverted
                  </span>
                )}
                <span
                  style={{ fontFamily: CR.mono, fontSize: 10, color: CR.muted }}
                >
                  {new Date(e.createdAt).toLocaleString()}
                </span>
              </div>

              {isOpen && (
                <div
                  style={{
                    padding: '0 12px 12px',
                    borderTop: `1px solid ${CR.borderSub}`,
                  }}
                >
                  {e.cycleId && (
                    <div
                      style={{
                        fontFamily: CR.mono,
                        fontSize: 10,
                        color: CR.muted,
                        margin: '8px 0',
                      }}
                    >
                      cycle {e.cycleId.slice(0, 8)}
                    </div>
                  )}
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {(['before', 'after'] as const).map((side) => (
                      <div
                        key={side}
                        style={{ flex: '1 1 240px', minWidth: 0 }}
                      >
                        <div
                          style={{
                            fontFamily: CR.mono,
                            fontSize: 10,
                            color: CR.muted,
                            marginBottom: 4,
                          }}
                        >
                          {side}
                        </div>
                        <pre
                          style={{
                            margin: 0,
                            padding: 8,
                            borderRadius: 6,
                            background: CR.bgSurf,
                            color: side === 'before' ? CR.sub : CR.cream,
                            fontFamily: CR.mono,
                            fontSize: 11,
                            maxHeight: 260,
                            overflow: 'auto',
                            whiteSpace: 'pre-wrap',
                            wordBreak: 'break-word',
                          }}
                        >
                          {JSON.stringify(
                            side === 'before' ? e.before : e.after,
                            null,
                            2,
                          )}
                        </pre>
                      </div>
                    ))}
                  </div>
                  {!e.revertedBy && (
                    <button
                      onClick={() => revert(e)}
                      disabled={reverting === e.id}
                      style={{
                        marginTop: 10,
                        padding: '5px 12px',
                        borderRadius: 6,
                        cursor: reverting === e.id ? 'default' : 'pointer',
                        border: `1px solid ${CR.border}`,
                        background: 'transparent',
                        color: CR.amber,
                        fontFamily: CR.mono,
                        fontSize: 11,
                      }}
                    >
                      {reverting === e.id ? 'Reverting…' : 'Revert to “before”'}
                    </button>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function AgentAuditTab({ agentId }: { agentId: string }) {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [result, setResult] = useState<AgentAuditResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const run = () => {
    setLoading(true);
    setError('');
    fetch(`/api/agents/${agentId}/audit`)
      .then((r) =>
        r.ok
          ? r.json()
          : r
              .json()
              .then((d) =>
                Promise.reject(new Error(d.error || 'Audit failed')),
              ),
      )
      .then(setResult)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  };
  useEffect(() => {
    run();
  }, [agentId]);

  const row: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '10px 14px',
    background: CR.bgCard,
    borderRadius: 8,
  };
  const CheckRow = ({
    ok,
    label,
    action,
  }: {
    ok: boolean;
    label: string;
    action?: React.ReactNode;
  }) => (
    <div style={row}>
      <span style={{ fontSize: 14, flexShrink: 0 }}>{ok ? '✅' : '❌'}</span>
      <span
        style={{
          flex: 1,
          fontSize: 13,
          color: ok ? CR.sub : CR.cream,
          fontFamily: CR.mono,
        }}
      >
        {label}
      </span>
      {action}
    </div>
  );

  return (
    <div style={{ padding: isMobile ? '18px 16px' : '28px 40px' }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: 16,
          marginBottom: 20,
          flexWrap: isMobile ? 'wrap' : 'nowrap',
        }}
      >
        <div>
          <div
            style={{
              fontFamily: CR.serif,
              fontSize: 20,
              color: CR.cream,
              marginBottom: 6,
            }}
          >
            Agent Audit
          </div>
          <div
            style={{
              fontSize: 13,
              color: CR.sub,
              maxWidth: 560,
              lineHeight: 1.6,
            }}
          >
            Checks whether every file this agent was promised (pinned
            "must-read" files, dedicated workspace folders), every tool it was
            given, and every credential those tools need actually exist right
            now — not just at creation time.
          </div>
        </div>
        <button
          onClick={run}
          disabled={loading}
          style={{
            flexShrink: 0,
            padding: '9px 16px',
            borderRadius: 9,
            background: CR.bgSurf,
            border: `1px solid ${CR.border}`,
            color: CR.sub,
            cursor: loading ? 'default' : 'pointer',
            fontSize: 12,
            fontWeight: 600,
            opacity: loading ? 0.6 : 1,
          }}
        >
          {loading ? 'Checking…' : '↺ Re-run'}
        </button>
      </div>

      {error && (
        <div
          style={{
            marginBottom: 14,
            fontSize: 12,
            color: 'var(--cr-error-str)',
            fontFamily: CR.mono,
          }}
        >
          {error}
        </div>
      )}

      {result && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div
            style={{
              padding: '14px 18px',
              borderRadius: 10,
              background: result.passed ? CR.greenLow : 'var(--cr-error-low)',
              border: `1px solid ${result.passed ? 'var(--cr-green-line)' : 'var(--cr-error-line)'}`,
              display: 'flex',
              alignItems: 'center',
              gap: 10,
            }}
          >
            <span style={{ fontSize: 18 }}>{result.passed ? '✅' : '⚠️'}</span>
            <span
              style={{
                fontSize: 14,
                fontWeight: 600,
                color: result.passed ? CR.green : 'var(--cr-error)',
              }}
            >
              {result.passed
                ? 'All checks passed'
                : 'Some checks failed — see below'}
            </span>
            <span style={{ marginLeft: 'auto', fontSize: 11, color: CR.muted }}>
              {new Date(result.checkedAt).toLocaleString()}
            </span>
          </div>

          {result.checks.pinnedFiles.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: CR.muted,
                  marginBottom: 8,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Pinned must-read files ({result.checks.pinnedFiles.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {result.checks.pinnedFiles.map((f) => (
                  <CheckRow
                    key={f.path}
                    ok={f.exists}
                    label={f.path + (f.exists ? '' : '  — missing')}
                  />
                ))}
              </div>
            </div>
          )}

          {result.checks.workspaceDirs.length > 0 && (
            <div>
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 600,
                  color: CR.muted,
                  marginBottom: 8,
                  textTransform: 'uppercase',
                  letterSpacing: '0.06em',
                }}
              >
                Dedicated workspace folders (
                {result.checks.workspaceDirs.length})
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {result.checks.workspaceDirs.map((d) => (
                  <CheckRow
                    key={d.name}
                    ok={d.exists}
                    label={d.name + (d.exists ? '' : '  — missing')}
                  />
                ))}
              </div>
            </div>
          )}

          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: CR.muted,
                marginBottom: 8,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Credentials
            </div>
            {result.checks.missingCredentials.length === 0 ? (
              <CheckRow
                ok={true}
                label="All required credentials are connected"
              />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {result.checks.missingCredentials.map((svc) => (
                  <CheckRow
                    key={svc}
                    ok={false}
                    label={`${svc} — not connected`}
                    action={
                      <button
                        onClick={() => navigate('/account')}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 6,
                          fontSize: 11,
                          fontWeight: 600,
                          cursor: 'pointer',
                          background: 'var(--cr-tint-3)',
                          border: `1px solid ${CR.border}`,
                          color: CR.sub,
                          flexShrink: 0,
                        }}
                      >
                        Connect →
                      </button>
                    }
                  />
                ))}
              </div>
            )}
          </div>

          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: CR.muted,
                marginBottom: 8,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Tools
            </div>
            {result.checks.unknownTools.length === 0 ? (
              <CheckRow ok={true} label="Every assigned tool is recognized" />
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                {result.checks.unknownTools.map((t) => (
                  <CheckRow
                    key={t}
                    ok={false}
                    label={`${t} — not a recognized tool name (possible typo)`}
                  />
                ))}
              </div>
            )}
          </div>

          <div>
            <div
              style={{
                fontSize: 11,
                fontWeight: 600,
                color: CR.muted,
                marginBottom: 8,
                textTransform: 'uppercase',
                letterSpacing: '0.06em',
              }}
            >
              Schedule
            </div>
            <CheckRow
              ok={result.checks.scheduleOk}
              label={
                result.checks.scheduleOk
                  ? 'Trigger mode and schedule are consistent'
                  : 'Set to "scheduled" but has no enabled interval — it will never run on its own'
              }
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Seed Files Preview (inline in the create_agent approval card) ───────────
// Lazily fetches the REAL content of each file a request_approval payload proposes
// to seed into the new agent, from the calling agent's own workspace (files aren't
// copied anywhere until approval) — so the user reviews the actual document, not
// just whatever the proposing agent said about it in report_md.

function SeedFilesPreview({
  agentId,
  seedFiles,
}: {
  agentId: string;
  seedFiles: unknown[];
}) {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [content, setContent] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState<string | null>(null);

  const paths = seedFiles
    .map((e) =>
      typeof e === 'string'
        ? e
        : ((e as any)?.source_path ?? (e as any)?.sourcePath ?? ''),
    )
    .filter(Boolean);

  async function toggle(p: string) {
    if (expanded === p) {
      setExpanded(null);
      return;
    }
    setExpanded(p);
    if (content[p] !== undefined) return;
    setLoading(p);
    try {
      const fullPath = p.startsWith('workspace/') ? p : `workspace/${p}`;
      const res = await fetch(
        `/api/agents/${agentId}/workspace/file?path=${encodeURIComponent(fullPath)}`,
      );
      const d = await res.json();
      setContent((prev) => ({
        ...prev,
        [p]:
          typeof d.content === 'string'
            ? d.content
            : (d.error ?? '(could not load — file may not exist yet)'),
      }));
    } catch {
      setContent((prev) => ({ ...prev, [p]: '(failed to load)' }));
    } finally {
      setLoading(null);
    }
  }

  if (paths.length === 0) return null;

  return (
    <div style={{ marginBottom: 10 }}>
      <div
        style={{
          fontFamily: CR.sans,
          fontSize: 10.5,
          color: CR.muted,
          marginBottom: 5,
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        Will seed {paths.length} file{paths.length !== 1 ? 's' : ''} into the
        new agent — preview before approving
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {paths.map((p) => (
          <div
            key={p}
            style={{
              border: `1px solid ${CR.border}`,
              borderRadius: 7,
              overflow: 'hidden',
            }}
          >
            <button
              onClick={() => toggle(p)}
              style={{
                width: '100%',
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 10px',
                background: CR.bgSurf,
                border: 'none',
                color: CR.sub,
                fontFamily: CR.mono,
                fontSize: 11,
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span
                style={{
                  transform: expanded === p ? 'rotate(90deg)' : 'none',
                  transition: 'transform 0.15s',
                  display: 'inline-block',
                }}
              >
                ▸
              </span>
              <span
                style={{
                  flex: 1,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                }}
              >
                {p}
              </span>
              <span style={{ color: CR.muted, flexShrink: 0 }}>
                {loading === p
                  ? 'loading…'
                  : expanded === p
                    ? 'hide'
                    : 'preview'}
              </span>
            </button>
            {expanded === p && (
              <pre
                style={{
                  margin: 0,
                  padding: '10px 12px',
                  maxHeight: 260,
                  overflowY: 'auto',
                  fontSize: 11,
                  fontFamily: CR.mono,
                  color: CR.text,
                  whiteSpace: 'pre-wrap',
                  background: CR.bgCard,
                  borderTop: `1px solid ${CR.border}`,
                }}
              >
                {content[p] ?? ''}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
