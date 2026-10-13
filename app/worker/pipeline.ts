import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRecord } from "../shared/api.ts";
import { STREAMS } from "./extract.ts";
import { createJob, enqueueJob, type JobQueue } from "./jobs.ts";
import { TRANSFORM_JOB_KIND } from "./transform.ts";

/** Queues one job per extraction stream for a repository: issues, issue comments, review comments. */
export async function startExtraction(db: SupabaseClient, queue: JobQueue, repositoryId: number): Promise<JobRecord[]> {
  const jobs: JobRecord[] = [];
  for (const kind of Object.keys(STREAMS)) {
    const job = await createJob(db, repositoryId, kind);
    const sent = await enqueueJob(db, queue, job.id);
    jobs.push(sent ?? job);
  }
  return jobs;
}

/** The job that follows a finished job of `kind`: every extraction stream feeds the transform. */
const NEXT_JOB_KIND: Record<string, string> = Object.fromEntries(Object.keys(STREAMS).map((kind) => [kind, TRANSFORM_JOB_KIND]));

export function nextJobKind(kind: string): string | undefined {
  return NEXT_JOB_KIND[kind];
}
