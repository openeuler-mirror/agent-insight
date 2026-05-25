import assert from "node:assert/strict"
import test from "node:test"

import {
    findSkillMd,
    findSkillMdPath,
    fileContentToString,
    getSkillFolderFromPath,
    sanitizeForFilename,
} from "../src/lib/skill-generator/skill-files"

const skillContent = [
    "---",
    "name: date-normalizer",
    "description: 把日期统一成 YYYY-MM-DD",
    "---",
    "",
    "# Date Normalizer",
].join("\n")

test("findSkillMd: locates SKILL.md in nested /workspace/<skill>/ layout", () => {
    const files = {
        "/workspace/date-normalizer/SKILL.md": { content: skillContent.split("\n") },
        "/workspace/date-normalizer/scripts/foo.py": { content: "print(1)" },
    }
    const info = findSkillMd(files)
    assert.equal(info?.path, "/workspace/date-normalizer/SKILL.md")
    assert.equal(info?.name, "date-normalizer")
    assert.equal(info?.description, "把日期统一成 YYYY-MM-DD")
    assert.equal(info?.folder, "date-normalizer")
})

test("findSkillMd: locates SKILL.md at /workspace/ root", () => {
    const files = {
        "/workspace/SKILL.md": { content: skillContent },
        "/workspace/scripts/foo.py": { content: "print(1)" },
    }
    const info = findSkillMd(files)
    assert.equal(info?.path, "/workspace/SKILL.md")
    assert.equal(info?.folder, null) // 根布局没有需要剥的文件夹
})

test("findSkillMd: prefers shallowest SKILL.md when multiple exist", () => {
    const files = {
        "/workspace/deep/nested/SKILL.md": { content: "---\nname: deep\n---" },
        "/workspace/shallow/SKILL.md": { content: "---\nname: shallow\n---" },
    }
    const info = findSkillMd(files)
    assert.equal(info?.name, "shallow")
})

test("findSkillMd: returns null when no SKILL.md present", () => {
    assert.equal(findSkillMd({ "/workspace/notes.md": { content: "hi" } }), null)
    assert.equal(findSkillMd({}), null)
    assert.equal(findSkillMd(null), null)
})

test("findSkillMd: ignores SKILL.md outside /workspace/", () => {
    const files = { "/other/SKILL.md": { content: skillContent } }
    assert.equal(findSkillMd(files), null)
})

test("findSkillMd: missing frontmatter → name/description undefined", () => {
    const files = { "/workspace/SKILL.md": { content: "# no frontmatter" } }
    const info = findSkillMd(files)
    assert.equal(info?.name, undefined)
    assert.equal(info?.description, undefined)
})

test("findSkillMdPath: thin path-only wrapper", () => {
    const files = { "/workspace/foo/SKILL.md": { content: "" } }
    assert.equal(findSkillMdPath(files), "/workspace/foo/SKILL.md")
})

test("fileContentToString: handles string, string[], undefined", () => {
    assert.equal(fileContentToString({ content: "abc" }), "abc")
    assert.equal(fileContentToString({ content: ["a", "b"] }), "a\nb")
    assert.equal(fileContentToString({}), "")
    assert.equal(fileContentToString(undefined), "")
})

test("getSkillFolderFromPath: returns folder or null", () => {
    assert.equal(getSkillFolderFromPath("/workspace/foo/SKILL.md"), "foo")
    assert.equal(getSkillFolderFromPath("/workspace/SKILL.md"), null)
    assert.equal(getSkillFolderFromPath(null), null)
    assert.equal(getSkillFolderFromPath("/other/SKILL.md"), null)
})

test("sanitizeForFilename: keeps safe chars, replaces the rest", () => {
    assert.equal(sanitizeForFilename("date-normalizer"), "date-normalizer")
    assert.equal(sanitizeForFilename("foo bar/baz"), "foo_bar_baz")
    assert.equal(sanitizeForFilename("中文 name"), "_name")
})
