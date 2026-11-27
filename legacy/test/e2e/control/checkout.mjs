import fs from 'node:fs';

export async function prepareCheckout(job, checkout, command, repositoryUrl = repository => 'https://gitcode.com/' + repository + '.git') {
  fs.mkdirSync(checkout);
  const git = args => command('git', ['-c', 'core.hooksPath=/dev/null', ...args], checkout);
  await git(['init', '-q']);
  // Both complete ancestries are needed to detect real merge conflicts.
  await git(['fetch', '--no-tags', repositoryUrl(job.repository), job.baseSha]);
  await git(['checkout', '--detach', job.baseSha]);
  await git(['fetch', '--no-tags', repositoryUrl(job.sourceRepository), job.headSha]);
  await git(['-c', 'user.name=E2E Runner', '-c', 'user.email=e2e@example.invalid', '-c', 'commit.gpgsign=false', 'merge', '--no-edit', '--no-ff', job.headSha]);
  return git(['rev-parse', 'HEAD']);
}
