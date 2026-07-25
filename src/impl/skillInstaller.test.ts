/**
 * Ports `internal/skill/install_test.go` (2 cases).
 *
 * `TestInstallFSWritesAndReplacesCompleteSkill` substituted an `fstest.MapFS`
 * for the embedded bundle. The TS bundle is a static import, so the real
 * content is installed and the assertions check for content that must be
 * present rather than for fixture strings — the two properties the Go test
 * actually guards are unchanged and asserted verbatim:
 *
 *   - a pre-existing `stale.md` inside the target does NOT survive the swap
 *   - no `.oytc-*-*` directory is left behind in the parent
 *
 * `TestBundledSkillIsComplete` checks the three embedded files are present
 * and non-empty.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import * as fsSync from "node:fs"
import * as os from "node:os"
import * as nodePath from "node:path"
import { Cause, Effect, Exit, FileSystem, Layer, Path, PlatformError } from "effect"
import { BunServices } from "@effect/platform-bun"
import { bundledSkillFileNames, bundledSkillFiles } from "../skills/bundle.ts"
import { installSkill, makeSkillInstaller } from "./skillInstaller.ts"
import { ProcessEnv, type ProcessEnvShape } from "../services/index.ts"
import { OperationalError } from "../domain/errors.ts"

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path>
): Promise<A> => Effect.runPromise(effect.pipe(Effect.provide(BunServices.layer)))

let root: string

beforeEach(() => {
  root = fsSync.mkdtempSync(nodePath.join(os.tmpdir(), "oytc-skill-test-"))
})

afterEach(() => {
  fsSync.rmSync(root, { recursive: true, force: true })
})

const targetPath = (): string => nodePath.join(root, ".agents", "skills", "oytc")

/** The Go test's `filepath.Glob(dir, ".oytc-*-*")`. */
const strayTempDirs = (parent: string): ReadonlyArray<string> =>
  fsSync.existsSync(parent)
    ? fsSync
        .readdirSync(parent)
        .filter((name) => /^\.oytc-.*-.*$/.test(name))
        .sort()
    : []

/** The `OperationalError.message` inside a failed `Exit`, or "" if absent. */
const operationalMessage = (exit: Exit.Exit<unknown, unknown>): string => {
  if (exit._tag !== "Failure") return ""
  const error = Cause.findErrorOption(exit.cause)
  return error._tag === "Some" && error.value instanceof OperationalError ? error.value.message : ""
}

/**
 * The real Bun filesystem with the staging swap sabotaged, so the rollback
 * path in step 5 is actually executed rather than argued about.
 */
const failingRenameLayer = (): Layer.Layer<FileSystem.FileSystem | Path.Path> =>
  Layer.effect(
    FileSystem.FileSystem,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      return {
        ...fs,
        rename: (oldPath: string, newPath: string) =>
          oldPath.includes(".oytc-install-")
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: newPath
                })
              )
            : fs.rename(oldPath, newPath)
      } satisfies FileSystem.FileSystem
    })
  ).pipe(Layer.provideMerge(BunServices.layer))

