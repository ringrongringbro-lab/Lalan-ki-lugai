const WORKFLOWS = ["encode.yml", "audio_merge.yml"];

function ghHeaders(env) {
  return {
    Authorization: `token ${env.GITHUB_TOKEN}`,
    Accept: "application/vnd.github+json",
  };
}

// Counts in_progress + queued runs across BOTH workflows
export async function activeRunCount(env) {
  let total = 0;
  for (const status of ["in_progress", "queued"]) {
    const url = `https://api.github.com/repos/${env.REPO_NAME}/actions/runs?status=${status}`;
    try {
      const r = await fetch(url, { headers: ghHeaders(env) });
      if (r.ok) {
        const j = await r.json();
        total += j.total_count || 0;
      }
    } catch (e) {
      console.log("GitHub API error:", e);
    }
  }
  return total;
}

export async function isServerBusy(env) {
  const max = parseInt(env.MAX_CONCURRENT || "2", 10);
  const count = await activeRunCount(env);
  return count >= max;
}

export async function dispatchWorkflow(env, workflowFile, inputs) {
  const url = `https://api.github.com/repos/${env.REPO_NAME}/actions/workflows/${workflowFile}/dispatches`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { ...ghHeaders(env), "Content-Type": "application/json" },
      body: JSON.stringify({ ref: "main", inputs }),
    });
    if (r.status === 204) return { ok: true };
    const text = await r.text();
    return { ok: false, error: `Code ${r.status}: ${text}` };
  } catch (e) {
    return { ok: false, error: String(e) };
  }
}

export async function cancelAllRuns(env) {
  let cancelled = false;
  for (const workflow of WORKFLOWS) {
    for (const status of ["in_progress", "queued"]) {
      const url = `https://api.github.com/repos/${env.REPO_NAME}/actions/workflows/${workflow}/runs?status=${status}`;
      try {
        const r = await fetch(url, { headers: ghHeaders(env) });
        if (r.ok) {
          const j = await r.json();
          for (const run of j.workflow_runs || []) {
            const cancelUrl = `https://api.github.com/repos/${env.REPO_NAME}/actions/runs/${run.id}/cancel`;
            await fetch(cancelUrl, { method: "POST", headers: ghHeaders(env) });
            cancelled = true;
          }
        }
      } catch (e) {
        console.log("Cancel error:", e);
      }
    }
  }
  return cancelled;
}
