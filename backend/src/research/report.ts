import type { ResearchDB } from "./db.js";

export async function saveReportHtml(
  researchDb: ResearchDB,
  taskId: string,
  html: string
): Promise<void> {
  await researchDb.saveReport(taskId, html);
}

export async function getReportHtml(
  researchDb: ResearchDB,
  taskId: string
): Promise<string | null> {
  return researchDb.getReport(taskId);
}
