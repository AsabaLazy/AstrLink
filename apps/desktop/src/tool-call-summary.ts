export type ToolSummaryKind = "file" | "command" | "search" | "generic";

/** A small, deterministic preview; the expandable card retains exact input. */
export function toolCallSummary(
  name: string,
  args: string,
): {
  kind: ToolSummaryKind;
  text: string;
} {
  const compact = (text: string) => {
    const line = text.replace(/\s+/g, " ").trim();
    return line.length > 180 ? `${line.slice(0, 179)}…` : line;
  };
  const fallback = { kind: "generic" as const, text: compact(args) };
  let value: unknown;
  try {
    value = JSON.parse(args);
  } catch {
    return fallback;
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    return fallback;
  const fields = value as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const candidate = fields[key];
      if (typeof candidate === "string" && candidate.trim())
        return compact(candidate);
    }
    return null;
  };
  const tool =
    name
      .split(/__|[./]/)
      .at(-1)
      ?.toLowerCase() ?? "";
  const kinds: Array<[ToolSummaryKind, RegExp, string[]]> = [
    [
      "file",
      /^(read|write|edit|view_image|read_file|read_text_file|read_file_lines|write_file|edit_file|readfile|writefile)$/,
      ["file_path", "path", "filename", "file"],
    ],
    [
      "command",
      /^(bash|shell|exec|exec_command|shell_command|run_command|run_shell_command|terminal)$/,
      ["command", "cmd", "script"],
    ],
    [
      "search",
      /^(grep|glob|search|web_search|search_files|find_files|ripgrep|rg)$/,
      ["pattern", "query", "q", "search_term", "glob"],
    ],
  ];
  for (const [kind, pattern, keys] of kinds) {
    if (!pattern.test(tool)) continue;
    const text = pick(...keys);
    if (text) return { kind, text };
  }
  return fallback;
}
