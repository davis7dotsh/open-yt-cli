/**
 * Guards on the embedded bundle itself.
 *
 * The Go equivalent is `TestBundledSkillIsComplete` in
 * `internal/skill/install_test.go`, which stats each of the three files in the
 * embedded FS and fails on a zero-size entry. The extra assertions here exist
 * because the TS bundle has a failure mode Go did not: a text import that
 * silently resolves to something other than the file on disk.
 */

import { describe, expect, test } from "bun:test"
import * as fsSync from "node:fs"
import * as nodePath from "node:path"
import { bundledSkillFileNames, bundledSkillFiles } from "./bundle.ts"

const skillsDirectory = nodePath.dirname(import.meta.path)

describe("bundledSkillFiles", () => {
  test("is the hardcoded three-file list, in Go's order", () => {
    expect(bundledSkillFileNames).toEqual([
      "SKILL.md",
      "references/commands.md",
      "references/recipes.md"
    ])
  })

  test("every entry is non-empty", () => {
    for (const file of bundledSkillFiles) {
      expect(file.content.length).toBeGreaterThan(0)
    }
  })

  test("each entry matches the file on disk byte for byte", () => {
    for (const file of bundledSkillFiles) {
      const onDisk = fsSync.readFileSync(
        nodePath.join(skillsDirectory, ...file.name.split("/")),
        "utf8"
      )
      expect(file.content).toBe(onDisk)
    }
  })

  test("names are slash-separated bundle paths, never absolute or traversing", () => {
    for (const name of bundledSkillFileNames) {
      expect(name).not.toContain("\\")
      expect(name).not.toContain("..")
      expect(nodePath.posix.isAbsolute(name)).toBe(false)
    }
  })

  test("the list is not derived from a directory walk", () => {
    // A stray file dropped into src/skills/ must NOT become part of a release.
    // If this ever needs updating, the update belongs in bundle.ts by hand.
    const onDisk = fsSync
      .readdirSync(skillsDirectory, { recursive: true, encoding: "utf8" })
      .filter((entry) => entry.endsWith(".md"))
      .map((entry) => entry.split(nodePath.sep).join("/"))
      .sort()
    expect(onDisk).toEqual([...bundledSkillFileNames].sort())
  })
})
