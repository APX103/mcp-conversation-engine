import fs from "fs/promises";
import path from "path";
import type { ResearchDB } from "./db.js";

const WORKSPACE_DIR = path.resolve(process.cwd(), "workspace", "research");

async function ensureDir(dir: string): Promise<void> {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch {
    // ignore
  }
}

export async function saveReportHtml(
  researchDb: ResearchDB,
  taskId: string,
  html: string
): Promise<string> {
  await ensureDir(WORKSPACE_DIR);
  const filePath = path.join(WORKSPACE_DIR, `${taskId}.html`);
  await fs.writeFile(filePath, html, "utf-8");
  // 同时保存路径到数据库
  await researchDb.saveReport(taskId, filePath);
  return filePath;
}

export async function getReportHtml(
  researchDb: ResearchDB,
  taskId: string
): Promise<string | null> {
  const filePath = await researchDb.getReport(taskId);
  if (!filePath) return null;
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}
