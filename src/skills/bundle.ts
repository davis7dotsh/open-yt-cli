/**
 * The bundled agent skill — the port of `skills/oytc/embed.go`.
 *
 * Go compiled the skill into the binary with `//go:embed SKILL.md
 * references/*.md`. Bun's equivalent is a static text import, which the
 * bundler inlines into the compiled executable:
 *
 *     import raw from "./SKILL.md" with { type: "text" }
 *
 * **The file list is HARDCODED, deliberately, in both implementations.** Go's
 * embed glob could match more than three files; `internal/skill/install.go`
 * still installs exactly the three named in its `files` slice, in that order.
 * Never replace this with a directory walk: a stray file dropped into
 * `src/skills/` must not silently become part of a release.
 *
 * TypeScript cannot resolve `*.md` module specifiers (no wildcard ambient
 * declaration is in scope), so each import carries a `@ts-ignore` and an
 * explicit `string` annotation. Bun resolves them at build and at `bun run`.
 */

// @ts-ignore -- Bun text import; TypeScript has no resolver for "*.md".
import skillMarkdown from "./SKILL.md" with { type: "text" }
// @ts-ignore -- Bun text import; TypeScript has no resolver for "*.md".
import commandsMarkdown from "./references/commands.md" with { type: "text" }
// @ts-ignore -- Bun text import; TypeScript has no resolver for "*.md".
import recipesMarkdown from "./references/recipes.md" with { type: "text" }

/** One embedded file: a slash-separated relative name and its contents. */
export interface BundledFile {
  /** Always slash-separated, even on Windows — it is a bundle path, not a host path. */
  readonly name: string
  readonly content: string
}

/**
 * The install manifest, in Go's order. `SkillInstaller` copies exactly these
 * entries and nothing else.
 */
export const bundledSkillFiles: ReadonlyArray<BundledFile> = [
  { name: "SKILL.md", content: skillMarkdown as string },
  { name: "references/commands.md", content: commandsMarkdown as string },
  { name: "references/recipes.md", content: recipesMarkdown as string }
]

/** Just the names, for callers that report what was installed. */
export const bundledSkillFileNames: ReadonlyArray<string> = bundledSkillFiles.map(
  (file) => file.name
)