describe("installSkill", () => {
  // internal/skill/install_test.go: TestInstallFSWritesAndReplacesCompleteSkill
  test("writes the complete skill and replaces an existing install wholesale", async () => {
    const target = targetPath()
    fsSync.mkdirSync(target, { recursive: true, mode: 0o755 })
    fsSync.writeFileSync(nodePath.join(target, "stale.md"), "stale", { mode: 0o644 })

    const result = await run(installSkill(target))
    expect(result.path).toBe(target)
    expect(result.files).toEqual(bundledSkillFileNames)

    for (const file of bundledSkillFiles) {
      const onDisk = fsSync.readFileSync(nodePath.join(target, ...file.name.split("/")), "utf8")
      expect(onDisk).toBe(file.content)
    }

    // The whole point of the swap: user-added files are destroyed.
    expect(fsSync.existsSync(nodePath.join(target, "stale.md"))).toBe(false)

    // No staging or backup directory survives.
    expect(strayTempDirs(nodePath.dirname(target))).toEqual([])
  })

  test("creates the skill from nothing when the target does not exist", async () => {
    const target = targetPath()
    expect(fsSync.existsSync(target)).toBe(false)

    await run(installSkill(target))

    for (const name of bundledSkillFileNames) {
      expect(fsSync.existsSync(nodePath.join(target, ...name.split("/")))).toBe(true)
    }
    expect(strayTempDirs(nodePath.dirname(target))).toEqual([])
  })

  test("is idempotent — installing twice leaves the same tree and no temp dirs", async () => {
    const target = targetPath()
    await run(installSkill(target))
    await run(installSkill(target))

    expect(fsSync.readdirSync(target).sort()).toEqual(["SKILL.md", "references"])
    expect(fsSync.readdirSync(nodePath.join(target, "references")).sort()).toEqual([
      "commands.md",
      "recipes.md"
    ])
    expect(strayTempDirs(nodePath.dirname(target))).toEqual([])
  })

  test("installs 0644 files inside 0755 directories, not 0600/0700", async () => {
    const target = targetPath()
    await run(installSkill(target))

    const mode = (...segments: ReadonlyArray<string>): number =>
      fsSync.statSync(nodePath.join(target, ...segments)).mode & 0o777

    expect(mode()).toBe(0o755)
    expect(mode("references")).toBe(0o755)
    expect(mode("SKILL.md")).toBe(0o644)
    expect(mode("references", "commands.md")).toBe(0o644)
    expect(mode("references", "recipes.md")).toBe(0o644)
  })

  test("a stale 0700/0600 install is re-hardened to 0755/0644 by the swap", async () => {
    const target = targetPath()
    fsSync.mkdirSync(target, { recursive: true, mode: 0o700 });
    fsSync.chmodSync(target, 0o700)
    fsSync.writeFileSync(nodePath.join(target, "SKILL.md"), "old", { mode: 0o600 })

    await run(installSkill(target))

    expect(fsSync.statSync(target).mode & 0o777).toBe(0o755)
    expect(fsSync.statSync(nodePath.join(target, "SKILL.md")).mode & 0o777).toBe(0o644)
  })

  test("a restrictive umask does not leak into the installed tree", async () => {
    // `mode` on create is masked by umask: under 077 the kernel would produce
    // 0700/0600 and the skill would be unreadable by the other agents it exists
    // to serve. Only the explicit chmods make the result stable.
    const target = targetPath()
    const previous = process.umask(0o077)
    try {
      await run(installSkill(target))
    } finally {
      process.umask(previous)
    }

    const mode = (...segments: ReadonlyArray<string>): number =>
      fsSync.statSync(nodePath.join(target, ...segments)).mode & 0o777

    expect(mode()).toBe(0o755)
    expect(mode("references")).toBe(0o755)
    expect(mode("SKILL.md")).toBe(0o644)
    expect(mode("references", "recipes.md")).toBe(0o644)
  })

  test("a DANGLING SYMLINK at the target is replaced, matching Go's Lstat", async () => {
    // `stat` follows symlinks, so a broken link reports NotFound where Go's
    // Lstat reported "exists". Skipping the backup branch would leave the link
    // in place and `rename(stage, target)` would fail with ENOTDIR.
    const parent = nodePath.join(root, ".agents", "skills")
    fsSync.mkdirSync(parent, { recursive: true })
    const target = nodePath.join(parent, "oytc")
    fsSync.symlinkSync(nodePath.join(root, "nowhere-at-all"), target)

    await run(installSkill(target))

    expect(fsSync.lstatSync(target).isSymbolicLink()).toBe(false)
    expect(fsSync.statSync(target).isDirectory()).toBe(true)
    expect(fsSync.existsSync(nodePath.join(target, "SKILL.md"))).toBe(true)
    expect(strayTempDirs(parent)).toEqual([])
  })

  test("creates every missing parent directory", async () => {
    const target = nodePath.join(root, "deep", "nested", "chain", "oytc")
    await run(installSkill(target))
    expect(fsSync.existsSync(nodePath.join(target, "SKILL.md"))).toBe(true)
  })

  test("a plain FILE at the target is moved aside and replaced, not merged into", async () => {
    // Go's Lstat succeeds on a file, so the backup/rename path runs and the
    // file ends up deleted along with the backup.
    const parent = nodePath.join(root, ".agents", "skills")
    fsSync.mkdirSync(parent, { recursive: true })
    const target = nodePath.join(parent, "oytc")
    fsSync.writeFileSync(target, "not a directory")

    await run(installSkill(target))

    expect(fsSync.statSync(target).isDirectory()).toBe(true)
    expect(fsSync.existsSync(nodePath.join(target, "SKILL.md"))).toBe(true)
    expect(strayTempDirs(parent)).toEqual([])
  })

  test("rolls the previous install back and cleans up when the swap fails", async () => {
    const target = targetPath()
    // A complete previous install, so there is something to roll back to.
    await run(installSkill(target))
    fsSync.writeFileSync(nodePath.join(target, "marker.md"), "previous")

    const exit = await Effect.runPromise(
      installSkill(target).pipe(Effect.provide(failingRenameLayer()), Effect.exit)
    )

    expect(exit._tag).toBe("Failure")
    expect(operationalMessage(exit)).toStartWith("install skill: ")

    // The old install is back where it was, contents intact.
    expect(fsSync.readFileSync(nodePath.join(target, "marker.md"), "utf8")).toBe("previous")
    expect(fsSync.existsSync(nodePath.join(target, "SKILL.md"))).toBe(true)
    expect(strayTempDirs(nodePath.dirname(target))).toEqual([])
  })

  test("wraps a filesystem failure in an OperationalError with Go's prefix", async () => {
    // An unwritable parent makes step 1 (`MkdirAll`) fail.
    const locked = nodePath.join(root, "locked")
    fsSync.mkdirSync(locked, { mode: 0o500 })
    const target = nodePath.join(locked, "sub", "oytc")

    const exit = await Effect.runPromise(
      installSkill(target).pipe(Effect.provide(BunServices.layer), Effect.exit)
    )
    expect(exit._tag).toBe("Failure")
    expect(operationalMessage(exit)).toStartWith("create skills directory: ")
    fsSync.chmodSync(locked, 0o700)
  })
})

