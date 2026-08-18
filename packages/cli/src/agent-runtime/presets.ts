/**
 * Presets for local coding agents that run on a *subscription* rather than an
 * API key.
 *
 * This is the integration path that matters for most people: Claude Code,
 * Codex and Gemini CLI all authenticate the same way their IDE extension does,
 * so a developer who pays for one already has everything needed to put that
 * assistant into an AgentMesh session. No API key, no separate billing.
 *
 * The IDE extension itself cannot be driven from outside - it exposes no local
 * API - but the command-line tool of the same product shares its login.
 */
export interface AgentPreset {
  id: string;
  label: string;
  /** Executable to run. Resolved against PATH, including Windows shims. */
  command: string;
  /** Arguments for a fresh conversation. `{prompt}` and `{session}` substitute. */
  args: string[];
  /**
   * Arguments for follow-up turns, when the tool can resume its own
   * conversation. Omitted means every turn starts from scratch and the full
   * session brief is re-sent.
   */
  continueArgs?: string[];
  /** Where the prompt goes. stdin avoids argv length and quoting limits. */
  promptVia: 'stdin' | 'arg';
  defaultProvider: string;
  defaultModel: string;
  /** Shown by `agentmesh agent presets`. */
  notes: string;
}

const CLAUDE: AgentPreset = {
  id: 'claude',
  label: 'Claude Code',
  command: 'claude',
  // --print is the documented non-interactive mode. --session-id pins one
  // conversation so the agent remembers earlier turns of this AgentMesh
  // session instead of waking up amnesiac on every mention.
  args: ['--print', '--output-format', 'text', '--session-id', '{session}'],
  continueArgs: ['--print', '--output-format', 'text', '--resume', '{session}'],
  promptVia: 'stdin',
  defaultProvider: 'anthropic',
  defaultModel: 'claude-code',
  notes: 'Uses your Claude subscription, the same login as the VS Code extension.',
};

const CODEX: AgentPreset = {
  id: 'codex',
  label: 'OpenAI Codex CLI',
  command: 'codex',
  args: ['exec', '{prompt}'],
  promptVia: 'arg',
  defaultProvider: 'openai',
  defaultModel: 'codex',
  notes: 'Uses a ChatGPT subscription via "Sign in with ChatGPT". Verify the flags for your version with: codex --help',
};

const GEMINI: AgentPreset = {
  id: 'gemini',
  label: 'Gemini CLI',
  command: 'gemini',
  args: ['--prompt', '{prompt}'],
  promptVia: 'arg',
  defaultProvider: 'google',
  defaultModel: 'gemini',
  notes: 'Uses a Google account login. Verify the flags for your version with: gemini --help',
};

const CUSTOM: AgentPreset = {
  id: 'custom',
  label: 'Any other command',
  command: '',
  args: ['{prompt}'],
  promptVia: 'arg',
  defaultProvider: 'custom',
  defaultModel: 'unknown',
  notes: 'Supply --command and --args yourself. Anything that reads a prompt and writes an answer works.',
};

export const PRESETS: Record<string, AgentPreset> = {
  claude: CLAUDE,
  codex: CODEX,
  gemini: GEMINI,
  custom: CUSTOM,
};

export function getPreset(id: string): AgentPreset {
  const preset = PRESETS[id];
  if (!preset) {
    throw new Error(`Unknown preset "${id}". Available: ${Object.keys(PRESETS).join(', ')}`);
  }
  return preset;
}

/** Replace `{prompt}` and `{session}` placeholders in an argument list. */
export function substitute(args: string[], values: { prompt: string; session: string }): string[] {
  return args.map((arg) => arg.replace('{prompt}', values.prompt).replace('{session}', values.session));
}
