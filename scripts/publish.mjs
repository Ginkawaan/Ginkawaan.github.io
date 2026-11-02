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
 *   --no-amend  每次都新建提交（默认会把「只改已有文章」的改动并进上一条提交）
 *
 * 提交规则：文章改动与非文章改动分成两条提交，message 各自说明自己改了什么
 *   docs(post): 更新《喜好》          ← 只有文章
 *   chore(ui): 更新 bangumi.astro     ← 只有代码/样式/图片
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
const NO_AMEND = argv.includes("--no-amend");

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
		notes.push(
			`文件名含大写字母，Astro 会转成小写，URL 是 ${base.toLowerCase()}`,
		);
	}
	if (info.draft) notes.push("draft: true —— 本地能看到，线上不会发布");

	// ── 图片引用检查 ──────────────────────────────────────
	// 1. Obsidian 的 ![[xxx.png]] 语法 Astro 不认，会原样输出成文字
	const body = parsed.content;
	const assetDir = `src/assets/images/posts/${base.toLowerCase()}`;
	// 正文在 src/content/posts/ 下，往上是两层才到 src/
	const relDir = `../../assets/images/posts/${base.toLowerCase()}`;
	for (const m of body.matchAll(/!\[\[([^\]\n]+)\]\]/g)) {
		const lineNo = body.slice(0, m.index).split("\n").length;
		problems.push(
			`第 ${lineNo} 行用了 Obsidian 的 ![[${m[1]}]] 图片语法，Astro 不认（会原样显示成文字）。` +
				`正确写法：图片放到 ${assetDir}/，正文写 ![](${relDir}/文件名)`,
		);
	}

	// 2. 相对路径的图片必须真实存在，否则线上是裂图
	for (const m of body.matchAll(/!\[[^\]\n]*\]\(([^)\s]+)\)/g)) {
		const src = m[1];
		if (/^(?:https?:)?\/\//i.test(src) || src.startsWith("/")) continue;
		if (src.startsWith("data:")) continue;
		const target = path.resolve(path.dirname(abs), src);
		if (!fs.existsSync(target)) {
			const lineNo = body.slice(0, m.index).split("\n").length;
			problems.push(`第 ${lineNo} 行引用的图片不存在：${src}`);
		}
	}

	return { ...info, problems, notes };
}

