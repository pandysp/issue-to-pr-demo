// GitHub owns the ordering. A cursor marks a position, unlike a local clock time.
// pi 018634af · 2026-11-20T15:53+01:00
import { execFileSync } from 'node:child_process';

const query = `query($owner:String!, $name:String!, $first:Int, $last:Int, $after:String) {
  repository(owner:$owner, name:$name) {
    issues(orderBy:{field:CREATED_AT, direction:ASC}, first:$first, last:$last, after:$after) {
      nodes { number title state }
      pageInfo { endCursor hasNextPage }
    }
  }
}`;

export function githubIssuePage(repo, { first, last, after }) {
  const [owner, name] = repo.split('/');
  const args = last ? ['-F', `last=${last}`] : ['-F', `first=${first}`];
  if (after) args.push('-f', `after=${after}`);
  const output = execFileSync('gh', ['api', 'graphql', '-f', `query=${query}`,
    '-f', `owner=${owner}`, '-f', `name=${name}`, ...args], { encoding: 'utf8' });
  return JSON.parse(output).data.repository.issues;
}

export function watchNewIssues(page) {
  // Capture the tail before announcing readiness. An empty repo has no cursor yet.
  let cursor = page({ last: 1 }).pageInfo.endCursor;
  return function poll() {
    const issues = [];
    let after = cursor;
    let nextPage;
    do {
      const { nodes, pageInfo } = page({ first: 100, after });
      issues.push(...nodes.filter((issue) => issue.state === 'OPEN'));
      // Closed issues also advance the cursor. An empty page must not reset it.
      if (pageInfo.endCursor) after = pageInfo.endCursor;
      nextPage = pageInfo.hasNextPage;
    } while (nextPage);
    cursor = after; // Only commit a complete poll.
    return issues;
  };
}
