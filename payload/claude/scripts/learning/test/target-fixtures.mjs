// Small, installation-independent documents with editable sections and protected policy examples.
export const editableHeading = "## Division of labour: Claude orchestrates, Luna executes";

export function targetFixtures(targets) {
  return Object.fromEntries(targets.map((target) => [target, Buffer.from([
    `# ${target === "CLAUDE.md" ? "Working instructions" : target.split("/")[1] + " skill"}`,
    "",
    editableHeading,
    "Plan the work in small steps and record the result of each step.",
    "",
    "## Local changes",
    "Preserve existing work while applying a focused change.",
    "",
    "## Completion notes",
    "Describe the outcome and the evidence collected during execution.",
    "",
    "## Review policy",
    "Use 3–5 critics to review the completed work.",
    "Never delete existing work. Ask for permission before destructive operations.",
    "Special instruction (user decision, 2026-10-21): preserve local changes.",
    "",
  ].join("\n"))]));
}
