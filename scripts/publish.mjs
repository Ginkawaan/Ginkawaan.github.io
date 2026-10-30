#!/usr/bin/env node
/**
 * 一键发布：校验 src/content/posts 的改动 → 构建验证 → 提交 → 推送
 *
 * 用法：
 *   双击项目根目录的「发布.bat」
 *   或命令行 node scripts/publish.mjs [--no-build] [--dry-run]
 *
 *   --no-build  跳过构建验证（快，但语法错要等线上 Actions 报错才知道）
 *   --dry-run   只检查不提交
 */

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
process.chdir(ROOT);

const POSTS_DIR = "src/content/posts";
const BRANCH = "master";
const SITE = "https://ginkawaan.github.io";

const argv = process.argv.slice(2);
const NO_BUILD = argv.includes("--no-build");
const DRY_RUN = argv.includes("--dry-run");

// ── 输出工具 ────────────────────────────────────────────────
const line = (n = 1) => console.log("\n".repeat(n - 1) + "─".repeat(52));
const log = (m = "") => console.log(m);
const ok = (m) => console.log(`  [OK]   ${m}`);
const note = (m) => console.log(`  [注意] ${m}`);
const bad = (m) => console.log(`  [错误] ${m}`);
const step = (i, total, m) => console.log(`\n[${i}/${total}] ${m}`);

// ── git 封装 ────────────────────────────────────────────────
function git(args, opts = {}) {
	return execFileSync("git", ["-c", "core.quotepath=false", ...args], {
		encoding: "utf8",
		cwd: ROOT,
		...opts,
	});
}

function readStatus() {
	const raw = git(["status", "--porcelain", "--untracked-files=all"]);
	return raw
		.split("\n")
		.filter((l) => l.trim())
		.map((rawLine) => {
			const code = rawLine.slice(0, 2);
			let p = rawLine.slice(3).trim();
			// 重命名会写成 "旧 -> 新"
			if (p.includes(" -> ")) p = p.split(" -> ").pop();
			return { code, path: p.replace(/^"|"$/g, "") };
		})
		.filter((e) => !e.path.split("/").includes(".obsidian"));
}

// ── 文章校验 ────────────────────────────────────────────────
function validatePost(rel) {
	const abs = path.join(ROOT, rel);
	const problems = [];
	const notes = [];
	const info = { rel, title: "", draft: false };

	let stat;
	try {
		stat = fs.statSync(abs);
	} catch {
		return { ...info, problems: ["文件读不到（可能刚被删除）"], notes };
	}

	if (stat.size === 0) {
		problems.push("文件是 0 字节（空的），Astro 构建会直接失败");
		return { ...info, problems, notes };
	}

	let parsed;
	try {
		parsed = matter(fs.readFileSync(abs, "utf8"));
	} catch (e) {
		problems.push(`frontmatter 解析失败：${e.message}`);
		return { ...info, problems, notes };
	}

	const d = parsed.data ?? {};
	info.title = typeof d.title === "string" ? d.title.trim() : "";
	info.draft = d.draft === true;

	if (!info.title) problems.push("缺少 title");
	if (!d.published) {
		problems.push("缺少 published（格式 YYYY-MM-DD）");
	} else if (Number.isNaN(new Date(d.published).getTime())) {
		problems.push(`published 不是合法日期：${d.published}`);
	}
	if (!parsed.content.trim()) problems.push("正文是空的");

	// 文件名决定 URL：中文/空格会让链接变成一长串编码
	const base = path.basename(rel, ".md");
	if (/[\u4e00-\u9fff]/.test(base)) {
		notes.push("文件名含中文，文章 URL 会是一串 %E4%B8%AD 编码，建议改成英文");
	}
	if (/\s/.test(base)) {
		notes.push("文件名含空格，URL 里会变成 %20，建议用 - 或 _");
	}
	if (/[A-Z]/.test(base)) {
		notes.push("文件名含大写字母，Astro 会转成小写，URL 是 " + base.toLowerCase());
	}
	if (info.draft) notes.push("draft: true —— 本地能看到，线上不会发布");

	return { ...info, problems, notes };
}

// ── commit message ──────────────────────────────────────────
function buildMessage(added, modified, removed, others) {
	// 只有非文章文件时，按文件名生成
	if (added.length === 0 && modified.length === 0 && removed.length === 0) {
		const names = others.slice(0, 3).map((c) => path.basename(c.path));
		const tail = others.length > 3 ? ` 等 ${others.length} 个文件` : "";
		return `chore: 更新 ${names.join("、")}${tail}`;
	}

	const titleOf = (p) => (typeof p === "string" ? path.basename(p, ".md") : p?.title ?? "");
	const first = titleOf(added[0] ?? modified[0] ?? "");
	if (added.length === 1 && modified.length === 0 && removed.length === 0) {
		return `feat(post): 新增《${first}》`;
	}
	if (added.length === 0 && modified.length === 1 && removed.length === 0) {
		return `docs(post): 更新《${first}》`;
	}
	if (added.length === 0 && modified.length === 0 && removed.length === 1) {
		return `chore(post): 删除《${path.basename(removed[0], ".md")}》`;
	}

	const parts = [];
	if (added.length) parts.push(`新增 ${added.length} 篇`);
	if (modified.length) parts.push(`更新 ${modified.length} 篇`);
	if (removed.length) parts.push(`删除 ${removed.length} 篇`);
	const head = first ? `（含《${first}》）` : "";
	return `docs(post): ${parts.join("、")}${head}`;
}

