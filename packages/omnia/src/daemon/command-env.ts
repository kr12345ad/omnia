const forbiddenKeys = new Set([
  "PATH",
  "DISPLAY",
  "BASH_ENV",
  "ENV",
  "SHELLOPTS",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "RUBYOPT",
  "RUBYLIB",
  "PERL5OPT",
  "PERL5LIB",
])

// This guards request-supplied startup overrides, not execution itself:
// user-approved commands still execute user code with the host's privileges.
export function commandEnvError(env: Readonly<Record<string, string>> | undefined): string | undefined {
  for (const [key, value] of Object.entries(env ?? {})) {
    if (!/^[A-Za-z_]/.test(key) || /[^A-Za-z0-9_]/.test(key)) {
      return "The command environment contains an invalid variable name."
    }
    if (typeof value !== "string" || value.includes("\0")) {
      return "The command environment contains an invalid variable value."
    }
    const normalized = key.toUpperCase()
    if (forbiddenKeys.has(normalized) || /^(?:LD_|DYLD_|BUN_)/.test(normalized)) {
      return `The command environment cannot override ${key}.`
    }
  }
  return undefined
}
