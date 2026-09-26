/**
 * 技能包与渐进加载（T18）。
 * 三层加载：元信息（选择）→ 正文（SKILL.md body，进上下文）→ 资源/脚本（按需，脚本默认不执行）。
 * 安装 ≠ 授权：allowedTools/requiredCapabilities 由平台策略核对，课程 manifest 决定本课可用技能。
 * 依据设计文档 v1.1 §12.5、验收 A11 相邻面。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, readdirSync } from "node:fs";
import { join, basename, resolve } from "node:path";
import type { Database } from "@agentglass/db";
import { newId, nowIso } from "@agentglass/db";
import type { BlobStore } from "@agentglass/events";

export const SKILL_LOADER_VERSION = "skill-loader-1";

export interface SkillManifest {
  id: string;
  slug: string;
  name: string;
  description: string;
  version: string;
  bodyRef: string;
  scripts: Array<{ name: string; path: string; authorized: boolean }>;
  requiredCapabilities: string[];
  allowedTools: string[];
  sourcePath: string | null;
}

export interface SkillMeta {
  slug: string;
  name: string;
  description: string;
  version: string;
}

export class SkillRegistry {
  constructor(private readonly db: Database, private readonly blobs: BlobStore) {}

  /**
   * 显式安装：从课程包 skills/<slug>/ 目录读取（不扫描用户主目录/当前目录/远程）。
   * 目录约定：SKILL.md（frontmatter: name/description/version）+ 可选 scripts/。
   */
  installFromDir(dir: string): SkillManifest {
    const skillMdPath = join(dir, "SKILL.md");
    if (!existsSync(skillMdPath)) {
      throw new Error(`SKILL_INVALID: ${dir} 缺少 SKILL.md`);
    }
    const raw = readFileSync(skillMdPath, "utf8");
    const { frontmatter, body } = parseFrontmatter(raw);
    const slug = String(frontmatter.name ?? basename(dir));
    if (!/^[a-z0-9-]+$/.test(slug)) {
      throw new Error(`SKILL_INVALID: slug 只允许小写字母数字连字符: ${slug}`);
    }
    const version = String(frontmatter.version ?? "1.0.0");
    const description = String(frontmatter.description ?? "");
    const requiredCapabilities = String(frontmatter.requiredCapabilities ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);
    const allowedTools = String(frontmatter.allowedTools ?? "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean);

    // 脚本清单（仅登记；执行需要独立能力授权，本版本不执行任何技能脚本）
    const scripts: SkillManifest["scripts"] = [];
    const scriptsDir = join(dir, "scripts");
    if (existsSync(scriptsDir) && statSync(scriptsDir).isDirectory()) {
      for (const f of readdirSync(scriptsDir)) {
        const fp = resolve(scriptsDir, f);
        if (!fp.startsWith(resolve(scriptsDir))) {
          throw new Error(`SKILL_INVALID: 脚本路径越界 ${f}`);
        }
        scripts.push({ name: f, path: fp, authorized: false });
      }
    }

    const id = newId("skill");
    const bodyRef = this.blobs.putText(body, "text/markdown");
    this.db.prepare("DELETE FROM skill_packages WHERE slug = ?").run(slug);
    this.db
      .prepare(
        `INSERT INTO skill_packages (id, slug, name, description, version, body_ref, scripts, required_capabilities, allowed_tools, source_path, installed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        slug,
        String(frontmatter.name ?? slug),
        description,
        version,
        bodyRef.id,
        JSON.stringify(scripts),
        JSON.stringify(requiredCapabilities),
        JSON.stringify(allowedTools),
        dir,
        nowIso(),
      );
    const contentSha = createHash("sha256").update(raw, "utf8").digest("hex");
    void contentSha;
    return this.get(slug)!;
  }

  get(slug: string): SkillManifest | undefined {
    const r = this.db.prepare("SELECT * FROM skill_packages WHERE slug = ?").get(slug) as
      | Record<string, unknown>
      | undefined;
    if (!r) return undefined;
    return {
      id: String(r.id),
      slug: String(r.slug),
      name: String(r.name),
      description: String(r.description),
      version: String(r.version),
      bodyRef: String(r.body_ref),
      scripts: JSON.parse(String(r.scripts)),
      requiredCapabilities: JSON.parse(String(r.required_capabilities)),
      allowedTools: JSON.parse(String(r.allowed_tools)),
      sourcePath: (r.source_path as string | null) ?? null,
    };
  }

  /** T31 晋级落点：更新技能正文与版本（仅由 CandidateService 门控通过后调用） */
  updateBody(slug: string, newBody: string, newVersion: string): SkillManifest {
    const skill = this.get(slug);
    if (!skill) throw new Error(`SKILL_NOT_INSTALLED: ${slug}`);
    const bodyRef = this.blobs.putText(newBody, "text/markdown");
    this.db
      .prepare("UPDATE skill_packages SET body_ref = ?, version = ? WHERE slug = ?")
      .run(bodyRef.id, newVersion, slug);
    return this.get(slug)!;
  }

  /** 第一层：元信息（用于选择；不含正文） */
  listMeta(allowedSlugs?: string[]): SkillMeta[] {
    const rows = this.db.prepare("SELECT slug FROM skill_packages ORDER BY slug").all() as Array<{
      slug: string;
    }>;
    return rows
      .map((r) => this.get(r.slug)!)
      .filter((s) => (allowedSlugs ? allowedSlugs.includes(s.slug) : true))
      .map((s) => ({ slug: s.slug, name: s.name, description: s.description, version: s.version }));
  }

  /** 第二层：正文加载（每次加载由调用方产生 skill.loaded 事件与上下文增量） */
  loadBody(slug: string): { body: string; version: string } {
    const skill = this.get(slug);
    if (!skill) throw new Error(`SKILL_NOT_INSTALLED: ${slug}`);
    return { body: this.blobs.getText(skill.bodyRef), version: skill.version };
  }

  /**
   * 第三层：脚本/资源。本版本一律拒绝执行（未授权即拒绝，诚实返回能力缺口），
   * 资源文本（references/*.md）可按需读取。
   */
  loadResource(skillSlug: string, resourceName: string): { text: string } {
    const skill = this.get(skillSlug);
    if (!skill?.sourcePath) throw new Error(`SKILL_NOT_INSTALLED: ${skillSlug}`);
    const resPath = join(skill.sourcePath, "references", basename(resourceName));
    if (!resolve(resPath).startsWith(resolve(join(skill.sourcePath, "references")))) {
      throw new Error("SKILL_RESOURCE_PATH_ESCAPE");
    }
    if (!existsSync(resPath)) throw new Error(`SKILL_RESOURCE_NOT_FOUND: ${resourceName}`);
    return { text: readFileSync(resPath, "utf8") };
  }

  executeScript(skillSlug: string, scriptName: string): never {
    const skill = this.get(skillSlug);
    const script = skill?.scripts.find((s) => s.name === scriptName);
    if (!script) throw new Error("SKILL_SCRIPT_NOT_FOUND");
    // 设计 §12.5：脚本执行需要独立能力授权；默认关闭。
    throw new Error("SKILL_SCRIPT_EXECUTION_NOT_AUTHORIZED");
  }
}

export function parseFrontmatter(raw: string): {
  frontmatter: Record<string, string>;
  body: string;
} {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { frontmatter: {}, body: raw };
  const frontmatter: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const idx = line.indexOf(":");
    if (idx > 0) {
      frontmatter[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { frontmatter, body: m[2]!.trim() };
}