// ── 主流程 ──────────────────────────────────────────────────
const TOTAL = NO_BUILD ? 4 : 5;
let stepNo = 0;

line();
log("  博客一键发布" + (DRY_RUN ? "（演练模式，不会提交）" : ""));
line();

step(++stepNo, TOTAL, "检查改动");
const changes = readStatus();
if (changes.length === 0) {
	ok("工作区干净，没有需要发布的内容");
	line();
	process.exit(0);
}

const isPost = (p) => p.startsWith(`${POSTS_DIR}/`) && p.endsWith(".md");
const added = [];
const modified = [];
const removed = [];
const others = [];

for (const c of changes) {
	if (!isPost(c.path)) {
		others.push(c);
		continue;
	}
	if (c.code === "??" || c.code === "A " || c.code === " A") added.push(c.path);
	else if (c.code.includes("D")) removed.push(c.path);
	else modified.push(c.path);
}

if (added.length + modified.length + removed.length === 0 && others.length === 0) {
	ok("没有文章改动");
	line();
	process.exit(0);
}

log(
	`  文章：新增 ${added.length} / 修改 ${modified.length} / 删除 ${removed.length}` +
		(others.length ? `　其他文件：${others.length}` : "")
);

step(++stepNo, TOTAL, "校验文章");
const problems = [];
const addedInfo = [];

for (const rel of [...added, ...modified]) {
	const r = validatePost(rel);
	if (r.problems.length) {
		for (const p of r.problems) bad(`${path.basename(rel)}：${p}`);
		problems.push({ rel, list: r.problems });
	} else {
		ok(`${path.basename(rel)}　${r.title}`);
	}
	for (const n of r.notes) note(`${path.basename(rel)}：${n}`);
	if (added.includes(rel)) addedInfo.push(r);
}

for (const rel of removed) note(`${path.basename(rel)}：将被删除`);

if (problems.length) {
	line();
	bad("有文章没通过校验，已中止（没有提交、没有推送）");
	log("  修好上面标红的项再点一次即可。模板在 _templates/文章模板.md");
	line();
	process.exit(1);
}
ok("全部通过");

// 构建验证
if (!NO_BUILD) {
	step(++stepNo, TOTAL, "构建验证（约 20~60 秒）");
	try {
		execSync("npx astro build", { cwd: ROOT, stdio: "pipe", encoding: "utf8" });
		ok("构建通过");
	} catch (e) {
		bad("构建失败，已中止（没有提交、没有推送）");
		const out = `${e.stdout ?? ""}\n${e.stderr ?? ""}`;
		log("\n  ── 构建输出（末尾） ──");
		log(
			out
				.split("\n")
				.filter((l) => l.trim())
				.slice(-25)
				.map((l) => `  ${l}`)
				.join("\n")
		);
		line();
		process.exit(1);
	}
}

// 提交
step(++stepNo, TOTAL, "提交");
if (DRY_RUN) {
	note("演练模式，跳过 git add / commit / push");
	for (const c of changes) log(`  ${c.code}  ${c.path}`);
	line();
	process.exit(0);
}

git(["add", "-A"]);
const message = buildMessage(addedInfo, modified, removed, others);
git(["commit", "-m", message], { stdio: "pipe" });
ok(message);

// 推送
step(++stepNo, TOTAL, "推送");
try {
	git(["fetch", "origin", BRANCH], { stdio: "pipe" });
	const behind = Number(git(["rev-list", "--count", `HEAD..origin/${BRANCH}`]).trim());
	if (behind > 0) {
		note(`远程多了 ${behind} 个提交，先 rebase`);
		git(["pull", "--rebase", "origin", BRANCH], { stdio: "inherit" });
	}
	git(["push", "origin", BRANCH], { stdio: "inherit" });
	ok("推送完成");
} catch (e) {
	bad("推送失败");
	log(String(e.stderr ?? e.message ?? e));
	log("\n  提交已在本地，网络恢复后再点一次脚本即可补推。");
	line();
	process.exit(1);
}

// 结果
line();
log("  发布成功，GitHub Actions 正在构建（约 1~2 分钟）");
log("");
const live = addedInfo.filter((p) => !p.draft);
if (live.length === 0) {
	note("这次提交里没有可上线的文章（都是 draft: true）");
} else {
	for (const p of live) {
		const slug = path.basename(p.rel, ".md").toLowerCase();
		log(`  ${p.title}`);
		log(`  ${SITE}/posts/${encodeURIComponent(slug)}/`);
	}
}
log("");
line();