// ── commit message ──────────────────────────────────────────
// 文章一条提交、其他文件另一条，避免「改了 CSS 却挂在文章名下面」
function buildPostMessage(added, modified, removed) {
	const titleOf = (p) =>
		typeof p === "string" ? path.basename(p, ".md") : (p?.title ?? "");
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

function buildOthersMessage(others) {
	const area = (p) => {
		if (p.startsWith("src/config/")) return "config";
		if (p.startsWith("src/content/")) return "content";
		if (p.startsWith("src/components/")) return "ui";
		if (p.startsWith("src/pages/")) return "ui";
		if (p.startsWith("src/layouts/")) return "ui";
		if (p.startsWith("src/styles/")) return "style";
		if (p.startsWith("src/")) return "src";
		if (p.startsWith("public/")) return "assets";
		if (p.startsWith(".github/")) return "ci";
		if (p.startsWith("scripts/")) return "script";
		if (p.startsWith("_templates/")) return "template";
		return "misc";
	};

	const seen = [];
	for (const c of others) {
		const a = area(c.path);
		if (!seen.includes(a)) seen.push(a);
	}

	const names = others.slice(0, 3).map((c) => path.basename(c.path));
	const tail = others.length > 3 ? ` 等 ${others.length} 个文件` : "";
	// 只涉及一个区域时带上 scope，混杂时就别塞一串括号了
	const scope = seen.length === 1 ? `(${seen[0]})` : "";
	return `chore${scope}: 更新 ${names.join("、")}${tail}`;
}

// 读 HEAD 里的版本，判断 draft 有没有被改（改了就意味着文章上线/下线）
function previousDraft(rel) {
	try {
		// 新文件在 HEAD 里没有，git 会往 stderr 打一行 fatal，这里静音掉
		const raw = git(["show", `HEAD:${rel}`], {
			stdio: ["ignore", "pipe", "ignore"],
		});
		return matter(raw).data?.draft === true;
	} catch {
		return null; // 新文件
	}
}

// ── 主流程 ──────────────────────────────────────────────────
const TOTAL = NO_BUILD ? 4 : 5;
let stepNo = 0;

line();
log(`  博客一键发布${DRY_RUN ? "（演练模式，不会提交）" : ""}`);
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

if (
	added.length + modified.length + removed.length === 0 &&
	others.length === 0
) {
	ok("没有文章改动");
	line();
	process.exit(0);
}

log(
	`  文章：新增 ${added.length} / 修改 ${modified.length} / 删除 ${removed.length}` +
		(others.length ? `　其他文件：${others.length}` : ""),
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
	// draft 状态翻转意味着文章上线/下线，单独提醒一句
	const prev = previousDraft(rel);
	if (prev === false && r.draft) {
		note(`${path.basename(rel)}：draft 改成了 true，提交后这篇会从线上消失`);
	} else if (prev === true && !r.draft) {
		note(`${path.basename(rel)}：draft 改回 false，这篇会重新上线`);
	}
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
				.join("\n"),
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

// 先同步远程信息，用于判断要不要 rebase、以及 amend 后是否需要 force
try {
	git(["fetch", "origin", BRANCH], { stdio: "pipe" });
} catch {
	note("fetch 失败（网络？），按本地状态继续");
}

try {
	const behind = Number(
		git(["rev-list", "--count", `HEAD..origin/${BRANCH}`]).trim(),
	);
	if (behind > 0) {
		note(`远程多了 ${behind} 个提交，先 rebase`);
		git(["pull", "--rebase", "origin", BRANCH], { stdio: "pipe" });
	}
} catch {
	note("rebase 失败，跳过（可能导致推送被拒）");
}

// 反复改同一篇时，把改动并进上一条提交，避免历史里堆一串「新增」
const headBefore = git(["rev-parse", "HEAD"]).trim();
let originHead = "";
try {
	originHead = git(["rev-parse", `origin/${BRANCH}`]).trim();
} catch {
	originHead = "";
}
const alreadyPushed = originHead !== "" && headBefore === originHead;

function canAmend() {
	if (NO_AMEND) return false;
	if (addedInfo.length > 0) return false; // 有新文章就正常提交
	if (others.length > 0) return false; // 有非文章改动也正常提交
	if (modified.length === 0) return false;

	let lastMsg = "";
	try {
		lastMsg = git(["log", "-1", "--pretty=%s"]).trim();
	} catch {
		return false;
	}
	// 只合并本脚本生成的提交，别把手工提交吞掉
	if (!/^(feat|docs|chore)\(post\):/.test(lastMsg)) return false;

	const lastFiles = git(["show", "--name-only", "--pretty=format:", "HEAD"])
		.split("\n")
		.map((s) => s.trim())
		.filter(Boolean);
	return modified.every((f) => lastFiles.includes(f));
}

// 文章与其它文件分成两条提交，各自的 message 才说得清自己改了什么
const postChanges = [...added, ...modified, ...removed];

function showCommit(msg, files) {
	ok(msg);
	for (const f of files.slice(0, 6)) log(`           ${f}`);
	if (files.length > 6) log(`           …等 ${files.length} 个文件`);
}

let amended = false;

if (postChanges.length > 0) {
	git(["add", "--", ...postChanges]);
	if (canAmend()) {
		git(["commit", "--amend", "--no-edit"], { stdio: "pipe" });
		const kept = git(["log", "-1", "--pretty=%s"]).trim();
		ok(`并入上一条提交：${kept}`);
		amended = true;
	} else {
		const message = buildPostMessage(addedInfo, modified, removed);
		git(["commit", "-m", message], { stdio: "pipe" });
		showCommit(message, postChanges);
	}
}

if (others.length > 0) {
	git(["add", "-A"]);
	const message = buildOthersMessage(others);
	git(["commit", "-m", message], { stdio: "pipe" });
	showCommit(
		message,
		others.map((c) => c.path),
	);
}

// 推送
step(++stepNo, TOTAL, "推送");
try {
	const pushArgs = ["push", "origin", BRANCH];
	// amend 改写了已推送的历史，只能 force；--force-with-lease 会在远程有新提交时拒绝
	if (amended && alreadyPushed) {
		pushArgs.push("--force-with-lease");
		note("已推送过的提交被改写，用 force-with-lease 覆盖");
	}
	// 用 pipe 收住 git 自己的输出：stdout 被重定向时 inherit 会让顺序乱掉
	git(pushArgs, { stdio: "pipe" });
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
