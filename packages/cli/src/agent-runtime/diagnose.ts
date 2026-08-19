/**
 * Turn a tool's failure output into something the operator can act on.
 *
 * "exit 1" plus a wall of stderr is technically complete and practically
 * useless: someone still has to recognise the message and know what it implies.
 * These are the failures that actually happen when wiring a coding CLI into a
 * session, each with the one sentence that resolves it.
 *
 * Deliberately conservative - an unrecognised failure returns nothing rather
 * than a confident guess, because a wrong hint costs more time than no hint.
 */
interface KnownFailure {
  match: RegExp;
  hint: string;
}

const KNOWN: KnownFailure[] = [
  {
    // Codex refuses to touch a directory that is not a git repository.
    match: /not inside a trusted directory|--skip-git-repo-check|not a git repository/i,
    hint:
      'The tool will not run outside a git repository. Point --workspace at a repo, ' +
      'or allow it explicitly, e.g. `-- codex exec --skip-git-repo-check "{prompt}"`.',
  },
  {
    match: /not logged in|please (run )?login|sign in|authenticat\w* (failed|required)|unauthorized/i,
    hint: 'The tool is not signed in. Run it once by hand in a terminal and complete its login, then restart the agent.',
  },
  {
    match: /rate limit|quota|usage limit|too many requests|429/i,
    hint: 'The provider is rate-limiting or the plan quota is spent. Waiting is the only fix; the agent will work again afterwards.',
  },
  {
    match: /trust|permission denied|EACCES/i,
    hint: 'The tool is asking for permission it cannot ask for without a terminal. Run it once interactively in this workspace and accept the prompt.',
  },
  {
    match: /ENOENT|command not found|is not recognized as/i,
    hint: 'The executable was not found. Check the name with `agentmesh agent presets`, or pass a full path with --command.',
  },
  {
    match: /unknown (option|argument|flag)|unrecognized (option|argument)|invalid (option|argument)/i,
    hint: 'The flags do not match this version of the tool. Check `--help` and override them: `agentmesh agent run "<name>" -- <command> <flags> "{prompt}"`.',
  },
];

/** A single actionable sentence, or null when the failure is not recognised. */
export function diagnose(output: string): string | null {
  const text = output.slice(0, 4000);
  return KNOWN.find((failure) => failure.match.test(text))?.hint ?? null;
}