describe("bundled skill", () => {
  // internal/skill/install_test.go: TestBundledSkillIsComplete
  test("all three embedded files are present and non-empty", () => {
    expect(bundledSkillFiles).toHaveLength(3)
    for (const file of bundledSkillFiles) {
      expect(file.content.length).toBeGreaterThan(0)
    }
  })

  test("the file list is the hardcoded Go list, in order", () => {
    expect(bundledSkillFileNames).toEqual([
      "SKILL.md",
      "references/commands.md",
      "references/recipes.md"
    ])
  })

  test("SKILL.md carries the frontmatter CI validates and the security clause", () => {
    const skill = bundledSkillFiles[0]!.content
    expect(skill).toStartWith("---\n")
    expect(skill).toContain("name: oytc")
    const description = /^description: (.+)$/m.exec(skill)?.[1]
    expect(description).toBeDefined()
    expect(description!.length).toBeGreaterThan(0)
    expect(description!.length).toBeLessThan(1024)
    expect(skill).toContain("Query public YouTube data")
    expect(skill).toContain("Never print, log, or echo API keys")
  })
})

describe("SkillInstaller service", () => {
  const envLayer = (home: Effect.Effect<string, OperationalError>) =>
    Effect.provideService(ProcessEnv, {
      env: () => ({ _tag: "None" }) as never,
      platform: process.platform,
      arch: process.arch,
      argv: [],
      executablePath: Effect.succeed("/bin/oytc"),
      isOutputTTY: false,
      homeDir: home
    } satisfies ProcessEnvShape)

  test("defaultPath is <home>/.agents/skills/oytc", async () => {
    const installer = await Effect.runPromise(
      makeSkillInstaller.pipe(envLayer(Effect.succeed(root)), Effect.provide(BunServices.layer))
    )
    const path = await Effect.runPromise(installer.defaultPath)
    expect(path).toBe(nodePath.join(root, ".agents", "skills", "oytc"))
  })

  test("defaultPath surfaces Go's 'find home directory' prefix", async () => {
    const installer = await Effect.runPromise(
      makeSkillInstaller.pipe(
        envLayer(Effect.fail(new OperationalError({ message: "no home" }))),
        Effect.provide(BunServices.layer)
      )
    )
    const exit = await Effect.runPromise(installer.defaultPath.pipe(Effect.exit))
    expect(exit._tag).toBe("Failure")
    expect(operationalMessage(exit)).toBe("find home directory: no home")
  })

  test("install through the service writes the bundle", async () => {
    const installer = await Effect.runPromise(
      makeSkillInstaller.pipe(envLayer(Effect.succeed(root)), Effect.provide(BunServices.layer))
    )
    const target = targetPath()
    const result = await Effect.runPromise(installer.install(target))
    expect(result.path).toBe(target)
    expect(fsSync.readFileSync(nodePath.join(target, "SKILL.md"), "utf8")).toBe(
      bundledSkillFiles[0]!.content
    )
  })
})
