import type { SupabaseClient } from "@supabase/supabase-js";
import type { JobRecord } from "../../../shared/api.ts";
import { FETCH_KINDS, STREAM_KINDS } from "../etl/extract.ts";
import { EMBED_JOB_KIND } from "../etl/embed.ts";
import { createJob, enqueueJob, type JobQueue } from "./jobs.ts";
import { TRANSFORM_JOB_KIND } from "../etl/transform.ts";

/** Queues the head pass of every extraction stream for a repository. */
export async function startExtraction(db: SupabaseClient, queue: JobQueue, repositoryId: number): Promise<JobRecord[]> {
  const jobs: JobRecord[] = [];
  for (const kind of FETCH_KINDS) {
    const job = await createJob(db, repositoryId, kind);
    const sent = await enqueueJob(db, queue, job.id);
    jobs.push(sent ?? job);
  }
  return jobs;
}

/** The job that follows a run of `kind`: every stream run feeds the transform, which feeds the embedding. */
const NEXT_JOB_KIND: Record<string, string> = {
  ...Object.fromEntries(Object.keys(STREAM_KINDS).map((kind) => [kind, TRANSFORM_JOB_KIND])),
  [TRANSFORM_JOB_KIND]: EMBED_JOB_KIND,
};

export function nextJobKind(kind: string): string | undefined {
  return NEXT_JOB_KIND[kind];
}
